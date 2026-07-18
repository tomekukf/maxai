"""Lambda: wyszukiwanie substytutów (embedding wycinka → pgvector cosine → TOP N).

Wejście (JSON body): { imageBase64, topK? }
Wyjście: { results: [{ optimaId, name, params, imageUrl, similarity }] }

imageUrl to presigned GET (do podglądu w UI). Sygnał główny: podobieństwo wizualne.
"""
import base64
import json
import os
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
    "sofa, naroznik, fotel, krzeslo, stol, stolik, lozko, szafka, komoda, regal, "
    "oswietlenie, plytki, dywan, dekoracja, inne"
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
    "szafka": "szafka", "komoda": "komoda", "regal": "regal", "regał": "regal",
    "plytki": "plytki", "płytki": "plytki", "dywan": "dywan",
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


def _describe_query(image_bytes: bytes):
    """Opisz wycinek zapytania tym samym schematem (drugi sygnał dopasowania)."""
    if not RERANK_MODEL_ID:
        return None
    try:
        out = bedrock.converse(
            modelId=RERANK_MODEL_ID,
            system=[{"text": DESCRIBE_SYSTEM}],
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"image": {"format": _img_format(image_bytes), "source": {"bytes": image_bytes}}},
                        {"text": "Opisz ten mebel wg schematu (JSON). To wycinek z wizualizacji wnętrza."},
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


def _rerank(query_bytes, cands, query_attrs=None):
    """Sonnet 4.5 sędzia: rankuje kandydatów na zdjęciach, odrzuca niepasujących.
    Zwraca listę indeksów (best→worst) pasujących kandydatów."""
    if not RERANK_MODEL_ID or len(cands) <= 1:
        print(f"[rerank] pomijam (model={RERANK_MODEL_ID}, cands={len(cands)})")
        return list(range(len(cands))), {}
    try:
        q_attrs = json.dumps(query_attrs or {}, ensure_ascii=False)[:500]
        content = [
            {"text": "ZAPYTANIE — mebel do dopasowania (wycinek z wizualizacji wnętrza):"},
            {"image": {"format": _img_format(query_bytes), "source": {"bytes": query_bytes}}},
            {"text": f"Atrybuty ZAPYTANIA (opis wizualny): {q_attrs}"},
        ]
        imgs = 0
        for i, c in enumerate(cands):
            attrs = json.dumps(c.get("attributes") or {}, ensure_ascii=False)[:400]
            content.append({"text": f"Kandydat {i}: {c.get('name') or ''}. Atrybuty: {attrs}"})
            b = _get_s3_bytes(c["image_s3_url"])
            if b:
                content.append({"image": {"format": _img_format(b), "source": {"bytes": b}}})
                imgs += 1
        content.append(
            {
                "text": (
                    "Oceń każdego kandydata jako STOPIEŃ DOPASOWANIA do ZAPYTANIA w skali 0-100 "
                    "(100 = niemal ten sam produkt; 0 = zupełnie inny mebel). "
                    "Zwróć szczególną uwagę na KOLOR i MATERIAŁ obicia oraz ogólny kształt/bryłę — "
                    "te cechy mogą wskazać DOKŁADNIE ten sam produkt (np. beżowy vs szary to różne modele). "
                    "Nie przeceniaj samej wielkości (2- vs 3-osobowa) ani tła renderu. "
                    "POMIŃ kandydatów będących zupełnie innym typem mebla lub wyraźnie niepodobnych "
                    "kolorem i materiałem (nie umieszczaj ich w wynikach). "
                    'Zwróć WYŁĄCZNIE JSON posortowany od najlepszego: '
                    '{"wyniki":[{"i":<indeks>,"dopasowanie":<0-100>}], "uzasadnienie":"1 zdanie"}. '
                    "Bez markdown."
                )
            }
        )
        print(f"[rerank] start: cands={len(cands)}, zdjec_kandydatow={imgs}, model={RERANK_MODEL_ID}")
        out = bedrock.converse(
            modelId=RERANK_MODEL_ID,
            messages=[{"role": "user", "content": content}],
            inferenceConfig={"maxTokens": 600, "temperature": 0},
        )
        raw = out["output"]["message"]["content"][0]["text"]
        print(f"[rerank] odpowiedz: {raw[:400]}")
        data = _parse_json(raw)
        if isinstance(data, dict) and data.get("uzasadnienie"):
            print(f"[rerank] uzasadnienie: {data['uzasadnienie']}")
        wyniki = data.get("wyniki") if isinstance(data, dict) else None
        if isinstance(wyniki, list):
            order, scores = [], {}
            for w in wyniki:
                if not isinstance(w, dict):
                    continue
                try:
                    i = int(w.get("i"))
                except (TypeError, ValueError):
                    continue
                if not (0 <= i < len(cands)) or i in scores:
                    continue
                order.append(i)
                try:
                    scores[i] = max(0, min(100, int(round(float(w.get("dopasowanie"))))))
                except (TypeError, ValueError):
                    scores[i] = None
            print(f"[rerank] ranking={order}, oceny={scores}")
            if order:
                return order, scores
        print("[rerank] brak poprawnych wynikow -> fallback wizualny")
    except Exception as e:  # noqa: BLE001
        print(f"[rerank] BLAD: {e}")
    return list(range(len(cands))), {}


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
    recall_k = max(top_k, int(body.get("recallK", 8)))  # ile kandydatów do rerankingu
    emb = _embed_image(image_bytes)
    vec = "[" + ",".join(str(x) for x in emb) + "]"

    # Opis wycinka zapytania NAJPIERW — daje kategorię (twarda bramka) + drugi sygnał do rerankingu.
    query_attrs = _describe_query(image_bytes)
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
            "  SELECT DISTINCT ON (product_id) optima_id, name, params, image_s3_url, attributes,"
            "         source, category, manufacturer, catalog_page, catalog_name, catalog_pdf, sim"
            "  FROM ("
            "    SELECT p.id AS product_id, p.optima_id, p.name, p.params, pi.image_s3_url, pi.attributes,"
            "           p.source, p.category, p.manufacturer, p.catalog_page,"
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
            "optimaId": optima_id, "name": name, "params": params,
            "image_s3_url": image_s3_url, "attributes": attributes,
            "source": source, "category": category, "manufacturer": manufacturer,
            "catalog_page": catalog_page, "catalog_name": catalog_name, "catalog_pdf": catalog_pdf,
            "sim": round(float(sim), 4),
        }
        for (optima_id, name, params, image_s3_url, attributes, source, category,
             manufacturer, catalog_page, catalog_name, catalog_pdf, sim) in rows
    ]

    # Rerank Sonnet 4.5 na zdjęciach i atrybutach (kandydaci już w tej samej kategorii).
    order, scores = _rerank(image_bytes, cands, query_attrs)

    results = []
    for idx in order[:top_k]:
        c = cands[idx]
        score = scores.get(idx)  # ocena dopasowania 0-100 z rerankingu (gdy dostępna)
        # Wyświetlany wynik = ocena rerankingu (spójna z kolejnością); fallback: cosinus Titana.
        match = round(score / 100, 4) if score is not None else c["sim"]
        item = {
            "optimaId": c["optimaId"],
            "name": c["name"],
            "params": c["params"],
            "imageUrl": _presign_get(c["image_s3_url"]),
            "similarity": match,
            "visualSimilarity": c["sim"],  # surowy cosinus Titana (pomocniczo)
            "reranked": score is not None,
            "source": c["source"],
            "category": c["category"],
        }
        # Odniesienie do źródła: produkt z katalogu → link do PDF w S3 otwierany na właściwej stronie.
        if c["source"] == "catalog" and c["catalog_pdf"]:
            item["manufacturer"] = c["manufacturer"]
            item["catalogName"] = c["catalog_name"]
            item["catalogPage"] = c["catalog_page"]
            item["catalogUrl"] = _presign_get(c["catalog_pdf"])
        results.append(item)
    return _resp(200, {"results": results, "queryCategory": cat})


def _resp(status, data):
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
        },
        "body": json.dumps(data, ensure_ascii=False),
    }
