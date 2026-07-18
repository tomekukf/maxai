"""Bootstrap onboardingu katalogu PDF (Krok 7.6).

Sonduje dowolny katalog PDF i generuje:
  rawdata/<nazwa>/PROBE.json            — fakty o strukturze (dla Claude Code)
  rawdata/<nazwa>/CLAUDE_INSTRUCTIONS.md — lista kroków dla Claude, jak wyprodukować collection.json
  rawdata/<nazwa>/samples/*.png          — próbki stron do wglądu

NIE używa AWS/Bedrock. Po uruchomieniu poproś Claude Code: „przygotuj katalog <nazwa>".

Użycie:
  python scripts/prepare-catalog.py <pdf> <nazwa> [--manufacturer X] [--category Y]
"""
import argparse
import io
import json
import os
import re
import sys
from collections import Counter

import fitz  # pymupdf

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

CODE_RE = re.compile(r"\b([A-Z]\d{3,4}[A-Z]?)\b")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("name")
    ap.add_argument("--manufacturer", default="")
    ap.add_argument("--category", default="")
    args = ap.parse_args()

    if not os.path.exists(args.pdf):
        print(f"Brak pliku: {args.pdf}")
        sys.exit(1)

    out = f"rawdata/{args.name}"
    samples = f"{out}/samples"
    os.makedirs(samples, exist_ok=True)
    doc = fitz.open(args.pdf)
    n = doc.page_count

    # Rozkładówki: strona treści zwykle szersza niż okładka (2 strony obok siebie).
    w0 = doc[0].rect.width
    wc = doc[min(3, n - 1)].rect.width
    is_spread = wc > w0 * 1.4

    # Warstwa tekstu + kody + indeks (na próbie stron treści).
    text_len = 0
    codes = Counter()
    index_hits = 0
    img_counts = []
    scan_to = min(n, 40)
    for i in range(scan_to):
        t = doc[i].get_text()
        text_len += len(t)
        for c in CODE_RE.findall(t):
            codes[c[0]] += 1
        index_hits += len(re.findall(r"\bp\.\s*\d{1,3}\b", t))
        img_counts.append(len(doc[i].get_images()))

    has_text = text_len > 200 * scan_to * 0.1  # heurystyka: sensowna ilość tekstu
    prefixes = dict(codes.most_common())

    # Próbki: pierwsze strony z kodami (prawdopodobnie produktowe).
    sample_pages = []
    for i in range(min(n, 60)):
        if CODE_RE.search(doc[i].get_text()):
            doc[i].get_pixmap(dpi=90).save(f"{samples}/p{i}.png")
            sample_pages.append(i)
        if len(sample_pages) >= 4:
            break

    probe = {
        "pdf": args.pdf,
        "name": args.name,
        "manufacturer": args.manufacturer or None,
        "category_hint": args.category or None,
        "page_count": n,
        "is_spread": is_spread,
        "printed_to_pdf_hint": "pdf_index = strona_drukarska // 2" if is_spread else "pdf_index ≈ strona_drukarska",
        "has_text_layer": has_text,
        "code_prefixes": prefixes,
        "index_like_hits": index_hits,
        "avg_images_per_page": round(sum(img_counts) / max(1, len(img_counts)), 1),
        "sample_pdf_pages": sample_pages,
    }
    with open(f"{out}/PROBE.json", "w", encoding="utf-8") as f:
        json.dump(probe, f, ensure_ascii=False, indent=2)

    _write_instructions(out, args, probe)

    print(f"Sondowanie gotowe → {out}/PROBE.json + CLAUDE_INSTRUCTIONS.md + samples/")
    print(f"Strony: {n} | rozkładówki: {is_spread} | tekst: {has_text} | prefiksy kodów: {prefixes}")
    print(f"\n>> Teraz poproś Claude Code: „przygotuj katalog {args.name}\"")


def _write_instructions(out, args, probe):
    md = f"""# Instrukcje dla Claude Code — przygotowanie katalogu „{args.name}"

Wygenerowane przez `prepare-catalog.py`. Cel: wyprodukować lokalnie (bez Bedrock)
`rawdata/{args.name}/collection.json` + `rawdata/{args.name}/images/`, gotowe do importu
w panelu admina (Import kolekcji).

## Fakty (z PROBE.json)
- Strony PDF: {probe['page_count']} · rozkładówki: {probe['is_spread']} ({probe['printed_to_pdf_hint']})
- Warstwa tekstu: {probe['has_text_layer']} · prefiksy kodów: {probe['code_prefixes']}
- Śr. obrazów/stronę: {probe['avg_images_per_page']} · próbki: `samples/` (strony {probe['sample_pdf_pages']})

## Kroki
1. **Obejrzyj próbki** (`rawdata/{args.name}/samples/*.png`) i odczytaj tekst kilku stron
   (`fitz`), by rozpoznać układ: gdzie nazwa, kod(y), specyfikacja, które zdjęcie to cutout, a które render.
2. **Skopiuj szablon** `scripts/extract-maxlight.py` → `scripts/extract-{args.name}.py` i dostrój:
   - `CONTENT_START` (pierwsza strona produktowa), mapowanie strony (rozkładówki: `pdf_index*2`).
   - `CODE_RE` (uwzględnij sufiks-literę, np. `P0635D`).
   - `CODE_SUBTYPE` — potwierdź WIZUALNIE mapowanie prefiks→subtype na próbkach (nie zgaduj).
   - Pola z warstwy tekstu (materiał, wykończenie, źródło światła, wymiary) — dwujęzyczne? bierz EN.
   - `category` = „{args.category or '<ustal>'}", `manufacturer` = „{args.manufacturer or '<ustal>'}".
3. **Klasyfikacja:** jeśli prefiks kodu nie wystarcza, dopisz subtype na podstawie próbek.
   Kategoria musi być kanonicznym slugiem (patrz `docs/product-description-spec.md`).
4. **Wyprodukuj `collection.json`** w formacie (zgodnym z importem panelu admina):
   ```json
   {{
     "catalog": {{ "name": "...", "manufacturer": "...", "domainCategory": "...", "pageCount": N }},
     "products": [
       {{ "name": "...", "optimaId": null, "category": "...", "subtype": "...",
          "manufacturer": "...", "manufacturerCode": "<pierwszy kod>",
          "params": {{ "codes": [...], "material": "...", "finish": "...", "printed_page": N, "viewer_page": N }},
          "catalogPage": <pdf_index+1>,
          "images": [ {{ "file": "nazwa.jpg", "role": "cutout|lifestyle" }} ] }}
     ]
   }}
   ```
   - Zdjęcia zapisz do `rawdata/{args.name}/images/`; `images[].file` = sama nazwa pliku.
   - `embedding` POMIŃ (policzy Titan przy imporcie). Atrybuty wizualne opcjonalnie.
5. **Zweryfikuj:** liczba produktów, brak duplikatów kodów, próbka wpisów sensowna.
   Wypisz podsumowanie (ile produktów, rozkład subtype).
6. (Opcjonalnie) PDF do S3 pod link „Otwórz katalog":
   `aws s3 cp "{args.pdf}" s3://<bucket>/catalogs/{args.name}/original.pdf` (bucket = output `FilesBucketName`).

## Po zakończeniu
Powiedz użytkownikowi: „Gotowe — zaimportuj `rawdata/{args.name}/` w panelu admina → Import kolekcji".
"""
    with open(f"{out}/CLAUDE_INSTRUCTIONS.md", "w", encoding="utf-8") as f:
        f.write(md)


if __name__ == "__main__":
    main()
