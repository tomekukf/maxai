"""Render stron katalogu PDF do lekkich JPEG (Faza 9A — szybkie otwieranie strony katalogu).

Zamiast pobierać cały PDF (200 MB) przy każdym „Otwórz katalog", pokazujemy JEDNĄ stronę
jako obraz (~200 KB). Render lokalny (bez AWS/Bedrock); pliki wgrywamy potem do S3.

Wynik: rawdata/<nazwa>/pages/p{i}.jpg  (i = 0-based indeks strony PDF = catalog_page - 1)

Użycie:
  python scripts/render-catalog-pages.py <pdf> <nazwa> [--dpi 100]
Potem:
  aws s3 cp rawdata/<nazwa>/pages "s3://<bucket>/catalogs/<folder>/pages/" --recursive
"""
import argparse
import io
import os
import sys

import fitz  # pymupdf

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("name")
    ap.add_argument("--dpi", type=int, default=100)
    args = ap.parse_args()

    out = f"rawdata/{args.name}/pages"
    os.makedirs(out, exist_ok=True)
    doc = fitz.open(args.pdf)
    n = doc.page_count
    total = 0
    for i in range(n):
        pix = doc[i].get_pixmap(dpi=args.dpi)
        fn = f"{out}/p{i}.jpg"
        pix.save(fn)  # pymupdf zapisuje JPEG po rozszerzeniu .jpg
        total += os.path.getsize(fn)
        if i % 50 == 0:
            print(f"… {i + 1}/{n}")
    print(f"Gotowe: {n} stron → {out}/  (łącznie ~{total // (1024 * 1024)} MB, dpi={args.dpi})")


if __name__ == "__main__":
    main()
