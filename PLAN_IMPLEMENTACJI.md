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
| **Waga dopasowania: kształt > kolor** ✅ (od Fazy 8) | Rerank przeważony: **bryła/kształt/proporcje/konstrukcja + opis wizualny = główne**, kolor/materiał = drugorzędne | Ten sam produkt bywa w wielu kolorach/tkaninach/wykończeniach (warianty) — kolor jako główny sygnał zaniżał trafność. Różnica koloru nie obniża mocno oceny przy zgodnej bryle. Uwaga: retrieve (Titan) jest czuły na kolor → większy `recallK` (12), by warianty docierały do reranku. |
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
3. **Rerank (Sonnet 4.5 jako sędzia):** na wejściu obraz zapytania + jego atrybuty + obrazy, atrybuty
   i **specyfikacje** kandydatów (wszystkie zdjęcia). Model **ocenia dopasowanie 0-100** per kandydat i zwraca ranking.
   **Waga (od Fazy 8, zmiana):** decydują **BRYŁA, KSZTAŁT, PROPORCJE, KONSTRUKCJA i typ + opis wizualny**;
   **KOLOR i MATERIAŁ są DRUGORZĘDNE** (ten sam produkt bywa w wielu kolorach/tkaninach — różnica koloru NIE
   obniża mocno oceny przy zgodnej bryle). Odrzucani tylko kandydaci o wyraźnie innej bryle/kształcie lub typie;
   niedowartościowanie samej wielkości i tła renderu. Specyfikacja (moc/barwa/IP/kąt…) — sygnał pomocniczy.
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
| `POST` | `/catalogs` | (Faza 7) Utworzenie katalogu (import z panelu admina zwraca `catalogId`). |
| `GET` | `/catalogs` | (Faza 7) Lista katalogów (nazwa, producent, liczba produktów). |
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

**Krok 6.4 — `/search`: „wczytaj kolejne"** — ✅ ZROBIONE (wdrożone)
- `topK` sterowany z frontu; przycisk „Wczytaj kolejne" ponawia zapytanie z większym `topK` (wycinek w `useRef`,
  bez ponownego kadrowania); `recall_k` rośnie z `topK` (więcej kandydatów do rerankingu).
- ✅ Weryfikacja: po wyszukaniu można dociągnąć kolejne propozycje.

**Krok 6.5 — `/search`: wyjaśnialność dopasowania (analityka)** — ✅ ZROBIONE (wdrożone)
- Backend: rerank zwraca per-kandydat `powod`; odpowiedź zawiera `queryAttributes` oraz per-wynik
  `visualSimilarity` (cosinus), `rerankScore` (0-100), `reason`, `attributes` kandydata.
- Front: przycisk „Dlaczego podobne?" → panel: ocena rerank %, cosinus %, uzasadnienie modelu + tabela
  zgodności cech (kategoria/subtype/materiał/kolor/styl; zielony = zgodność).
- ✅ Weryfikacja: EMPIRE → #1 rerank 95 / cos 100% z powodem „Identyczna kompozycja…"; odrzucone z powodem
  różnicy formy. `tsc` czysty.

> 🎉 **Faza 6 ukończona** (katalog: przegląd/edycja + wyszukiwanie: wczytaj kolejne + wyjaśnialność).

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

**Krok 7.0 — Architektura ról + nawigacja** — ✅ ZROBIONE
- `App.tsx`: dwa obszary — **Panel handlowca** (domyślny) i **Panel admina** (nawigacja na stanie; `react-router`
  odłożony jako zbędny na tym etapie). Interim gate admina (`VITE_ADMIN_PASSWORD`; brak → tryb dev) z adnotacją,
  że to UX, **nie** zabezpieczenie API.
- ✅ Weryfikacja: przełączanie obszarów działa; handlowiec nie widzi narzędzi admina; gate wymaga hasła (interim).

**Krok 7.1 — Panel handlowca (user)** — ✅ ZROBIONE
- Zakładki: **Wyszukiwanie** (z „wczytaj kolejne"/„dlaczego podobne" z Fazy 6) + **Katalog** w trybie
  read-only (`CatalogPage admin={false}` — bez usuwania/edycji; podgląd, szukanie, link do katalogu).
- (Opc. na później) schowek ofertowy + historia — nie zrobione.
- ✅ Weryfikacja: handlowiec ma pełny flow bez funkcji destrukcyjnych. `tsc`/`vite build` czyste.

**Krok 7.2 — Panel admina (zarządzanie danymi)** — 🟡 CZĘŚCIOWO
- ✅ Zakładki: **Katalog** (`admin` — edycja/usuwanie), **Zasilanie** (`IngestPage`), **Statystyki**
  (`StatsPage`: produkty/zdjęcia/kategorie/z ID Optima + rozkłady kategoria/podtyp/źródło), **Dokumentacja**.
- ✅ **Import kolekcji** (zakładka, `ImportPage`) — patrz Krok 7.5. ⏳ Zarządzanie katalogami w UI (lista/usuń) — do zrobienia.

**Krok 7.3 — Dokumentacja techniczna administracji (w panelu admina)** — ✅ ZROBIONE
- `docs/admin-runbook.md` (architektura, zasoby AWS, procedury migracji/ekstrakcji/seedu/deployu/czyszczenia,
  zasada „kolekcje lokalnie", bezpieczeństwo, gotchas, koszty) renderowany w zakładce Dokumentacja
  (`MarkdownLite`, import `?raw` z repo root — `vite fs.allow: ['..']`). Jedno źródło prawdy.
- ✅ Weryfikacja: runbook renderuje się w aplikacji (build przechodzi z importem z `docs/`).

**Krok 7.4 — (Bezpieczeństwo) Uwierzytelnianie i autoryzacja API — Cognito** — ✅ ZROBIONE (wdrożone)
- CDK: Cognito User Pool + client publiczny (USER_PASSWORD_AUTH) + grupy `admin`/`handlowiec`; `HttpJwtAuthorizer`
  na HTTP API. **Chronione (token + grupa `admin`):** `POST/DELETE /products`, `PUT/DELETE /products/{id}`,
  `POST /catalogs`, `POST /uploads/presign`. GET-y i `/search` publiczne (zgodnie z decyzją „tylko operacje admina").
- Lambda (`products`, `presign`): sprawdza `cognito:groups` z claims → operacje mutujące tylko dla `admin` (inaczej 403).
- Front: `lib/auth.ts` (login USER_PASSWORD_AUTH, sesja w `localStorage`, grupa z ID tokena), `App.tsx` — logowanie
  do panelu admina + `setAuthToken` dołączany do wywołań admina. `VITE_COGNITO_CLIENT_ID`/`_REGION` w `.env`.
- ✅ Weryfikacja: `POST /catalogs` bez tokena → **401**, z tokenem admina → **200**, `GET /catalogs` → **200**.
  Zarządzanie użytkownikami: `docs/admin-runbook.md`. (Utworzony testowy `admin`.)
- ⏳ Do rozważenia: challenge zmiany hasła w UI, ochrona `GET /catalogs/{id}/export`, zawężenie CORS do domeny.

> 🎉 **Faza 7 ukończona** (role handlowiec/admin, statystyki, dokumentacja, import/eksport kolekcji, onboarding, Cognito).

**Krok 7.5 — Import/eksport kolekcji produktów/katalogów (panel admina)** — 🟡 ZROBIONE (backend wdrożony + UI; pełny round-trip do potwierdzenia klikalnie)
- **Zasada (zablokowana decyzja):** kolekcje **powstają lokalnie** (bez vision na Bedrock). Panel admina
  służy do **wgrywania** gotowych kolekcji i ich **eksportu** (backup / transfer / re-import po czyszczeniu bazy).
- **Format paczki `collection.json`** (jedno źródło dla importu i eksportu):
  `{ catalog:{name,manufacturer,domainCategory,pdfKey?,pageCount}, products:[{ name, optimaId?, category, subtype,
  manufacturer, manufacturerCode, params, images:[{file, role, attributes?, embedding?}] }] }`.
  Świeży katalog (z ekstrakcji lokalnej): bez `embedding` (Titan przy imporcie). Eksport: z `embedding` (re-import bez Bedrock).
- **Import w przeglądarce (panel admina):** wybór folderu paczki `<input webkitdirectory>` (bez nowych zależności)
  → parse `collection.json` → `POST /catalogs` (utworzenie) → per produkt: presign + upload zdjęć do S3 →
  `POST /products` (`describe:false`; gdy paczka ma `embedding` → pomija Titan, inaczej Titan liczy raz). Pasek
  postępu + obsługa duplikatów (dedup po kodzie). PDF (duży) wgrywa **skrypt lokalny** (aws cli), nie przeglądarka.
- **Eksport:** `GET /catalogs/{id}/export` → `collection.json` z embeddingami + zdjęcia (klucze/URL lub zip).
- **Nowe/rozszerzone endpointy:** `POST /catalogs` (create), `GET /catalogs` (lista), `GET /catalogs/{id}/export`;
  `/products` — opcjonalne `embedding` per zdjęcie (`images:[{key, embedding?, attributes?, sortOrder?}]`, pomija Titan).
- ✅ Zrobione: `POST/GET /catalogs`, `GET /catalogs/{id}/export` (paczka do S3 + presigned URL — omija limit 6 MB),
  `/products` przyjmuje `embedding` per zdjęcie (pomija Titan). `ImportPage` (folder `webkitdirectory` → `createCatalog`
  → presign+upload → `importProduct`, pasek postępu, log). Backend przetestowany (lista/eksport z embeddingami).
- ⏳ Do potwierdzenia klikalnie: pełny round-trip (import folderu → eksport → wipe → re-import bez Bedrock).

**Krok 7.6 — Onboarding katalogu: skrypt bootstrap + instrukcje dla Claude + gotowość panelu** — ✅ ZROBIONE
- **Cel:** jedną komendą lokalnie przygotować dowolny katalog PDF do importu — skrypt sonduje PDF i **generuje
  zestaw instrukcji dla Claude Code**, żeby ekstrakcja (różna per katalog) nie wymagała szukania „jak to zrobić".
- **`scripts/prepare-catalog.py <pdf> <nazwa> [--manufacturer X] [--category Y]`** (lokalnie, bez AWS/Bedrock):
  tworzy `rawdata/<nazwa>/`, sonduje PDF (liczba stron, rozkładówki, warstwa tekstu + próbka, obrazy osadzone,
  wykrycie indeksu), renderuje kilka próbek stron, zapisuje `PROBE.json` oraz **`CLAUDE_INSTRUCTIONS.md`**
  (dostosowana lista kroków: rozpoznaj układ, skopiuj i dostrój ekstraktor z szablonu, ustal mapowanie
  prefiks-kodu→`subtype`, pola z warstwy tekstu, `category`, uruchom, zweryfikuj, wypisz `collection.json`).
  Na końcu wypisuje: „poproś Claude: »przygotuj katalog <nazwa>«".
- **Szablon ekstraktora:** `extract-maxlight.py` jako wzorzec (parametryzowany/kopiowany per katalog).
- **Instrukcja end-to-end w panelu admina:** sekcja w `docs/admin-runbook.md` (render w zakładce Dokumentacja)
  opisująca cały przepływ: 1) `python scripts/prepare-catalog.py …`, 2) „Claude, przygotuj katalog <nazwa>",
  3) Import w panelu admina (Krok 7.5). Dzięki temu Claude i admin mają całość w jednym miejscu.
- ✅ Zrobione: `scripts/prepare-catalog.py` (sonduje: strony/rozkładówki/warstwa tekstu/prefiksy kodów/indeks/próbki
  → `PROBE.json` + `CLAUDE_INSTRUCTIONS.md` + `samples/`); szablon = `extract-maxlight.py`; instrukcja end-to-end w
  `docs/admin-runbook.md` (render w panelu Dokumentacja). Bootstrap przetestowany na Maxlight.
- ⏳ Do potwierdzenia: pełny onboarding nowego (innego) katalogu end-to-end.

### Faza 8 — Jakość danych v1 (specyfikacje, opisy wizualne, wyszukiwanie wielozdjęciowe, edycja)

**Cel:** żeby przy wyszukiwaniu dostępny był **pełny kontekst produktu** (specyfikacja techniczna + opis wizualny),
wykorzystywany przez LLM wyszukujący; oraz żeby dane te dało się podejrzeć i edytować w panelu admina.

**Analiza stanu (pomiary):** 0/891 zdjęć ma opis wizualny (`attributes`); 51/287 produktów bez żadnej
specyfikacji; format tabeli technicznej (np. `7W 230V 572lm 3000K IP20 35°`) nie był parsowany; rerank
i opis zapytania **nie widzą `params`**; rerank ocenia kandydata tylko na **jednym** (najlepszym) zdjęciu.
Formaty specyfikacji spójne w katalogu: `W` (moc), `lm`, `K` (barwa), `IP`, `°` (kąt), `V` + kolory.

**Krok 8.1 — Ekstraktor: generyczny parser specyfikacji** — ✅ ZROBIONE
- Parser tokenów oświetleniowych: `power_w, voltage_v, lumens, cct_k, cri, ip, beam_deg` + `colors[]`; scala z
  istniejącym `finish/material` (bilingwalny). Zapis do `params.specs`. Re-ekstrakcja Maxlight.
- ✅ Weryfikacja: TRIAC/C0155 → `params.specs` z 7W/572lm/3000K/IP20/35°/230V + kolory; spadek liczby braków.

**Krok 8.2 — Aktualizacja bazy o specyfikacje** — ✅ ZROBIONE (285/287; `update-maxlight-specs.mjs`)
- Skrypt (bezpośrednio DB, bez re-embed): scala `params.specs` do istniejących produktów po `manufacturer_code`.
- ✅ Weryfikacja: liczba produktów bez specyfikacji znacząco spada; embeddingi nietknięte.

**Krok 8.3 — LLM wyszukujący widzi specyfikacje + bogatszy wynik** — ✅ ZROBIONE (wdrożone)
- `/search`: rerank i opis zapytania dostają `params`/`specs` kandydatów w kontekście; **prompt (generyczny)
  zaktualizowany**, że mogą występować dane techniczne (moc, barwa, IP, kąt, kolory) i należy je uwzględniać.
- Wynik `/search` zwraca dodatkowo `subtype`, `id`, pełne `params` (dla karty/analizy).
- ✅ Weryfikacja: w odpowiedzi widać specyfikacje kandydatów; rerank może się nimi kierować.

**Krok 8.4 — Wyszukiwanie wielozdjęciowe (rerank na wszystkich zdjęciach)** — ✅ ZROBIONE (wdrożone)
- Retrieve już rankuje po najlepszym ujęciu z **wszystkich** `product_images`. Rerank dostaje **wszystkie**
  zdjęcia kandydata (limit ~3–4), nie tylko najlepsze. W wyniku pokazywane **jedno** zdjęcie.
- ✅ Weryfikacja: rerank ocenia na komplecie zdjęć; jakość rankingu ≥ dotychczasowej.

**Krok 8.5 — Opisy wizualne (`attributes`) — LOKALNIE** — 📐 ZAPLANOWANE (0/891; konsumpcja w rerank/podglądzie gotowa; mechanizm zapisu: re-seed z `attributes` w `collection.json` LUB endpoint update per zdjęcie)
- Zasada „kolekcje lokalnie": opis wizualny każdego zdjęcia generuję **ja (Claude Code)** czytając zdjęcia
  (bez Bedrock vision), wg `docs/product-description-spec.md`. Zapis do `product_images.attributes`.
- Mechanizm zapisu: endpoint aktualizacji `attributes` per zdjęcie (lub re-import `collection.json` z `attributes`
  — zachowuje embeddingi). Rerank i opis zapytania już z nich korzystają.
- Zakres: 287 produktów × zdjęcia — praca wsadowa (partiami). ✅ Weryfikacja: `attributes` wypełnione;
  rerank cytuje cechy z opisu.

**Krok 8.6 — Podgląd i edycja specyfikacji w katalogu (admin)** — ✅ ZROBIONE (czytelna 'Specyfikacja' + 'Opis wizualny'; edycja przez params JSON w trybie admina)
- `CatalogPage` (modal szczegółów): **czytelny** podgląd specyfikacji + opisu wizualnego; w trybie admina
  edycja tych pól (obok edycji `params` JSON). Kontekst: pojedynczy podglądany produkt.
- ✅ Weryfikacja: admin widzi i edytuje specyfikacje/opis pojedynczego produktu; zmiana zapisuje się (`PUT`).

**Krok 8.7 — Tryb diagnostyczny wyszukiwania (admin, tymczasowy)** — ✅ ZROBIONE
- `SearchPage`: gdy zalogowany admin (sesja Cognito) → przełącznik „🔬 Tryb diagnostyczny". Panel pokazuje:
  **obraz zapytania** (wysłany wycinek), **bramkę kategorii**, **opis wycinka przez LLM** (queryAttributes:
  kategoria/subtype/kolor/materiał/styl/opis + pełny JSON) oraz tabelę „co wpłynęło na wynik" per kandydat
  (rerank %, kosinus Titana, powód sędziego). Dane już zwracane przez `/search` — zmiana tylko we froncie.
- ✅ Weryfikacja: admin widzi flow zapytania (opis LLM + wpływ na ranking); niewidoczne dla handlowca.

### Faza 9 — UX katalogu (podgląd, szybkie otwieranie) + grupowanie wariantów

**Krok 9.0 — Powiększanie zdjęć (lightbox) w podglądzie produktu** — ✅ ZROBIONE
- `CatalogPage`: klik w miniaturę → overlay z powiększeniem (klik zamyka). Bez backendu.

**Krok 9.1 — Szybkie otwieranie strony katalogu (bez pobierania 200 MB)** — ✅ ZROBIONE
- Problem: presigned URL do całego PDF zmienia się co klik → brak cache → 200 MB za każdym razem.
- Rozwiązanie (darmowe): `scripts/render-catalog-pages.py` renderuje strony do JPEG (~200–500 KB), wgrywane do
  `s3://…/catalogs/<folder>/pages/pN.jpg`. `/search` i `GET /products/{id}` zwracają `catalogPageImageUrl`
  (presigned obraz strony). Front otwiera **obraz strony** (ta sama nazwana karta), a „(cały PDF)" jako drugorzędny.
- Koszt: render lokalny 0 zł; S3 ~100 MB → grosze. ✅ Weryfikacja: 343 strony w S3; wynik otwiera lekki obraz.

**Krok 9.2 — Grupowanie wariantów produktu (group_id)** — ✅ ZROBIONE
- Migracja `005_group_id.sql` (`products.group_id` + indeks). Klucz grupy (heurystyka, edytowalna):
  `slug(name)-subtype-{moc}w-{lm}lm` → warianty tego samego modelu w różnych wykończeniach/kolorach.
  Ekstraktor (`extract-maxlight.py`) + aktualizacja istniejących (SQL). `/products`, `/search` zwracają `groupId`;
  `group_id` w polach edytowalnych (`PUT`) + eksporcie.
- Front: `SearchPage` i `CatalogPage` **zwijają warianty w jedną kartę** (badge „N wariantów" + kody);
  admin może poprawić `group_id` w edycji produktu.
- **Łączenie w GUI (admin):** (a) przeciągnięcie kafelka na inny **scala grupy**; (b) **zaznaczenie checkboxami
  wielu** kafelków + „Połącz zaznaczone w grupę"; „Odłącz od grupy" w podglądzie produktu. PUT `group_id`, bez zmian backendu.
- Koszt: 0 zł Bedrock (logika lokalna/DB). ✅ Weryfikacja: EMPIRE P0634D+P0635D (chrom+złoto, 121 W) →
  jedna grupa; P0636D (17 W) osobno; TRIAC nieprzemerdżony.

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
