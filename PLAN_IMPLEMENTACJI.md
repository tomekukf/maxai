# Plan działania i implementacji — Asystent Sprzedaży (MVP)

> Dokument roboczy dla PoC/MVP integracji wizualizacji architektonicznych z asortymentem (ID Optima).
> Bazuje na `max_ai_concept.txt.txt` po review technicznym.
> **Cel nadrzędny: działające MVP przy minimalnych kosztach.**
> **Zasada pracy:** realizujemy jeden krok, weryfikujemy kryterium, dopiero potem następny.

---

## A. Decyzje architektoniczne (zablokowane)

| Decyzja | Wybór | Uzasadnienie |
|---|---|---|
| Detekcja obiektów | **Ścieżka A — bez Rekognition** + **auto-detekcja (Haiku 4.5 vision)** ✅ | Domyślnie model sam rozpoznaje meble na obrazie i zwraca listę etykiet + bounding boxy do akceptacji; kadrowanie (`react-image-crop`) jest edytowalne (boxy z auto-detekcji bywają nieprecyzyjne). Endpoint `/detect`. |
| Model ekstrakcji/NLP | **Claude Haiku 4.5** — `eu.anthropic.claude-haiku-4-5-20251001-v1:0` ✅ | Tani, szybki, multimodalny. Ekstrakcja parametrów + auto-detekcja obiektów. |
| Opis wizualny + rerank | **Claude Sonnet 4.5** — `eu.anthropic.claude-sonnet-4-5-20250929-v1:0` ✅ | Sonnet 5 niedostępny → używamy 4.5. Bogaty opis produktu (JSON wg schematu) przy zasilaniu ORAZ rerank kandydatów na zdjęciach (sędzia) w wyszukiwaniu. |
| Embeddingi (model) | **Titan Multimodal** — `amazon.titan-embed-image-v1` ✅ | Wektor 1024. |
| Embeddingi | **Amazon Titan Multimodal** (1024 wym.) | Wektor obraz+tekst w jednej przestrzeni. |
| Baza wektorowa | **RDS PostgreSQL + pgvector** | Sprawdzone, wystarczające dla MVP. |
| Backend | **Python** (Lambda 3.12) | Najlepszy ekosystem AI/obraz/PDF. |
| IaC | **AWS CDK (TypeScript)** | Kod w `infra/`. Node 22 pewne; Lambdy w Pythonie z runtime `python3.13` (lokalny Python 3.14 jest za nowy dla Lambdy). |
| Zasilanie danymi | **BRW (JSON-LD, ~25 sof)**, ID `BRW-<kod>` | Agata za Cloudflare → pivot na BRW. Brak dostępu do Optimy klienta. |
| Wizualizacje testowe | **Dostarcza użytkownik (2 PDF-y)** | Patrz sekcja D. Fallback: kompozycja realnych zdjęć. |
| **Tworzenie kolekcji = LOKALNIE** ✅ | Analiza katalogów (ekstrakcja, klasyfikacja, opis) **lokalnie** (Claude Code / model lokalny), NIE na Bedrock vision | Ograniczenie kosztów Bedrock. Na AWS pozostają wyłącznie: (a) **analiza dokumentu przy wyszukiwaniu** (opis wycinka + rerank), (b) **embeddingi Titan** (jedyny model bez lokalnego odpowiednika; tani; liczony raz przy imporcie, potem **eksportowany** → re-import bez Bedrock). Interaktywny import z vision na AWS (`/catalog/analyze-page`, Krok 5.2/5.5) odłożony na rzecz ścieżki lokalnej + import/eksport (Krok 7.5). Zrobione dla Maxlight (`extract-maxlight.py` + `seed-maxlight.mjs`). |

---

## B. Zakres MVP

> **Kluczowe założenie:** to wyszukiwarka **substytutów**. Jeśli produktu z wizualizacji nie mamy 1:1
> (inny producent), zwracamy **maksymalnie podobne wizualnie** produkty z naszego asortymentu jako
> alternatywy do zaoferowania — nigdy „brak wyniku".

**JEST:** panel zasilania bazy (upload zdjęć → S3, opis + ID Optima → ekstrakcja parametrów Haiku 4.5 → JSON → embedding Titan → zapis), ścieżka wyszukiwania (render PDF → ręczne kadrowanie → opc. analiza Sonnet 5 → embedding wycinka → pgvector → 3 propozycje z ID Optima), formularz dopytania (Haiku 4.5), CI/CD Amplify.

**NIE MA (iteracja 2+):** auto-detekcja obiektów, realna integracja API Optima, masowy import, zaawansowane auth.

---

## C. Stos technologiczny

- Repo: GitHub · Frontend: React (Vite) + TS, Tailwind + shadcn/ui, `react-pdf`, `react-image-crop`
- Hosting/CI: AWS Amplify (auto-deploy z `main`) · API: API Gateway + Lambda (Python 3.12)
- Baza: RDS PostgreSQL 15+ z `pgvector` · Storage: S3
- AI: Bedrock → Titan Multimodal, Claude Haiku 4.5, Claude Sonnet 5 · IaC: AWS CDK
- **Region:** `eu-central-1` (Frankfurt) · **Node:** 22 · **Konto AWS:** wspólne z `liveorganizer` (te same credentials). Z liveorganizer bierzemy tylko dane dostępowe — stack maxai jest niezależny.

---

## D. Materiały do dostarczenia przez użytkownika

Potrzebne **przed Krokiem 2.5** (test end-to-end):

1. **PDF „test pozytywny"** — salon z sofą, która **JEST** w zasilonej bazie (jedna z ~25 sof BRW).
   - Sofa na wizualizacji powinna **wizualnie odpowiadać** zdjęciu produktu w bazie (podobny model/kąt),
     żeby podobieństwo wektorowe było wysokie. Ustalimy wspólnie, którą sofę z seed-setu użyć.
2. **PDF „test alternatywny"** — salon z sofą **innego producenta**, której **NIE MA** w bazie.
   - Sprawdza kluczowe założenie: system zwraca **maksymalnie podobne wizualnie** sofy z naszego
     asortymentu (substytuty do zaoferowania), a nie „brak wyniku". Sofa **NIE musi** być w seed-secie.

> Jeśli wolisz, żebym to ja przygotował wizualizacje — fallback: wklejenie realnego zdjęcia produktu
> w stockowy render salonu i eksport do PDF. Daj znać, zmienimy ten punkt.

---

## E. Model danych (PostgreSQL + pgvector)

**Multi-image:** produkt ma wiele zdjęć; każde zdjęcie ma własny embedding i własny opis wizualny
(`attributes` JSONB). Migracje: `001_init.sql`, `002_multi_images.sql`, `003_attributes.sql`.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE products (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    optima_id  TEXT NOT NULL,            -- syntetyczne: BRW-<kod>
    name       TEXT,
    params     JSONB,                    -- {kategoria, wymiary_cm, kolor, styl, materiał, cena, kod, warianty, specyfikacja, ...}
    source_url TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE product_images (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id   UUID REFERENCES products(id) ON DELETE CASCADE,
    image_s3_url TEXT NOT NULL,
    embedding    vector(1024),           -- Titan Multimodal (per zdjęcie)
    attributes   JSONB,                  -- opis wizualny wg docs/product-description-spec.md (Sonnet 4.5)
    sort_order   INT DEFAULT 0,
    created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON product_images USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

Zapytanie (dwuetapowe — patrz sekcja E'): **głównym sygnałem jest podobieństwo wizualne**
(`embedding <=> $1`, kosinus) — szukamy substytutów, nie exact-match. Filtry po `params` są
**opcjonalne/miękkie**, NIE twarde `WHERE` domyślnie — inaczej wykluczylibyśmy dobre alternatywy.

**Wyjątek — kategoria (od Fazy 5) to JEDYNY twardy filtr.** Substytut jest zawsze w tej samej
kategorii (sofa ↔ sofa, nie sofa ↔ lampa). `products.category` + tabela źródeł `catalogs`
(+ `source/catalog_id/catalog_page/manufacturer/manufacturer_code`) dochodzą w migracji `004`
(szczegóły w Fazie 5). Wewnątrz kategorii wszystko pozostaje miękkie.

---

## E'. Architektura wyszukiwania (retrieve → rerank)

Surowy kosinus Titana na parach *render z wizualizacji ↔ zdjęcie studyjne* bywał za słaby
(mylił np. beżowy fotel z szarymi sofami). Wprowadzono dwuetapowy pipeline:

1. **Retrieve (Titan + pgvector):** embedding wycinka → `DISTINCT ON (product_id)` najlepsze ujęcie
   per produkt → **TOP-8** kandydatów (recall), z ich `attributes`.
2. **Opis zapytania (Sonnet 4.5):** wycinek zapytania jest opisywany tym samym schematem co produkty
   (drugi sygnał: typ/kolor/materiał/kształt).
3. **Rerank (Sonnet 4.5 jako sędzia):** na wejściu obraz zapytania + jego atrybuty + obrazy i atrybuty
   kandydatów. Model **ocenia dopasowanie 0-100** per kandydat, odrzuca inny typ mebla / wyraźnie
   niepodobne kolorem i materiałem, zwraca ranking. Nacisk na **kolor + materiał + bryłę** (rozróżniają
   ten sam vs inny model), z niedowartościowaniem samej wielkości i tła renderu.
4. **Wynik:** wyświetlana „**dopasowanie %**" = ocena rerankingu (spójna z kolejnością);
   `visualSimilarity` (kosinus Titana) trzymany pomocniczo.

Efekt (test realny): beżowa amerykanka BRW-718047 z wizualizacji trafiła na **#1**, mimo niższego
kosinusa Titana niż konkurencyjne szare sofy.

---

## F. Endpointy API (MVP)

| Metoda | Ścieżka | Opis |
|---|---|---|
| `POST` | `/uploads/presign` | Presigned URL do wgrania pliku na S3. |
| `POST` | `/extract` | Surowy opis → JSON parametrów (Haiku 4.5), podgląd przed zapisem. |
| `POST` | `/detect` | Obraz (base64) → lista mebli (etykieta + bounding box 0-1) do akceptacji (Haiku 4.5 vision). |
| `GET` | `/products` | Lista produktów (z głównym zdjęciem, presigned GET) — dla katalogu. |
| `POST` | `/products` | ID Optima + `imageKeys[]` → per zdjęcie: embedding (Titan) + opis wizualny (Sonnet 4.5) → zapis. |
| `DELETE` | `/products` \| `/products/{optimaId}` | Usuń wszystkie / jeden produkt (kaskada + sprzątanie S3). |
| `POST` | `/search` | Wycinek (base64) → **bramka kategorii** → retrieve (Titan+pgvector TOP-8) → rerank (Sonnet 4.5, ocena 0-100) → TOP N (+ odniesienie do źródła: Optima / katalog). |
| `POST/GET/DELETE` | `/catalogs` \| `/catalogs/{id}` | (Faza 5) CRUD katalogu PDF (+ kaskada produktów, sprzątanie S3). |
| `POST` | `/catalog/analyze-page` | (Faza 5) Obraz strony + tekst PDF → produkty `{nazwa, kategoria, box, params, opis, kod}[]` (Haiku 4.5 vision). |
| `GET` | `/products/{id}` | (Faza 6) Szczegóły produktu: pełne `params`, atrybuty, wszystkie zdjęcia (presigned), odniesienie do katalogu. |
| `PUT` | `/products/{id}` | (Faza 6) Edycja metadanych produktu (bez zmiany embeddingu). |
| `GET` | `/catalogs/{id}/export` | (Faza 7) Eksport kolekcji: JSON (produkty + `attributes` + **embeddingi** + zdjęcia) do backupu/re-importu bez Bedrock. |
| `POST` | `/products` (rozszerzenie) | (Faza 7) `images:[{key, embedding?, ...}]` — gotowy embedding pomija Titan (import kolekcji = 0 Bedrock). |

---

## G. KROKI (realizacja jeden po drugim)

Każdy krok ma **kryterium weryfikacji** — akceptujemy krok, gdy jest spełnione.

### Faza 0 — Fundament

**Krok 0.1 — Repozytorium i struktura** — ✅ ZROBIONE (commit `0b98d26`, branch `main`)
- Działania: `git init -b main`, struktura folderów (`frontend/`, `backend/`, `infra/`, `scripts/`, `docs/`), `.gitignore`, `.nvmrc` (22), README.
- ✅ Weryfikacja: repo jest gitem, struktura istnieje, pierwszy commit wykonany.

**Krok 0.2 — Konto AWS + budżet i alerty** — ✅ ZROBIONE
- Działania: konto wspólne z liveorganizer (zweryfikowane `aws sts get-caller-identity`); budżet `maxai-monthly-5usd` ($5, alert-only, e-mail na progach 50/80/100% actual + 100% forecast). Definicje: `infra/budget-5usd.json`, `infra/budget-notifications.json`.
- ✅ Weryfikacja: `aws budgets describe-budget` zwraca budżet z limitem 5 USD, status HEALTHY.
- Uwaga: AWS Budgets tylko alarmuje, nie zatrzymuje wydatków (twardy auto-stop = Budget Actions, ew. później).

**Krok 0.3 — Dostęp do modeli Bedrock** — ✅ ZROBIONE (Sonnet 5 odłożony do Kroku 3.2)
- Modele potwierdzone testowo w `eu-central-1` (inference profile **EU** → dane w UE):
  - Haiku 4.5: `eu.anthropic.claude-haiku-4-5-20251001-v1:0` — ✅ (converse zwrócił „OK")
  - Titan Multimodal (1024): `amazon.titan-embed-image-v1` — ✅ (embedding length 1024)
  - Sonnet 5: `eu.anthropic.claude-sonnet-5` — ⏸️ dostęp do włączenia w konsoli (Bedrock → Model access); potrzebny dopiero w Kroku 3.2 (opcjonalna analiza wizualizacji).
- ✅ Weryfikacja: ścieżka krytyczna (Haiku + Titan) działa — wystarcza do Fazy 1 i wyszukiwania.

**Krok 0.4 — CDK bootstrap + szkielet + IAM dewelopera** — ✅ ZROBIONE
- Język: **CDK w TypeScript** (`infra/`), Lambdy w Pythonie (runtime `python3.13`).
- Szkielet: `infra/{package.json,tsconfig.json,cdk.json,bin/maxai.ts,lib/maxai-stack.ts}`.
- Bootstrap + deploy wykonane. Stack `MaxaiStack`, bucket S3 na pliki: `maxaistack-filesbucket16450113-3fnndonlqpsv` (eu-central-1).
- IAM: dostęp do wspólnego konta (bez osobnego usera dev na tym etapie).
- ✅ Weryfikacja: `cdk deploy` OK, output `FilesBucketName`, bucket widoczny w `aws s3 ls`.

> 🎉 **Faza 0 (fundament) ukończona.** Dalej: Faza 1 — baza + zasilanie.

### Faza 1 — Baza + zasilanie (najpierw dane!)

**Krok 1.1 — RDS PostgreSQL + pgvector + schemat** — ✅ ZROBIONE
- Sieć MVP: RDS **publicznie dostępny**, Lambdy **poza VPC** → brak NAT/VPC endpoints ($0 extra). Ochrona: hasło (Secrets Manager) + SSL, SG 5432.
- CDK: VPC (bez NAT) + RDS PostgreSQL **16.14** `db.t3.micro` (Free Tier) + SG. Endpoint/login w outputach stacku (`DbEndpoint`, `DbSecretName`) i Secrets Manager.
- Migracja: `backend/migrations/001_init.sql` (extension `vector` + tabela `products` + indeksy). Runner (brak psql): `scripts/migrate.mjs` — pobiera dane z Secrets Manager, wykonuje SQL, weryfikuje.
- ✅ Weryfikacja: `OK migracja | pgvector: jest | tabela products: jest`.

**Krok 1.2 — S3 + presigned upload** — ✅ ZROBIONE
- Bucket (Faza 0) + Lambda `/uploads/presign` (Python 3.13, poza VPC) + HTTP API (API Gateway v2). Kod: `backend/lambdas/presign/handler.py`. Test: `scripts/test-presign.mjs`. Output `ApiUrl`.
- Gotcha: presigned URL w **path-style** (`Config(s3={'addressing_style':'path'})`) — inaczej S3 zwraca 307 na virtual-hosted host świeżego bucketu, a klient podążający za redirectem (fetch/przeglądarka) dostaje SignatureDoesNotMatch. Nie podpisujemy też Content-Type.
- ✅ Weryfikacja: `PUT status: 200 OK`, plik w `s3://.../test/`.

**Krok 1.3 — Lambda `/extract` (Haiku 4.5)** — ✅ ZROBIONE
- Działania: opis → JSON parametrów. Kod: `backend/lambdas/extract/handler.py` (Bedrock `converse`, model `eu.anthropic.claude-haiku-4-5-...`, `temperature:0`). Route `/extract`. IAM `bedrock:InvokeModel`. Test: `scripts/test-extract.mjs`.
- ✅ Weryfikacja: przykładowy opis → poprawny JSON (nazwa, wymiary, kolor, materiały, cena, kod).

**Krok 1.4 — Lambda `/products` (Titan + zapis)** — ✅ ZROBIONE
- `backend/lambdas/products/handler.py`: zdjęcie z S3 → embedding Titan (1024) → atomowy INSERT do `products`. Sterownik **pg8000** (czysty Python) vendorowany (`pip install -r requirements.txt -t .`; gitignore poza handler.py+requirements.txt). SSL bez weryfikacji CA (MVP).
- IAM: `s3:GetObject`, `bedrock:InvokeModel`, `secretsmanager:GetSecretValue`. Route `/products`. Testy: `scripts/test-products.mjs` (generuje PNG 64×64 — Titan odrzuca 1×1: „Truncated File Read"), `scripts/db-count.mjs`.
- ✅ Weryfikacja: `HTTP 200 {id}`, `{ produkty:1, z_embeddingiem:1 }`.
- **Build fresh clone** (przed `cdk deploy`): `python -m pip install -r backend/lambdas/products/requirements.txt -t backend/lambdas/products/`.

**Krok 1.5 — Panel `IngestPage`** — ✅ ZROBIONE
- Frontend: React 18 + Vite 5 + TS + Tailwind 3 (`frontend/`). `IngestPage` + `lib/api.ts`. API URL w `frontend/.env.local` (gitignore; wzór `.env.example`).
- Flow: upload zdjęcia → `/extract` (podgląd/edycja JSON) → `/products`. **Konwersja obrazu do JPEG w przeglądarce** (canvas) przed uploadem — Titan przyjmuje tylko JPEG/PNG (AVIF/WebP z realnych sklepów → błąd „Unable to process provided image").
- ✅ Weryfikacja: dodanie produktu przez UI działa end-to-end (licznik `products` rośnie).

**Krok 1.6 — Zasilenie danymi testowymi (BRW)** — ✅ ZROBIONE
- **Pivot z Agaty:** Agata (`agatameble.pl`) za Cloudflare managed challenge → automatyczny scraping odpada (nie obchodzimy anti-bot). Wybór **BRW** (`brw.pl`): `robots.txt` pozwala (`Disallow: /` tylko dla bota „Fasterfox"; `*` ma wykluczenia paginacji/parametrów, ale kategorie dozwolone), brak Cloudflare, kategoria sof ma **JSON-LD dla 36 produktów** w SSR HTML.
- `scripts/scrape-brw.mjs`: parsuje JSON-LD kategorii sof → `rawdata/brw-products.json` (name, image JPG, price, url, code). `scripts/seed.mjs`: dla każdej → download zdjęcia (JPEG, bez `sharp`) → presign+upload → `/extract`(nazwa) → `/products` z ID `BRW-<code>`, rate limit 0,5s.
- ✅ Weryfikacja: **25/25 załadowane**, `{ produkty: 28, z_embeddingiem: 28 }`.

> 🎉 **Faza 1 (baza + zasilanie) ukończona.** Dalej: Faza 2 — wyszukiwanie.

### Faza 2 — Wyszukiwanie

**Krok 2.1 — `PdfViewer` (react-pdf)** — ✅ ZROBIONE
- Dodatkowo: obsługa uploadu **zdjęć** (JPG/PNG/AVIF/WebP), nie tylko PDF — konwersja do JPEG w przeglądarce.
- ✅ Weryfikacja: wgrany PDF/obraz renderuje się w przeglądarce.

**Krok 2.2 — `ImageCropper` (react-image-crop)** — ✅ ZROBIONE
- Kadrowanie **edytowalne**, wstępnie wypełniane bounding boxem z auto-detekcji (`/detect`).
- ✅ Weryfikacja: kadrowanie zwraca poprawny wycinek obrazu.

**Krok 2.3 — Lambda `/search` (Titan + pgvector)** — ✅ ZROBIONE (zrobione jako pierwsze w Fazie 2 — walidacja rdzenia headless)
- `backend/lambdas/search/handler.py`: base64 wycinka → Titan embedding → pgvector cosine (`ORDER BY similarity DESC LIMIT n`) → TOP N z presigned GET zdjęć. pg8000 vendorowany. Route `/search`. Test: `scripts/test-search.mjs`.
- Gotcha pg8000: NIE powtarzać named-param (`:q`) i NIE parametryzować `LIMIT` — psuło liczbę wyników; użyć aliasu w `ORDER BY` + `LIMIT <int>`.
- ✅ **Weryfikacja rdzenia:** substytuty (sofa spoza bazy) → TOP 3 podobnych (sim 0,68–0,77); dokładny (sofa w bazie) → jej wariant #1 (sim 1,0) + własna pozycja #2 (0,92). **Wyszukiwarka substytutów działa na realnych danych.**

**Krok 2.4 — `ResultsList` + `SearchPage` + `CatalogPage`** — ✅ ZROBIONE
- `SearchPage`: zunifikowany flow (upload → auto-detekcja jako klikalne etykiety → edytowalny crop → `/search` → wyniki). Wynik: zdjęcie, „dopasowanie %", nazwa, ID Optima kopiowalne jednym kliknięciem.
- `CatalogPage`: siatka produktów z bazy (`GET /products`) + „Usuń" / „Usuń wszystko" / „Odśwież".
- ✅ Weryfikacja: wyniki i katalog wyświetlają się, ID Optima kopiowalne.

**Krok 2.5 — Test end-to-end na wizualizacji** — 🟡 CZĘŚCIOWO (pozytywny ✅)
- ✅ **Test pozytywny:** wizualizacja z sofą/amerykanką **BRW-718047** (w bazie) → po dodaniu rerankingu
  produkt trafił na **#1** (mimo niższego kosinusa Titana niż konkurencyjne szare sofy). Rdzeń +
  jakość dopasowania udowodnione na realnych danych.
- ⏳ **Test alternatywny:** wizualizacja z sofą innego producenta (spoza bazy) → TOP N substytutów.
  Do wykonania.

### Faza 2b — Jakość dopasowania (dodane w trakcie)

Powód: „algorytm prawdopodobieństwa za słaby" — sam Titan mylił typy/kolory. Wprowadzono:

**Krok 2b.1 — Multi-image + opis wizualny** — ✅ ZROBIONE
- Migracje `002_multi_images.sql`, `003_attributes.sql`: tabela `product_images` (embedding per zdjęcie
  + `attributes` JSONB). `/products` osadza wiele zdjęć i **opisuje każde Sonnetem 4.5** wg
  `docs/product-description-spec.md`. Opis dostaje **nazwę handlową jako kontekst** (kotwiczy typ —
  np. „sofa"/„kanapa" nie zostanie nazwana „fotelem").
- Gotcha: obrazy BRW to **PNG mimo rozszerzenia `.jpg`** → wykrywanie formatu po magic-bytes
  (`_img_format`) w describe/rerank/detect (inaczej Bedrock: „image appears to be a image/png image").
- ✅ Weryfikacja: `db-count` → `z_opisem` = liczba zdjęć; podgląd opisu: `scripts/db-attrs.mjs`.

**Krok 2b.2 — Auto-detekcja obiektów (`/detect`)** — ✅ ZROBIONE (przeniesione z iteracji 2)
- Lambda `detect` (Haiku 4.5 vision): obraz → etykiety mebli + bounding boxy 0-1. UI: klikalne etykiety
  wypełniają edytowalny crop.
- ✅ Weryfikacja: auto-detekcja zwraca sensowne etykiety; boxy edytowalne.

**Krok 2b.3 — Retrieve → rerank + opis zapytania + ocena dopasowania** — ✅ ZROBIONE
- `/search`: TOP-8 kandydatów (Titan) → opis wycinka zapytania (Sonnet 4.5) → rerank sędziowski na
  zdjęciach + atrybutach, **ocena 0-100** per kandydat (nacisk kolor+materiał+bryła). Wyświetlane
  „dopasowanie %" = ocena rerankingu. Logi diagnostyczne: `[query] atrybuty`, `[rerank] uzasadnienie`,
  `[rerank] ranking`.
- ✅ Weryfikacja: BRW-718047 z wizualizacji → #1 (patrz Krok 2.5, test pozytywny).

### Faza 3 — Warstwa AI dopytywania

**Krok 3.1 — `RefinementForm` + Haiku 4.5**
- Działania: model decyduje, czy potrzebny kontekst; predefiniowane przyciski (Welur/Skóra…) + pole tekstowe wpływają na zapytanie.
- ✅ Weryfikacja: formularz pojawia się gdy trzeba; wybór wpływa na wyniki.

**Krok 3.2 — (opc.) Sonnet 5 wzbogaca zapytanie**
- ✅ Weryfikacja: opis cech z Sonnet 5 mierzalnie poprawia ranking na zestawie testowym.

### Faza 4 — CI/CD i domknięcie

**Krok 4.1 — Amplify + `main`**
- ✅ Weryfikacja: push na `main` → auto-deploy, aplikacja dostępna pod URL Amplify.

**Krok 4.2 — Backend w CDK + dokumentacja lokalna**
- ✅ Weryfikacja: świeże środowisko odtwarzalne z CDK; instrukcja uruchomienia lokalnego działa.

**Krok 4.3 — Mini-zestaw ewaluacyjny**
- Działania: 10 wizualizacji → oczekiwany produkt; pomiar trafności TOP 3.
- ✅ Weryfikacja: raport trafności (np. % trafień w TOP 3).

### Faza 5 — Import katalogu PDF producenta

**Cel:** wciągać do bazy produkty z katalogów PDF różnych producentów i kategorii (płytki, meble,
sofy, krzesła, oświetlenie), interpretowane **per kategoria**; przy wyszukiwaniu proponować je z
odniesieniem do źródła (**ID Optima LUB katalog PDF w S3 otwierany na właściwej stronie**), bo nie
wszystko jest w Optimie. **Substytut zawsze w obrębie tej samej kategorii** (patrz „bramka kategorii").

**Decyzje (zatwierdzone z użytkownikiem):**
- **Poziom automatyzacji:** kreator z przeglądem (human-in-the-loop) — dane katalogów bywają zaszumione.
- **Podział importu:** hybryda — jedna encja katalogu (`catalogs`), przetwarzanie/przegląd **partiami stron**
  (np. po 10), status per strona, wznawialne; dedup na poziomie całego katalogu.
- **Kategoria:** deklaracja domeny katalogu przy imporcie (kotwica) **+** auto-klasyfikacja per produkt
  (Haiku vision) do kontrolowanej taksonomii. Dla katalogów mieszanych.
- **Bramka kategorii w wyszukiwaniu:** **TWARDA** — kandydaci spoza kategorii zapytania są odrzucani
  przed rerankingiem (chroni przed „lampą zamiast sofy" — błąd dyskwalifikujący). To jedyny twardy filtr;
  wewnątrz kategorii wszystko pozostaje miękkie (sekcja E).
- **Duplikaty:** ostrzeż i pozwól zdecydować (pomiń / dodaj jako kolejne zdjęcie istniejącego / dodaj jako nowy).

**Taksonomia (kontrolowana, wspólna dla importu i wyszukiwania; rozszerzalna):**
`sofa, naroznik, fotel, krzeslo, stol, stolik, lozko, szafka, komoda, regal, oswietlenie, plytki, dywan, dekoracja, inne`.

**Model danych — migracja `004_catalogs.sql`:**
```sql
CREATE TABLE catalogs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT, manufacturer TEXT,
    domain_category TEXT,          -- deklarowana domena: 'sofy' | 'oswietlenie' | 'mixed' ...
    pdf_s3_url TEXT NOT NULL,
    pdf_sha256 TEXT,               -- wykrycie ponownego importu tego samego pliku
    page_count INT,
    status TEXT DEFAULT 'ready',   -- uploaded|processing|ready|error
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE products ADD COLUMN source            TEXT DEFAULT 'optima';  -- 'optima'|'catalog'
ALTER TABLE products ADD COLUMN category          TEXT;                   -- kanoniczny slug (taksonomia) — TWARDA bramka
ALTER TABLE products ADD COLUMN subtype           TEXT;                   -- generyczny podtyp w obrębie kategorii (sygnał różnicujący)
ALTER TABLE products ADD COLUMN manufacturer      TEXT;
ALTER TABLE products ADD COLUMN manufacturer_code TEXT;
ALTER TABLE products ADD COLUMN catalog_id        UUID REFERENCES catalogs(id) ON DELETE CASCADE;
ALTER TABLE products ADD COLUMN catalog_page      INT;                    -- strona PDF do podglądu (#page=N)
ALTER TABLE products ALTER COLUMN optima_id DROP NOT NULL;  -- produkt z katalogu może nie mieć ID Optima

CREATE UNIQUE INDEX products_mfr_code_uq
    ON products (manufacturer, manufacturer_code) WHERE manufacturer_code IS NOT NULL;
CREATE INDEX products_category_idx ON products (category);
CREATE INDEX products_subtype_idx  ON products (subtype);
```

**`subtype` jest generyczny** (dla każdej kategorii, gdzie ma sens) i wypełniany przy analizie —
deterministycznie (gdy da się z danych, jak prefiks kodu Maxlight) lub przez model. Logika opisu
LLM (`describe`/`analyze-page`) jest **adaptacyjna per kategoria** wg `docs/product-description-spec.md`
(rdzeń wspólny + `atrybuty_kategorii`). W wyszukiwaniu `subtype` służy jako dodatkowy sygnał
różnicujący w obrębie kategorii (miękki lub wtórna bramka — do strojenia).

**S3:** `catalogs/<catalogId>/original.pdf` (cały katalog, render „na stronie N" via `#page=N`);
wycinki produktów jak dziś w `products/...`.

**Pipeline (kreator, partiami stron):** upload PDF → `/uploads/presign` → S3 + `POST /catalogs`
(nazwa, producent, domena, sha256, liczba stron) → przeglądarka renderuje partię stron (react-pdf, jak
w `SearchPage`) → `/catalog/analyze-page` per strona → kadrowanie per produkt w przeglądarce → **przegląd
per strona** (edytowalne ramki + karty: nazwa/kategoria/params/opis; checkbox „zapisz/pomiń" domyślnie
zaznaczony; flaga duplikatu) → zapis zbiorczy partii `POST /products`. Status per strona → katalog
domykalny w kilku podejściach.

**Kluczowa obserwacja:** `SearchPage` już renderuje strony PDF do PNG w przeglądarce → **nie wnosimy
bibliotek PDF do Lambdy w Pythonie**. Lambdy robią to, co już umieją (vision, Titan, Sonnet, zapis).

**Ścieżka offline (duże katalogi, oszczędność Bedrock) — zrealizowana dla Maxlight 2026:**
Zamiast analizy LLM w chmurze, katalog przetwarzany **lokalnie** (bez kosztów AWS/Bedrock) — analiza
w ramach subskrypcji Claude Code. `scripts/extract-maxlight.py` (pymupdf, deterministyczny, re-runnable):
PDF → `rawdata/maxlight/products.raw.json` + `rawdata/maxlight/images/`. Wynik: **243 produkty, 750
zdjęć** (cutout + render aranżacyjny per produkt). Twarde dane z warstwy tekstu (kod, źródło światła,
`finish`, `material` — dwujęzyczne PL|EN, EN czyste), **podtyp deterministycznie z prefiksu kodu**
(P=wisząca, W=kinkiet, C=plafon, T=stołowa, F=podłogowa, S=reflektor szynowy, H=downlight, M=system
magnetyczny). Atrybuty wizualne (kolor/kształt/styl) — opcjonalne, dorabiane wsadowo (odłożone na v1).
`rawdata/` jest w `.gitignore` → wersjonujemy **skrypt** (rawdata odtwarzalne z PDF), zdjęcia trafiają
do S3 przy seedzie. Załadowanie: `scripts/seed-maxlight.mjs` (po migracji 004; koszt = tylko Titan).

**Kroki (z kryteriami weryfikacji):**

**Krok 5.1 — Migracja `004` + taksonomia** — ✅ ZROBIONE
- `backend/migrations/004_catalogs.sql` uruchomiona (`migrate.mjs`). Tabela `catalogs` + kolumny
  `source/category/subtype/manufacturer/manufacturer_code/catalog_id/catalog_page`, `optima_id` nullable,
  indeksy `products_mfr_code_uq` (dedup), `products_category_idx`, `products_subtype_idx`, `products_catalog_idx`.
- Baza wyczyszczona z danych testowych BRW (0 produktów) — czysty start pod realne katalogi.
- ✅ Weryfikacja: schemat potwierdzony zapytaniem do `information_schema` (catalogs=jest, 7 kolumn, optima_id nullable).

**Krok 5.2 — Backend `/catalogs` (CRUD) + `/catalog/analyze-page` (Haiku 4.5 vision)**
- `/analyze-page`: obraz strony + tekst warstwy PDF → `{nazwa, kategoria, subtype, box 0-1, params, opis, kod}[]` (kotwica: domena katalogu). Prompt **adaptacyjny per kategoria** (spec).
- ✅ Weryfikacja: strona testowa → poprawna lista produktów z kategorią, subtype i boxami.

**Krok 5.3 — `/products` rozszerzony + dedup** — ✅ ZROBIONE (wdrożone)
- `backend/lambdas/products/handler.py`: nowe pola `category, subtype, source, manufacturer, manufacturerCode,
  catalogId, catalogPage`; `images:[{key,attributes?,sortOrder?}]` (wstecz: `imageKeys[]`); przełącznik
  `describe:false` (seed katalogu nie płaci za Sonnet — atrybuty odłożone na v1). **Ten sam kanoniczny
  endpoint** dla seeda offline i przyszłego importu z UI (zero duplikacji logiki embeddingu).
- Dedup: twardy unikat `(manufacturer, manufacturer_code)` → przy kolizji `{duplicate:true, skipped:true}`.
  (Miękka flaga cosine >~0.97 — do dołożenia przy imporcie z UI, Krok 5.5.)
- ✅ Weryfikacja: seed testowy (3 produkty) zapisał komplet pól + 13 embeddingów; ścieżka insert OK.

**Krok 5.4 — `/search`: twarda bramka kategorii + odniesienie do źródła** — ✅ ZROBIONE (wdrożone)
- `backend/lambdas/search/handler.py`: opis wycinka (Sonnet, schemat adaptacyjny) → `kategoria` (+ normalizacja
  slugów) → `WHERE p.category = :cat` PRZED retrieve/rerank. Wynik: `source, category` oraz dla katalogu
  `catalogUrl` (presigned PDF, do `#page=N`), `catalogPage`, `manufacturer`, `catalogName`. `queryCategory` w odpowiedzi.
- ✅ Weryfikacja: zapytanie „lampa" → 3 lampy Maxlight z linkiem do katalogu (str. 24–26); „krzesło" →
  `queryCategory=krzeslo`, **0 wyników** (bramka wyklucza lampy). Rdzeń bramki udowodniony.

**Krok 5.2 — `/catalogs` (CRUD) + `/catalog/analyze-page`** — ⏸️ ODŁOŻONE do etapu UI (Krok 5.5).
- Seed offline zakłada wiersz `catalogs` bezpośrednim INSERT-em (trywialny, bez logiki do zduplikowania).
  Pełny CRUD `/catalogs` + `/analyze-page` (Haiku vision) zrobimy przy interaktywnym imporcie z przeglądarki.

**Krok 5.5 — Frontend `CatalogImportPage` (kreator + przegląd per strona)**
- ✅ Weryfikacja: import partii end-to-end, wybór które produkty, obsługa duplikatów.

**Krok 5.6 — Wyniki wyszukiwania + lista/usuwanie katalogów**
- `ResultCard`: ID Optima (kopiuj) **lub** „Katalog: <nazwa>, str. N" + „Otwórz katalog".
- ✅ Weryfikacja: odniesienie do katalogu widoczne i klikalne.

**Krok 5.7 — Test end-to-end na wielokategoryjnym katalogu**
- ✅ Weryfikacja: brak wyników cross-kategorii; dedup działa.

**Krok 5.8 — Seed Maxlight (ścieżka offline) → S3 + DB** — ✅ ZROBIONE
- `scripts/seed-maxlight.mjs`: czyta `products.raw.json` + zdjęcia → `catalogs` (1 wiersz, PDF w S3
  pod `catalogs/maxlight_2026/original.pdf`) → hurtowy upload zdjęć (`products/maxlight/`) → per produkt
  `POST /products` (`describe:false`, source='catalog', category='oswietlenie', subtype, manufacturer,
  manufacturerCode, catalogId, catalogPage) → embedding Titan + `product_images`. `SKIP_UPLOAD` do re-runów.
- ✅ Weryfikacja: **243 produkty, 750 zdjęć — wszystkie z embeddingiem**, 0 błędów/duplikatów. Wyszukiwanie
  cutoutu AKIKO → AKIKO #1 (100%) + podobne lampy, każda z linkiem do katalogu i numerem strony.

**Krok 5.6 — Wyniki + lista/usuwanie katalogów** — 🟡 CZĘŚCIOWO
- ✅ `ResultCard` (frontend): produkt z Optimy → ID + kopiuj; z katalogu → producent + kody + „📄 Katalog,
  str. N" (link do presigned PDF z `#page=N`). Typ `SearchResult` rozszerzony. `tsc --noEmit` czysty.
- ⏳ Lista katalogów + usuwanie w UI (CatalogPage) — do zrobienia razem z Krokiem 5.2/5.5 (UI importu).

### Faza 6 — Katalog (przegląd/edycja) + wyjaśnialność wyszukiwania

**Cel:** operacyjny widok katalogu (szukanie, podgląd pełnych danych, edycja) oraz wyjaśnialność
wyników wyszukiwania (dlaczego dany produkt jest najbardziej podobny) do celów analitycznych.

**Analiza stanu (dlaczego tak):**
- `GET /products` (`_list`) kluczuje po `optima_id`, który dla produktów katalogowych jest `NULL` →
  `CatalogPage` (klucz React + „Usuń" po `optimaId`) jest niespójny. **Prerekwizyt: tożsamość po `id` (UUID).**
- `_list` zwraca skrót (bez opisu/atrybutów/wszystkich zdjęć) → podgląd wymaga `GET /products/{id}`.
- Brak endpointu edycji → potrzebny `PUT /products/{id}` (bez zmiany embeddingu — edycja metadanych).
- `/search` już liczy rerank z `uzasadnienie` (Sonnet) i trzyma `visualSimilarity` (cosinus) →
  „dlaczego podobne" = wystawienie tego + per-kandydat `powod` + porównanie cech (subtype/materiał/finish
  z `params` oraz atrybutów zapytania). Uwaga: produkty Maxlight mają `attributes=NULL` (opis wizualny
  odłożony), więc porównanie opiera się na `params` (twarde dane) + cosinus + ocena/uzasadnienie rerankingu.
- Katalog ~287 pozycji → **filtr po stronie klienta** wystarcza (ścieżka do server-side search później).

**Krok 6.0 — Tożsamość produktu po UUID (prerekwizyt)** — ✅ ZROBIONE (wdrożone)
- `_list` zwraca `id` (UUID) + `source, category, subtype, manufacturerCode`. Route `/products/{optimaId}`
  (nazwa zmiennej zachowana — rename na `{id}` konfliktuje w API GW) obsługuje teraz GET/PUT/DELETE po UUID;
  handler czyta `id`/`optimaId` zamiennie. Front kluczuje/usuwa po `id`.
- ✅ Weryfikacja: lista zwraca `id`; produkty Maxlight (bez `optima_id`) wyświetlają się i usuwają.

**Krok 6.1 — `GET /products/{id}` (szczegóły)** — ✅ ZROBIONE (wdrożone)
- Pełny produkt: `params`, `category`, `subtype`, `source`, `manufacturer`, odniesienie do katalogu
  (nazwa, `catalog_page`, presigned PDF), lista zdjęć (presigned) + `attributes` per zdjęcie.
- ✅ Weryfikacja: TRIAC → 3 zdjęcia + katalog (str. 339); pełne dane.

**Krok 6.2 — `PUT /products/{id}` (edycja)** — ✅ ZROBIONE (wdrożone)
- Aktualizacja metadanych: `name, optimaId, category, subtype, params (JSON), sourceUrl, manufacturer, manufacturerCode`.
  Nie rusza embeddingu/zdjęć. Kolizja unikatu `(manufacturer, manufacturer_code)` → 409.
- ✅ Weryfikacja: edycja `subtype` zapisała się i po przywróceniu wróciła; test przez API.

**Krok 6.3 — `CatalogPage`: szukanie + filtry + podgląd + edycja** — ✅ ZROBIONE (front)
- Pole szukania (nazwa/kod/ID Optima/subtype) — filtr klienta; dropdowny `category`/`subtype`.
- Klik w kartę → modal: zdjęcia, pełne `params`, odniesienie do katalogu; tryb edycji (formularz + params JSON → `PUT`).
- `tsc --noEmit` czysty. ⏳ Do potwierdzenia klikalnie w aplikacji przez użytkownika.

**Krok 6.4 — `/search`: „wczytaj kolejne"**
- `topK` sterowany z frontu; przycisk „Wczytaj kolejne N" zwiększa `topK` (i `recallK`) i ponawia zapytanie
  (wycinek trzymany w pamięci — bez ponownego kadrowania). Koszt: dodatkowy embedding + rerank przy dociąganiu.
- ✅ Weryfikacja: po wyszukaniu można dociągnąć kolejne propozycje (np. 3 → 6 → 9).

**Krok 6.5 — `/search`: wyjaśnialność dopasowania (analityka)**
- Backend: rerank zwraca per-kandydat krótki `powod`; odpowiedź zawiera `queryAttributes`
  (kategoria/kolor/materiał/styl wykryte na wycinku) oraz per-wynik: `visualSimilarity` (cosinus),
  `rerankScore` (0-100), `reason`, `attributes`/`params` kandydata.
- Front: przy wyniku przycisk „Dlaczego podobne?" → panel: cosinus %, ocena rerank %, zgodne cechy
  (kategoria/subtype/materiał/finish: zapytanie vs kandydat), zdanie uzasadnienia modelu.
- ✅ Weryfikacja: klik pokazuje spójne metryki i uzasadnienie zgodne z kolejnością wyników.

### Faza 7 — Role: panel handlowca (user) i panel admina

**Cel:** rozdzielić aplikację na dwa obszary dopasowane do odbiorcy — **panel handlowca** (codzienna praca:
znajdowanie substytutów, katalog) i **panel admina** (zarządzanie danymi + dokumentacja techniczna
administracji rozwiązaniem + statystyki).

**Analiza stanu (dlaczego tak):**
- Dziś `App.tsx` to nawigacja na `useState` z 3 zakładkami (Wyszukiwanie/Katalog/Zasilanie) **bez ról**;
  operacje destrukcyjne (usuwanie) są dostępne dla każdego.
- **Rozdział ról to również kwestia bezpieczeństwa API.** Endpointy `POST/PUT/DELETE /products`, `/catalogs`
  są otwarte — samo ukrycie w UI nie chroni danych. Dlatego: teraz **separacja UX** (dwa layouty) + opcjonalny
  prosty gate admina (hasło z konfiguracji), a **twarde zabezpieczenie = Cognito + authorizer** (Krok 7.4).
- Dokumentacja techniczna powinna być **wersjonowana** (`docs/admin-runbook.md`) i renderowana w panelu
  (react-markdown), nie wpisana na sztywno w komponent.
- Nawigacja ról uzasadnia wprowadzenie `react-router` (obecnie brak).

**Krok 7.0 — Architektura ról + nawigacja**
- Rozdział na **Panel handlowca** (domyślny) i **Panel admina**; routing (`react-router`) + layout per obszar.
  Interim gate admina (hasło z `VITE_*`/konfiguracji) z wyraźną adnotacją: to porządek UX, **nie** zabezpieczenie API.
- ✅ Weryfikacja: dwa obszary działają; handlowiec nie widzi narzędzi admina; gate admina wymaga hasła (interim).

**Krok 7.1 — Panel handlowca (user)**
- Skupiony na pracy: **Wyszukiwanie substytutów** (PDF/obraz → kadr → wyniki z ID Optima / odniesieniem do
  katalogu, „wczytaj kolejne" i „dlaczego podobne" z Fazy 6), **przeglądanie/szukanie katalogu** w trybie
  read-only (podgląd, kopiuj ID, link do katalogu), **doprecyzowanie** (Faza 3). Brak funkcji destrukcyjnych.
- (Opc.) „schowek" produktów do oferty dla klienta + historia ostatnich wyszukiwań (lokalnie, `localStorage`).
- ✅ Weryfikacja: handlowiec wykonuje pełny flow bez dostępu do edycji/usuwania/importu.

**Krok 7.2 — Panel admina (zarządzanie danymi)**
- Narzędzia: zasilanie pojedyncze (`IngestPage`), import katalogu PDF (UI Fazy 5), zarządzanie katalogami
  (lista/usuń), edycja/usuwanie produktów (Faza 6), **statystyki** (liczba produktów/katalogów/zdjęć,
  rozkład `category`/`subtype`, produkty bez embeddingu/opisu).
- ✅ Weryfikacja: admin zarządza danymi; operacje destrukcyjne dostępne wyłącznie tutaj.

**Krok 7.3 — Dokumentacja techniczna administracji (w panelu admina)**
- Widok renderujący `docs/admin-runbook.md`: architektura i zasoby AWS (RDS+pgvector, S3, Lambda, API GW,
  Bedrock — modele + ID), procedury (migracje `migrate.mjs`; ekstrakcja/seed katalogu `extract-maxlight.py`
  + `seed-maxlight.mjs`; deploy `cdk deploy`; czyszczenie/odtworzenie bazy `db-clear.mjs`), koszty/budżet,
  bezpieczeństwo (SSL, Secrets Manager, presigned S3), gotchas i troubleshooting. Jedno źródło prawdy, wersjonowane.
- ✅ Weryfikacja: admin widzi aktualny runbook w aplikacji; treść zgodna z repo.

**Krok 7.4 — (Bezpieczeństwo) Uwierzytelnianie i autoryzacja API — Cognito**
- Docelowo: Cognito user pool + role (`admin`/`handlowiec`), authorizer na HTTP API; endpointy
  `POST/PUT/DELETE /products`, `/catalogs`, import — tylko `admin`; wyszukiwanie/katalog — zalogowany user.
  Do czasu wdrożenia interim gate (7.0) jest wyłącznie UX.
- ✅ Weryfikacja: bez ważnego tokena/roli API odrzuca operacje admina (401/403).

**Krok 7.5 — Import/eksport kolekcji produktów/katalogów (panel admina)**
- **Zasada (zablokowana decyzja):** kolekcje **powstają lokalnie** (bez vision na Bedrock). Panel admina
  służy do **wgrywania** gotowych kolekcji i ich **eksportu** (backup / transfer / re-import po czyszczeniu bazy).
- **Eksport:** `GET /catalogs/{id}/export` → pakiet (JSON): metadane katalogu + produkty (`params`, `category`,
  `subtype`, `manufacturerCode`, `optimaId`, `attributes`) **oraz embeddingi per zdjęcie** i klucze/URL zdjęć.
  Opcjonalnie zip z obrazami (pełna przenośność). Embedding w eksporcie → **re-import bez Bedrock**.
- **Import:** admin wgrywa pakiet → obrazy do S3 → zapis przez kanoniczny `/products` z **gotowym embeddingiem**
  (bez Titana) i `describe:false` (bez vision) → **zero wywołań Bedrock**. Dedup po `(manufacturer, manufacturer_code)`.
- **Rozszerzenie `/products`:** opcjonalne `embedding` per zdjęcie (`images:[{key, embedding?, attributes?, sortOrder?}]`)
  — gdy podane, pomija Titan. Bez zmian dla dotychczasowych wywołań.
- Format pakietu spójny z `rawdata/<kolekcja>/` (ekstraktory lokalne produkują od razu importowalny pakiet).
- ✅ Weryfikacja: eksport kolekcji → wyczyszczenie bazy → import → identyczna liczba produktów i embeddingów,
  **0 wywołań Bedrock** przy imporcie; wyszukiwanie działa jak przed czyszczeniem.

---

## H. Szacunek kosztów (rząd wielkości)

- Bedrock Haiku 4.5: ekstrakcja ~0,01 zł/produkt (30 sof ≈ 0,30 zł).
- Bedrock Sonnet 5: analiza wizualizacji ~0,01–0,03 zł/wyszukiwanie.
- Titan embeddingi: grosze. · S3/Lambda/API GW: Free Tier / grosze przy niskim ruchu.
- RDS `db.t3.micro`: Free Tier 12 mies., potem ~kilkanaście–kilkadziesiąt zł/mies. (24/7, nie serverless).
- **Realny koszt MVP: kilka–kilkanaście zł/mies.** Zawsze aktywny alert budżetowy.

---

## I. Ryzyka i mitigacje

| Ryzyko | Mitigacja |
|---|---|
| Pusta baza = brak wyników | Faza 1 przed Fazą 2; Krok 1.6 zasila realnymi danymi. |
| Agata renderuje treść w JS / anty-bot | Headless (Playwright), rate limit, respekt `robots.txt`. |
| Sofa z PDF pozytywnego nie jest w seed-secie | Skoordynować: sofa z PDF musi być w ~20–30 zasilonych (Krok 1.6). |
| Trafność wyszukiwania nieznana | Krok 2.5 + Krok 4.3 (zestaw ewaluacyjny). |
| Twarde filtry wykluczają dobre alternatywy | Podobieństwo wizualne = sygnał główny; filtry miękkie/opcjonalne (sekcja E). |
| Lambda + RDS: wyczerpanie połączeń | RDS Proxy w razie potrzeby. |
| Koszt Bedrock rośnie | Budżet + alerty; Haiku domyślnie, Sonnet tylko przy obrazie. |

---

## J. Iteracja 2+ (po MVP)
- Auto-detekcja obiektów (kandydat: Claude vision, nie Rekognition). ✅ zrobione (Faza 2b).
- Realna integracja z Comarch ERP Optima (API/konektor).
- Masowy import produktów z katalogów PDF (Faza 5) — Batch API (50% taniej) jako dalsza optymalizacja.
- Uwierzytelnianie (Cognito) i role — rozpisane jako Faza 7 (panel handlowca/admin + Krok 7.4 hardening API).
