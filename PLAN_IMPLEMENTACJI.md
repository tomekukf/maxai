# Plan działania i implementacji — Asystent Sprzedaży (MVP)

> Dokument roboczy dla PoC/MVP integracji wizualizacji architektonicznych z asortymentem (ID Optima).
> Bazuje na `max_ai_concept.txt.txt` po review technicznym.
> **Cel nadrzędny: działające MVP przy minimalnych kosztach.**
> **Zasada pracy:** realizujemy jeden krok, weryfikujemy kryterium, dopiero potem następny.

---

## A. Decyzje architektoniczne (zablokowane)

| Decyzja | Wybór | Uzasadnienie |
|---|---|---|
| Detekcja obiektów | **Ścieżka A — bez Rekognition** | Ręczne kadrowanie (`react-image-crop`) + Claude vision. Prostszy pipeline, koszt tylko za realne wyszukiwania. Auto-detekcja → iteracja 2. |
| Model ekstrakcji/NLP | **Claude Haiku 4.5** — `eu.anthropic.claude-haiku-4-5-20251001-v1:0` ✅ | Tani, szybki, multimodalny. Ekstrakcja parametrów + „dopytywanie". |
| Model analizy wizualizacji | **Claude Sonnet 5** — `eu.anthropic.claude-sonnet-5` ⏸️ | Opcjonalny (Krok 3.2). Dostęp do włączenia w konsoli. |
| Embeddingi (model) | **Titan Multimodal** — `amazon.titan-embed-image-v1` ✅ | Wektor 1024. |
| Embeddingi | **Amazon Titan Multimodal** (1024 wym.) | Wektor obraz+tekst w jednej przestrzeni. |
| Baza wektorowa | **RDS PostgreSQL + pgvector** | Sprawdzone, wystarczające dla MVP. |
| Backend | **Python** (Lambda 3.12) | Najlepszy ekosystem AI/obraz/PDF. |
| IaC | **AWS CDK (TypeScript)** | Kod w `infra/`. Node 22 pewne; Lambdy w Pythonie z runtime `python3.13` (lokalny Python 3.14 jest za nowy dla Lambdy). |
| Zasilanie danymi | **Publiczne dane (Agata Meble, ~20–30 sof)**, ID `AGATA-<kod>` | Brak dostępu do Optimy klienta. |
| Wizualizacje testowe | **Dostarcza użytkownik (2 PDF-y)** | Patrz sekcja D. Fallback: kompozycja realnych zdjęć. |

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

1. **PDF „test pozytywny"** — salon z sofą, która **JEST** w zasilonej bazie (jedna z ~20–30 sof Agaty).
   - Sofa na wizualizacji powinna **wizualnie odpowiadać** zdjęciu produktu w bazie (podobny model/kąt),
     żeby podobieństwo wektorowe było wysokie. Ustalimy wspólnie, którą sofę z seed-setu użyć.
2. **PDF „test alternatywny"** — salon z sofą **innego producenta**, której **NIE MA** w bazie.
   - Sprawdza kluczowe założenie: system zwraca **maksymalnie podobne wizualnie** sofy z naszego
     asortymentu (substytuty do zaoferowania), a nie „brak wyniku". Sofa **NIE musi** być w seed-secie.

> Jeśli wolisz, żebym to ja przygotował wizualizacje — fallback: wklejenie realnego zdjęcia produktu
> w stockowy render salonu i eksport do PDF. Daj znać, zmienimy ten punkt.

---

## E. Model danych (PostgreSQL + pgvector)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE products (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    optima_id    TEXT NOT NULL,          -- syntetyczne: AGATA-<kod>
    name         TEXT,
    params       JSONB,                  -- {wymiary, kolor, styl, materiał, cena, kod, ...}
    image_s3_url TEXT NOT NULL,
    source_url   TEXT,                    -- link do strony produktu (pomocniczo)
    embedding    vector(1024),           -- Titan Multimodal
    created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON products USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX ON products USING gin (params);
```

Zapytanie: **głównym sygnałem jest podobieństwo wizualne** (`embedding <=> $1`, kosinus) — szukamy
substytutów, nie exact-match. Filtry po `params` (materiał, wymiary, cena) są **opcjonalne/miękkie**
(włączane przez sprzedawcę lub jako re-ranking), NIE twarde `WHERE` domyślnie — inaczej wykluczylibyśmy
dobre alternatywy.

---

## F. Endpointy API (MVP)

| Metoda | Ścieżka | Opis |
|---|---|---|
| `POST` | `/uploads/presign` | Presigned URL do wgrania pliku na S3. |
| `POST` | `/extract` | Surowy opis → JSON parametrów (Haiku 4.5), podgląd przed zapisem. |
| `POST` | `/products` | Opis + ID Optima + klucz S3 → ekstrakcja + embedding (Titan) → zapis atomowy. |
| `POST` | `/search` | Wycinek + tekst/filtry → embedding + pgvector → TOP 3. |

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

**Krok 1.2 — S3 + presigned upload**
- Działania: bucket, Lambda `/uploads/presign`.
- ✅ Weryfikacja: wgranie pliku przez presigned URL kończy się sukcesem, plik w S3.

**Krok 1.3 — Lambda `/extract` (Haiku 4.5)**
- Działania: opis → JSON parametrów (wymiary, kolor, styl, materiał).
- ✅ Weryfikacja: przykładowy surowy opis zwraca poprawnie ustrukturyzowany JSON.

**Krok 1.4 — Lambda `/products` (Titan + zapis)**
- Działania: embedding głównego zdjęcia (Titan) + zapis atomowy wiersza.
- ✅ Weryfikacja: dodanie produktu → wiersz w bazie z niepustym wektorem i parametrami.

**Krok 1.5 — Panel `IngestPage`**
- Działania: formularz (upload zdjęć, opis, ID Optima), integracja z API.
- ✅ Weryfikacja: dodanie produktu przez UI działa end-to-end.

**Krok 1.6 — Zasilenie danymi testowymi (Agata Meble)**
- Źródło: `https://www.agatameble.pl/meble/wypoczynkowe/sofy`
- Działania:
  - Skrypt w `scripts/` pobiera ~20–30 sof: nazwa, zdjęcie główne, kod produktu, parametry (wymiary/kolor/materiał/styl jeśli dostępne), cena, URL.
  - ID Optima = `AGATA-<kod_produktu>`.
  - Zdjęcia → S3; parametry z opisu domyka Haiku 4.5 (opisy bywają nieustrukturyzowane); załadowanie przez `/products`.
  - Respektować `robots.txt` i rate limit; jeśli strona renderuje treść w JS — headless (Playwright).
- ✅ Weryfikacja: ~20–30 produktów w bazie z wektorami i parametrami; wśród nich sofa użyta w PDF „test pozytywny".

### Faza 2 — Wyszukiwanie

**Krok 2.1 — `PdfViewer` (react-pdf)**
- ✅ Weryfikacja: wgrany PDF renderuje się w przeglądarce.

**Krok 2.2 — `ImageCropper` (react-image-crop)**
- ✅ Weryfikacja: kadrowanie zwraca poprawny wycinek obrazu.

**Krok 2.3 — Lambda `/search` (Titan + pgvector)**
- Działania: embedding wycinka + zapytanie wektorowe (podobieństwo wizualne = sygnał główny; filtry opcjonalne, nie domyślne).
- ✅ Weryfikacja: wycinek zwraca TOP 3 najbliższych wizualnie produktów z bazy.

**Krok 2.4 — `ResultsList`**
- Działania: 3 propozycje (zdjęcie, parametry, ID Optima do skopiowania).
- ✅ Weryfikacja: wyniki wyświetlają się, ID Optima kopiowalne jednym kliknięciem.

**Krok 2.5 — Test end-to-end na 2 wizualizacjach**
- Wymaga: 2 PDF-y od użytkownika (sekcja D).
- ✅ Weryfikacja:
  - PDF pozytywny (sofa w bazie) → ta sofa w TOP 3 (najlepiej #1).
  - PDF alternatywny (inny producent, spoza bazy) → TOP 3 to sofy z naszego asortymentu **wizualnie najbliższe** oryginałowi (ocena jakościowa: czy realnie da się je zaoferować jako zamiennik).

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
- Auto-detekcja obiektów (kandydat: Claude vision, nie Rekognition).
- Realna integracja z Comarch ERP Optima (API/konektor).
- Masowy import produktów (Batch API — 50% taniej).
- Uwierzytelnianie (Cognito) i role.
