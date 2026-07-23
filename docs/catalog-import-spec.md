# Kanon importu danych do maxai

Jak wciągać produkty (katalog PDF, sklep, plik od producenta), żeby dane **realnie działały
w wyszukiwaniu substytutów** i nie trzeba było ich importować drugi raz po każdej zmianie decyzji.

> **Czytaj to przed każdym importem.** Kanony szczegółowe: `docs/product-images-spec.md` (zdjęcia),
> `docs/product-description-spec.md` (opis wizualny `attributes`). Runbook operacyjny: `docs/admin-runbook.md`.

---

## 0. Zasada nadrzędna

Nie zbieramy „danych o produkcie" — zbieramy **sygnały, po których system rozpoznaje, że produkt A może
zastąpić produkt B z wizualizacji**. Każde pole ma konkretne miejsce w rankingu. Pole wypełnione byle jak
jest gorsze niż puste, bo puste system pomija, a błędne aktywnie psuje wynik.

| pole | gdzie działa | co się psuje, gdy jest złe |
|---|---|---|
| `category` | **twarda bramka** (+ kategorie siostrzane) | produkt **nigdy** nie wyjdzie w wynikach dla swojej intencji |
| `subtype` | sygnał miękki (+0,05 / −0,08) | produkt spada pod gorsze dopasowania albo wypycha lepsze |
| `name` | sygnał leksykalny (+0,05 / −0,08) + kontekst dla sędziego | brak słowa typu w nazwie = brak sygnału; kod producenta nic nie wnosi |
| zdjęcie **główne** | jedyne, które przy domyślnych ustawieniach ogląda sędzia | zły kadr = produkt oceniony na 10% mimo trafności |
| pozostałe zdjęcia | retrieve (wybierane jest najlepiej pasujące ujęcie) | brak = mniejsza szansa trafienia z nietypowego kadru |
| `attributes` | doszukiwanie po opisie + sygnał kształtu (+0,06) | dla płytek/wzorów **jedyny** nośnik kształtu — bez tego liczą się gołe piksele |
| `params.wymiary_cm`, `params.specs` | miękkie porównanie w reranku, kontrola wariantów | rozjazd wymiarów >2,5× karany; złe dane = fałszywe kary |
| `manufacturer` + `manufacturerCode` | dedup (twardy unikat), odniesienie dla handlowca | duplikaty w bazie albo odrzucone wiersze przy imporcie |
| `catalogId` / `source` | usuwalna partia danych | nie da się wycofać złego importu bez ręcznego czyszczenia |
| `group_id` | zwijanie wariantów w jedną kartę | scalenie różnych modeli = produkty **znikają** z wyników |

**Reguła praktyczna:** jeśli nie masz pewnego źródła dla pola — zostaw `null`. Nigdy nie zgaduj.

---

## 1. Zanim zaczniesz: trzy pytania do źródła

1. **Co to za dane?** Katalog PDF producenta (`source: "catalog"`, jest `catalogPage` i link do strony),
   sklep/web (`source: "web"`, jest `product_url`), czy eksport z systemu klienta (`source: "optima"`, jest `optimaId`).
2. **Czy da się to odtworzyć?** Import ma być powtarzalny: surowe dane lądują w `rawdata/<nazwa>/`,
   skrypt ekstrakcji w `scripts/extract-<nazwa>.py` lub `scripts/scrape-<nazwa>.mjs`. `rawdata/` jest w `.gitignore` —
   w repo zostaje **skrypt**, nie dane.
3. **Ile to kosztuje?** Analiza treści (klasyfikacja, opisy, czytanie PDF) robimy **lokalnie** (Claude Code, `pymupdf`).
   Na AWS wolno tylko: embeddingi Titan przy imporcie. Vision na Bedrocku przy imporcie = **nie** (patrz `CLAUDE.md`).

---

## 2. Kategoria — najważniejsza decyzja w całym imporcie

Kategoria jest **twardym filtrem**. Produkt z błędną kategorią jest w bazie martwy.

**Kanoniczne slugi** (jedyne dozwolone): `sofa, naroznik, fotel, krzeslo, stol, stolik, lozko, materac,
szafka, komoda, regal, mebel, oswietlenie, plytki, podlogi, lazienka, drzwi, tapety, sztukateria, lustro,
dywan, dekoracja, inne`.

**Reguła wyboru:** kategoria opisuje **do czego produkt służy w przestrzeni**, nie z czego jest zrobiony
ani jak nazywa go producent.

| przypadek graniczny | decyzja | dlaczego |
|---|---|---|
| szafka podumywalkowa, słupek łazienkowy | `lazienka` | użytkownik szuka wyposażenia łazienki; bramka ma siostrę `szafka→lazienka` |
| płytka ceramiczna na podłogę | `plytki` | `podlogi` u nas = panele i deski; siostra `plytki↔podlogi` łapie oba kierunki |
| panel ścienny 3D, listwa, rozeta | `sztukateria` | wykończenie ściany, nie mebel |
| lustro w ramie z półką | `lustro` | funkcja główna decyduje |
| stolik nocny | `szafka` lub `stolik` — wybierz jedno i trzymaj się w całym imporcie | spójność ważniejsza niż trafność wyboru |
| nie wiesz | **zapytaj**, nie wpisuj `inne` | `inne` = produkt niewidoczny w wyszukiwaniu |

**Kategoria domenowa katalogu** (`catalog.domainCategory`) to podpowiedź, nie wyrok — pojedynczy produkt
może mieć inną kategorię niż cały katalog (katalog „łazienka" może zawierać lustra i oświetlenie).

---

## 3. Subtype — mały, generyczny słownik

`subtype` to **sygnał miękki**: zgodność podnosi ocenę, niezgodność obniża. Ma być krótki, jednowyrazowy
(lub z podkreśleniem) i **powtarzalny w obrębie kategorii**. Nie wymyślaj nowych wartości per produkt.

- `oswietlenie`: `wiszaca, kinkiet, plafon, stolowa, podlogowa, reflektor_szynowy, downlight, zyrandol, listwa_liniowa, system_magnetyczny`
- `sofa/naroznik/fotel`: `2_osobowa, 3_osobowa, rozkladana, z_szezlongiem, modulowa, uszak`
- `lazienka`: `umywalka, bateria, wanna, wanna_wolnostojaca, kabina, brodzik, wc, bidet, szafka, grzejnik, akcesorium`
- `plytki`: **kształt/rodzina wzoru**, nie format → `mozaika, cegielka, heksagon, luska, wielkoformatowa, terrazzo, dekor`
- `podlogi`: `panel, deska, winyl, jodelka`
- `szafka/komoda/regal`: `nocna, podumywalkowa, wiszaca, z_szufladami, z_drzwiami, witryna`

> **Uwaga na płytki:** format (`30x30`, `60x120`) **nie jest** subtypem — idzie do `params.format_cm`.
> Subtype ma nieść kształt, bo to on jest sygnałem w rankingu; wartość czysto liczbowa jest ignorowana.

---

## 4. Nazwa — pisz ją dla wyszukiwarki, nie dla magazynu

Nazwa jest drugim po kategorii sygnałem tekstowym i **jedynym**, gdy produkt nie ma opisu wizualnego.

**Wzorzec:** `<TYP PRODUKTU> <MODEL/SERIA> <WARIANT> OD <PRODUCENT> <KOD>`

- ✅ `UMYWALKA NABLATOWA OKRĄGŁA HAMNES RILA BIAŁA OD OLTENS 40330000`
- ❌ `PŁYTKA CERAMICZNA EQ/WA63BGDE X CM OD EQUIPE` — brak kształtu, formatu i koloru; system nie ma z czego wnioskować
- ❌ `LAMPA MODERN CZARNY OD MAXLIGHT P0626` przy ośmiu różnych modelach o tej samej nazwie — nazwa nie identyfikuje produktu

Zasady:
1. **Typ produktu słowem** na początku — po nim idzie sygnał leksykalny („umywalka", „kinkiet", „mozaika").
2. Jeśli źródło daje tylko kod, **dopisz typ z kontekstu katalogu** (strona, sekcja, ikona) — to legalne,
   bo wynika z dokumentu; nie zgaduj kształtu, którego nie widać.
3. Kod producenta zostaw **na końcu**, ale trzymaj go też w `manufacturerCode` i `params.sku`.
4. Nie wciskaj do nazwy wymiarów ani specyfikacji — mają swoje pola.
5. Nie zostawiaj podwójnych spacji i pustych miejsc po wyciętym kodzie (widać je dziś w bazie).

---

## 5. Zdjęcia

Pełny kanon: **`docs/product-images-spec.md`**. Skrót absolutnie obowiązkowy:

- **3 zdjęcia na produkt, maksymalnie 4** (piąte i dalsze system ignoruje — do reranku pobiera `LIMIT 4`).
- **`sortOrder: 0` = packshot na jednolitym tle, cały produkt, front lub 3/4.** To jedyne zdjęcie, które
  przy domyślnych ustawieniach ogląda model oceniający — najważniejsza decyzja w imporcie.
- Dalej: inne ujęcie bryły (bok/tył/góra), potem aranżacja lub detal faktury.
- **Nie wciągaj:** rysunków technicznych, banerów i grafik opakowań, zdjęć zbiorczych rodziny produktów,
  kadrów z produktem w tle, tego samego packshotu w innej rozdzielczości, duplikatów ujęcia.
- **Warianty kolorystyczne to nie duplikaty** — zostaw je.
- Po imporcie: `node scripts/dedupe-images.mjs` (dry-run; `APPLY=1` wykonuje; próg `THRESHOLD=0.95`).

---

## 6. `params` — dane twarde, stałe klucze

`params` to worek JSONB, ale **klucze są kontraktem** — sięgają po nie rerank, backfille i statystyki.
Nie wymyślaj synonimów (`wymiary` vs `wymiary_cm` vs `dims` = trzy razy ta sama informacja, z czego dwie martwe).

```jsonc
"params": {
  "sku": "8721452828388",              // główny kod handlowy (= manufacturerCode)
  "codes": ["8721452828388", "..."],   // wszystkie kody wariantu/opakowania
  "product_url": "https://…",          // źródło (web) — do audytu i re-scrape
  "wymiary_cm": {                      // ZAWSZE w centymetrach, liczby (nie stringi)
    "szerokosc": 36, "glebokosc": 36, "wysokosc": null,
    "srednica": 36, "dlugosc": null
  },
  "format_cm": "30x30",                // płytki/panele: format handlowy
  "specs": {                           // specyfikacja techniczna, klucze generyczne
    "power_w": 12, "lumens": 900, "cct_k": 3000,
    "ip": "IP44", "beam_deg": 36, "voltage_v": 230, "colors": ["czarny", "złoty"]
  },
  "printed_page": 42, "viewer_page": 44,   // katalog PDF: numer drukowany vs indeks w pliku
  "zrodlo": "katalog Maxlight 2026, s. 42" // skąd wzięte dane (audyt)
}
```

Zasady:
1. **Wymiary zawsze w cm**, jako liczby. Milimetry i cale przelicz przy imporcie.
2. Czego nie ma w źródle → `null` lub brak klucza. **Nie interpoluj i nie licz „z proporcji zdjęcia".**
3. Dane, których nie umiesz zmapować na kanon, **też zapisz** — jako dodatkowe klucze w `params`.
   Lepiej mieć je surowe niż stracić; kanon rozszerzymy później bez ponownego importu.
4. Nie duplikuj do `params` tego, co ma własną kolumnę (`name`, `category`, `subtype`, `manufacturer`).

---

## 7. `attributes` — opis wizualny (opcjonalny, ale to on wygrywa trudne przypadki)

Schemat i prompt: **`docs/product-description-spec.md`**. Kiedy generować:

- **Zawsze dla płytek, tapet, dywanów i wszystkiego wzorzystego** — w tych kategoriach nazwa to kod,
  `subtype` to kształt, a bez `attributes` kształt wzoru **nie istnieje** jako sygnał tekstowy.
- Dla mebli i lamp — wartościowe, ale nie blokujące (bryłę widać na zdjęciu, nazwa niesie typ).
- Generujemy **lokalnie** (Claude Code czyta zdjęcia z `rawdata/`), nigdy przez Bedrock vision przy imporcie.
- Można dograć po imporcie: `scripts/describe-fetch.mjs` → opis → `scripts/describe-writeback.mjs`
  (bez ponownego liczenia embeddingów).

---

## 8. `group_id` — tylko z dowodu, nigdy z nazwy

`group_id` zwija produkty w **jedną kartę** w wynikach. Błędne scalenie **ukrywa produkty** przed handlowcem.

- Ustawiaj **tylko wtedy**, gdy źródło jawnie mówi, że to ten sam model w innym wariancie
  (Shopify `options`/`variants`, tabela wariantów w katalogu, wspólny kod bazowy z sufiksem koloru).
- Nie buduj `group_id` przez wycinanie słów z nazwy — sprawdzone: to scala różne modele
  (35 paneli ORAC w jedną kartę). Szczegóły i narzędzie: `scripts/regroup-variants.mjs`, Faza 13.7.
- **Nie masz pewności → `null`.** Brak grupowania jest niegroźny; złe grupowanie usuwa produkty z wyników.

---

## 9. Źródło danych = usuwalna partia

Każdy import musi dać się **wycofać jednym ruchem**, bo pierwsza wersja importu prawie nigdy nie jest ostatnia.

1. Utwórz katalog (`POST /catalogs` lub panel admina): `name` (czytelne, np. `maxfliz — oświetlenie`),
   `manufacturer`, `domainCategory`, opcjonalnie `pdfKey` i `pageCount`.
2. Wszystkie produkty importu dostają jego `catalogId`.
3. `DELETE /catalogs/{id}` kasuje katalog + produkty + zdjęcia z S3 (kaskada).
4. Duże importy rób **partiami po kategoriach** — osobny katalog na kategorię. Łatwiej wycofać i policzyć.
5. Przerwany import wznawiasz tym samym `CATALOG_ID` — dedup po `manufacturer + manufacturerCode` pominie wgrane.

---

## 10. Format wsadu

**`collection.json`** (import z panelu admina i skryptów `seed-*.mjs`):

```jsonc
{
  "catalog": { "name": "…", "manufacturer": "…", "domainCategory": "…", "pageCount": 120 },
  "products": [
    {
      "name": "UMYWALKA NABLATOWA OKRĄGŁA HAMNES RILA BIAŁA OD OLTENS",
      "optimaId": null,
      "category": "lazienka",
      "subtype": "umywalka",
      "manufacturer": "Oltens",
      "manufacturerCode": "40330000",
      "source": "catalog",
      "catalogPage": 42,
      "group_id": null,
      "params": { "sku": "40330000", "wymiary_cm": { "szerokosc": 36, "glebokosc": 36 } },
      "images": [
        { "file": "oltens-40330000-packshot.jpg", "sortOrder": 0, "role": "cutout" },
        { "file": "oltens-40330000-bok.jpg",      "sortOrder": 1, "role": "cutout" },
        { "file": "oltens-40330000-aranz.jpg",    "sortOrder": 2, "role": "lifestyle" }
      ]
    }
  ]
}
```

- `images[].file` = nazwa pliku w `rawdata/<nazwa>/images/`; alternatywnie `images[].src` = URL (scraping).
- `attributes` (opis wizualny) możesz dołożyć per zdjęcie — wtedy import ich nie liczy ponownie.
- `embedding` **pomijaj** — policzy Titan przy imporcie. Wyjątek: re-import z eksportu kolekcji
  (`GET /catalogs/{id}/export`), który zawiera gotowe embeddingi i nie wymaga Bedrocka.

**`POST /products`** (kanoniczny zapis, używany przez skrypty i panel):
`name, optimaId, manufacturer, manufacturerCode, source, sourceUrl, category, subtype, catalogId,
catalogPage, groupId, params, describe: false, images: [{ key, sortOrder, attributes?, embedding? }]`.

`describe: false` = nie wołaj Sonneta o opis przy imporcie (kanon kosztowy).

---

## 11. Kontrola jakości — lista do odhaczenia po każdym imporcie

1. **Liczby się zgadzają:** produktów w `collection.json` = produktów w bazie (minus zgłoszone duplikaty).
2. **Zero `inne`** i zero pustych kategorii — `GET /categories` po imporcie.
3. **Rozkład zdjęć:** średnia 1–4 na produkt; policz produkty z jednym zdjęciem (kandydaci do uzupełnienia).
4. **Duplikaty ujęć:** `node scripts/dedupe-images.mjs` (dry-run) — jeśli >10% do usunięcia, popraw skrypt ekstrakcji.
5. **Wzrokowa próbka 10 losowych rekordów:** nazwa niesie typ? zdjęcie główne to packshot? wymiary sensowne?
6. **Test wyszukiwania:** weź 3 produkty z importu, wytnij ich zdjęcie i puść przez `/search`
   (tryb szybki = darmowy). Każdy powinien znaleźć **sam siebie na #1**. Jeśli nie — zdjęcie główne albo kategoria są złe.
7. **Test substytutu:** znajdź produkt spoza bazy z tej samej kategorii i sprawdź, czy propozycje są sensowne.
8. Wynik zapisz w podsumowaniu importu (ile produktów, rozkład kategorii/subtype, produkty wymagające poprawki).

---

## 12. Generyczność — jak nie utknąć przy następnej zmianie decyzji

Decyzje o rankingu zmieniają się (w tym projekcie zmieniły się kilka razy w jednym tygodniu). Dane mają je przetrwać.

1. **Nie kasuj surowych danych.** `rawdata/<nazwa>/` + oryginalny PDF w S3 = możliwość powtórzenia importu
   bez dostępu do źródła (sklep może zmienić stronę, katalog może zniknąć).
2. **Skrypt ekstrakcji w repo, dane poza repo.** Import ma być funkcją: źródło → `collection.json`.
3. **Zapisuj więcej niż dziś używamy** (dodatkowe klucze w `params`) — dołożenie sygnału do rankingu
   nie może wymagać ponownego zbierania danych.
4. **Nie twórz nowych kategorii ani subtypów bez zmiany kanonu** — najpierw uzgodnij i dopisz do
   `docs/product-description-spec.md` oraz listy w `search/handler.py`, potem importuj.
5. **Eksportuj kolekcję po udanym imporcie** (`GET /catalogs/{id}/export`) — paczka z embeddingami pozwala
   odtworzyć bazę bez ani jednego wywołania Bedrocka.
6. **Wszystko, co robi model, musi być odtwarzalne:** zapisuj w `params.zrodlo`, skąd wzięte są dane
   (strona katalogu, URL), żeby dało się zweryfikować wątpliwy rekord bez zgadywania.

---

## 13. Przepływ pracy ze mną (Claude Code)

> **Najkrócej: wpisz `/import-katalog`.** Skill (`.claude/skills/import-katalog/SKILL.md`) prowadzi
> wszystkie kroki poniżej i sam wczytuje ten kanon oraz kanony zdjęć i opisu.

1. **Bootstrap:** `python scripts/prepare-catalog.py <pdf> <nazwa> [--manufacturer X] [--category Y]`
   → `rawdata/<nazwa>/PROBE.json` + `CLAUDE_INSTRUCTIONS.md` + `samples/`.
2. Powiedz mi: **„przygotuj katalog `<nazwa>`"**. Przeczytam ten kanon + `CLAUDE_INSTRUCTIONS.md`,
   obejrzę próbki stron i napiszę `scripts/extract-<nazwa>.py`, a potem `collection.json`.
3. **Zanim zaimportujesz — poproś o próbkę:** „pokaż 10 gotowych rekordów". Sprawdzimy nazwy, kategorie
   i zdjęcia główne, zanim policzymy embeddingi dla całości.
4. **Import:** panel admina → Import kolekcji (folder `rawdata/<nazwa>/`) albo `node scripts/seed-*.mjs`.
5. **Po imporcie:** przejdź listę z punktu 11 — poproś mnie: „zrób kontrolę jakości importu `<nazwa>`".
6. Jeśli coś jest nie tak: `DELETE /catalogs/{id}`, poprawiamy skrypt, importujemy ponownie.
   Dlatego partie mają być małe i tematyczne.

**Czego ode mnie oczekiwać:** zapytam o kategorię przy produktach granicznych, zgłoszę produkty
z podejrzanym zdjęciem głównym i wypiszę te, dla których nie dało się ustalić typu — zamiast wpisać `inne`.
