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

REGION = os.environ.get("AWS_REGION", "eu-central-1")
FILES_BUCKET = os.environ["FILES_BUCKET"]
DB_SECRET_ARN = os.environ["DB_SECRET_ARN"]
EMBED_MODEL_ID = os.environ["EMBED_MODEL_ID"]  # amazon.titan-embed-image-v1

s3 = boto3.client("s3", region_name=REGION)
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


def lambda_handler(event, _ctx):
    global _conn
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
