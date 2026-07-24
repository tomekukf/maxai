---
name: import-katalog
description: Zasilanie bazy maxai danymi produktowymi — katalog PDF producenta, scraping sklepu, plik od dostawcy. Prowadzi cały przepływ: sondowanie źródła, skrypt ekstrakcji, collection.json, próbka do akceptacji, import, kontrola jakości. Użyj, gdy użytkownik mówi "przygotuj katalog", "zaimportuj dane", "wciągnij produkty", "dodaj katalog/kolekcję", "zasil bazę" albo podaje PDF/URL z produktami.
---

# Import katalogu do maxai

Prowadzisz zasilanie bazy od źródła do zweryfikowanych danych. **Nie improwizuj formatu ani taksonomii** —
wszystko jest ustalone w kanonach; ten plik to przepływ pracy i twarde punkty kontrolne.

## Krok 0 — wczytaj kanony (zawsze, zanim cokolwiek napiszesz)

Przeczytaj w tej kolejności:

1. **`docs/catalog-import-spec.md`** — kanon importu: co które pole robi w rankingu, wybór kategorii
   i subtype, zasady nazewnictwa, `params`, `group_id`, kontrola jakości. **To jest źródło prawdy.**
2. **`docs/product-images-spec.md`** — ile zdjęć i które (3, maks. 4; `sortOrder: 0` = packshot).
3. **`docs/product-description-spec.md`** — schemat `attributes`, jeśli import obejmuje opisy wizualne.

Jeśli któregoś nie ma lub jest sprzeczny z tym, co widzisz w kodzie — powiedz to użytkownikowi,
zamiast działać na domysłach.

## Krok 0.5 — triage całej puli (gdy dostajesz wiele katalogów naraz)

Gdy użytkownik wrzuca folder z **wieloma** dostawcami (np. `rawdata/catalogs/**`, cenniki wymieszane
z katalogami, zdjęciami, modelami 3D), najpierw zrób przegląd całości, zanim zabierzesz się za pojedynczy:

```bash
python scripts/analyze-catalogs.py            # → rawdata/catalogs/_index.json + _status.html
```

Analizator klasyfikuje każdego dostawcę i nadaje status: **GOTOWY** (luźne zdjęcia + nazwy → można przygotować),
**EKSTRAKCJA_PDF** (katalog PDF ze zdjęciami do wyciągnięcia), **BRAK_ZDJEC** (sam cennik — maxai wymaga zdjęć,
nieimportowalne wprost), **BRAK_NAZW**, **PUSTY**, **NIEPRZYDATNE** (3D/wideo). Flaguje też, co już jest w bazie
(`_imported.txt`). `_status.html` to dashboard do podglądu dla użytkownika (filtry, sortowanie, jakość).
Skrypt jest **re-używalny** — uruchamiaj ponownie, gdy dojdą nowe dane.

Na tej podstawie ustal z użytkownikiem **kolejność prac** (najpierw GOTOWY o najwyższej jakości), a potem dla
wybranego dostawcy przejdź do kroków 1–7 poniżej. Producentów już w bazie odśwież przez:
`node` jednolinijkowiec zapisujący `SELECT DISTINCT manufacturer` do `rawdata/catalogs/_imported.txt`.

## Krok 1 — ustal źródło i zakres (zapytaj, jeśli nie wiadomo)

- **Typ źródła:** katalog PDF (`source: "catalog"`, jest `catalogPage`), sklep/web (`source: "web"`,
  jest `product_url`), eksport od klienta (`source: "optima"`, jest `optimaId`).
- **Producent** i **kategoria domenowa** katalogu (podpowiedź, nie wyrok — produkt może mieć własną).
- **Zakres partii:** duże źródła dzielimy **po kategoriach, osobny katalog na kategorię** — łatwiej wycofać
  i policzyć. Zapytaj, czy robimy całość, czy jedną kategorię na próbę.

## Krok 2 — sondowanie źródła

**PDF:**
```bash
python scripts/prepare-catalog.py <pdf> <nazwa> [--manufacturer X] [--category Y]
```
→ `rawdata/<nazwa>/PROBE.json` + `CLAUDE_INSTRUCTIONS.md` + `samples/`. Obejrzyj próbki stron
(`Read` na PNG) i odczytaj warstwę tekstu (`fitz`), zanim napiszesz cokolwiek.

**Sklep/web:** sprawdź `robots.txt` i rate limit (kanon projektu: respektujemy oba), zbadaj strukturę
(Shopify → `/products.json` z `options`/`variants`). Wzorzec: `scripts/scrape-maxfliz.mjs`.

Nie zgaduj układu katalogu — **potwierdź wizualnie na próbkach**, zwłaszcza mapowanie prefiksu kodu
na subtype i numerację stron (rozkładówki: `printed_page` ≠ `viewer_page`).

## Krok 3 — skrypt ekstrakcji

Kopiuj wzorzec (`scripts/extract-maxlight.py` dla PDF, `scripts/scrape-maxfliz.mjs` dla web)
do `scripts/extract-<nazwa>.py` / `scrape-<nazwa>.mjs` i dostrój. Wynik: `rawdata/<nazwa>/collection.json`
+ `rawdata/<nazwa>/images/`.

Twarde zasady (szczegóły w kanonie):
- **Kategoria** z listy kanonicznej; „do czego produkt służy", nie z czego jest. Nie wiesz → **zapytaj**,
  nigdy `inne`.
- **Subtype** z małego, powtarzalnego słownika; dla płytek kształt (`mozaika`, `heksagon`, `cegielka`),
  a format do `params.format_cm`.
- **Nazwa** zaczyna się od typu produktu **słowem** — bez tego produkt nie ma sygnału leksykalnego.
- **Zdjęcia: 3, maks. 4.** `sortOrder: 0` = packshot całego produktu na jednolitym tle. Nie wciągaj
  rysunków technicznych, banerów, zdjęć zbiorczych rodziny ani duplikatów ujęcia.
- **Wymiary zawsze w cm, liczbami.** Czego nie ma w źródle → `null`. Nigdy nie interpoluj.
- **`group_id` tylko z dowodu ze źródła** (wariant Shopify, tabela wariantów). Brak pewności → `null`.
- Dane, których nie umiesz zmapować, i tak zapisz w `params` — nie gub ich.

## Krok 4 — PRÓBKA DO AKCEPTACJI (punkt kontrolny, nie pomijaj)

Zanim policzymy embeddingi dla całości, pokaż użytkownikowi **10 losowych gotowych rekordów**:
nazwa, kategoria, subtype, kod, wymiary + miniatury zdjęcia głównego. Zapytaj wprost o akceptację
kategorii i zdjęć głównych. Import całości dopiero po „ok".

Wypisz też od razu:
- produkty, dla których **nie dało się ustalić typu** (kandydaci do decyzji użytkownika),
- produkty z **podejrzanym zdjęciem głównym** (rysunek, baner, zdjęcie zbiorcze),
- rozkład kategorii i subtype oraz **średnią liczbę zdjęć** (ma być 1–4).

## Krok 5 — import

Panel admina → **Import kolekcji** (folder `rawdata/<nazwa>/`) albo skrypt `scripts/seed-*.mjs`.
Każdy import = **jeden usuwalny katalog** (`catalogId`); przerwany wznawiasz tym samym `CATALOG_ID`
(dedup po `manufacturer + manufacturerCode` pominie wgrane).

Koszty — kanon projektu:
- **`describe: false`** przy imporcie (żadnego Sonneta na opisy).
- Analiza treści (klasyfikacja, opisy, czytanie PDF) **lokalnie**, nie przez Bedrock vision.
- Jedyne dozwolone wywołanie AWS to **embedding Titan** przy zapisie produktu.
- Nowe wywołania Bedrock **tylko za zgodą użytkownika**.

## Krok 6 — kontrola jakości (odhacz punkt po punkcie)

Pełna lista: `docs/catalog-import-spec.md` §11. Minimum:

1. Liczby się zgadzają (produkty w pliku vs w bazie, minus zgłoszone duplikaty).
2. `GET /categories` — zero `inne`, rozkład zgodny z oczekiwaniem.
3. Rozkład zdjęć 1–4 na produkt; policz produkty z jednym zdjęciem.
4. `node scripts/dedupe-images.mjs` (dry-run). >10% do usunięcia = popraw skrypt ekstrakcji, nie bazę.
5. Wzrokowa próbka 10 rekordów z bazy.
6. **Test „produkt znajduje sam siebie":** weź 3 zaimportowane produkty, wytnij ich zdjęcie i puść przez
   `/search` w **trybie szybkim** (`fast: true` — darmowy). Każdy musi wyjść na **#1**. Jeśli nie —
   winne jest zdjęcie główne albo kategoria.
7. Podsumowanie dla użytkownika: ile produktów, rozkład kategorii/subtype, co wymaga poprawki.

Jeśli coś jest nie tak: `DELETE /catalogs/{id}` (kaskada: produkty + zdjęcia z S3), popraw skrypt,
importuj ponownie. Dlatego partie mają być małe i tematyczne.

## Krok 7 — utrwalenie

- **Eksport kolekcji** (`GET /catalogs/{id}/export`) — paczka z embeddingami pozwala odtworzyć bazę
  bez ani jednego wywołania Bedrocka. Zrób po udanym imporcie.
- (PDF) Oryginał i lekkie strony do S3: `python scripts/render-catalog-pages.py <pdf> <nazwa>` →
  `aws s3 cp … s3://<bucket>/catalogs/<folder>/pages/ --recursive` oraz `original.pdf`.
- **Skrypt ekstrakcji commituj do repo**, dane surowe zostaw poza nim (`rawdata/` jest w `.gitignore`).
- Zapytaj użytkownika o aktualizację `CLAUDE.md` / `PLAN_IMPLEMENTACJI.md` (stan bazy, nowe źródło) —
  to konwencja tego projektu.

## Czego nie robić

- Nie wpisuj `inne` jako kategorii — to produkt niewidoczny w wyszukiwaniu. Zapytaj.
- Nie twórz nowych kategorii ani subtypów bez uzgodnienia i zmiany kanonu (`docs/product-description-spec.md`
  + lista w `backend/lambdas/search/handler.py`).
- Nie wciągaj więcej niż 4 zdjęć — piąte i dalsze system ignoruje.
- Nie buduj `group_id` przez wycinanie słów z nazwy (sprawdzone: scala różne modele i **ukrywa produkty**).
- Nie licz embeddingów dla całości przed akceptacją próbki z kroku 4.
- Nie kasuj `rawdata/` po imporcie — to jedyna droga do powtórzenia bez dostępu do źródła.
