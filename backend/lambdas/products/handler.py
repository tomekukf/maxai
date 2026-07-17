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

def _create(body):
    global _conn
    optima_id = body.get("optimaId")
    image_keys = body.get("imageKeys")
    if not image_keys and body.get("imageKey"):
        image_keys = [body["imageKey"]]  # kompatybilność wstecz
    if not optima_id or not image_keys:
        return _resp(400, {"error": "Wymagane: optimaId, imageKeys[]"})

    name = body.get("name")
    source_url = body.get("sourceUrl")
    params = body.get("params") or {}

    def insert_product():
        return _db().run(
            "INSERT INTO products (optima_id, name, params, source_url) "
            "VALUES (:o, :n, CAST(:p AS jsonb), :s) RETURNING id",
            o=optima_id,
            n=name,
            p=json.dumps(params, ensure_ascii=False),
            s=source_url,
        )

    try:
        rows = insert_product()
    except Exception:  # noqa: BLE001
        _conn = None
        rows = insert_product()
    pid = str(rows[0][0])

    inserted = 0
    for i, key in enumerate(image_keys):
        try:
            obj = s3.get_object(Bucket=FILES_BUCKET, Key=key)
            emb = _embed_image(obj["Body"].read())
            vec = "[" + ",".join(str(x) for x in emb) + "]"
            _db().run(
                "INSERT INTO product_images (product_id, image_s3_url, embedding, sort_order) "
                "VALUES (CAST(:pid AS uuid), :url, CAST(:emb AS vector), :so)",
                pid=pid,
                url=f"s3://{FILES_BUCKET}/{key}",
                emb=vec,
                so=i,
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
