# Model danych produktu (`params`) — kanon dla maxai

Jedno źródło prawdy dla **struktury `params`** (JSONB w tabeli `products`). Ten sam kształt
produkujemy przy: ręcznym zasilaniu (IngestPage), scraperze, ekstrakcji z opisu (`/extract`),
opisie wizualnym (`/describe`, Faza B) oraz przyszłym imporcie z PDF (katalog).

## Zasady

1. `params` to **JSONB** — **rozszerzalny bez migracji**. Nowe pola dodajemy swobodnie; nic nie psują.
2. Pola opcjonalne: czego nie ma → pomijamy albo `null`. Nie wymyślamy danych.
3. Sekcje mają **stałe nazwy** (poniżej), żeby dane były porównywalne między produktami i przy
   dopasowaniu. Wewnątrz sekcji (np. `specyfikacja`) można dokładać dowolne klucze.
4. Sygnały do dopasowania: `opis_wizualny` (główny, z vision), `wymiary_cm` i `specyfikacja`
   (pomocnicze — rerank może je uwzględniać, np. zbliżone wymiary/funkcje podbijają dopasowanie).

## Kształt `params`

```json
{
  "kategoria": "string|null",           // sofa, narożnik, fotel, lampa, stół...
  "kod_produktu": "string|null",
  "cena_pln": "number|null",

  "wymiary_cm": {                       // wymiary — sekcja stała, klucze rozszerzalne
    "szerokosc": "number|null",
    "glebokosc": "number|null",
    "wysokosc": "number|null",
    "wysokosc_siedziska": "number|null",
    "dlugosc_spania": "number|null",
    "szerokosc_spania": "number|null"
  },

  "opis_wizualny": {                    // z vision (Faza B) — schemat w product-description-spec.md
    "typ": "string|null",
    "ksztalt_ogolny": "string|null",
    "material": "string|null",
    "kolor_dominujacy": "string|null",
    "styl": "string|null",
    "cechy": ["string"],
    "opis_swobodny": "string|null"
    // ...pełny schemat: docs/product-description-spec.md
  },

  "warianty": [                         // dostępne warianty (kolor/rozmiar/konfiguracja)
    { "nazwa": "string|null", "kolor": "string|null", "material": "string|null", "kod": "string|null" }
  ],

  "specyfikacja": {                     // specyfikacja techniczna — sekcja stała, klucze DOWOLNE/rozszerzalne
    "konstrukcja": "string|null",       // np. drewno + płyta, stelaż metalowy
    "wypelnienie": "string|null",       // pianka HR, sprężyny bonell, granulat...
    "funkcje": ["string"],              // funkcja spania, pojemnik, regulowane zagłówki...
    "nosnosc_kg": "number|null",
    "gwarancja": "string|null",
    "kraj_pochodzenia": "string|null"
    // dowolne kolejne klucze w przyszłości — bez migracji
  },

  "material": "string|null",            // szybkie pola pomocnicze (mogą duplikować opis_wizualny)
  "kolor": "string|null",
  "styl": "string|null"
}
```

## Jak wypełniamy poszczególne sekcje

| Sekcja | Źródło |
|---|---|
| `kategoria`, `kod_produktu`, `cena_pln` | scraper / ręcznie / `/extract` |
| `wymiary_cm` | **ręcznie (IngestPage)**, `/extract` z opisu, w przyszłości z tabel w PDF |
| `opis_wizualny` | **`/describe` (vision)** — Faza B |
| `warianty`, `specyfikacja` | ręcznie / `/extract` z opisu / import PDF |
| `material`, `kolor`, `styl` | `/extract` lub `opis_wizualny` |

## Rozszerzanie w przyszłości

- Nowe pole w istniejącej sekcji (np. `specyfikacja.certyfikaty`) — po prostu dokładamy; JSONB, zero migracji.
- Nowa sekcja (np. `dostepnosc`, `logistyka`) — dodajemy klucz najwyższego poziomu i opisujemy tutaj.
- Twardsze zapytania (filtry) po konkretnym polu — można dołożyć indeks GIN po ścieżce JSONB, gdy zajdzie potrzeba.
