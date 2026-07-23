# Reguła doboru zdjęć produktu — kanon dla maxai

Jedno źródło prawdy o tym, **ile zdjęć i jakich** wciągać do bazy podczas zasilania
(katalogi PDF, scraping, import kolekcji). Obowiązuje każdy skrypt i każdy model
przygotowujący `collection.json` / wywołujący `POST /products`.

> Ten plik jest nadrzędny. `scripts/prepare-catalog.py` (generator `CLAUDE_INSTRUCTIONS.md`)
> i `docs/product-description-spec.md` muszą być z nim zgodne.

## Dlaczego to ma znaczenie (jak system zużywa zdjęcia)

| etap wyszukiwania | ile zdjęć bierze |
|---|---|
| **Retrieve** (pgvector) | **wszystkie** — wybierane jest *najlepiej pasujące* ujęcie produktu. Tu każde dodatkowe zdjęcie zwiększa szansę trafienia. |
| **Pobranie do reranku** | **maks. 4** (`ORDER BY sort_order LIMIT 4`) — piąte i dalsze **nigdy** nie trafią do sędziego |
| **Rerank (Sonnet)** | twardy budżet `RERANK_IMG_BUDGET` (domyślnie **8 zdjęć na całe zapytanie**), dzielony na kandydatów: przy 8 kandydatach = **1 zdjęcie każdemu, zawsze to główne** |

Wniosek: **zdjęcie główne decyduje**, dodatkowe pomagają tylko w retrieve, a powyżej
czterech nie robią już nic.

## Zasady

1. **Cel: 3 zdjęcia na produkt. Twardy sufit: 4.** Piątego i kolejnych nie wciągamy —
   nie mają jak wpłynąć na wynik, a puchną w bazie i w koszcie embeddingów.
2. **Minimum: 1 zdjęcie** — czysty packshot. Lepiej jedno dobre niż trzy przypadkowe.
3. **Kolejność jest znacząca.** `sortOrder: 0` = zdjęcie główne; to jedyne, które
   w domyślnej konfiguracji widzi sędzia. Wybieraj je świadomie, nie „pierwsze z brzegu".
4. **Nie wciągaj duplikatów ujęcia.** Jeśli dwa kadry różnią się tylko lekkim obrotem,
   cieniem albo kompresją — bierz jeden. Próg praktyczny: gdyby dwa zdjęcia dało się
   podmienić bez zauważenia różnicy, to jest duplikat.
5. **Warianty kolorystyczne to NIE duplikaty.** Ten sam mebel w szarej i różowej tkaninie
   to dwa użyteczne ujęcia (kolor bywa jedynym sygnałem odróżniającym w retrieve).
   Jeśli producent daje osobne kody na kolory — to zwykle osobne produkty (`groupId` je zwiąże).

## Które ujęcia wybrać (w tej kolejności)

| `sortOrder` | ujęcie | po co |
|---|---|---|
| **0 (główne)** | **packshot na jednolitym tle, cały produkt, front lub 3/4** | jedyne zdjęcie widziane przez sędziego — musi pokazywać **bryłę i kształt** bez zakłóceń |
| 1 | **inne ujęcie bryły** — bok, profil, tył, widok z góry | niesie informację o kształcie, której nie widać z frontu |
| 2 | **aranżacja lub detal faktury** | kadry z wizualizacji też są „scenami" — to ujęcie łapie je w retrieve |
| 3 | (opcjonalnie) drugi detal / wariant wykończenia | tylko jeśli realnie różny |

## Czego NIE wciągać — nigdy jako główne

- **rysunki techniczne i szkice wymiarowe** (retrieve dopasuje je do innych rysunków, nie do produktu),
- **banery i grafiki opakowań** („x20 szt.", logotypy, plansze z ceną),
- **zdjęcia zbiorcze rodziny produktów** (kilka modeli na jednym kadrze — model nie wie, który to ten),
- **kadry, gdzie produkt jest tłem** albo zajmuje mniej niż ~⅓ kadru,
- **zdjęcia mocno stylizowane** (ciemna aranżacja, silne światło barwne) — jako główne zniekształcają kolor i bryłę,
- **ten sam packshot w innej rozdzielczości**.

Jeśli jedyne dostępne zdjęcie jest z tej listy — wciągnij je, ale odnotuj produkt jako
wymagający poprawki (admin ma w panelu „Ustaw jako główne" do reorganizacji ujęć).

## Kontrola jakości po imporcie

- **Produkty z 1 zdjęciem** — akceptowalne, ale to kandydaci do uzupełnienia w pierwszej kolejności.
- **Deduplikacja** — `node scripts/dedupe-images.mjs` (dry-run domyślnie) usuwa ujęcia o kosinusie
  ≥ progu względem już zachowanych. **Bezpieczny próg to 0.95**; przy 0.90 kasowane są
  warianty kolorystyczne (zweryfikowane wzrokowo: fotel w dwóch kolorach ma kosinus ~0.90).
- Skrypt nigdy nie usuwa zdjęcia głównego ani ostatniego zdjęcia produktu i **nie rusza plików w S3**.

## Format w `collection.json` / `POST /products`

```json
"images": [
  { "file": "sofa-alto-packshot.jpg", "sortOrder": 0, "role": "cutout" },
  { "file": "sofa-alto-bok.jpg",      "sortOrder": 1, "role": "cutout" },
  { "file": "sofa-alto-aranzacja.jpg","sortOrder": 2, "role": "lifestyle" }
]
```

`sortOrder` rosnąco od 0; `role` jest opisowe (nie wpływa na ranking, ułatwia audyt).
`embedding` pomijamy — policzy Titan przy imporcie (chyba że robimy re-import z eksportu kolekcji).
