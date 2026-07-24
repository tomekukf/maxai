#!/usr/bin/env python3
"""Analiza surowych katalogów/cenników pod kątem importu do maxai.

Cel: przejść przez `rawdata/catalogs/**` (dane wymieszane: cenniki XLSX, katalogi PDF,
zdjęcia produktów, modele 3D, próbki tkanin, wideo, śmieci) i dla KAŻDEGO dostawcy ocenić,
co nadaje się do importu, a co nie — wg tego, czego maxai realnie potrzebuje.

maxai to WIZUALNA wyszukiwarka substytutów. Do importu produktu potrzebne są:
  (1) ZDJĘCIE produktu (packshot) — luźny plik JPG/PNG albo osadzone w katalogu PDF,
  (2) NAZWA + KOD — z cennika (XLSX/PDF) lub z warstwy tekstu katalogu.
Bez zdjęć dane nie są importowalne wprost (to nie jest wyszukiwarka po SKU).
CEN NIE importujemy (decyzja projektu) — cennik służy tylko jako źródło nazw/kodów.

Wynik (re-używalny — uruchamiaj ponownie, gdy dojdą nowe dane):
  rawdata/catalogs/_index.json   — maszynowy indeks (wejście do dalszych kroków/importu),
  rawdata/catalogs/_status.html  — dashboard do podglądu statusu dla człowieka.

Użycie:
  python scripts/analyze-catalogs.py
  python scripts/analyze-catalogs.py --root rawdata/catalogs --imported rawdata/catalogs/_imported.txt
  python scripts/analyze-catalogs.py --no-pdf-probe        # szybciej, bez zaglądania do PDF

Logika klasyfikacji i statusów jest CELOWO wydzielona i opisana — będzie strojona,
gdy dojdą kolejne partie danych.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import fitz  # PyMuPDF — do rozróżnienia „katalog ze zdjęciami" od „cennika tekstowego"
except Exception:  # noqa: BLE001
    fitz = None

# --- Progi i słowniki (do strojenia) -----------------------------------------

IMAGE_MIN_BYTES = 15_000          # mniejsze pliki = miniatury/ikony, nie packshoty produktów
CATALOG_READY_IMAGES = 5          # tyle zdjęć produktowych → traktujemy folder jako „gotowy do przygotowania"
PDF_PROBE_PAGES = 6               # ile pierwszych stron próbkujemy, by ocenić charakter PDF
PDF_IMAGE_PAGE_RATIO = 0.5        # jeśli >=50% próbkowanych stron ma grafikę → katalog ze zdjęciami

EXT_BUCKETS = {
    "image": {".jpg", ".jpeg", ".png", ".heic", ".webp", ".tif", ".tiff"},
    "pricelist": {".xls", ".xlsx", ".ods", ".csv"},
    "pdf": {".pdf"},
    "doc": {".doc", ".docx", ".odt", ".rtf", ".txt", ".ppt", ".pptx"},
    "model3d": {".3ds", ".obj", ".mtl", ".fbx", ".stl", ".skp", ".skb", ".stp", ".step", ".x", ".ai", ".dwg"},
    "video": {".mp4", ".mov", ".avi", ".mkv"},
    "archive": {".zip", ".rar", ".7z"},
    "junk": {".db", ".ini", ".ds_store", ".tmp", ".lock"},
}
# odwrotna mapa rozszerzenie → kubełek
_EXT2BUCKET = {ext: b for b, exts in EXT_BUCKETS.items() for ext in exts}

# Słowa w nazwie pliku, które zmieniają interpretację (to NIE są produkty do importu):
KW_FABRIC = ("tkanin", "wykończen", "wykonczen", "finish", "campionario", "materiali",
             "sample", "wybarwien", "kolekcja tkanin", " ral", "swatch", "próbnik", "probnik")
KW_DISCONTINUED = ("wycofane", "wycofan", "discontinued", "dyskontynuacja")
KW_NEW = ("nowość", "nowosci", "nowosc", "new", "novelties", "nowe produkty")

# --- Parsowanie nazwy folderu dostawcy ---------------------------------------

def parse_vendor_name(folder: str) -> dict:
    """Z 'ARKETIPO - 50%-2% - 5,8 - 8-10' wyciąga markę, rabat i termin (do wyświetlenia).
    Marka = tekst przed pierwszym znacznikiem rabatu/terminu; reszta to metadane handlowe."""
    raw = folder.strip()
    discount = None
    m = re.search(r"(\d{1,2})\s*%", raw)
    if m:
        discount = int(m.group(1))
    lead = None
    m = re.search(r"(\d+\s*[-–]\s*\d+\s*tyg|\d+\s*tyg|\d+\s*[-–]\s*\d+\s*(?:tygodni|weeks))", raw, re.I)
    if m:
        lead = m.group(1)
    # marka: utnij przy pierwszym '%', ' - <cyfra>' lub ', <slowo> NN%'
    brand = raw
    cut = re.search(r"\s*[-–]\s*\d|\s+\d{1,2}\s*%|,\s*\d", raw)
    if cut:
        brand = raw[: cut.start()].strip(" -,–")
    brand = brand.strip()
    return {"brand": brand or raw, "discount_pct": discount, "lead_time": lead, "raw": raw}


def norm_brand(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def matches_imported(brand: str, imported: set[str]) -> bool:
    """Dopasowanie marki do zbioru producentów w bazie. Krótkie nazwy (<4 znaki po normalizacji,
    np. 'lł'→'l') dopasowujemy WYŁĄCZNIE dokładnie — inaczej 'l' jest podłańcuchem wszystkiego."""
    g = norm_brand(brand)
    if len(g) < 4:
        return g in imported
    return any(g == im or (len(im) >= 4 and (g in im or im in g)) for im in imported)


# --- Klasyfikacja PDF ---------------------------------------------------------

def classify_pdf(path: Path, probe: bool) -> dict:
    """Rozróżnia katalog ze zdjęciami od cennika tekstowego. Zwraca dict z metadanymi.
    Bez pymupdf lub przy --no-pdf-probe klasyfikuje po nazwie/rozmiarze (zgrubnie)."""
    name = path.name.lower()
    info = {"pages": None, "image_pages": None, "kind": "pdf-nieznany",
            "fabric": any(k in name for k in KW_FABRIC),
            "discontinued": any(k in name for k in KW_DISCONTINUED),
            "new": any(k in name for k in KW_NEW)}
    if not probe or fitz is None:
        # heurystyka nazwy: 'cennik/listino/pricelist' → tekstowy; 'katalog/catalogue/lookbook' → zdjęcia
        if any(k in name for k in ("cennik", "listino", "price", "prezzi", "pricelist")):
            info["kind"] = "cennik-tekstowy"
        elif any(k in name for k in ("katalog", "catalogue", "catalog", "lookbook", "collection", "kolekcja")):
            info["kind"] = "katalog-ze-zdjeciami"
        return info
    try:
        doc = fitz.open(path)
        info["pages"] = doc.page_count
        n = min(PDF_PROBE_PAGES, doc.page_count)
        img_pages = 0
        text_chars = 0
        for i in range(n):
            page = doc.load_page(i)
            if page.get_images(full=False):
                img_pages += 1
            text_chars += len(page.get_text("text") or "")
        doc.close()
        info["image_pages"] = img_pages
        ratio = img_pages / n if n else 0
        if ratio >= PDF_IMAGE_PAGE_RATIO and not info["fabric"]:
            info["kind"] = "katalog-ze-zdjeciami"
        elif text_chars > 400 and ratio < PDF_IMAGE_PAGE_RATIO:
            info["kind"] = "cennik-tekstowy"
        else:
            info["kind"] = "mieszany"
    except Exception as e:  # noqa: BLE001
        info["kind"] = f"pdf-blad"
        info["error"] = str(e)[:120]
    return info


# --- Analiza jednego dostawcy -------------------------------------------------

def analyze_vendor(vendor_dir: Path, group: str, probe: bool, imported: set[str]) -> dict:
    meta = parse_vendor_name(vendor_dir.name)
    buckets = {b: 0 for b in EXT_BUCKETS}
    buckets["other"] = 0
    product_images = 0          # zdjęcia >= progu (kandydaci na packshoty)
    tiny_images = 0
    total_bytes = 0
    fabric_images = 0           # zdjęcia w podfolderach „tkaniny/wykończenia"
    pdfs: list[dict] = []
    newest_mtime = 0.0

    for f in vendor_dir.rglob("*"):
        if not f.is_file():
            continue
        ext = f.suffix.lower()
        try:
            size = f.stat().st_size
            newest_mtime = max(newest_mtime, f.stat().st_mtime)
        except OSError:
            size = 0
        total_bytes += size
        bucket = _EXT2BUCKET.get(ext, "other")
        # rozpoznaj śmieci po nazwie (lock/Thumbs) nawet bez rozszerzenia
        low = f.name.lower()
        if low in ("thumbs.db", ".ds_store") or low.startswith(".~lock") or low.endswith("#"):
            bucket = "junk"
        buckets[bucket] += 1
        if bucket == "image":
            in_fabric_dir = any(any(k in part.lower() for k in KW_FABRIC) for part in f.parts)
            if size >= IMAGE_MIN_BYTES:
                if in_fabric_dir:
                    fabric_images += 1
                else:
                    product_images += 1
            else:
                tiny_images += 1
        elif bucket == "pdf":
            pdfs.append({"file": str(f.relative_to(vendor_dir)), **classify_pdf(f, probe)})

    catalogs_with_images = sum(1 for p in pdfs if p["kind"] == "katalog-ze-zdjeciami")
    text_pricelists_pdf = sum(1 for p in pdfs if p["kind"] == "cennik-tekstowy")
    fabric_pdfs = sum(1 for p in pdfs if p.get("fabric"))
    price_lists = buckets["pricelist"]

    has_names = price_lists > 0 or text_pricelists_pdf > 0 or catalogs_with_images > 0
    has_images = product_images >= 1

    # --- decyzja o statusie (rdzeń logiki — do strojenia) ---
    if sum(buckets.values()) == 0:
        status, reason = "PUSTY", "folder pusty — dane zapewne u dostawcy / na stronie (patrz nazwa folderu)"
    elif product_images >= CATALOG_READY_IMAGES and has_names:
        status, reason = "GOTOWY", "luźne zdjęcia produktów + źródło nazw/kodów (cennik lub katalog)"
    elif catalogs_with_images > 0 and product_images < CATALOG_READY_IMAGES:
        status, reason = "EKSTRAKCJA_PDF", "katalog PDF ze zdjęciami — wymaga ekstrakcji produktów i zdjęć z PDF"
    elif has_names and not has_images and catalogs_with_images == 0:
        status, reason = "BRAK_ZDJEC", "tylko cennik tekstowy, brak zdjęć — maxai jest wizualne, potrzebne źródło zdjęć"
    elif has_images and not has_names:
        status, reason = "BRAK_NAZW", "są zdjęcia, ale brak cennika/katalogu z nazwami i kodami"
    elif buckets["model3d"] + buckets["video"] > 0 and not has_images and not has_names:
        status, reason = "NIEPRZYDATNE", "wyłącznie modele 3D / wideo / materiały pomocnicze — nie do importu"
    elif product_images > 0 and has_names:
        status, reason = "GOTOWY_MALO", "zdjęcia + nazwy, ale mało zdjęć produktowych — sprawdzić pokrycie"
    else:
        status, reason = "DO_WERYFIKACJI", "niejednoznaczne — wymaga ręcznego rzutu okiem"

    # jakość 0-100 (heurystyka do rankingu kolejności prac)
    q = 0
    q += min(40, product_images // 2)                    # do 40 za zdjęcia
    q += 20 if price_lists > 0 else 0                     # cennik = nazwy/kody
    q += 20 if catalogs_with_images > 0 else 0            # katalog ze zdjęciami
    q += 10 if text_pricelists_pdf > 0 else 0
    q -= 10 if fabric_images > product_images > 0 else 0  # dominują próbki tkanin
    q = max(0, min(100, q))

    guessed = norm_brand(meta["brand"])
    is_imported = matches_imported(meta["brand"], imported)

    return {
        "group": group,
        "folder": vendor_dir.name,
        "brand": meta["brand"],
        "discount_pct": meta["discount_pct"],
        "lead_time": meta["lead_time"],
        "path": str(vendor_dir),
        "status": status,
        "reason": reason,
        "quality": q,
        "imported": is_imported,
        "signals": {
            "product_images": product_images,
            "tiny_images": tiny_images,
            "fabric_images": fabric_images,
            "price_lists": price_lists,
            "catalogs_with_images": catalogs_with_images,
            "text_pricelists_pdf": text_pricelists_pdf,
            "fabric_pdfs": fabric_pdfs,
            "models_3d": buckets["model3d"],
            "video": buckets["video"],
            "archives": buckets["archive"],
            "junk": buckets["junk"],
            "total_files": sum(buckets.values()),
            "total_mb": round(total_bytes / 1e6, 1),
        },
        "pdfs": pdfs[:40],
        "newest": datetime.fromtimestamp(newest_mtime, tz=timezone.utc).strftime("%Y-%m-%d") if newest_mtime else None,
    }


# --- HTML dashboard -----------------------------------------------------------

STATUS_META = {
    "GOTOWY":         ("#108474", "Gotowy do przygotowania"),
    "GOTOWY_MALO":    ("#3f9d7f", "Gotowy — mało zdjęć"),
    "EKSTRAKCJA_PDF": ("#2563eb", "Ekstrakcja z PDF"),
    "BRAK_ZDJEC":     ("#d97706", "Brak zdjęć (tylko cennik)"),
    "BRAK_NAZW":      ("#d97706", "Brak nazw/kodów"),
    "DO_WERYFIKACJI": ("#6b7280", "Do weryfikacji"),
    "PUSTY":          ("#9ca3af", "Pusty folder"),
    "NIEPRZYDATNE":   ("#b91c1c", "Nieprzydatne"),
}
STATUS_ORDER = ["GOTOWY", "GOTOWY_MALO", "EKSTRAKCJA_PDF", "BRAK_ZDJEC", "BRAK_NAZW", "DO_WERYFIKACJI", "PUSTY", "NIEPRZYDATNE"]


# Stany PRACY (postęp — edytowalne przez użytkownika, trwałe między odświeżeniami):
WORK_STATES = [
    ("todo",       "Do zrobienia",   "#6b7280"),
    ("progress",   "W toku",         "#2563eb"),
    ("prepared",   "Przygotowane",   "#7c3aed"),
    ("imported",   "Zaimportowane",  "#108474"),
    ("rejected",   "Odrzucone",      "#b91c1c"),
    ("hold",       "Wstrzymane",     "#d97706"),
]


def render_html(vendors: list[dict], generated: str, progress: dict) -> str:
    esc = lambda s: (str(s) if s is not None else "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    counts = {s: 0 for s in STATUS_ORDER}
    for v in vendors:
        counts[v["status"]] = counts.get(v["status"], 0) + 1
    imported_n = sum(1 for v in vendors if v["imported"])

    cards = "".join(
        f'<button class="card" data-filter="{s}" style="--c:{STATUS_META[s][0]}">'
        f'<span class="n">{counts.get(s,0)}</span><span class="l">{esc(STATUS_META[s][1])}</span></button>'
        for s in STATUS_ORDER
    )
    # karty postępu (liczniki wypełnia JS z localStorage)
    prog_cards = "".join(
        f'<button class="pcard" data-pfilter="{k}" style="--c:{c}">'
        f'<span class="n" data-pcount="{k}">0</span><span class="l">{esc(lbl)}</span></button>'
        for k, lbl, c in WORK_STATES
    )

    rows = []
    for v in sorted(vendors, key=lambda x: (STATUS_ORDER.index(x["status"]) if x["status"] in STATUS_ORDER else 9, -x["quality"])):
        sg = v["signals"]
        color = STATUS_META.get(v["status"], ("#6b7280", v["status"]))[0]
        badge = STATUS_META.get(v["status"], ("#6b7280", v["status"]))[1]
        vid = f'{v["group"]}/{v["folder"]}'  # stabilny klucz postępu (przetrwa re-analizę)
        chips = []
        if sg["product_images"]:      chips.append(f'📷 {sg["product_images"]}')
        if sg["price_lists"]:         chips.append(f'📊 {sg["price_lists"]} cennik')
        if sg["catalogs_with_images"]:chips.append(f'📕 {sg["catalogs_with_images"]} katalog+zdj')
        if sg["text_pricelists_pdf"]: chips.append(f'📄 {sg["text_pricelists_pdf"]} cennik PDF')
        if sg["fabric_images"] or sg["fabric_pdfs"]: chips.append(f'🧵 {sg["fabric_images"]+sg["fabric_pdfs"]} tkaniny')
        if sg["models_3d"]:           chips.append(f'🧊 {sg["models_3d"]} 3D')
        if sg["video"]:               chips.append(f'🎬 {sg["video"]}')
        chips_html = " ".join(f'<span class="chip">{esc(c)}</span>' for c in chips)
        meta = []
        if v["discount_pct"] is not None: meta.append(f'rabat {v["discount_pct"]}%')
        if v["lead_time"]: meta.append(esc(v["lead_time"]))
        imp = '<span class="imp">✓ w bazie</span>' if v["imported"] else ""
        opts = "".join(f'<option value="{k}">{esc(lbl)}</option>' for k, lbl, _ in WORK_STATES)
        rows.append(
            f'<tr data-status="{v["status"]}" data-group="{esc(v["group"])}" data-imported="{1 if v["imported"] else 0}" '
            f'data-q="{v["quality"]}" data-name="{esc(v["brand"].lower())}" data-id="{esc(vid)}">'
            f'<td><span class="dot" style="background:{color}"></span></td>'
            f'<td class="brand"><b>{esc(v["brand"])}</b> {imp}<div class="sub">{esc(v["folder"])}</div>'
            f'<div class="metas">{esc(" · ".join(meta))}</div></td>'
            f'<td><span class="badge" style="background:{color}">{esc(badge)}</span>'
            f'<div class="reason">{esc(v["reason"])}</div></td>'
            f'<td class="chips">{chips_html}</td>'
            f'<td class="prog">'
            f'<select class="wsel">{opts}</select>'
            f'<input class="wnote" placeholder="notatka…">'
            f'<div class="wupd"></div></td>'
            f'<td class="q"><span class="qbar"><i style="width:{v["quality"]}%;background:{color}"></i></span>{v["quality"]}</td>'
            f'<td class="sz">{sg["total_mb"]} MB<div class="sub">{sg["total_files"]} plików</div></td>'
            f'</tr>'
        )
    rows_html = "\n".join(rows)
    seed = json.dumps(progress, ensure_ascii=False)
    states = json.dumps([[k, lbl, c] for k, lbl, c in WORK_STATES], ensure_ascii=False)

    return f"""<!doctype html><html lang="pl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>maxai — tracker importu katalogów</title>
<style>
:root{{color-scheme:light dark;--bg:#f7f7f5;--fg:#1a1a1a;--mut:#6b7280;--line:#e5e5e2;--card:#fff;--acc:#760039}}
@media (prefers-color-scheme:dark){{:root{{--bg:#15161a;--fg:#e8e8e6;--mut:#9aa0a6;--line:#2a2c31;--card:#1d1f24}}}}
*{{box-sizing:border-box}}body{{font:15px/1.5 'Jost',system-ui,sans-serif;margin:0;background:var(--bg);color:var(--fg)}}
header{{padding:22px 26px 8px}}h1{{margin:0;font-size:20px}}.sub{{color:var(--mut);font-size:12px}}
.wrap{{padding:0 26px 40px}}
.sec{{font-size:12px;color:var(--mut);margin:16px 0 6px;text-transform:uppercase;letter-spacing:.04em}}
.cards{{display:flex;flex-wrap:wrap;gap:10px}}
.card,.pcard{{flex:1 1 120px;min-width:120px;border:1px solid var(--line);border-left:4px solid var(--c);border-radius:10px;
  background:var(--card);padding:9px 12px;cursor:pointer;text-align:left;font:inherit;color:inherit}}
.card:hover,.pcard:hover{{border-color:var(--c)}}.card.active,.pcard.active{{outline:2px solid var(--c)}}
.card .n,.pcard .n{{display:block;font-size:23px;font-weight:600}}.card .l,.pcard .l{{font-size:12px;color:var(--mut)}}
.bar{{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:14px 0}}
input[type=search]{{flex:1;min-width:200px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:inherit}}
label.f{{font-size:13px;color:var(--mut);display:flex;gap:5px;align-items:center;cursor:pointer}}
button.act{{font:inherit;font-size:13px;padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:inherit;cursor:pointer}}
button.act:hover{{border-color:var(--acc)}}
table{{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}}
th,td{{padding:9px 12px;text-align:left;vertical-align:top;border-top:1px solid var(--line)}}
th{{position:sticky;top:0;background:var(--card);font-size:12px;color:var(--mut);cursor:pointer;user-select:none;z-index:1}}
tr:hover td{{background:color-mix(in srgb,var(--acc) 5%,transparent)}}
tr.done td{{opacity:.62}}
.dot{{display:inline-block;width:10px;height:10px;border-radius:50%}}
.brand b{{font-size:15px}}.brand .sub{{font-size:11px}}.metas{{font-size:11px;color:var(--mut);margin-top:2px}}
.badge{{display:inline-block;color:#fff;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600}}
.reason{{font-size:11px;color:var(--mut);margin-top:4px;max-width:240px}}
.chip{{display:inline-block;background:color-mix(in srgb,var(--fg) 8%,transparent);border-radius:6px;padding:1px 7px;font-size:11px;margin:2px 2px 0 0;white-space:nowrap}}
.imp{{color:#108474;font-size:11px;font-weight:600}}
.prog{{min-width:170px}}.wsel{{width:100%;padding:4px 6px;border-radius:7px;border:1px solid var(--line);background:var(--bg);color:inherit;font:inherit;font-size:12px;border-left:4px solid var(--wc,var(--line))}}
.wnote{{width:100%;margin-top:5px;padding:4px 6px;border-radius:7px;border:1px solid var(--line);background:var(--bg);color:inherit;font:inherit;font-size:12px}}
.wupd{{font-size:10px;color:var(--mut);margin-top:3px}}
.q{{white-space:nowrap;font-size:12px}}.qbar{{display:inline-block;width:50px;height:6px;border-radius:4px;background:var(--line);margin-right:6px;vertical-align:middle;overflow:hidden}}
.qbar i{{display:block;height:100%}}.sz{{font-size:12px;white-space:nowrap}}.sz .sub{{font-size:10px}}
.hidden{{display:none}}
footer{{color:var(--mut);font-size:12px;padding:8px 26px 30px}}
</style></head><body>
<header><h1>maxai — tracker importu katalogów</h1>
<div class="sub">Analiza z {esc(generated)} · {len(vendors)} dostawców · {imported_n} rozpoznanych w bazie ·
zmiany postępu <b>zapisują się automatycznie</b> w tej przeglądarce. Aby utrwalić/przenieść — „Zapisz postęp".</div></header>
<div class="wrap">
<div class="sec">Postęp pracy (klikalny — Twój)</div>
<div class="cards">{prog_cards}</div>
<div class="sec">Ocena importowalności (automatyczna — z analizy plików)</div>
<div class="cards">{cards}</div>
<div class="bar">
  <input type="search" id="q" placeholder="szukaj marki lub folderu…">
  <label class="f"><input type="checkbox" id="hideDone"> ukryj zaimportowane/odrzucone</label>
  <label class="f"><input type="checkbox" id="onlyReady"> tylko nadające się (Gotowy / Ekstrakcja PDF)</label>
  <span style="flex:1"></span>
  <button class="act" id="save">💾 Zapisz postęp (_progress.json)</button>
  <button class="act" id="load">📂 Wczytaj postęp</button>
  <input type="file" id="file" accept="application/json" hidden>
</div>
<table id="t"><thead><tr>
<th data-k="status"></th><th data-k="name">Dostawca</th><th data-k="status">Ocena (auto)</th>
<th>Sygnały (co jest w folderze)</th><th data-k="work">Postęp (Ty)</th><th data-k="q">Jakość</th><th data-k="sz">Rozmiar</th>
</tr></thead><tbody>
{rows_html}
</tbody></table>
</div>
<footer>Ocena (auto): <b>Gotowy</b> — luźne zdjęcia + nazwy/kody · <b>Ekstrakcja PDF</b> — katalog ze zdjęciami do wyciągnięcia ·
<b>Brak zdjęć</b> — sam cennik (maxai wymaga zdjęć) · <b>Nieprzydatne</b> — 3D/wideo. Ceny nie są importowane.
Postęp trzymany jest w przeglądarce (localStorage) i przetrwa ponowną analizę (klucz = grupa/folder).
Po dodaniu danych uruchom <code>python scripts/analyze-catalogs.py</code>; by postęp był widoczny też dla skryptu/na innym
komputerze — „Zapisz postęp" i wrzuć <code>_progress.json</code> do <code>rawdata/catalogs/</code>.</footer>
<script>
const SEED={seed};                 // postęp z _progress.json (jeśli był) — używany, gdy localStorage puste
const STATES={states};             // [[klucz,etykieta,kolor],…]
const LS='maxai_catalog_progress';
const COLOR=Object.fromEntries(STATES.map(s=>[s[0],s[2]]));
const LABEL=Object.fromEntries(STATES.map(s=>[s[0],s[1]]));
const DONE=['imported','rejected'];
let store=JSON.parse(localStorage.getItem(LS)||'null')||JSON.parse(JSON.stringify(SEED||{{}}));
function persist(){{localStorage.setItem(LS,JSON.stringify(store));}}
const t=document.getElementById('t'),tb=t.tBodies[0],rows=[...tb.rows];
let filter=null,pfilter=null,sortK=null,sortAsc=false;

function paintRow(r){{
  const id=r.dataset.id, e=store[id]||{{}};
  const st=e.state||'todo';
  const sel=r.querySelector('.wsel'); sel.value=st; sel.style.setProperty('--wc',COLOR[st]||'var(--line)');
  r.querySelector('.wnote').value=e.note||'';
  r.querySelector('.wupd').textContent=e.updated?('zmieniono '+e.updated):'';
  r.dataset.work=st;
  r.classList.toggle('done',DONE.includes(st));
}}
function counts(){{
  const c=Object.fromEntries(STATES.map(s=>[s[0],0]));
  for(const r of rows){{const st=(store[r.dataset.id]||{{}}).state||'todo';c[st]=(c[st]||0)+1;}}
  document.querySelectorAll('[data-pcount]').forEach(el=>el.textContent=c[el.dataset.pcount]||0);
}}
function apply(){{
  const q=document.getElementById('q').value.toLowerCase().trim();
  const hideDone=document.getElementById('hideDone').checked;
  const onlyReady=document.getElementById('onlyReady').checked;
  for(const r of rows){{
    let ok=true;
    if(filter&&r.dataset.status!==filter)ok=false;
    if(pfilter&&r.dataset.work!==pfilter)ok=false;
    if(q&&!(r.dataset.name.includes(q)||r.textContent.toLowerCase().includes(q)))ok=false;
    if(hideDone&&DONE.includes(r.dataset.work))ok=false;
    if(onlyReady&&!['GOTOWY','GOTOWY_MALO','EKSTRAKCJA_PDF'].includes(r.dataset.status))ok=false;
    r.classList.toggle('hidden',!ok);
  }}
}}
// init
rows.forEach(paintRow); counts();
rows.forEach(r=>{{
  const id=r.dataset.id;
  r.querySelector('.wsel').addEventListener('change',e=>{{
    store[id]=Object.assign({{}},store[id],{{state:e.target.value,updated:new Date().toISOString().slice(0,16).replace('T',' ')}});
    persist();paintRow(r);counts();apply();
  }});
  let tmr; r.querySelector('.wnote').addEventListener('input',e=>{{
    clearTimeout(tmr);tmr=setTimeout(()=>{{
      store[id]=Object.assign({{}},store[id],{{note:e.target.value,updated:new Date().toISOString().slice(0,16).replace('T',' ')}});
      persist();r.querySelector('.wupd').textContent='zmieniono '+store[id].updated;
    }},400);
  }});
}});
document.querySelectorAll('.card').forEach(c=>c.onclick=()=>{{
  const s=c.dataset.filter;filter=filter===s?null:s;
  document.querySelectorAll('.card').forEach(x=>x.classList.toggle('active',x===c&&filter));apply();
}});
document.querySelectorAll('.pcard').forEach(c=>c.onclick=()=>{{
  const s=c.dataset.pfilter;pfilter=pfilter===s?null:s;
  document.querySelectorAll('.pcard').forEach(x=>x.classList.toggle('active',x===c&&pfilter));apply();
}});
document.getElementById('q').oninput=apply;
document.getElementById('hideDone').onchange=apply;
document.getElementById('onlyReady').onchange=apply;
document.getElementById('save').onclick=()=>{{
  const blob=new Blob([JSON.stringify(store,null,2)],{{type:'application/json'}});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='_progress.json';a.click();
}};
document.getElementById('load').onclick=()=>document.getElementById('file').click();
document.getElementById('file').onchange=e=>{{
  const f=e.target.files[0];if(!f)return;const rd=new FileReader();
  rd.onload=()=>{{try{{store=JSON.parse(rd.result);persist();rows.forEach(paintRow);counts();apply();alert('Wczytano postęp.');}}catch{{alert('Zły plik JSON.');}}}};
  rd.readAsText(f);
}};
t.querySelectorAll('th[data-k]').forEach(th=>th.onclick=()=>{{
  const k=th.dataset.k;sortAsc=sortK===k?!sortAsc:false;sortK=k;
  const val=r=>k==='q'?+r.dataset.q:k==='sz'?parseFloat(r.querySelector('.sz').textContent):(r.dataset[k]||r.dataset.name||'');
  rows.sort((a,b)=>{{const x=val(a),y=val(b);return (x>y?1:x<y?-1:0)*(sortAsc?1:-1);}});
  rows.forEach(r=>tb.appendChild(r));
}});
</script></body></html>"""


# --- main ---------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="rawdata/catalogs")
    ap.add_argument("--imported", default="rawdata/catalogs/_imported.txt",
                    help="opcjonalny plik: po jednej nazwie producenta na linię (do flagi 'w bazie')")
    ap.add_argument("--no-pdf-probe", action="store_true", help="nie zaglądaj do PDF (szybciej)")
    args = ap.parse_args()

    root = Path(args.root)
    if not root.is_dir():
        print(f"Brak katalogu: {root}", file=sys.stderr)
        sys.exit(1)

    imported = set()
    ip = Path(args.imported)
    if ip.exists():
        imported = {norm_brand(x) for x in ip.read_text(encoding="utf-8").splitlines() if x.strip()}
    print(f"Producentów już w bazie (do flagi): {len(imported)}")

    vendors = []
    groups = [d for d in sorted(root.iterdir()) if d.is_dir() and not d.name.startswith("_")]
    for group_dir in groups:
        subdirs = [d for d in sorted(group_dir.iterdir()) if d.is_dir()]
        for vendor_dir in subdirs:
            print(f"  · {group_dir.name} / {vendor_dir.name}")
            vendors.append(analyze_vendor(vendor_dir, group_dir.name, not args.no_pdf_probe, imported))

    # Postęp pracy (ustawiany ręcznie w dashboardzie) — seed dla świeżej przeglądarki / innego komputera.
    # localStorage w HTML i tak ma priorytet; ten plik pozwala postępowi przetrwać reset przeglądarki
    # i być widocznym dla skryptu. Klucz = "grupa/folder" (stabilny między re-analizami).
    progress = {}
    pp = root / "_progress.json"
    if pp.exists():
        try:
            progress = json.loads(pp.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            print("  (uwaga: _progress.json nieczytelny — pomijam)")

    generated = datetime.now().strftime("%Y-%m-%d %H:%M")
    (root / "_index.json").write_text(
        json.dumps({"generated": generated, "root": str(root), "vendors": vendors}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    (root / "_status.html").write_text(render_html(vendors, generated, progress), encoding="utf-8")

    # podsumowanie do konsoli
    from collections import Counter
    c = Counter(v["status"] for v in vendors)
    print("\n=== PODSUMOWANIE ===")
    for s in STATUS_ORDER:
        if c.get(s):
            print(f"  {s:16s} {c[s]:3d}  — {STATUS_META[s][1]}")
    print(f"\nIndeks : {root/'_index.json'}")
    print(f"Podgląd: {root/'_status.html'}")


if __name__ == "__main__":
    main()
