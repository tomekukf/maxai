# CLAUDE.md — maxai

Aktualny kontekst projektu dla Claude Code. Czytaj to na starcie każdej sesji.

## Czym jest projekt
Webowe **MVP asystenta sprzedaży** dla salonu meblowego. Pracownik wgrywa wizualizację
architektoniczną (PDF), kadruje mebel, a system dopasowuje go do asortymentu w bazie
(z ID z systemu Optima). Wyszukiwanie hybrydowe obraz+tekst przez embeddingi w pgvector.

**Kluczowe założenie — wyszukiwarka SUBSTYTUTÓW, nie exact-match:** jeśli produktu z wizualizacji
nie mamy 1:1 (np. sofa innego producenta), system zwraca **maksymalnie podobne wizualnie** produkty
z NASZEGO asortymentu, które można zaoferować zamiast. Zawsze proponujemy najbliższe alternatywy —
nigdy „brak wyniku". Stąd: podobieństwo wizualne to sygnał główny, a filtry po parametrach są
miękkie/opcjonalne (nie twarde `WHERE`), żeby nie wykluczać dobrych zamienników.

## Dokumenty źródłowe
- `PLAN_IMPLEMENTACJI.md` — pełny plan podzielony na kroki (główny dokument roboczy).
- `max_ai_concept.txt.txt` — pierwotna koncepcja (wypracowana z Gemini), po review technicznym.

## Status
🎉 **Faza 0 (fundament) ukończona.** Repo: `github.com/tomekukf/maxai` (branch `main`).
- ✅ Krok 0.1 — repozytorium i struktura (commit `0b98d26`).
- ✅ Krok 0.2 — budżet AWS `maxai-monthly-5usd` ($5, alert-only).
- ✅ Krok 0.3 — modele Bedrock potwierdzone (Haiku 4.5 + Titan; Sonnet 5 odłożony do 3.2).
- ✅ Krok 0.4 — CDK (TypeScript), stack `MaxaiStack` wdrożony; bucket S3 `maxaistack-filesbucket16450113-3fnndonlqpsv`.
- ✅ Krok 1.1 — RDS PostgreSQL 16.14 + pgvector + tabela `products` (RDS publiczny, Lambdy poza VPC). Migracja: `scripts/migrate.mjs`.
- ✅ Krok 1.2 — `/uploads/presign` (Lambda py3.13 + HTTP API). Presigned **path-style** (unika 307/SignatureDoesNotMatch). Test: `scripts/test-presign.mjs`.
- ✅ Krok 1.3 — `/extract` (Haiku 4.5 via Bedrock converse → JSON parametrów). Test: `scripts/test-extract.mjs`.
- ✅ Krok 1.4 — `/products` (zdjęcie→Titan 1024→atomowy INSERT). Sterownik pg8000 vendorowany. Testy: `scripts/test-products.mjs`, `scripts/db-count.mjs`.
- ✅ Krok 1.5 — panel `IngestPage` (React 18 + Vite 5 + TS + Tailwind 3 w `frontend/`). Konwersja obrazu→JPEG w przeglądarce (Titan tylko JPEG/PNG).
- ✅ Krok 1.6 — zasilenie **BRW** (Agata za Cloudflare → pivot). `scrape-brw.mjs` (JSON-LD) + `seed.mjs`. Baza: 28 produktów z embeddingiem.
- 🎉 **Faza 1 ukończona.** ▶️ Następne: **Faza 2 — wyszukiwanie** (`/search`, PDF viewer, cropper, wyniki).

## Gotchas (git bash / AWS)
- `MSYS_NO_PATHCONV=1` przed komendami z argumentami `/aws/...` (np. `aws logs`) — inaczej git bash konwertuje na ścieżkę Windows.
- Env do node przez `export API=...` (nie `API=... && node` — to nie eksportuje).
- Presigned S3: path-style + nie podpisywać Content-Type. Titan: obraz min. sensownego rozmiaru (1×1 = błąd).

## Zablokowane decyzje
- **Detekcja obiektów: ścieżka A — bez Rekognition.** Ręczne kadrowanie (`react-image-crop`)
  + Claude vision. Auto-detekcja → iteracja 2.
- **Modele Bedrock (eu-central-1, inference profile EU — dane w UE):**
  - Ekstrakcja/NLP: Haiku 4.5 → `eu.anthropic.claude-haiku-4-5-20251001-v1:0` ✅
  - Analiza wizualizacji: Sonnet 5 → `eu.anthropic.claude-sonnet-5` ⏸️ (dostęp do włączenia; potrzebny w Kroku 3.2)
  - Embeddingi (1024): `amazon.titan-embed-image-v1` ✅
  - NIE używać Claude 3 Haiku (przestarzały).
- **Embeddingi:** Amazon Titan Multimodal (1024 wym.).
- **Baza:** RDS PostgreSQL + `pgvector`. **Backend:** Lambdy w Pythonie (runtime `python3.13`;
  lokalny Python 3.14 jest za nowy dla Lambdy). **IaC:** AWS CDK w **TypeScript** (kod w `infra/`).
- **Frontend:** React (Vite) + TS + Tailwind + shadcn/ui + `react-pdf` + `react-image-crop`.
- **Hosting/CI:** AWS Amplify (auto-deploy z `main`).

## Priorytety
- Działające MVP przy **minimalnych kosztach**. Ustawić AWS Budgets z alertem.
- Kolejność: **najpierw baza + zasilanie danymi, potem wyszukiwanie** (bez danych nie ma czego szukać).
- Brak dostępu do Optimy klienta → zasilanie **publicznie dostępnymi danymi** (patrz krok
  „Zasilenie danymi testowymi" w planie), syntetyczne ID Optima.

## Konwencje pracy
- **Dokumentacja to priorytet — projekt będzie rozwijany.** Po **każdej istotnej zmianie**
  (kod, decyzja architektoniczna, zmiana zakresu/założeń, nowy lub ukończony krok) **zapytaj
  użytkownika, czy zaktualizować dokumentację** (`CLAUDE.md`, `PLAN_IMPLEMENTACJI.md`, w razie
  potrzeby pamięć projektu). Nie zostawiaj dokumentów rozjechanych z rzeczywistością.
- Gdy kończysz krok z planu — zaproponuj oznaczenie go jako zrobiony i utrwalenie wniosków.
- Praca **krok po kroku**: realizuj jeden krok z `PLAN_IMPLEMENTACJI.md`, potem weryfikacja z użytkownikiem.
- Platforma: Windows, PowerShell (główny shell). Ścieżki Windows.
- Język komunikacji: polski.
- Pobieranie danych zewnętrznych: respektować `robots.txt` i rate limit.

## Środowisko / koszty
- **Region:** `eu-central-1` (Frankfurt). **Konto AWS:** wspólne z projektem `liveorganizer`
  (te same dane dostępowe/credentials). **Node:** 22.
- **Uwaga:** z `liveorganizer` bierzemy **tylko ogólne dane dostępowe do AWS** (region, konto, Node).
  maxai ma **własny stack** — NIE czerpiemy technologicznie z liveorganizer (bez ich Amplify Gen 2 /
  DynamoDB / Cognito). Nasz stack: standalone CDK + RDS pgvector + Python Lambda + Amplify Hosting na frontend.
- Bedrock jest płatny per użycie (tanio, ale nie Free Tier). RDS Free Tier tylko 12 mies. i działa 24/7.
- Realny koszt MVP: kilka–kilkanaście zł/mies. Zawsze mieć aktywny alert budżetowy (może już istnieć na poziomie konta).
