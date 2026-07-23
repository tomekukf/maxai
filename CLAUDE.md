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

### Kanony (obowiązkowe przed odpowiednią pracą)
- **`docs/catalog-import-spec.md` — zasilanie bazy danymi. PRZECZYTAJ ZAWSZE, zanim zaczniesz import
  (katalog PDF, scraping, plik od producenta) albo pisanie skryptu ekstrakcji.** Mówi, które pole
  do czego służy w rankingu, jak wybierać kategorię/subtype/nazwę, co zapisać „na zapas" i jak
  sprawdzić import. Gdy użytkownik mówi „przygotuj katalog X" / „zaimportuj dane" — start jest tutaj.
  **Przepływ pracy jest opakowany w skilla `/import-katalog`** (`.claude/skills/import-katalog/SKILL.md`) —
  uruchom go zamiast odtwarzać kroki z pamięci.
- `docs/product-images-spec.md` — ile zdjęć i które (3, maks. 4; `sortOrder: 0` = packshot).
- `docs/product-description-spec.md` — schemat i prompt opisu wizualnego (`attributes`).
- `docs/admin-runbook.md` — procedury operacyjne (widoczne też w GUI, zakładka Dokumentacja).

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
- ✅ Krok 1.6 — zasilenie **BRW** (Agata za Cloudflare → pivot). `scrape-brw.mjs` (JSON-LD) + `seed.mjs`. (Dane BRW były testowe — **usunięte** przy przejściu na realne katalogi; skrypty zostają jako referencja.)
- 🎉 **Faza 1 ukończona.**
- ✅ Krok 2.3 — `/search` (base64 wycinka → Titan → pgvector cosine → TOP N). **Rdzeń (substytuty) udowodniony na realnych danych.** Test: `scripts/test-search.mjs`.
- ✅ Kroki 2.1/2.2/2.4 — front wyszukiwania: `SearchPage` (upload PDF/obraz → auto-detekcja → edytowalny crop → wyniki), `CatalogPage` (lista + usuwanie).
- ✅ **Faza 2b (jakość dopasowania):**
  - Multi-image: tabela `product_images` (embedding + `attributes` JSONB per zdjęcie). Migracje `002`/`003`.
  - Opis wizualny (Sonnet 4.5) każdego zdjęcia wg `docs/product-description-spec.md`, z nazwą jako kontekstem (kotwiczy typ).
  - Auto-detekcja `/detect` (Haiku 4.5 vision) — etykiety + boxy.
  - **Retrieve → rerank:** `/search` = Titan TOP-N → opis wycinka zapytania (Sonnet 4.5) → rerank sędziowski na wszystkich zdjęciach+atrybutach+specyfikacji z **oceną dopasowania 0-100**. **Waga (od Fazy 8): kształt/bryła/proporcje/konstrukcja + opis wizualny są GŁÓWNE; kolor/materiał DRUGORZĘDNE** (warianty tego samego produktu). Wyświetlane „dopasowanie %" = ocena rerankingu.
  - Gotcha: obrazy BRW to PNG mimo `.jpg` → `_img_format` (magic-bytes) w describe/rerank/detect.
- 🟡 Krok 2.5 — test pozytywny **zaliczony**: BRW-718047 (beżowa amerykanka) z wizualizacji → **#1** po rerankingu (mimo niższego kosinusa niż szare sofy). ⏳ Zostaje test alternatywny (produkt spoza bazy).
- 📐 **Faza 5 — Import katalogu PDF producenta (zaprojektowana, do implementacji).** Wciąganie
  produktów z katalogów PDF różnych kategorii (płytki/meble/sofy/krzesła/oświetlenie) z odniesieniem
  do źródła (ID Optima LUB link do katalogu w S3 otwierany na właściwej stronie `#page=N`). Decyzje:
  kreator z przeglądem, hybryda partiami stron, deklaracja domeny katalogu + auto-klasyfikacja per
  produkt, **twarda bramka kategorii** (nie proponować lampy zamiast sofy — błąd dyskwalifikujący),
  dedup (twardy unikat producent+kod + miękka flaga cosine >~0.97). Model: migracja `004` (tabela
  `catalogs` + kolumny `source/category/catalog_id/catalog_page/manufacturer/manufacturer_code`,
  `optima_id` nullable). Nowe endpointy: `/catalogs`, `/catalog/analyze-page`. Render PDF w
  przeglądarce (jak w `SearchPage`) — bez bibliotek PDF w Lambdzie. Szczegóły: `PLAN_IMPLEMENTACJI.md` Faza 5.
  - ✅ **Ścieżka offline Maxlight 2026 (208 MB PDF) — ekstrakcja lokalna zrobiona** (`scripts/extract-maxlight.py`,
    pymupdf, bez kosztów Bedrock): **243 produkty, 750 zdjęć** → `rawdata/maxlight/` (gitignore; odtwarzalne
    z PDF). Podtyp deterministycznie z prefiksu kodu (P/W/C/T/F/S/H/M). Twarde dane z warstwy tekstu (PL|EN).
    Atrybuty wizualne odłożone na v1. Seed do AWS (`seed-maxlight.mjs`) — po migracji 004.
  - **Opis LLM adaptacyjny per kategoria** + generyczny `subtype` (`docs/product-description-spec.md` zaktualizowany;
    prompty w handlerach `describe`/`analyze-page` do zsynchronizowania w ramach Fazy 5).
  - ✅ **Kroki 5.1/5.3/5.4/5.8 ZROBIONE (wdrożone i przetestowane):**
    - 5.1 migracja `004_catalogs.sql` (tabela `catalogs` + kolumny źródła/kategorii/podtypu, `optima_id` nullable, dedup unikat).
    - 5.3 `/products` rozszerzony (category/subtype/source/manufacturer/manufacturerCode/catalogId/catalogPage,
      `images:[{key,attributes?,sortOrder?}]`, `describe:false` = bez kosztu Sonnet, dedup po kodzie). **Kanoniczny zapis dla seeda i przyszłego UI.**
    - 5.4 `/search` **twarda bramka kategorii** (opis Sonnet → `kategoria` → `WHERE category=`) + pola źródła w wyniku (`catalogUrl`+`#page=N`, `catalogPage`, `manufacturer`, `catalogName`). Zweryfikowane: lampa→lampy, krzesło→0 wyników.
    - 5.8 **seed Maxlight zrobiony: 243 produkty, 750 zdjęć z embeddingiem w bazie**, katalog + PDF w S3 (`seed-maxlight.mjs`).
    - Frontend: `ResultCard` pokazuje odniesienie do katalogu (link do PDF, strona). Baza po BRW → teraz **243 produkty Maxlight**.
  - ⏸️ ODŁOŻONE: `/catalogs` CRUD + `/catalog/analyze-page` + UI importu z przeglądarki + miękka flaga duplikatów cosine (Krok 5.2/5.5), lista/usuwanie katalogów w UI (5.6).
- 🎉 **Faza 6 UKOŃCZONA — Katalog (przegląd/edycja) + wyjaśnialność wyszukiwania (wdrożone).** Tożsamość po UUID,
  `GET/PUT /products/{id}`, `CatalogPage` (szukanie/filtry/podgląd/edycja), `/search` „wczytaj kolejne" + „Dlaczego
  podobne?" (rerankScore, cosinus, per-kandydat `powod`, `queryAttributes`, tabela zgodności cech).
- 🚧 **Faza 7 — Role: panel handlowca + panel admina (w toku).** ✅ 7.0–7.3: `App.tsx` rozdzielony na panel
  handlowca (Wyszukiwanie + Katalog read-only) i panel admina za gate'em (`VITE_ADMIN_PASSWORD`) — Katalog
  (edycja/usuwanie), Zasilanie, Statystyki (`StatsPage`), Dokumentacja (runbook `docs/admin-runbook.md` renderowany
  przez `MarkdownLite`, `?raw` + `vite fs.allow:['..']`). Nawigacja na stanie (bez react-router). ⏳ Zostaje:
  ✅ **7.5 import/eksport kolekcji** (wdrożone): `POST/GET /catalogs`, `GET /catalogs/{id}/export` (paczka→S3+presigned,
  omija limit 6 MB), `/products` przyjmuje gotowy `embedding` (import bez Titana); `ImportPage` (folder `webkitdirectory`
  → createCatalog → presign+upload → importProduct). ✅ **7.6 onboarding** (`scripts/prepare-catalog.py` → `PROBE.json` +
  `CLAUDE_INSTRUCTIONS.md` + próbki; instrukcja end-to-end w `admin-runbook.md`). ✅ **7.4 Cognito** (wdrożone):
  User Pool + grupy admin/handlowiec + `HttpJwtAuthorizer`; chronione operacje admina (mutacje + `POST /catalogs`
  + presign, wymóg grupy `admin` w Lambdzie), GET/`/search` publiczne; logowanie USER_PASSWORD_AUTH w `App.tsx`
  (`lib/auth.ts`, token dołączany w `api.ts`). `VITE_COGNITO_CLIENT_ID`/`_REGION`. Zarządzanie userami: `admin-runbook.md`.
  🎉 **Faza 7 ukończona.** Szczegóły: `PLAN_IMPLEMENTACJI.md` Faza 7.
- 🚧 **Faza 8 — Jakość danych v1 (w toku).** ✅ 8.1 parser specyfikacji w `extract-maxlight.py`
  (`params.specs`: power_w/lumens/cct_k/ip/beam_deg/voltage_v/colors — generyczny). ✅ 8.2 `update-maxlight-specs.mjs`
  zaktualizował 285/287 (bez re-embed). ✅ 8.3 `/search` zwraca `id`/`subtype`/pełne `params`, a rerank+prompt
  uwzględniają specyfikacje. ✅ 8.4 rerank ocenia na **wszystkich** zdjęciach kandydata (w wyniku 1). ✅ 8.6
  `CatalogPage` — czytelna „Specyfikacja" + „Opis wizualny" w podglądzie (edycja przez params JSON w adminie).
  🟡 8.5 opisy wizualne (`attributes`) — **pilot zrobiony (16 umywalek), reszta do dogenerowania LOKALNIE**. Narzędzia:
  `scripts/describe-fetch.mjs` (pobiera z S3 zdjęcia bez opisu + manifest, filtry CATEGORY/NAME_LIKE/NAME_NOT_LIKE/PRIMARY_ONLY) →
  Claude opisuje wg `docs/product-description-spec.md` → `attributes.json` → `scripts/describe-writeback.mjs`
  (`UPDATE product_images.attributes`, bez re-embeddingu). **Zweryfikowane:** zapytanie kwadratową umywalką → kwadratowe
  warianty (inny kolor) na górze, okrągłe zdegradowane (kształt rządzi). Szczegóły: Faza 8.
- 🎉 **Faza 9 — UX katalogu + grupowanie wariantów (zrobione).** 9.0 lightbox miniatur w podglądzie. 9.1 szybkie
  otwieranie strony katalogu: `render-catalog-pages.py` → JPEG stron w S3 (`catalogs/<folder>/pages/pN.jpg`);
  `/search` i `/products/{id}` zwracają `catalogPageImageUrl`; front otwiera lekki obraz (nie 200 MB PDF), „(cały PDF)"
  drugorzędnie. 9.2 grupowanie wariantów: migracja `005` (`group_id`), heurystyka `slug(name)-subtype-{moc}w-{lm}lm`,
  zwijanie w jedną kartę (search+katalog), edytowalne w adminie. Koszt: darmowe/grosze. Szczegóły: Faza 9.
- 🎉 **Faza 10 — maxfliz jako źródło + wielokategoryjność + redesign UI (w większości zrobiona).** Klient = **maxfliz.pl** (Shopify;
  publiczne `/products.json`, robots OK, Crawl-delay 1; vendorzy: płytki/oświetlenie/meble). 10.1 `scrape-maxfliz.mjs`
  (pełna oferta publiczna, bez cen → rawdata → import; source='web' vs 'catalog'). 10.2 analiza/rozszerzenie modelu pod wiele
  kategorii. **10.2 klasyfikacja ZROBIONA: 0 „inne"** (3749 produktów sklasyfikowanych; taksonomia rozszerzona o
  podlogi/lazienka/drzwi/tapety/sztukateria/lustro/mebel — w spec + `/search`). 10.3 redesign GUI w stylu maxfliz (Jost,
  #760039 burgund, #108474 turkus). ✅ **10.4 ZROBIONE (wdrożone):** `GET /categories` (liczby per kategoria); prompt `/detect`
  rozszerzony o łazienkę/wykończenie (ignoruje dekoracje); **SearchPage filtruje podpowiedzi detekcji do kategorii obecnych w bazie**
  (`labelToCategory` + `/categories`, licznik „X spoza asortymentu pominięto"). ✅ **Import maxfliz zrobiony częściowo:
  oświetlenie (869) + łazienka (779).** Reszta (płytki 1310, dywan 180, meble/tapety/podłogi/drzwi/sztukateria/lustro) czeka na zgodę (Titan ~kilka zł).
  Szczegóły: `PLAN_IMPLEMENTACJI.md` Faza 10.
- ✅ **Paginacja katalogu (wdrożona, poza numeracją faz).** `GET /products` z `limit`/`offset` + `total`, filtry server-side
  (`q`, `category`, `source`) + tryb `slim` (bez presignów, do statystyk); presign tylko widocznej strony. `CatalogPage` „Pokaż więcej"
  + wyszukiwarka/kategoria po stronie serwera (koniec ładowania 1908 rekordów naraz); `StatsPage` skanuje bazę w trybie `slim`.
- 🎉 **Import danych UKOŃCZONY — stan bazy (po deduplikacji ujęć, Faza 13.5): 3881 produktów, 8972 zdjęcia
  (100% z embeddingiem), 23 usuwalne źródła.** Przed dedupem było 10 874 zdjęć.
  **maxfliz (web, cała oferta publiczna, 17 źródeł):** płytki 1306, oświetlenie 869, łazienka 779, dywany 180, sztukateria 147,
  meble 98, tapety 63, sofy 62, podłogi 62, stoliki 54, krzesła 44, fotele 25, drzwi 23, komody 14, szafki 10, lustra 5, regały 3.
  **MAXLIVING (catalog, 6 katalogów tematycznych): 135.** Każde źródło usuwalne (`DELETE /catalogs/{id}`), z linkiem do strony
  (MAXLIVING). Import per kategoria (`seed-maxfliz.mjs`, `CATALOG_ID` = wznowienie po przerwaniu; dedup po SKU). Błędy: 2 produkty
  (brak/zły obraz). **Uwaga:** zbiorczy „MAXLIVING — meble 2026" (125) usunięty jako duplikat tematycznych.
  ⏳ Opisy wizualne (`attributes`, Faza 8.5) do dogenerowania lokalnie dla świeżo zaimportowanych (fetch bierze tylko nieopisane).
- 📐 **Faza 11 — źródła jako usuwalne partie + import/analiza z GUI (zaplanowana).** 11.1 dane jako „źródło"
  (`catalogs`+`source`, `DELETE /catalogs/{id}` kaskada → łatwe wipe & re-import, lista źródeł w GUI). 11.2 dedykowany
  import + instrukcja w GUI. 11.3 **onboarding PDF = instrukcja w GUI** (Dokumentacja) + wiedza w kontekście Claude +
  ręczna orchestracja (komendy); **bez** wyzwalania analizy z przeglądarki (webowe GUI nie odpali lokalnego Pythona/LLM).
  Szczegóły: `PLAN_IMPLEMENTACJI.md` Faza 11.
- 🎉 **Faza 12 — UX wyszukiwania (ukończona).** ✅ 12.1 multi-produkt (numerowane wykrycia, wielokrotny wybór → kilka list;
  nakładki nieklikane, kadr ReactCrop swobodny, zapamiętywany per produkt). ✅ 12.2 podpowiedź kontekstu (`hint`). ✅ 12.3 PDF:
  widok do druku (search) **oraz PDF-tabelka ze Schowka z selekcją** (miniatura/nazwa/kod-SKU/producent/link ref; frontend-only).
  ✅ 12.4 **F2a** rysunek techniczny/spec → `/search` `contextImageBase64` → `_extract_context` (Sonnet, TYLKO czytelne,
  anti-halucynacja; odczyt pokazany w UI) wzmacnia hint + miękki sygnał do reranku; **F2b** wymiary: `scripts/backfill-dims.mjs`
  (re-scrape maxfliz body_html → `params.wymiary_cm`, 0 Bedrock) — **1449 produktów** ma wymiary; rerank porównuje miękko.
  ✅ 12.5 hardening reranku. ✅ **Fix jakości danych:** admin „Ustaw jako główne" (reorder zdjęć, `imageOrder`→`sort_order`) —
  naprawia produkty z mylącym zdjęciem głównym. ✅ **12.7 tryb szybki:** `/search` przyjmuje `fast:true` → ranking wprost
  z kosinusa Titana, bez `_rerank` (0 kosztu Sonnet), odpowiedź z `mode: fast|quality`; przełącznik „Tryb szybki
  (bez Sonneta)" **tylko dla admina**, plakietka przy wynikach. ✅ **12.8 redesign `SearchPage`:** układ dwukolumnowy
  (obraz + ruchomy kadr po lewej, sticky panel „Wykryte produkty" po prawej) — każda podpowiedź to **checkbox
  „wyślij do analizy" + miniatura wycinka** (liczona lokalnie z canvas, odświeżana po poprawieniu kadru) + „popraw kadr";
  analiza startuje automatycznie po wgraniu, `↻ analizuj` do ponowienia. Szczegóły: `PLAN_IMPLEMENTACJI.md` Faza 12.
- 🎉 **Faza 13 — Jakość rankingu, wyjaśnialność i sufity kosztów (ukończona, 2026-07-22/23).** Wywołana dwoma zgłoszeniami
  z testów (wanna przy zapytaniu o umywalkę; brak oczekiwanej płytki). ✅ **13.1 sygnały miękkie:** do kosinusa doliczane
  podtyp (+0,05/−0,08), słowo-klucz w nazwie (+0,05/−0,08), rozjazd wymiarów >2,5× (−0,05), słowo kształtu w opisie (+0,06);
  słowa-klucze z opisu **oraz z etykiety zaznaczenia**, dopasowanie po rdzeniu (polska fleksja); **doszukiwanie po opisie**
  dociąga kandydatów spoza puli wizualnej; pula retrieve 5×`recallK`. Kategoria dalej **jedynym twardym filtrem**.
  ✅ **13.2 anty-zakotwiczenie sędziego** (opis = hipoteza; kształt oceniaj z obrazu) + **słownik kształtów powierzchni
  wzorzystych** w `DESCRIBE_SYSTEM` (heksagon/łuska/pióro/arabeska/romb/cegiełka/prążek; „zaokrąglona krawędź to NIE heksagon").
  ✅ **13.3 eksport diagnostyki** (JSON z obrazem zapytania + pełnym rozbiciem oceny; „Kopiuj podsumowanie"; kolumna
  „sygnały miękkie"). ✅ **13.4 twarde sufity kosztu:** `RERANK_IMG_BUDGET=8` (zdjęcia to ~90% rachunku, limit nie rośnie
  z `recallK`), `MAX_RECALL_QUALITY=12` / `MAX_RECALL_FAST=60`, nierówny podział budżetu (czołówka +1 ujęcie) — sufit
  zapytania ~35 gr zamiast „nielimitowany". ✅ **13.5 kanon zdjęć** (`docs/product-images-spec.md`: 3 na produkt, maks. 4,
  `sortOrder:0` = packshot bo tylko on trafia do sędziego) + **deduplikacja ujęć** (`scripts/dedupe-images.mjs`, próg **0,95**
  — przy 0,90 giną warianty kolorystyczne; usunięto 1904). ✅ **13.6 uczciwość wyniku:** stan **„brak odpowiednika"**
  (`weakMatch` gdy najlepsza ocena < 30 → UI mówi wprost „to nie są substytuty"), **kategorie siostrzane w bramce**
  (`plytki↔podlogi`, `szafka→komoda/mebel/lazienka`, `stol↔stolik`, `sofa↔naroznik`), **rubryka ocen** sędziego
  (90+ tylko przy zgodnym kształcie ORAZ kolorze), **kolor zależny od kategorii** (dla powierzchni kryterium główne)
  oraz **orientacja i układ** w opisie wzoru. ⏸️ **13.7 grupowanie wariantów kolorystycznych ODŁOŻONE** — dane nie
  odróżniają wariantu koloru od innego modelu (dowód i narzędzie: `scripts/regroup-variants.mjs`); właściwe miejsce
  to import z `options`/`variants` Shopify. Szczegóły: `PLAN_IMPLEMENTACJI.md` Faza 13.
- ▶️ Następne (do rozważenia): **tożsamość wariantów przy imporcie** (Shopify `options`/`variants` w `scrape-maxfliz.mjs`
  → odblokowuje Krok 13.7); **Faza 8.5 dla płytek** — bez opisów wizualnych kształt w tej kategorii nie istnieje jako sygnał
  (nazwy to kody, `subtype` to format); dogenerować `attributes` lokalnie, partia walidacyjna ~100–150 szt.
  Uzupełnienie zdjęć dla produktów z jednym ujęciem; dokończenie importu maxfliz; ew. dedykowany endpoint `/stats`
  (dziś statystyki liczone przez pełny skan `slim` z frontu); hosting frontu (Amplify — **nie istnieje**, front działa lokalnie).

## Gotchas (git bash / AWS)
- `MSYS_NO_PATHCONV=1` przed komendami z argumentami `/aws/...` (np. `aws logs`) — inaczej git bash konwertuje na ścieżkę Windows.
- Env do node przez `export API=...` (nie `API=... && node` — to nie eksportuje).
- Presigned S3: path-style + nie podpisywać Content-Type. Titan: obraz min. sensownego rozmiaru (1×1 = błąd).

## Zablokowane decyzje
- **Detekcja obiektów: ścieżka A — bez Rekognition.** Ręczne (edytowalne) kadrowanie (`react-image-crop`)
  + Claude vision. **Auto-detekcja (`/detect`, Haiku 4.5) zrobiona** — sugeruje etykiety + boxy, użytkownik akceptuje/poprawia.
- **Modele Bedrock (eu-central-1, inference profile EU — dane w UE):**
  - Ekstrakcja/NLP + auto-detekcja: Haiku 4.5 → `eu.anthropic.claude-haiku-4-5-20251001-v1:0` ✅
  - Opis wizualny + rerank: **Sonnet 4.5** → `eu.anthropic.claude-sonnet-4-5-20250929-v1:0` ✅ (Sonnet 5 niedostępny → 4.5)
  - Embeddingi (1024): `amazon.titan-embed-image-v1` ✅
  - NIE używać Claude 3 Haiku (przestarzały).
- **Embeddingi:** Amazon Titan Multimodal (1024 wym.).
- **Kategoria = jedyny twardy filtr (od Fazy 5), ale z kategoriami siostrzanymi (od Fazy 13.6).** Bramka wpuszcza
  kategorię zapytania + jej siostry (`_SIBLING_CATEGORIES` w `search/handler.py`: `plytki↔podlogi`,
  `szafka→komoda/mebel/lazienka`, `stol↔stolik`, `sofa↔naroznik`) — bo granica taksonomii nie pokrywa się z intencją
  („płytki podłogowe" ≠ nasze `podlogi`). Wszystko inne (podtyp, kolor, materiał, wymiar) pozostaje miękkie —
  od Fazy 13.1 jako punktowane sygnały, nie `WHERE`.
- **Kolor: drugorzędny dla mebli/lamp, GŁÓWNY dla powierzchni (od Fazy 13.6).** Dla `plytki/podlogi/tapety/dywan`
  inny odcień = inny produkt (ocena maks. 60), bo tam kolor i wzór SĄ produktem; dla reszty kolor to wariant.
- **Wynik ma być uczciwy (od Fazy 13.6).** Gdy najlepsza ocena < `WEAK_MATCH_BELOW` (30), zwracamy wyniki, ale
  oznaczone jako „najbliższe wizualnie, nie substytuty". Zasada „nigdy brak wyniku" nie oznacza podawania 10% jako oferty.
- **Zdjęcia produktu: 3, maksymalnie 4 (od Fazy 13.5).** `sortOrder: 0` = packshot, bo przy domyślnym `recallK`
  **tylko zdjęcie główne trafia do sędziego**; do reranku pobierane są maks. 4 (`LIMIT 4`). Kanon i czarna lista
  ujęć: `docs/product-images-spec.md` (obowiązuje każdy import i każdy model zasilający bazę).
- **Sufity kosztu `/search` (od Fazy 13.4).** `RERANK_IMG_BUDGET=8` zdjęć na zapytanie (twardo, niezależnie od
  `recallK`), `MAX_RECALL_QUALITY=12`, `MAX_RECALL_FAST=60`. Wszystko przez ENV — nie podnosić bez zgody.
- **Bedrock tylko za zgodą (etap dev).** Nowa praca (scraping/kategoryzacja/opisy/model/GUI) = lokalny LLM (Claude Code);
  NIE dokładać nowych wywołań Bedrock bez zgody. Obecne zostają: Titan (import) + Sonnet opis/rerank (runtime `/search`).
  Szerszy Bedrock dopiero w testach finalnych.
- **Bez cen / zakres = dobór do wizualizacji.** Aplikacja pomaga opiekunom architektów znaleźć produkt użyty w wizualizacji
  lub najbliższy substytut; ceny/wyceny poza zakresem (z maxfliz nie pobieramy cen).
- **Tworzenie kolekcji = LOKALNIE (ograniczenie kosztów Bedrock).** Analiza katalogów (ekstrakcja/klasyfikacja/opis)
  lokalnie (Claude Code), NIE na Bedrock vision. Na AWS tylko: (a) analiza dokumentu przy wyszukiwaniu (opis wycinka
  + rerank), (b) embeddingi Titan (raz przy imporcie; **eksportowane** → re-import bez Bedrock). Import/eksport kolekcji
  w panelu admina (Krok 7.5); eksport zawiera embeddingi. Interaktywny import z vision na AWS (5.2/5.5) odłożony.
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
