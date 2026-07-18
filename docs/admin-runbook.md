# maxai — dokumentacja techniczna administracji

Runbook operacyjny rozwiązania. Renderowany w panelu admina (zakładka Dokumentacja).
Jedno źródło prawdy — edytuj ten plik w repo.

## Architektura (skrót)

- **Frontend:** React + Vite + TS + Tailwind (`frontend/`). Hosting docelowo AWS Amplify.
- **API:** API Gateway (HTTP API v2) → Lambda (Python 3.13, poza VPC).
- **Baza:** RDS PostgreSQL 16 + `pgvector` (publiczny, SSL, hasło w Secrets Manager).
- **Storage:** S3 (PDF katalogów + zdjęcia produktów).
- **AI (Bedrock, eu-central-1, profil EU):**
  - Embeddingi: `amazon.titan-embed-image-v1` (1024 wym.).
  - Ekstrakcja/detekcja: Claude Haiku 4.5.
  - Opis wizualny + rerank: Claude Sonnet 4.5.
- **Region:** `eu-central-1`. **IaC:** AWS CDK (TypeScript) w `infra/`.

## Uruchomienie lokalne (frontend)

1. **Konfiguracja** — utwórz `frontend/.env.local` (wzór: `frontend/.env.example`):
   ```
   VITE_API_URL=https://<api-id>.execute-api.eu-central-1.amazonaws.com   # output ApiUrl
   VITE_COGNITO_CLIENT_ID=<UserPoolClientId>                              # output UserPoolClientId
   VITE_COGNITO_REGION=eu-central-1
   ```
   Konkretne wartości dla tego środowiska: **`SECRETS.local.md`** (w katalogu głównym repo, poza gitem).
2. **Start:** `cd frontend && npm install && npm run dev` → `http://localhost:5173`.
3. **Panel handlowca** działa bez logowania (Wyszukiwanie, Katalog).
4. **Panel admina:** kliknij „Admin →" i zaloguj się kontem z grupy `admin`.
   Login/hasło startowe: patrz **`SECRETS.local.md`** (nie trzymamy haseł w repo).

## Zasada kosztowa (WAŻNE)

- **Tworzenie kolekcji odbywa się LOKALNIE** (analiza katalogów: ekstrakcja, klasyfikacja, opis),
  aby ograniczyć koszty Bedrock.
- Na AWS działają tylko: (a) **analiza dokumentu przy wyszukiwaniu** (opis wycinka + rerank),
  (b) **embeddingi Titan** (raz przy imporcie; eksportowane → re-import bez Bedrock).

## Model danych

- `products` — produkt: `optima_id` (może być NULL), `name`, `params` (JSONB), `source`
  (`optima`/`catalog`), `category`, `subtype`, `manufacturer`, `manufacturer_code`, `catalog_id`, `catalog_page`.
- `product_images` — zdjęcia: `image_s3_url`, `embedding vector(1024)`, `attributes` (JSONB), `sort_order`.
- `catalogs` — źródłowe katalogi PDF: `name`, `manufacturer`, `domain_category`, `pdf_s3_url`, `page_count`.
- **Bramka kategorii:** wyszukiwanie zwraca substytuty tylko z tej samej kategorii (twardy filtr).

## Procedury (skrypty w `scripts/`)

Zmienne: `DB_SECRET` = nazwa sekretu z Secrets Manager (output stacku `DbSecretName`).

- **Migracja bazy:** `DB_SECRET=<sekret> node scripts/migrate.mjs backend/migrations/<plik>.sql`
- **Ekstrakcja katalogu (lokalnie, bez AWS):** `python scripts/extract-maxlight.py`
  → `rawdata/maxlight/products.raw.json` + `rawdata/maxlight/images/`.
- **Seed kolekcji do AWS:** `SKIP_UPLOAD=1 node scripts/seed-maxlight.mjs` (Titan embed + zapis).
- **Liczniki:** `DB_SECRET=<sekret> node scripts/db-count.mjs`
- **Czyszczenie:** `PREFIX=BRW- DB_SECRET=<sekret> node scripts/db-clear.mjs` (po prefiksie optima_id).
- **Deploy backendu/infra:** `cd infra && npx cdk deploy --require-approval never`.

## Onboarding nowego katalogu (od PDF do bazy)

Pełny przepływ (0 wywołań Bedrock vision):

1. **Bootstrap:** `python scripts/prepare-catalog.py <pdf> <nazwa> [--manufacturer X] [--category Y]`
   → sonduje PDF i tworzy `rawdata/<nazwa>/PROBE.json` + `CLAUDE_INSTRUCTIONS.md` + `samples/`.
2. **Przygotowanie (Claude Code):** poproś: „**przygotuj katalog <nazwa>**". Claude wykona kroki z
   `CLAUDE_INSTRUCTIONS.md` i wyprodukuje `rawdata/<nazwa>/collection.json` + `rawdata/<nazwa>/images/`.
3. **Import (panel admina → Import kolekcji):** wybierz folder `rawdata/<nazwa>/` → aplikacja tworzy katalog,
   wgrywa zdjęcia do S3 i zapisuje produkty (`describe:false`; embedding = Titan przy imporcie lub z paczki).
4. (Opcjonalnie) PDF do S3 pod link „Otwórz katalog":
   `aws s3 cp <pdf> s3://<bucket>/catalogs/<nazwa>/original.pdf`.

## Import / eksport kolekcji

- **Format paczki `collection.json`**: `{ catalog:{...}, products:[{ ..., images:[{file, role, attributes?, embedding?}] }] }`.
- **Import (panel admina):** wybór folderu (`webkitdirectory`) → `POST /catalogs` → presign+upload zdjęć → `/products`.
  Gdy paczka zawiera `embedding` — pomijany Titan (import bez Bedrock).
- **Eksport:** panel admina → eksport katalogu → `GET /catalogs/{id}/export` zapisuje paczkę (z embeddingami)
  do S3 i zwraca link do pobrania. Backup na wypadek czyszczenia bazy → re-import bez Bedrock.

## Odtworzenie bazy po czyszczeniu

1. Migracje (`001`–`004`) jeśli świeża baza.
2. Import kolekcji: eksport pakietu (panel admina) → import (embeddingi z pakietu → bez Bedrock),
   lub `seed-maxlight.mjs` (embeddingi z Titana — jednorazowy koszt).

## Bezpieczeństwo i logowanie (Cognito, Faza 7.4)

- **Autoryzacja API:** operacje admina (`POST/PUT/DELETE /products`, `POST /catalogs`, `/uploads/presign`)
  wymagają tokena JWT (Cognito) + grupy **`admin`**. GET-y i `/search` są publiczne (praca handlowca bez logowania).
- **Logowanie:** formularz w panelu admina (USER_PASSWORD_AUTH). Front potrzebuje `VITE_COGNITO_CLIENT_ID`
  (output `UserPoolClientId`) i `VITE_COGNITO_REGION` w `frontend/.env.local`.
- **Zarządzanie użytkownikami** (`UP` = output `UserPoolId`):
  - Utwórz: `aws cognito-idp admin-create-user --user-pool-id <UP> --username <login> --message-action SUPPRESS`
  - Stałe hasło: `aws cognito-idp admin-set-user-password --user-pool-id <UP> --username <login> --password '<hasło>' --permanent`
  - Rola: `aws cognito-idp admin-add-user-to-group --user-pool-id <UP> --username <login> --group-name admin|handlowiec`
  - (Bez `--permanent` konto wymaga zmiany hasła — logowanie w aplikacji tego nie obsługuje; ustaw stałe hasło.)
- **RDS:** SSL + hasło (Secrets Manager). SG 5432 otwarty (MVP) — TODO: zawęzić / RDS prywatny.
- **S3:** presigned URL (path-style), bucket prywatny.
- **Uwaga (skrypty):** `seed-maxlight.mjs` woła `POST /products` (chroniony) → wymaga teraz tokena admina;
  podstawowa ścieżka to import przez panel admina. `migrate.mjs`/`db-clear.mjs`/`db-count.mjs` łączą się z DB
  bezpośrednio (bez API) — działają bez zmian.

## Gotchas

- Presigned S3: path-style, nie podpisywać Content-Type (inaczej 307/SignatureDoesNotMatch).
- Titan przyjmuje tylko JPEG/PNG; obrazy z realnych źródeł konwertujemy do JPEG.
- Obrazy bywają PNG mimo rozszerzenia `.jpg` → wykrywanie formatu po magic-bytes.
- pg8000: nie powtarzać named-param w jednym zapytaniu; `LIMIT` jako liczba, nie parametr.
- Kody produktów w katalogu mogą mieć sufiks-literę (np. `P0635D`) — regex ekstrakcji to uwzględnia.

## Koszty

- Realny koszt MVP: kilka–kilkanaście zł/mies. RDS `db.t3.micro` (Free Tier 12 mies., działa 24/7).
- Zawsze aktywny alert budżetowy (`maxai-monthly-5usd`).
