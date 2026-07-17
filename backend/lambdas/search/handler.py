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
    min_sim = float(body.get("minSimilarity", 0.5))  # próg — odcina słabe dopasowania
    emb = _embed_image(image_bytes)
    vec = "[" + ",".join(str(x) for x in emb) + "]"

    def query():
        conn = _db()
        # Multi-image: liczymy podobieństwo per zdjęcie, dedupujemy po produkcie
        # (najlepiej pasujące ujęcie), potem TOP N produktów. :q tylko raz (najgłębiej).
        return conn.run(
            "SELECT * FROM ("
            "  SELECT DISTINCT ON (product_id) optima_id, name, params, image_s3_url, sim"
            "  FROM ("
            "    SELECT p.id AS product_id, p.optima_id, p.name, p.params, pi.image_s3_url,"
            "           1 - (pi.embedding <=> CAST(:q AS vector)) AS sim"
            "    FROM product_images pi JOIN products p ON p.id = pi.product_id"
            "  ) x"
            "  ORDER BY product_id, sim DESC"
            ") y "
            "ORDER BY sim DESC "
            f"LIMIT {top_k}",
            q=vec,
        )

    try:
        rows = query()
    except Exception:  # noqa: BLE001
        _conn = None
        rows = query()

    results = []
    for optima_id, name, params, image_s3_url, similarity in rows:
        sim = round(float(similarity), 4)
        if sim < min_sim:
            continue  # poniżej progu — nie pokazujemy (np. lampa vs sofy)
        results.append(
            {
                "optimaId": optima_id,
                "name": name,
                "params": params,
                "imageUrl": _presign_get(image_s3_url),
                "similarity": sim,
            }
        )
    return _resp(200, {"results": results})


def _resp(status, data):
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
        },
        "body": json.dumps(data, ensure_ascii=False),
    }
