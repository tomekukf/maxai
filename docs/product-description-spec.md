# Reguła opisu produktu (wizualnego) — kanon dla maxai

Jedno źródło prawdy dla opisywania produktów przez model wizyjny (Claude).
Ten sam schemat i prompt stosujemy **przy zasilaniu bazy** (opis produktu katalogowego)
oraz **przy wyszukiwaniu** (opis wyciętego mebla z wizualizacji) — dzięki temu opisy są
porównywalne i stanowią drugi (obok embeddingu wizualnego) „punkt zaczepienia" przy dopasowaniu.

> Zmiany w tym pliku są nadrzędne. Prompt w Lambdach (`backend/lambdas/describe/…`) musi być
> z nim zsynchronizowany (kopiujemy stąd).

> **Ile zdjęć i które wciągać do bazy** — osobny kanon: `docs/product-images-spec.md`
> (3 zdjęcia na produkt, maks. 4; `sortOrder: 0` = packshot, bo tylko on trafia do reranku).

## Zasady ogólne

1. Opisuj **wyłącznie to, co widać** na obrazie. Nie zgaduj marki, ceny, wymiarów w cm
   (chyba że widoczne na zdjęciu). Czego nie widać → `null` (lub `[]` dla list).
2. Po **polsku**, zwięźle ale **konkretnie** (rzeczowniki + cechy, nie lanie wody).
3. Skupiaj się na **cechach różnicujących** wygląd: bryła, kształt, proporcje, detale.
   To one decydują o „podobny / niepodobny".
4. Zwracaj **wyłącznie poprawny JSON** wg schematu poniżej (bez markdown, bez komentarzy).
5. Schemat jest **adaptacyjny per kategoria** (meble, oświetlenie, płytki, dywany…).
   **Rdzeń wspólny** wypełniamy zawsze; **`kategoria` i `subtype` są obowiązkowe** (to one budują
   twardą bramkę i sygnał różnicujący w wyszukiwaniu). Cechy specyficzne dla danej kategorii idą do
   obiektu `atrybuty_kategorii` (klucze zależne od kategorii). Pola nieadekwatne → `null`.

### Kategorie (kanoniczne slugi) i podtypy
- **meble tapicerowane:** `sofa, naroznik, fotel` → subtype np. `3-osobowa`, `rozkladana`, `z_szezlongiem`.
- **inne meble:** `krzeslo, stol, stolik, lozko, szafka, komoda, regal` → subtype np. `rozkladany`, `barowe`.
- **oswietlenie** → subtype: `wiszaca, kinkiet, plafon, stolowa, podlogowa, reflektor_szynowy, downlight, zyrandol, listwa_liniowa, system_magnetyczny`.
- **mebel** (ogólne, gdy nie da się doprecyzować), **lustro**.
- **wykończenie/łazienka (oferta maxfliz):** `plytki` (subtype: `scienne/podlogowe`, format), `podlogi` (panele/deska),
  `lazienka` (umywalki/baterie/prysznice/wanny/armatura), `drzwi`, `sztukateria` (listwy/rozety/profile), `tapety` (fototapety/dekoracje ścienne).
- **dywan, dekoracja, inne** → subtype wg sensu.

## Schemat JSON

```json
{
  "kategoria": "string",               // OBOWIĄZKOWE, kanoniczny slug (patrz lista wyżej)
  "subtype": "string|null",            // OBOWIĄZKOWE gdy możliwe do ustalenia; generyczny podtyp w obrębie kategorii
  "typ": "string|null",                // czytelna nazwa typu (np. 'lampa wisząca', 'sofa 3-osobowa')
  "ksztalt_ogolny": "string|null",     // bryła: kula/dysk/walec/prostokątna/smukła/masywna...
  "material": "string|null",           // dominujący materiał: metal/szkło/trawertyn/alabaster/tkanina/skóra/drewno...
  "kolor_dominujacy": "string|null",   // np. 'czarny', 'złoty', 'biały', 'beż'
  "kolory_dodatkowe": ["string"],      // akcenty, kontrastowe wykończenia
  "wzor_faktura": "string|null",       // gładki/prążkowany/marmurowy/pikowany/połysk/mat
  "styl": "string|null",               // nowoczesny/glamour/industrialny/skandynawski/klasyczny/boho...
  "cechy": ["string"],                 // cechy różnicujące (funkcje, detale)
  "wymiary_cm": {                      // tylko jeśli widoczne/podane, inaczej null
    "szerokosc": "number|null", "glebokosc": "number|null", "wysokosc": "number|null", "srednica": "number|null"
  },
  "atrybuty_kategorii": { },           // cechy specyficzne dla kategorii (klucze zależne — patrz niżej)
  "opis_swobodny": "string"            // 1-2 zdania naturalnego opisu wyglądu (do rerankingu/tekstu)
}
```

**`atrybuty_kategorii` — przykładowe klucze per kategoria:**
- **oswietlenie:** `typ_montazu`, `klosz` (kształt+materiał), `zrodlo_swiatla` (np. 'G9', 'LED'), `liczba_punktow`, `barwa_swiatla`, `regulacja`.
- **meble tapicerowane:** `oparcie`, `podlokietniki`, `nogi_podstawa`, `poduszki`, `sylwetka`.
- **stol/krzeslo:** `blat`/`siedzisko`, `nogi_podstawa`, `regulacja`.
- **plytki:** `format`, `powierzchnia` (mat/połysk/struktura), `imitacja` (np. marmur/beton/drewno).

## Prompt systemowy (do skopiowania do Lambdy)

```
Jesteś ekspertem od opisu wizualnego mebli i produktów wnętrzarskich (meble, oświetlenie, płytki,
dywany…). Na podstawie zdjęcia opisz produkt WYŁĄCZNIE tym, co widać. NAJPIERW ustal `kategoria`
(kanoniczny slug: sofa, naroznik, fotel, krzeslo, stol, stolik, lozko, szafka, komoda, regal, mebel,
oswietlenie, plytki, podlogi, lazienka, drzwi, tapety, sztukateria, lustro, dywan, dekoracja, inne) oraz `subtype` (generyczny podtyp w obrębie kategorii,
np. dla oświetlenia: wiszaca/kinkiet/plafon/stolowa/podlogowa/reflektor_szynowy/downlight/zyrandol).
Zwróć wyłącznie poprawny JSON wg schematu:
{kategoria, subtype, typ, ksztalt_ogolny, material, kolor_dominujacy, kolory_dodatkowe[],
wzor_faktura, styl, cechy[], wymiary_cm{szerokosc,glebokosc,wysokosc,srednica},
atrybuty_kategorii{...}, opis_swobodny}.
`atrybuty_kategorii` dobierz do kategorii (oświetlenie: typ_montazu, klosz, zrodlo_swiatla,
liczba_punktow, barwa_swiatla; meble tapicerowane: oparcie, podlokietniki, nogi_podstawa, poduszki).
Po polsku, zwięźle i konkretnie, skupiając się na cechach różnicujących wygląd. Czego nie widać →
null (lub [] dla list; wymiary tylko jeśli widoczne). Bez markdown, bez komentarzy — sam JSON.
```

## Jak używamy tego w dopasowaniu (Faza B)

1. **Zasilanie:** dla każdego zdjęcia produktu generujemy ten JSON (Claude vision, Sonnet 5)
   i zapisujemy w bazie (kolumna/atrybuty). `opis_swobodny` + wybrane pola dają tekstowy sygnał.
2. **Wyszukiwanie (retrieve → rerank):**
   - **Retrieve:** embedding wizualny (Titan) daje szeroki TOP-K kandydatów (recall).
   - **Rerank:** opisujemy wycięty mebel tym samym schematem i **przerankowujemy** kandydatów,
     łącząc podobieństwo wizualne z **zgodnością atrybutów** (typ, kształt, materiał, kolor, styl,
     cechy). To eliminuje „3 sofy z dupy" i podbija precyzję.
3. **Spójność:** opis katalogowy i opis zapytania powstają z **tego samego promptu/schematu** —
   inaczej porównanie atrybutów byłoby niemiarodajne.

## Model

Do opisu używamy **Claude Sonnet 5** (lepsza percepcja/detale niż Haiku) — wymaga włączenia
dostępu w konsoli Bedrock (Model access). Haiku 4.5 jako fallback (niższa jakość opisu).
