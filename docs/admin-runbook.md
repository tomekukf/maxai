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

## Odtworzenie bazy po czyszczeniu

1. Migracje (`001`–`004`) jeśli świeża baza.
2. Import kolekcji: eksport pakietu (panel admina) → import (embeddingi z pakietu → bez Bedrock),
   lub `seed-maxlight.mjs` (embeddingi z Titana — jednorazowy koszt).

## Bezpieczeństwo

- RDS: SSL + hasło (Secrets Manager). SG 5432 otwarty (MVP) — TODO: zawęzić / RDS prywatny.
- S3: presigned URL (path-style), bucket prywatny.
- API: obecnie **otwarte** — rozdział ról to na razie UX. Docelowo Cognito + authorizer (Krok 7.4).

## Gotchas

- Presigned S3: path-style, nie podpisywać Content-Type (inaczej 307/SignatureDoesNotMatch).
- Titan przyjmuje tylko JPEG/PNG; obrazy z realnych źródeł konwertujemy do JPEG.
- Obrazy bywają PNG mimo rozszerzenia `.jpg` → wykrywanie formatu po magic-bytes.
- pg8000: nie powtarzać named-param w jednym zapytaniu; `LIMIT` jako liczba, nie parametr.
- Kody produktów w katalogu mogą mieć sufiks-literę (np. `P0635D`) — regex ekstrakcji to uwzględnia.

## Koszty

- Realny koszt MVP: kilka–kilkanaście zł/mies. RDS `db.t3.micro` (Free Tier 12 mies., działa 24/7).
- Zawsze aktywny alert budżetowy (`maxai-monthly-5usd`).
