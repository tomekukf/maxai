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
3. **Logowanie (wymagane):** aplikacja startuje ekranem logowania.
   - **Handlowiec** (grupa `handlowiec`) → panel handlowca (Wyszukiwanie, Katalog).
   - **Admin** (grupa `admin`) → dodatkowo przycisk „Admin →" (import/edycja/usuwanie, statystyki, dokumentacja).
   - Loginy/hasła: patrz **`SECRETS.local.md`** (nie trzymamy haseł w repo).
   - Uwaga: to gate frontendu + tożsamość. Endpointy GET/`/search` są nadal publiczne po stronie API
     (twardo chronione są tylko operacje admina — patrz niżej); pełne zamknięcie API to dalszy krok.

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
4. (Opcjonalnie) **Lekkie strony katalogu** (szybkie „Otwórz katalog" zamiast 200 MB PDF):
   `python scripts/render-catalog-pages.py <pdf> <nazwa>` → `rawdata/<nazwa>/pages/` →
   `aws s3 cp rawdata/<nazwa>/pages "s3://<bucket>/catalogs/<folder>/pages/" --recursive`.
   Oraz PDF: `aws s3 cp <pdf> s3://<bucket>/catalogs/<folder>/original.pdf`.

### Zdjęcia produktów — ile i które (kanon)

Pełne zasady: `docs/product-images-spec.md`. Skrót, bo to najczęstsze źródło słabych wyników:

- **3 zdjęcia na produkt, maksymalnie 4** — piąte i dalsze system ignoruje (do reranku pobiera `LIMIT 4`).
- **Zdjęcie główne (`sortOrder: 0`) to jedyne, które przy domyślnych ustawieniach ogląda model
  oceniający wyniki.** Musi to być packshot na jednolitym tle, cały produkt, front lub 3/4.
- Kolejne: inne ujęcie bryły (bok/tył), potem aranżacja lub detal faktury.
- **Nie wciągamy:** rysunków technicznych, banerów/opakowań, zdjęć zbiorczych rodziny produktów,
  kadrów gdzie produkt jest tłem, ani tego samego packshotu w innej rozdzielczości.
- **Duplikaty ujęcia** usuwa `node scripts/dedupe-images.mjs` (dry-run domyślnie, `APPLY=1` wykonuje).
  Bezpieczny próg: `THRESHOLD=0.95`. Przy 0.90 kasowane są **warianty kolorystyczne** — nie schodź niżej.
- Zły kadr jako główny naprawiasz bez re-importu: **Katalog → podgląd produktu → „Ustaw jako główne"**.

### Ręczna orchestracja (komendy)

Gdy chcesz zrobić wszystko z konsoli, bez GUI:
- **Ekstrakcja → rawdata:** `python scripts/prepare-catalog.py <pdf> <nazwa>` (potem Claude wg `CLAUDE_INSTRUCTIONS.md`).
- **Seed do AWS bez GUI:** `SKIP_UPLOAD=1 node scripts/seed-maxlight.mjs` (wzorzec; dla nowej kolekcji analogiczny skrypt).
- **Usunięcie całego źródła i re-import:** panel admina → lista źródeł → „Usuń źródło" (kaskada) **lub**
  `DELETE /catalogs/{id}`; następnie ponowny import paczki. To realizuje „łatwo usunąć zakres i dodać od nowa".
- **maxfliz (oferta publiczna, Faza 10.1 — planowane):** `node scripts/scrape-maxfliz.mjs` → `rawdata/maxfliz/` → import w panelu.

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

- Największe pozycje: **Sonnet 4.5** (rerank przy każdym `/search` — wysyła zdjęcia kandydatów) i **RDS 24/7**.
- **Zastosowane cięcia (A+D):** rerank wysyła ~8 zdjęć zamiast ~16 (`per_cand`, budżet 8); opis wycinka i kontekst z rysunku
  liczone na **Haiku** (`DESCRIBE_MODEL_ID`), rerank zostaje na Sonnet. Efekt: ~50–60% mniej za wyszukiwanie, jakość ~bez zmian.
  Dalszy krok (C, opcjonalnie): downscale zdjęć do ~512px przed rerankiem (Pillow) → jeszcze ~2–4× taniej.
- **Uwaga o Free Tier:** okno 12 mies. liczy się od założenia KONTA (nie instancji), a konto jest wspólne z `liveorganizer`
  → RDS może już NIE być darmowy (spec `db.t3.micro` jest „eligible", ale okno bywa zamknięte / pula 750 h dzielona).
  `db.t3.micro` 24/7 ≈ ~$13/mies. + storage 20 GB ≈ ~$1.8. Publiczny IPv4 (linia „VPC") nie jest darmowy.
## Ochrona budżetu (limit $20 + auto-odcięcie)

- **Budżet `maxai-monthly-20usd`** (na całe konto): alerty e-mail przy **60/80/90%** (ACTUAL) + **prognozie 100%**.
- **Auto-odcięcie przy 85% ($17):** akcja budżetu dopina politykę **`maxai-DenyBedrock`** do 4 ról Lambd (Search/Detect/Extract/
  Products) → Bedrock (Sonnet/Haiku/Titan) przestaje działać → **koszt zmienny się zatrzymuje**. Wyszukiwanie/Detekcja padają;
  **Katalog i logowanie działają**; RDS zostaje (opcja „a"). ⚠️ **Uwaga:** dane kosztowe AWS mają **opóźnienie ~dobę** — akcja
  odpala na opóźnionych danych, więc nie jest to stop „co do godziny".
- **Ręczna kontrola (natychmiastowa, w rootcie):**
  - `.\budget-lock.ps1` — **teraz** odetnij Bedrock (gdy nie chcesz czekać na AWS).
  - `.\budget-unlock.ps1` — przywróć Bedrock (po auto-akcji lub locku; **konieczne, by wznowić wyszukiwanie** — auto-akcja sама się nie cofa).
- Elementy: polityka `maxai-DenyBedrock`, rola `maxai-budget-action-role` (trust: budgets.amazonaws.com).

## Oszczędzanie: Stop / Start RDS (dev)

Największe realne cięcie na dev = **zatrzymywać RDS, gdy nikt nie korzysta** (płacisz wtedy tylko storage ~$1.8/mies.
zamiast ~$15). AWS pozwala trzymać stop **do 7 dni** — potem instancja sama wstaje (ograniczenie AWS).

**Wpływ na apkę przy zatrzymanym RDS:** frontend się ładuje, **logowanie działa** (Cognito, nie baza), ale **Wyszukiwanie,
Katalog, Statystyki, Import przestają działać** (Lambda nie połączy się z bazą). Start trwa ~1–3 min. Zatrzymuj tylko na czas przestoju.

Instancja: `maxaistack-db5d02a0a9-jybapipmxkn3` (region `eu-central-1`).

**Skrypty PowerShell w rootcie projektu** (najprościej):
```powershell
.\rds-stop.ps1      # zatrzymaj (oszczędzasz)
.\rds-start.ps1     # uruchom przed pracą/demem
.\rds-status.ps1    # sprawdź stan (available / stopped / starting…)
```

**Albo komendy wprost (AWS CLI):**
```bash
aws rds stop-db-instance  --db-instance-identifier maxaistack-db5d02a0a9-jybapipmxkn3 --region eu-central-1
aws rds start-db-instance --db-instance-identifier maxaistack-db5d02a0a9-jybapipmxkn3 --region eu-central-1
aws rds describe-db-instances --db-instance-identifier maxaistack-db5d02a0a9-jybapipmxkn3 --region eu-central-1 --query "DBInstances[0].DBInstanceStatus" --output text
```
