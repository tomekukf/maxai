"""Lambda: produkty (multi-image).

POST   /products            → utwórz produkt + osadź wiele zdjęć (imageKeys[])
GET    /products            → lista produktów (z głównym zdjęciem)
DELETE /products            → usuń wszystkie (+ zdjęcia z S3)
DELETE /products/{optimaId} → usuń jeden (+ zdjęcia z S3)

Każde zdjęcie ma własny embedding (tabela product_images). Sterownik: pg8000.
"""
import json
import os
import ssl

import boto3
import pg8000.native  # vendorowane (pip install -t)
from botocore.config import Config

REGION = os.environ.get("AWS_REGION", "eu-central-1")
FILES_BUCKET = os.environ["FILES_BUCKET"]
DB_SECRET_ARN = os.environ["DB_SECRET_ARN"]
EMBED_MODEL_ID = os.environ["EMBED_MODEL_ID"]  # amazon.titan-embed-image-v1
DESCRIBE_MODEL_ID = os.environ.get("DESCRIBE_MODEL_ID")  # Sonnet 4.5 (opis wizualny; opcjonalne)

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
    import base64

    b64 = base64.b64encode(image_bytes).decode()
    out = bedrock.invoke_model(
        modelId=EMBED_MODEL_ID,
        body=json.dumps({"inputImage": b64, "embeddingConfig": {"outputEmbeddingLength": 1024}}),
    )
    return json.loads(out["body"].read())["embedding"]


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


# Skrócony prompt wg docs/product-description-spec.md
DESCRIBE_SYSTEM = (
    "Jesteś ekspertem od opisu wizualnego mebli. Na podstawie zdjęcia opisz produkt WYŁĄCZNIE tym, "
    "co widać. Zwróć wyłącznie poprawny JSON o kluczach: typ, podtyp, ksztalt_ogolny, sylwetka, "
    "oparcie, podlokietniki, nogi_podstawa, poduszki, material, kolor_dominujacy, kolory_dodatkowe[], "
    "wzor_faktura, styl, cechy[], opis_swobodny. Po polsku, zwięźle, skupiając się na cechach "
    "różnicujących wygląd (bryła, kształt, proporcje, detale). Czego nie widać → null (lub []). "
    "Bez markdown, bez komentarzy."
)


def _describe(image_bytes: bytes, name=None):
    if not DESCRIBE_MODEL_ID:
        return None
    hint = f"Nazwa handlowa produktu: {name}. " if name else ""
    try:
        out = bedrock.converse(
            modelId=DESCRIBE_MODEL_ID,
            system=[{"text": DESCRIBE_SYSTEM}],
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"image": {"format": _img_format(image_bytes), "source": {"bytes": image_bytes}}},
                        {
                            "text": hint
                            + "Opisz ten produkt wg schematu (JSON). Pole 'typ' MUSI być zgodne z nazwą "
                            "handlową (np. gdy nazwa mówi 'sofa'/'kanapa' — to nie jest fotel)."
                        },
                    ],
                }
            ],
            inferenceConfig={"maxTokens": 800, "temperature": 0},
        )
        return _parse_json(out["output"]["message"]["content"][0]["text"])
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


def _presign_get(s3_url: str) -> str:
    without = s3_url.replace("s3://", "", 1)
    bucket, key = without.split("/", 1)
    return s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=3600)


def _delete_s3(s3_url: str):
    try:
        without = s3_url.replace("s3://", "", 1)
        bucket, key = without.split("/", 1)
        s3.delete_object(Bucket=bucket, Key=key)
    except Exception:  # noqa: BLE001
        pass


# ---------- operacje ----------

def _is_dup(msg):
    return "products_mfr_code_uq" in msg or "duplicate key" in msg


def _create(body):
    global _conn
    optima_id = body.get("optimaId")
    manufacturer = body.get("manufacturer")
    manufacturer_code = body.get("manufacturerCode")

    # Zdjęcia: bogata lista images:[{key, attributes?, sortOrder?}] LUB imageKeys[] (wstecz).
    images = body.get("images")
    if not images:
        keys = body.get("imageKeys") or ([body["imageKey"]] if body.get("imageKey") else [])
        images = [{"key": k} for k in keys]
    if not images or not (optima_id or manufacturer_code):
        return _resp(400, {"error": "Wymagane: images[]/imageKeys[] oraz optimaId lub manufacturerCode"})

    name = body.get("name")
    source_url = body.get("sourceUrl")
    params = body.get("params") or {}
    category = body.get("category")
    subtype = body.get("subtype")
    catalog_id = body.get("catalogId")
    catalog_page = body.get("catalogPage")
    source = body.get("source") or ("catalog" if catalog_id else "optima")
    # Opis wizualny LLM tylko gdy włączony (seed katalogu: describe=false → brak kosztu Sonnet).
    do_describe = bool(DESCRIBE_MODEL_ID) and body.get("describe", True) is not False

    def insert_product():
        return _db().run(
            "INSERT INTO products (optima_id, name, params, source_url, source, category, subtype, "
            "manufacturer, manufacturer_code, catalog_id, catalog_page) "
            "VALUES (:o, :n, CAST(:p AS jsonb), :su, :src, :cat, :st, :mf, :mc, "
            "CAST(:cid AS uuid), :cp) RETURNING id",
            o=optima_id, n=name, p=json.dumps(params, ensure_ascii=False), su=source_url,
            src=source, cat=category, st=subtype, mf=manufacturer, mc=manufacturer_code,
            cid=catalog_id, cp=catalog_page,
        )

    try:
        rows = insert_product()
    except Exception as e:  # noqa: BLE001
        if _is_dup(str(e)):
            return _resp(200, {"duplicate": True, "skipped": True, "manufacturerCode": manufacturer_code})
        _conn = None
        try:
            rows = insert_product()
        except Exception as e2:  # noqa: BLE001
            if _is_dup(str(e2)):
                return _resp(200, {"duplicate": True, "skipped": True, "manufacturerCode": manufacturer_code})
            return _resp(500, {"error": str(e2)[:200]})
    pid = str(rows[0][0])

    inserted = 0
    for i, im in enumerate(images):
        key = im.get("key")
        if not key:
            continue
        try:
            obj = s3.get_object(Bucket=FILES_BUCKET, Key=key)
            img_bytes = obj["Body"].read()
            emb = _embed_image(img_bytes)
            vec = "[" + ",".join(str(x) for x in emb) + "]"
            attrs = im.get("attributes")  # gotowe atrybuty (jeśli przekazane) mają priorytet
            if attrs is None and do_describe:
                attrs = _describe(img_bytes, name)  # opis wizualny (Sonnet 4.5), z kontekstem nazwy
            _db().run(
                "INSERT INTO product_images (product_id, image_s3_url, embedding, attributes, sort_order) "
                "VALUES (CAST(:pid AS uuid), :url, CAST(:emb AS vector), CAST(:attr AS jsonb), :so)",
                pid=pid,
                url=f"s3://{FILES_BUCKET}/{key}",
                emb=vec,
                attr=json.dumps(attrs, ensure_ascii=False) if attrs else None,
                so=im.get("sortOrder", i),
            )
            inserted += 1
        except Exception:  # noqa: BLE001
            continue

    if inserted == 0:
        _db().run("DELETE FROM products WHERE id = CAST(:pid AS uuid)", pid=pid)
        return _resp(502, {"error": "Nie udało się osadzić żadnego zdjęcia"})
    return _resp(200, {"id": pid, "images": inserted})


def _list():
    rows = _db().run(
        "SELECT p.optima_id, p.name, p.params, "
        "(SELECT image_s3_url FROM product_images pi WHERE pi.product_id = p.id "
        " ORDER BY sort_order, created_at LIMIT 1) AS primary_image, "
        "(SELECT count(*) FROM product_images pi WHERE pi.product_id = p.id) AS image_count "
        "FROM products p ORDER BY p.created_at DESC"
    )
    items = []
    for optima_id, name, params, primary_image, image_count in rows:
        items.append(
            {
                "optimaId": optima_id,
                "name": name,
                "params": params,
                "imageUrl": _presign_get(primary_image) if primary_image else None,
                "imageCount": int(image_count),
            }
        )
    return _resp(200, {"items": items})


def _delete(optima_id):
    conn = _db()
    if optima_id:
        img_rows = conn.run(
            "SELECT pi.image_s3_url FROM product_images pi "
            "JOIN products p ON p.id = pi.product_id WHERE p.optima_id = :oid",
            oid=optima_id,
        )
        n = int(conn.run("SELECT count(*) FROM products WHERE optima_id = :oid", oid=optima_id)[0][0])
    else:
        img_rows = conn.run("SELECT image_s3_url FROM product_images")
        n = int(conn.run("SELECT count(*) FROM products")[0][0])

    for (url,) in img_rows:
        _delete_s3(url)

    if optima_id:
        conn.run("DELETE FROM products WHERE optima_id = :oid", oid=optima_id)  # cascade → product_images
    else:
        conn.run("DELETE FROM products")  # cascade
    return _resp(200, {"deleted": n})


def _with_retry(fn):
    global _conn
    try:
        return fn()
    except Exception:  # noqa: BLE001
        _conn = None
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            return _resp(500, {"error": str(e)[:200]})


def lambda_handler(event, _ctx):
    method = event.get("requestContext", {}).get("http", {}).get("method", "POST")
    if method == "GET":
        return _with_retry(_list)
    if method == "DELETE":
        optima_id = (event.get("pathParameters") or {}).get("optimaId")
        return _with_retry(lambda: _delete(optima_id))
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"error": "Nieprawidłowy JSON"})
    return _create(body)


def _resp(status, data):
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
        },
        "body": json.dumps(data, ensure_ascii=False),
    }
