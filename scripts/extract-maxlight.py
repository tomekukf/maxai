"""Ekstraktor katalogu Maxlight 2026 (PDF -> rawdata, LOKALNIE, bez LLM/AWS).

Wyciaga twarde dane z warstwy tekstu (kod, zrodlo swiatla, wykonczenie, material)
oraz osadzone zdjecia (cutout produktu + render aranzacyjny). Deterministyczny i
re-runnable. Wynik:
  rawdata/maxlight/products.raw.json   (dane per produkt, bez atrybutow wizualnych)
  rawdata/maxlight/images/*.jpeg|png   (zdjecia produktow)

Atrybuty wizualne (kategoria/podtyp/kolor/ksztalt/styl) dokladane w osobnym kroku
(analiza wizualna) -> products.json. Zaladowanie do S3/DB: seed-maxlight.mjs.

Uzycie:  python scripts/extract-maxlight.py [--limit N] [--from PDF_IDX] [--to PDF_IDX]

Model danych: produkt = strona produktowa (rozkladowka). Kolekcja rozbita na wiele
stron o roznych kodach/typach (np. LANDO: wiszaca P0650 vs kinkiet W0426) daje wiele
produktow - zgodne z podtypem. Mapowanie: pdf_index*2 = strona drukarska (lewa).
"""
import argparse
import io
import json
import os
import re
import sys

import fitz  # pymupdf

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

PDF = "rawdata/maxlight_2026.pdf"
OUT = "rawdata/maxlight"
IMGDIR = f"{OUT}/images"
CONTENT_START = 14  # pierwsze strony to okladka/wstep/indeks
MANUFACTURER = "Maxlight"

# Tokeny wielkoliterowe, ktore NIE sa nazwa produktu
STOP = {
    "IP44", "IP20", "IP54", "IP65", "IP", "LED", "DECO", "INDEX", "MAX", "LIGHT",
    "NEW", "G9", "E27", "E14", "GU10", "SMD", "CCT", "RGB", "DTW", "AC", "DC",
}
CODE_RE = re.compile(r"\b([A-Z]\d{4}[A-Z]?)\b")  # dopuszcza sufiks-literę (np. P0635D = wariant)
# Prefiks kodu -> podtyp opraw (POTWIERDZONE wizualnie na probkach Maxlight 2026).
CODE_SUBTYPE = {
    "P": "wiszaca",
    "W": "kinkiet",
    "C": "plafon",            # sufitowa natynkowa
    "T": "stolowa",
    "F": "podlogowa",
    "S": "reflektor_szynowy",  # track / spot
    "H": "downlight",          # oczko wpuszczane
    "M": "system_magnetyczny",
}


def subtype_of(codes):
    prefs = {c[0] for c in codes}
    subs = {CODE_SUBTYPE.get(p) for p in prefs if p in CODE_SUBTYPE}
    subs.discard(None)
    if len(subs) == 1:
        return next(iter(subs))
    return "|".join(sorted(subs)) if subs else None  # mieszane kody na stronie


def title_of(text, fallback=None):
    words = [w for w in re.findall(r"(?m)^\s*([A-Z][A-Z0-9\-]{2,18})\s*$", text) if w not in STOP]
    if not words:
        return fallback
    return max(set(words), key=words.count)


def light_source(text):
    m = re.search(r"(\d+\s*x\s*[A-Z0-9]{2,4}(?:\s*max)?\s*[\d.,]+\s*W)", text, re.I)
    if m:
        return re.sub(r"\s+", " ", m.group(1)).strip()
    bulbs = re.findall(r"\b(G9|E27|E14|GU10|LED)\b", text)
    return bulbs[0] if bulbs else None


def field(text, key):
    m = re.search(rf"{key}:\s*([^\n|]+)", text, re.I)
    return m.group(1).strip() if m else None


def dimensions(text):
    """Tylko pewne wymiary: srednica (Ø) i wartosci z jednostka cm/mm.
    NIE lapiemy golych 'W123' itp. bo to koliduje z kodami produktow (W0373)."""
    dims = {}
    for m in re.finditer(r"[ØøΦ⌀]\s*(\d{1,4})", text):
        dims["diameter_cm"] = m.group(1)
    wymiary = re.findall(r"\b(\d{1,4})\s*(?:cm|mm)\b", text, re.I)
    if wymiary:
        dims["values"] = wymiary
    return dims or None


def classify_images(page, doc):
    """Zwraca liste zdjec: najwiekszy plik = render aranzacyjny, reszta = cutout/wariant.
    Pomija drobne ikony (<200x200)."""
    out = []
    for im in page.get_images(full=True):
        xref = im[0]
        d = doc.extract_image(xref)
        if d["width"] * d["height"] < 200 * 200:
            continue
        out.append({"xref": xref, "w": d["width"], "h": d["height"], "ext": d["ext"], "bytes": d["image"]})
    if not out:
        return out
    big = max(out, key=lambda x: len(x["bytes"]))
    for o in out:
        o["role"] = "lifestyle" if o is big else "cutout"
    return out


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "prod").lower()).strip("-")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--from", dest="frm", type=int, default=CONTENT_START)
    ap.add_argument("--to", dest="to", type=int, default=0)
    args = ap.parse_args()

    os.makedirs(IMGDIR, exist_ok=True)
    doc = fitz.open(PDF)
    end = args.to or doc.page_count

    products, last_name = [], None
    for pi in range(args.frm, end):
        page = doc[pi]
        text = page.get_text()
        codes = sorted(set(CODE_RE.findall(text)))
        if not codes:
            continue  # strona sekcyjna / czysto aranzacyjna
        name = title_of(text, fallback=last_name)
        last_name = name or last_name
        imgs = classify_images(page, doc)
        saved = []
        for k, im in enumerate(imgs):
            fn = f"{slug(name)}_{codes[0]}_{im['role']}_{k}.{im['ext']}"
            with open(f"{IMGDIR}/{fn}", "wb") as f:
                f.write(im["bytes"])
            saved.append({"file": fn, "role": im["role"], "w": im["w"], "h": im["h"]})
        products.append({
            "manufacturer": MANUFACTURER,
            "name": name,
            "codes": codes,
            "pdf_index": pi,             # 0-based; viewer #page = pdf_index+1
            "viewer_page": pi + 1,
            "printed_page": pi * 2,      # lewa strona drukarska (orientacyjnie)
            "light_source": light_source(text),
            "finish": field(text, "finish"),
            "material": field(text, "material"),
            "dimensions": dimensions(text),
            "images": saved,
            "category": "oswietlenie",
            "subtype": subtype_of(codes),   # deterministycznie z prefiksu kodu
            "attributes": None,             # uzupelniane w kroku analizy wizualnej (opc.)
        })
        if args.limit and len(products) >= args.limit:
            break

    os.makedirs(OUT, exist_ok=True)
    with open(f"{OUT}/products.raw.json", "w", encoding="utf-8") as f:
        json.dump(products, f, ensure_ascii=False, indent=2)

    n_imgs = sum(len(p["images"]) for p in products)
    print(f"Produktow: {len(products)} | zdjec: {n_imgs}")
    print(f"Zapisano: {OUT}/products.raw.json, {IMGDIR}/")
    miss_ls = sum(1 for p in products if not p["light_source"])
    miss_mat = sum(1 for p in products if not p["material"])
    print(f"Braki: light_source={miss_ls}, material={miss_mat}")


if __name__ == "__main__":
    main()
