"""Lambda: wyszukiwanie substytutów (embedding wycinka → pgvector cosine → TOP N).

Wejście (JSON body): { imageBase64, topK? }
Wyjście: { results: [{ optimaId, name, params, imageUrl, similarity }] }

imageUrl to presigned GET (do podglądu w UI). Sygnał główny: podobieństwo wizualne.
"""
import base64
import json
import os
import re
import ssl

import boto3
import pg8000.native  # vendorowane (pip install -t)
from botocore.config import Config

REGION = os.environ.get("AWS_REGION", "eu-central-1")
FILES_BUCKET = os.environ["FILES_BUCKET"]
DB_SECRET_ARN = os.environ["DB_SECRET_ARN"]
EMBED_MODEL_ID = os.environ["EMBED_MODEL_ID"]
RERANK_MODEL_ID = os.environ.get("RERANK_MODEL_ID")  # Sonnet 4.5 (rerank; opcjonalne)

# path-style presigned GET (jak w /uploads/presign — unika 307)
s3 = boto3.client(
    "s3",
    region_name=REGION,
    config=Config(s3={"addressing_style": "path"}, signature_version="s3v4"),
)
bedrock = boto3.client("bedrock-runtime", region_name=REGION)
sm = boto3.client("secretsmanager", region_name=REGION)

_conn = None


def _db():
    global _conn
    if _conn is None:
        secret = json.loads(sm.get_secret_value(SecretId=DB_SECRET_ARN)["SecretString"])
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        _conn = pg8000.native.Connection(
            user=secret["username"],
            password=secret["password"],
            host=secret["host"],
            port=int(secret["port"]),
            database=secret.get("dbname", "maxai"),
            ssl_context=ctx,
        )
    return _conn


def _embed_image(image_bytes: bytes):
    b64 = base64.b64encode(image_bytes).decode()
    out = bedrock.invoke_model(
        modelId=EMBED_MODEL_ID,
        body=json.dumps({"inputImage": b64, "embeddingConfig": {"outputEmbeddingLength": 1024}}),
    )
    return json.loads(out["body"].read())["embedding"]


def _presign_get(s3_url: str) -> str:
    without = s3_url.replace("s3://", "", 1)
    bucket, key = without.split("/", 1)
    return s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=3600)


def _page_image_url(pdf_s3_url, catalog_page):
    """Lekki obraz strony katalogu (JPEG) zamiast całego PDF: <prefix>/pages/p{idx}.jpg (idx = strona-1)."""
    if not pdf_s3_url or not catalog_page:
        return None
    prefix = pdf_s3_url.rsplit("/", 1)[0]  # s3://.../catalogs/<folder>
    return _presign_get(f"{prefix}/pages/p{int(catalog_page) - 1}.jpg")


def _get_s3_bytes(s3_url: str):
    try:
        without = s3_url.replace("s3://", "", 1)
        bucket, key = without.split("/", 1)
        return s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    except Exception:  # noqa: BLE001
        return None


def _parse_json(text):
    text = (text or "").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None
    return None


def _img_format(b: bytes) -> str:
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if b[:2] == b"\xff\xd8":
        return "jpeg"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "webp"
    if b[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    return "jpeg"


# Adaptacyjny per kategoria (docs/product-description-spec.md) — opis wycinka zapytania.
# NAJPIERW kategoria (kanoniczny slug) + subtype — budują bramkę i sygnał różnicujący.
CANON_CATEGORIES = (
    "sofa, naroznik, fotel, krzeslo, stol, stolik, lozko, szafka, komoda, regal, mebel, "
    "oswietlenie, plytki, podlogi, lazienka, drzwi, tapety, sztukateria, lustro, dywan, dekoracja, inne"
)
DESCRIBE_SYSTEM = (
    "Jesteś ekspertem od opisu wizualnego mebli i produktów wnętrzarskich (meble, oświetlenie, "
    "płytki, dywany…). Na podstawie zdjęcia opisz produkt WYŁĄCZNIE tym, co widać. NAJPIERW ustal "
    f"'kategoria' (kanoniczny slug: {CANON_CATEGORIES}) oraz 'subtype' (generyczny podtyp w obrębie "
    "kategorii, np. dla oświetlenia: wiszaca/kinkiet/plafon/stolowa/podlogowa/reflektor_szynowy/"
    "downlight/zyrandol). Zwróć wyłącznie poprawny JSON o kluczach: kategoria, subtype, typ, "
    "ksztalt_ogolny, material, kolor_dominujacy, kolory_dodatkowe[], wzor_faktura, styl, cechy[], "
    "atrybuty_kategorii{}, opis_swobodny. Po polsku, zwięźle, skupiając się na cechach różnicujących "
    "wygląd. Czego nie widać → null (lub []). Bez markdown, bez komentarzy."
)

# Normalizacja kategorii zwróconej przez model → kanoniczny slug (bramka).
_CAT_SYNONYMS = {
    "lampa": "oswietlenie", "lampy": "oswietlenie", "oswietlenie": "oswietlenie",
    "oświetlenie": "oswietlenie", "light": "oswietlenie", "lighting": "oswietlenie",
    "zyrandol": "oswietlenie", "kinkiet": "oswietlenie", "plafon": "oswietlenie",
    "kanapa": "sofa", "sofa": "sofa", "naroznik": "naroznik", "narożnik": "naroznik",
    "fotel": "fotel", "krzeslo": "krzeslo", "krzesło": "krzeslo", "stol": "stol",
    "stół": "stol", "stolik": "stolik", "lozko": "lozko", "łóżko": "lozko",
    "szafka": "szafka", "komoda": "komoda", "regal": "regal", "regał": "regal", "mebel": "mebel",
    "plytki": "plytki", "płytki": "plytki", "gres": "plytki", "dywan": "dywan",
    # kategorie z oferty maxfliz:
    "podlogi": "podlogi", "podłoga": "podlogi", "podloga": "podlogi", "panel": "podlogi", "panele": "podlogi",
    "lazienka": "lazienka", "łazienka": "lazienka", "umywalka": "lazienka", "bateria": "lazienka",
    "prysznic": "lazienka", "wanna": "lazienka", "wc": "lazienka", "armatura": "lazienka", "brodzik": "lazienka",
    "drzwi": "drzwi", "tapeta": "tapety", "tapety": "tapety", "fototapeta": "tapety",
    "sztukateria": "sztukateria", "listwa": "sztukateria", "rozeta": "sztukateria",
    "lustro": "lustro", "lustra": "lustro", "dekoracja": "dekoracja",
}


def _norm_category(cat):
    if not cat:
        return None
    key = str(cat).strip().lower()
    if key in _CAT_SYNONYMS:
        return _CAT_SYNONYMS[key]
    for word in key.replace("/", " ").split():
        if word in _CAT_SYNONYMS:
            return _CAT_SYNONYMS[word]
    return None


def _describe_query(image_bytes: bytes, hint: str = None):
    """Opisz wycinek zapytania tym samym schematem (drugi sygnał dopasowania).

    hint (opcjonalny) = etykieta z auto-detekcji, np. 'stolik kawowy'. Naprowadza opis na WŁAŚCIWY
    obiekt, gdy w kadrze jest tło (np. stolik na pierwszym planie + pół kanapy w tle). Sygnał MIĘKKI:
    finalną kategorię i tak ustala model (odporność na błędną detekcję)."""
    if not RERANK_MODEL_ID:
        return None
    hint = (hint or "").strip()
    if hint:
        prompt = (
            f"To wycinek z wizualizacji wnętrza. GŁÓWNYM obiektem zapytania jest: «{hint}» — "
            "opisz WŁAŚNIE ten obiekt (pierwszy plan / centrum kadru), a inne meble/produkty w tle "
            "ZIGNORUJ. Jeśli wskazanego obiektu naprawdę nie ma w kadrze, opisz obiekt dominujący. "
            "Zwróć JSON wg schematu."
        )
    else:
        prompt = "Opisz ten mebel wg schematu (JSON). To wycinek z wizualizacji wnętrza."
    try:
        out = bedrock.converse(
            modelId=RERANK_MODEL_ID,
            system=[{"text": DESCRIBE_SYSTEM}],
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"image": {"format": _img_format(image_bytes), "source": {"bytes": image_bytes}}},
                        {"text": prompt},
                    ],
                }
            ],
            inferenceConfig={"maxTokens": 800, "temperature": 0},
        )
        attrs = _parse_json(out["output"]["message"]["content"][0]["text"])
        print(f"[query] atrybuty: {json.dumps(attrs, ensure_ascii=False)[:300]}")
        return attrs
    except Exception as e:  # noqa: BLE001
        print(f"[query] BLAD opisu: {e}")
        return None


CONTEXT_SYSTEM = (
    "Analizujesz DODATKOWE źródło dołączone do zapytania o produkt wnętrzarski: rysunek techniczny, "
    "kartę katalogową, spec lub zdjęcie detalu. Twoim zadaniem jest wyłuskać PEWNE informacje o produkcie. "
    "ZASADA NADRZĘDNA: podawaj tylko to, co WYRAŹNIE widać/czytasz. Czego nie widać jednoznacznie → null "
    "(dla list → []). NIE ZGADUJ, nie interpoluj, nie wymyślaj marki ani wymiarów. Wymiary podaj TYLKO jeśli "
    "są wypisane liczbami (z jednostką) lub jednoznacznie zwymiarowane na rysunku. "
    'Zwróć WYŁĄCZNIE JSON: {"typ":..,"ksztalt":..,"material":..,"cechy":[..],'
    '"wymiary_cm":{"szerokosc":..,"glebokosc":..,"wysokosc":..,"srednica":..,"dlugosc":..},'
    '"czytelnosc":"dobra|slaba"}. Bez markdown, bez komentarzy.'
)


def _extract_context(image_bytes: bytes):
    """Wyciąga PEWNE cechy z dodatkowego źródła (rysunek/spec). Zwraca dict albo None.
    Anti-halucynacja: model raportuje tylko czytelne pola; niepewne → null."""
    if not RERANK_MODEL_ID:
        return None
    try:
        out = bedrock.converse(
            modelId=RERANK_MODEL_ID,
            system=[{"text": CONTEXT_SYSTEM}],
            messages=[{"role": "user", "content": [
                {"image": {"format": _img_format(image_bytes), "source": {"bytes": image_bytes}}},
                {"text": "Wyłuskaj PEWNE informacje o produkcie z tego źródła (JSON). Niepewne → null."},
            ]}],
            inferenceConfig={"maxTokens": 500, "temperature": 0},
        )
        data = _parse_json(out["output"]["message"]["content"][0]["text"])
        print(f"[context] z rysunku: {json.dumps(data, ensure_ascii=False)[:300]}")
        return data if isinstance(data, dict) else None
    except Exception as e:  # noqa: BLE001
        print(f"[context] BLAD: {e}")
        return None


def _rerank(query_bytes, cands, query_attrs=None, query_context=None):
    """Sonnet 4.5 sędzia: rankuje kandydatów na zdjęciach, odrzuca niepasujących.
    Zwraca listę indeksów (best→worst) pasujących kandydatów.
    query_context = pewne cechy z dołączonego rysunku/spec (typ/kształt/wymiary) — sygnał MIĘKKI."""
    if not RERANK_MODEL_ID or len(cands) <= 1:
        print(f"[rerank] pomijam (model={RERANK_MODEL_ID}, cands={len(cands)})")
        return list(range(len(cands))), {}, {}
    try:
        q_attrs = json.dumps(query_attrs or {}, ensure_ascii=False)[:500]
        content = [
            {"text": "ZAPYTANIE — mebel do dopasowania (wycinek z wizualizacji wnętrza):"},
            {"image": {"format": _img_format(query_bytes), "source": {"bytes": query_bytes}}},
            {"text": f"Atrybuty ZAPYTANIA (opis wizualny): {q_attrs}"},
        ]
        if isinstance(query_context, dict):
            ctx_bits = {k: query_context.get(k) for k in ("typ", "ksztalt", "material", "cechy", "wymiary_cm")
                        if query_context.get(k)}
            if ctx_bits:
                content.append({"text": (
                    "DODATKOWY KONTEKST ZAPYTANIA z rysunku/specyfikacji (od użytkownika, doprecyzowuje intencję): "
                    + json.dumps(ctx_bits, ensure_ascii=False)[:400]
                    + ". Traktuj to jako sygnał MIĘKKI: WYMIARY orientacyjnie (bliższe = lepiej, ale nie odrzucaj z "
                      "powodu samej różnicy rozmiaru); typ/kształt wspierają dopasowanie."
                )})
        imgs = 0
        # Limit obrazów Sonnet ~20/żądanie (łącznie z obrazem zapytania). Budżet dzielimy na kandydatów,
        # żeby przy większym recall NIE przekroczyć limitu (inaczej wyjątek → fallback bez oceny).
        per_cand = max(1, min(4, 18 // max(1, len(cands))))
        for i, c in enumerate(cands):
            attrs = json.dumps(c.get("attributes") or {}, ensure_ascii=False)[:400]
            params = json.dumps(c.get("params") or {}, ensure_ascii=False)[:400]
            # Kontekst kandydata: nazwa + podtyp + opis wizualny + PARAMETRY (specyfikacja techniczna).
            content.append({
                "text": f"Kandydat {i}: {c.get('name') or ''} (podtyp: {c.get('subtype') or '?'}). "
                        f"Opis: {attrs}. Parametry/specyfikacja: {params}"
            })
            # Zdjęcia kandydata (wiele ujęć, w ramach budżetu obrazów).
            for url in (c.get("image_urls") or [c.get("image_s3_url")])[:per_cand]:
                b = _get_s3_bytes(url) if url else None
                if b:
                    content.append({"image": {"format": _img_format(b), "source": {"bytes": b}}})
                    imgs += 1
        content.append(
            {
                "text": (
                    "Oceń każdego kandydata jako STOPIEŃ DOPASOWANIA do ZAPYTANIA w skali 0-100 "
                    "(100 = ten sam / bliźniaczy produkt; 0 = zupełnie inny). Każdy kandydat może mieć KILKA zdjęć "
                    "(różne ujęcia/warianty) — oceniaj po całości. "
                    "NAJWAŻNIEJSZE (decyduje o ocenie): BRYŁA, KSZTAŁT, PROPORCJE, SYLWETKA, KONSTRUKCJA/DETALE i typ — "
                    "to one wskazują ten sam model. Duży nacisk na zgodność opisu wizualnego (kształt/forma). "
                    "KOLOR i MATERIAŁ traktuj jako DRUGORZĘDNE: ten sam produkt często występuje w różnych kolorach/"
                    "tkaninach/wykończeniach (warianty), więc RÓŻNICA koloru lub materiału NIE obniża mocno oceny, "
                    "jeśli bryła i kształt się zgadzają. Nie odrzucaj dobrego dopasowania kształtem tylko z powodu koloru. "
                    "Kandydaci mogą mieć PARAMETRY/specyfikację (moc W, barwa K, IP, kąt °, źródło światła, wymiary) — "
                    "użyj ich pomocniczo do potwierdzenia/rozróżnienia. Nie przeceniaj samej wielkości ani tła renderu. "
                    "POMIŃ tylko kandydatów o wyraźnie innej bryle/kształcie lub innym typie (nie umieszczaj ich w wynikach). "
                    "Dla każdego kandydata podaj też 'powod' — krótkie (do ~14 słów) uzasadnienie oceny "
                    "(przede wszystkim: kształt/bryła/typ; kolor/materiał tylko wtórnie). "
                    'Zwróć WYŁĄCZNIE JSON posortowany od najlepszego: '
                    '{"wyniki":[{"i":<indeks>,"dopasowanie":<0-100>,"powod":"..."}], "uzasadnienie":"1 zdanie"}. '
                    "Bez markdown."
                )
            }
        )
        print(f"[rerank] start: cands={len(cands)}, zdjec_kandydatow={imgs}, model={RERANK_MODEL_ID}")
        # maxTokens hojnie (koniec ucinania JSON przy wielu kandydatach) + 1 retry (transient/parse).
        for attempt in range(2):
            out = bedrock.converse(
                modelId=RERANK_MODEL_ID,
                messages=[{"role": "user", "content": content}],
                inferenceConfig={"maxTokens": 2000, "temperature": 0},
            )
            stop = out.get("stopReason")
            raw = out["output"]["message"]["content"][0]["text"]
            print(f"[rerank] proba={attempt + 1} stopReason={stop} odpowiedz={raw[:400]}")
            parsed = _parse_rerank(raw, len(cands))
            if parsed:
                order, scores, reasons = parsed
                print(f"[rerank] ranking={order}, oceny={scores}")
                return order, scores, reasons
            print(f"[rerank] proba={attempt + 1}: brak poprawnych wynikow (stopReason={stop})")
    except Exception as e:  # noqa: BLE001
        print(f"[rerank] BLAD: {e}")
    print("[rerank] fallback wizualny (kolejność kosinusowa)")
    return list(range(len(cands))), {}, {}


def _parse_rerank(raw, n):
    """Zamień odpowiedź sędziego na (order, scores, reasons). Odporne na ucięty JSON:
    gdy pełne parsowanie zawiedzie, odzyskujemy kompletne obiekty wyników regexem."""
    data = _parse_json(raw)
    if isinstance(data, dict) and data.get("uzasadnienie"):
        print(f"[rerank] uzasadnienie: {data['uzasadnienie']}")
    wyniki = data.get("wyniki") if isinstance(data, dict) else None
    if not isinstance(wyniki, list) or not wyniki:
        wyniki = _salvage_rerank_items(raw)  # ratunek z (potencjalnie uciętego) tekstu
    if not isinstance(wyniki, list) or not wyniki:
        return None
    order, scores, reasons = [], {}, {}
    for w in wyniki:
        if not isinstance(w, dict):
            continue
        try:
            i = int(w.get("i"))
        except (TypeError, ValueError):
            continue
        if not (0 <= i < n) or i in scores:
            continue
        order.append(i)
        try:
            scores[i] = max(0, min(100, int(round(float(w.get("dopasowanie"))))))
        except (TypeError, ValueError):
            scores[i] = None
        if w.get("powod"):
            reasons[i] = str(w.get("powod"))[:200]
    return (order, scores, reasons) if order else None


# Wyłuskuje kompletne obiekty {"i":..,"dopasowanie":..,"powod":".."} nawet gdy całość JSON jest ucięta.
_RERANK_ITEM_RE = re.compile(
    r'"i"\s*:\s*(\d+)\s*,\s*"dopasowanie"\s*:\s*(\d+)(?:\s*,\s*"powod"\s*:\s*"([^"]*)")?'
)


def _salvage_rerank_items(raw):
    items = [{"i": int(m.group(1)), "dopasowanie": int(m.group(2)), "powod": m.group(3) or ""}
             for m in _RERANK_ITEM_RE.finditer(raw or "")]
    if items:
        print(f"[rerank] odzyskano {len(items)} wynikow z uciętej/niepełnej odpowiedzi")
    return items


def lambda_handler(event, _ctx):
    global _conn
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"error": "Nieprawidłowy JSON"})

    img_b64 = body.get("imageBase64")
    if not img_b64:
        return _resp(400, {"error": "Wymagane: imageBase64"})
    if isinstance(img_b64, str) and img_b64.startswith("data:") and "," in img_b64:
        img_b64 = img_b64.split(",", 1)[1]
    try:
        image_bytes = base64.b64decode(img_b64)
    except Exception:  # noqa: BLE001
        return _resp(400, {"error": "Nieprawidłowy base64"})

    top_k = max(1, min(int(body.get("topK", 3)), 20))
    recall_k = max(top_k, int(body.get("recallK", 8)))  # kandydaci do rerankingu (budżet obrazów dzielony na nich)
    emb = _embed_image(image_bytes)
    vec = "[" + ",".join(str(x) for x in emb) + "]"

    # F2a: opcjonalny 2. obraz (rysunek techniczny / spec) → wyłuskanie pewnych cech (typ/kształt/wymiary).
    query_context = None
    ctx_b64 = body.get("contextImageBase64")
    if ctx_b64:
        if isinstance(ctx_b64, str) and ctx_b64.startswith("data:") and "," in ctx_b64:
            ctx_b64 = ctx_b64.split(",", 1)[1]
        try:
            query_context = _extract_context(base64.b64decode(ctx_b64))
        except Exception:  # noqa: BLE001
            query_context = None

    # hint = etykieta z auto-detekcji (np. 'stolik kawowy') + doprecyzowanie z rysunku (typ/kształt).
    hint = (body.get("hint") or "").strip()
    if isinstance(query_context, dict):
        parts = [f"{lab}={query_context[k]}" for k, lab in (("typ", "typ"), ("ksztalt", "kształt"))
                 if query_context.get(k)]
        if parts:
            hint = (hint + (" ; " if hint else "") + "z rysunku/spec: " + ", ".join(parts))

    # Opis wycinka zapytania NAJPIERW — daje kategorię (twarda bramka) + drugi sygnał do rerankingu.
    query_attrs = _describe_query(image_bytes, hint)
    cat = None
    if body.get("category"):
        cat = _norm_category(body.get("category"))  # jawne wymuszenie z UI (opcjonalne)
    elif isinstance(query_attrs, dict):
        cat = _norm_category(query_attrs.get("kategoria"))
    print(f"[gate] kategoria zapytania: {cat}")

    def query():
        # Retrieve: TOP recall_k produktów (najlepsze ujęcie per produkt), z atrybutami i źródłem.
        # TWARDA bramka kategorii: substytut zawsze w tej samej kategorii (nie 'lampa zamiast sofy').
        where = "WHERE p.category = :cat " if cat else ""
        sql = (
            "SELECT * FROM ("
            "  SELECT DISTINCT ON (product_id) product_id, optima_id, name, params, subtype, group_id, image_s3_url,"
            "         attributes, source, category, manufacturer, catalog_page, catalog_name, catalog_pdf, sim"
            "  FROM ("
            "    SELECT p.id AS product_id, p.optima_id, p.name, p.params, p.subtype, p.group_id, pi.image_s3_url,"
            "           pi.attributes, p.source, p.category, p.manufacturer, p.catalog_page,"
            "           c.name AS catalog_name, c.pdf_s3_url AS catalog_pdf,"
            "           1 - (pi.embedding <=> CAST(:q AS vector)) AS sim"
            "    FROM product_images pi JOIN products p ON p.id = pi.product_id"
            "    LEFT JOIN catalogs c ON c.id = p.catalog_id "
            + where +
            "  ) x"
            "  ORDER BY product_id, sim DESC"
            ") y "
            "ORDER BY sim DESC "
            f"LIMIT {recall_k}"
        )
        return _db().run(sql, q=vec, cat=cat) if cat else _db().run(sql, q=vec)

    try:
        rows = query()
    except Exception:  # noqa: BLE001
        _conn = None
        rows = query()

    cands = [
        {
            "product_id": str(product_id), "optimaId": optima_id, "name": name, "params": params,
            "subtype": subtype, "group_id": group_id, "image_s3_url": image_s3_url, "attributes": attributes,
            "source": source, "category": category, "manufacturer": manufacturer,
            "catalog_page": catalog_page, "catalog_name": catalog_name, "catalog_pdf": catalog_pdf,
            "sim": round(float(sim), 4),
        }
        for (product_id, optima_id, name, params, subtype, group_id, image_s3_url, attributes, source, category,
             manufacturer, catalog_page, catalog_name, catalog_pdf, sim) in rows
    ]

    # Wszystkie zdjęcia kandydata (do rerankingu wielozdjęciowego); w wyniku pokazujemy jedno.
    for c in cands:
        try:
            imgs = _db().run(
                "SELECT image_s3_url FROM product_images WHERE product_id = CAST(:pid AS uuid) "
                "ORDER BY sort_order, created_at LIMIT 4",
                pid=c["product_id"],
            )
            c["image_urls"] = [u for (u,) in imgs] or [c["image_s3_url"]]
        except Exception:  # noqa: BLE001
            c["image_urls"] = [c["image_s3_url"]]

    # Rerank Sonnet 4.5 na WSZYSTKICH zdjęciach + atrybutach + specyfikacji (kandydaci w tej samej kategorii).
    order, scores, reasons = _rerank(image_bytes, cands, query_attrs, query_context)

    results = []
    for idx in order[:top_k]:
        c = cands[idx]
        score = scores.get(idx)  # ocena dopasowania 0-100 z rerankingu (gdy dostępna)
        # Wyświetlany wynik = ocena rerankingu (spójna z kolejnością); fallback: cosinus Titana.
        match = round(score / 100, 4) if score is not None else c["sim"]
        item = {
            "id": c["product_id"],
            "optimaId": c["optimaId"],
            "name": c["name"],
            "subtype": c["subtype"],
            "groupId": c["group_id"],
            "params": c["params"],
            "imageUrl": _presign_get(c["image_s3_url"]),
            "similarity": match,
            "visualSimilarity": c["sim"],  # surowy cosinus Titana (pomocniczo)
            "reranked": score is not None,
            "source": c["source"],
            "category": c["category"],
            # Wyjaśnialność (analityka): ocena rerankingu + powód + atrybuty kandydata.
            "rerankScore": score,            # 0-100 lub null (fallback wizualny)
            "reason": reasons.get(idx),       # krótkie uzasadnienie modelu
            "attributes": c["attributes"],    # opis wizualny produktu (jeśli jest)
        }
        # Odniesienie do źródła: produkt z katalogu → link do PDF w S3 otwierany na właściwej stronie.
        if c["source"] == "catalog" and c["catalog_pdf"]:
            item["manufacturer"] = c["manufacturer"]
            item["catalogName"] = c["catalog_name"]
            item["catalogPage"] = c["catalog_page"]
            item["catalogUrl"] = _presign_get(c["catalog_pdf"])  # cały PDF (do pobrania)
            item["catalogPageImageUrl"] = _page_image_url(c["catalog_pdf"], c["catalog_page"])  # lekki obraz strony
        results.append(item)
    # queryAttributes: co system „zrozumiał" z wycinka (do panelu „dlaczego podobne").
    return _resp(200, {"results": results, "queryCategory": cat, "queryAttributes": query_attrs,
                       "queryContext": query_context})


def _resp(status, data):
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
        },
        "body": json.dumps(data, ensure_ascii=False),
    }
