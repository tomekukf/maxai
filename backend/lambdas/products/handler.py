"""Lambda: zapis produktu do bazy (embedding Titan + atomowy INSERT).

Wejście (JSON body): { optimaId, imageKey, name?, sourceUrl?, params? }
  - imageKey: klucz obiektu w buckecie (zdjęcie wgrane wcześniej przez /uploads/presign)
Wyjście: { id }

Kroki: pobierz zdjęcie z S3 -> embedding (Titan Multimodal, 1024) -> INSERT do products.
Sterownik Postgresa: pg8000 (czysty Python, vendorowany do folderu Lambdy).
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
    """Połączenie do RDS (SSL bez weryfikacji CA — MVP), cache między wywołaniami."""
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


def _insert(optima_id, name, params, image_url, source_url, vec):
    conn = _db()
    return conn.run(
        "INSERT INTO products (optima_id, name, params, image_s3_url, source_url, embedding) "
        "VALUES (:oid, :name, CAST(:params AS jsonb), :img, :src, CAST(:emb AS vector)) "
        "RETURNING id",
        oid=optima_id,
        name=name,
        params=json.dumps(params, ensure_ascii=False),
        img=image_url,
        src=source_url,
        emb=vec,
    )


def _presign_get(s3_url: str) -> str:
    without = s3_url.replace("s3://", "", 1)
    bucket, key = without.split("/", 1)
    return s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=3600)


def _list_products():
    global _conn

    def q():
        return _db().run(
            "SELECT optima_id, name, params, image_s3_url FROM products ORDER BY created_at DESC"
        )

    try:
        rows = q()
    except Exception:  # noqa: BLE001
        _conn = None
        rows = q()
    items = [
        {
            "optimaId": optima_id,
            "name": name,
            "params": params,
            "imageUrl": _presign_get(image_s3_url),
        }
        for optima_id, name, params, image_s3_url in rows
    ]
    return _resp(200, {"items": items})


def _delete_s3(s3_url):
    try:
        without = s3_url.replace("s3://", "", 1)
        bucket, key = without.split("/", 1)
        s3.delete_object(Bucket=bucket, Key=key)
    except Exception:  # noqa: BLE001
        pass


def _delete_products(optima_id):
    global _conn

    def run(sql, **kw):
        return _db().run(sql, **kw)

    def fetch():
        if optima_id:
            return run("SELECT image_s3_url FROM products WHERE optima_id = :oid", oid=optima_id)
        return run("SELECT image_s3_url FROM products")

    try:
        rows = fetch()
    except Exception:  # noqa: BLE001
        _conn = None
        rows = fetch()

    for (url,) in rows:
        _delete_s3(url)

    if optima_id:
        run("DELETE FROM products WHERE optima_id = :oid", oid=optima_id)
    else:
        run("DELETE FROM products")
    return _resp(200, {"deleted": len(rows)})


def lambda_handler(event, _ctx):
    global _conn
    method = event.get("requestContext", {}).get("http", {}).get("method", "POST")
    if method == "GET":
        return _list_products()
    if method == "DELETE":
        optima_id = (event.get("pathParameters") or {}).get("optimaId")
        return _delete_products(optima_id)
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"error": "Nieprawidłowy JSON"})

    optima_id = body.get("optimaId")
    image_key = body.get("imageKey")
    if not optima_id or not image_key:
        return _resp(400, {"error": "Wymagane: optimaId, imageKey"})

    name = body.get("name")
    source_url = body.get("sourceUrl")
    params = body.get("params") or {}

    # 1) zdjęcie z S3
    try:
        obj = s3.get_object(Bucket=FILES_BUCKET, Key=image_key)
        image_bytes = obj["Body"].read()
    except Exception as e:  # noqa: BLE001
        return _resp(400, {"error": f"Nie moge pobrac zdjecia: {e}"})

    # 2) embedding
    emb = _embed_image(image_bytes)
    vec = "[" + ",".join(str(x) for x in emb) + "]"
    image_url = f"s3://{FILES_BUCKET}/{image_key}"

    # 3) INSERT (z jednym ponowieniem na wypadek zerwanego połączenia)
    try:
        rows = _insert(optima_id, name, params, image_url, source_url, vec)
    except Exception:  # noqa: BLE001
        _conn = None  # wymuś reconnect
        rows = _insert(optima_id, name, params, image_url, source_url, vec)

    return _resp(200, {"id": str(rows[0][0])})


def _resp(status, data):
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
        },
        "body": json.dumps(data, ensure_ascii=False),
    }
