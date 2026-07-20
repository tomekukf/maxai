"""Ekstraktor katalogów MAXLIVING (dane wewnętrzne, PDF, 1 produkt/stronę) → rawdata/<nazwa>/ (Faza 5/10).

Lokalnie, bez AWS/Bedrock. Tożsamość = NAZWA + ref do katalogu (źródło) + strona (link).
Bez kodów/SKU. Zdjęcia osadzone (aranżacyjne). Kategoria: domyślna per katalog + override z tytułu.

Wynik: rawdata/<nazwa>/collection.json (format importu) + rawdata/<nazwa>/images/.
Strony do linku „otwórz stronę": osobno `render-catalog-pages.py`.

Użycie:
  python scripts/extract-maxliving.py "<pdf>" <nazwa-folder> --category fotel [--from 1]
"""
import argparse
import io
import json
import os
import re
import sys

import fitz

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

MANUFACTURER = "MAXLIVING"
# Override kategorii z linii typu (ASCII-bezpieczne prefiksy — get_text gubi polskie znaki).
TYPE_RULES = [
    (r"naro", "naroznik"), (r"sofa|kanap", "sofa"), (r"fotel", "fotel"),
    (r"krzes|taboret|hoker", "krzeslo"), (r"stolik|\bława|\blawa", "stolik"),
    (r"biurko", "stol"), (r"st[o�]?[l�]", "stol"),
    (r"[l�][o�]?[z�]k", "lozko"), (r"komod", "komoda"),
    (r"bibliotek|rega", "regal"), (r"kontener|szaf", "szafka"), (r"materac", "materac"),
]


def clean(s):
    return re.sub(r"\s{2,}", " ", (s or "").strip())


def category_of(default, type_line):
    t = (type_line or "").lower()
    for rx, cat in TYPE_RULES:
        if re.search(rx, t):
            return cat
    return default


def params_of(text):
    p = {}
    m = re.search(r"(?:Rozmiar|Wymiary)[^\n]*\n\s*([\d/x×.,\s]+cm)", text, re.I)
    if m:
        p["wymiary"] = clean(m.group(1))
    m = re.search(r"(?:Wype[^\n:]*)\n\s*([^\n]+)", text, re.I)
    if m:
        p["wypelnienie"] = clean(m.group(1))
    m = re.search(r"(?:Stela[^\n:]*)\n\s*([^\n]+)", text, re.I)
    if m:
        p["stelaz"] = clean(m.group(1))
    m = re.search(r"Grupy materia[^\n]*\n\s*([^\n]+)", text, re.I)
    if m:
        p["grupy_materialowe"] = clean(m.group(1))
    m = re.search(r"\b(BY [A-ZĄĆĘŁŃÓŚŹŻ .\-]+|PROD\.? [A-ZĄĆĘŁŃÓŚŹŻ .\-]+)", text)
    if m:
        p["podmarka"] = clean(m.group(1))
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("name")
    ap.add_argument("--category", required=True)
    ap.add_argument("--from", dest="frm", type=int, default=1)
    args = ap.parse_args()

    out = f"rawdata/{args.name}"
    img_dir = f"{out}/images"
    os.makedirs(img_dir, exist_ok=True)
    doc = fitz.open(args.pdf)

    products = []
    for pi in range(args.frm, doc.page_count):
        page = doc[pi]
        text = page.get_text()
        imgs = [im for im in page.get_images(full=True)
                if (lambda d: d["width"] * d["height"] >= 200 * 200)(doc.extract_image(im[0]))]
        lines = [clean(l) for l in text.splitlines() if clean(l)]
        # strona produktowa: ma zdjęcie, nazwę i słowo-specyfikację
        has_spec = re.search(r"Rozmiar|Wymiary|Grupy materia|Wysoko|Wype|Stela|Szeroko", text, re.I)
        if not imgs or not lines or not has_spec:
            continue
        name = lines[0]
        type_line = lines[1] if len(lines) > 1 else ""
        cat = category_of(args.category, type_line)
        saved = []
        big = max(imgs, key=lambda im: doc.extract_image(im[0])["width"] * doc.extract_image(im[0])["height"])
        for k, im in enumerate(imgs):
            d = doc.extract_image(im[0])
            fn = f"{re.sub(r'[^a-z0-9]+','-',name.lower()).strip('-')[:40]}_{pi}_{k}.{d['ext']}"
            with open(f"{img_dir}/{fn}", "wb") as f:
                f.write(d["image"])
            saved.append({"file": fn, "role": "cutout" if im is big else "lifestyle", "sortOrder": k})
        products.append({
            "name": name,
            "manufacturer": MANUFACTURER,
            "manufacturerCode": None,
            "category": cat,
            "subtype": None,
            "group_id": re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"),
            "source": "catalog",
            "catalogPage": pi + 1,
            "params": {"typ": type_line, "printed_page": pi + 1, **params_of(text)},
            "images": saved,
        })

    pkg = {
        "catalog": {"name": f"MAXLIVING — {args.name}", "manufacturer": MANUFACTURER,
                    "domainCategory": args.category, "pageCount": doc.page_count},
        "products": products,
    }
    with open(f"{out}/collection.json", "w", encoding="utf-8") as f:
        json.dump(pkg, f, ensure_ascii=False, indent=2)
    from collections import Counter
    print(f"Produktów: {len(products)} | kategorie: {dict(Counter(p['category'] for p in products))}")
    print(f"Zapisano: {out}/collection.json + {img_dir}/")
    for p in products[:5]:
        print(f"  - {p['name']} [{p['category']}] str.{p['catalogPage']} zdjęć={len(p['images'])} | {p['params'].get('wymiary')}")


if __name__ == "__main__":
    main()
