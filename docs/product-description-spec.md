# Reguła opisu produktu (wizualnego) — kanon dla maxai

Jedno źródło prawdy dla opisywania produktów przez model wizyjny (Claude).
Ten sam schemat i prompt stosujemy **przy zasilaniu bazy** (opis produktu katalogowego)
oraz **przy wyszukiwaniu** (opis wyciętego mebla z wizualizacji) — dzięki temu opisy są
porównywalne i stanowią drugi (obok embeddingu wizualnego) „punkt zaczepienia" przy dopasowaniu.

> Zmiany w tym pliku są nadrzędne. Prompt w Lambdach (`backend/lambdas/describe/…`) musi być
> z nim zsynchronizowany (kopiujemy stąd).

## Zasady ogólne

1. Opisuj **wyłącznie to, co widać** na obrazie. Nie zgaduj marki, ceny, wymiarów w cm
   (chyba że widoczne na zdjęciu). Czego nie widać → `null` (lub `[]` dla list).
2. Po **polsku**, zwięźle ale **konkretnie** (rzeczowniki + cechy, nie lanie wody).
3. Skupiaj się na **cechach różnicujących** wygląd: bryła, kształt, proporcje, detale.
   To one decydują o „podobny / niepodobny".
4. Zwracaj **wyłącznie poprawny JSON** wg schematu poniżej (bez markdown, bez komentarzy).
5. Schemat jest **ogólny dla mebli i produktów wnętrzarskich** (sofy, fotele, stoły, lampy…).
   Pola nieadekwatne do danego typu → `null`.

## Schemat JSON

```json
{
  "typ": "string|null",                // sofa, narożnik, fotel, krzesło, stół, lampa, komoda, regał...
  "podtyp": "string|null",             // np. '3-osobowa rozkładana', 'lampa wisząca', 'stół rozkładany'
  "ksztalt_ogolny": "string|null",     // bryła: prostokątna/kompaktowa/nisko osadzona/smukła/masywna
  "sylwetka": "string|null",           // proporcje: wys. oparcia, głębokość siedziska, lekkość/masywność
  "oparcie": "string|null",            // proste/pikowane/z luźnymi poduchami/wysokie/niskie/brak
  "podlokietniki": "string|null",      // brak/szerokie/wąskie/proste/zaokrąglone/drewniane/tapicerowane
  "nogi_podstawa": "string|null",      // drewniane/metalowe/kryte/wysokie/niskie/skośne/płozy + kolor
  "poduszki": "string|null",           // liczba, kształt, pikowanie
  "material": "string|null",           // welur/sztruks/tkanina/skóra/ekoskóra/plecionka/drewno/metal/szkło
  "kolor_dominujacy": "string|null",   // np. 'szary', 'butelkowa zieleń', 'beż'
  "kolory_dodatkowe": ["string"],      // akcenty, kontrastowe elementy
  "wzor_faktura": "string|null",       // gładki/prążkowany/pikowany/melanż/połysk/mat
  "styl": "string|null",               // nowoczesny/skandynawski/klasyczny/glamour/loft/industrialny/boho
  "cechy": ["string"],                 // funkcja spania, pojemnik, regulowane zagłówki, ściągane pokrowce...
  "wymiary_cm": {                      // tylko jeśli widoczne/podane na obrazie, inaczej null
    "szerokosc": "number|null",
    "glebokosc": "number|null",
    "wysokosc": "number|null"
  },
  "opis_swobodny": "string"            // 1-2 zdania naturalnego opisu wyglądu (do rerankingu/tekstu)
}
```

## Prompt systemowy (do skopiowania do Lambdy)

```
Jesteś ekspertem od opisu wizualnego mebli i produktów wnętrzarskich. Na podstawie zdjęcia
opisz produkt WYŁĄCZNIE tym, co widać. Zwróć wyłącznie poprawny JSON wg schematu:
{typ, podtyp, ksztalt_ogolny, sylwetka, oparcie, podlokietniki, nogi_podstawa, poduszki,
material, kolor_dominujacy, kolory_dodatkowe[], wzor_faktura, styl, cechy[],
wymiary_cm{szerokosc,glebokosc,wysokosc}, opis_swobodny}.
Po polsku, zwięźle i konkretnie, skupiając się na cechach różnicujących wygląd (bryła, kształt,
proporcje, detale). Czego nie widać → null (lub [] dla list; wymiary tylko jeśli widoczne).
Bez markdown, bez komentarzy — sam JSON.
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
