"""Lambda: generuje presigned URL (PUT) do wgrania pliku na S3.

Wejście (JSON body): { filename, contentType, prefix? }
Wyjście: { uploadUrl, key }

Klient robi potem PUT na uploadUrl z nagłówkiem Content-Type = contentType.
"""
import json
import os
import uuid

import boto3  # dostępne w runtime Lambda (python3.13)
from botocore.config import Config

# Path-style + s3v4: unika 307 TemporaryRedirect (propagacja DNS virtual-hosted
# dla świeżego bucketu). Bez tego klienci podążający za redirectem (Node fetch,
# przeglądarka) dostają SignatureDoesNotMatch, bo podpis był dla innego hosta.
s3 = boto3.client(
    "s3",
    region_name=os.environ.get("AWS_REGION", "eu-central-1"),
    config=Config(s3={"addressing_style": "path"}, signature_version="s3v4"),
)
BUCKET = os.environ["FILES_BUCKET"]
URL_TTL = 900  # sekund


def _is_admin(event) -> bool:
    try:
        claims = event["requestContext"]["authorizer"]["jwt"]["claims"]
    except (KeyError, TypeError):
        return False
    g = claims.get("cognito:groups", "")
    return "admin" in g if isinstance(g, list) else "admin" in str(g)


def lambda_handler(event, _context):
    # Presign używany przez import/zasilanie (admin) → wymaga roli admin.
    if not _is_admin(event):
        return _resp(403, {"error": "Brak uprawnień (wymagana rola admin)"})
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"error": "Nieprawidłowy JSON"})

    filename = str(body.get("filename", "plik"))
    prefix = str(body.get("prefix", "uploads")).strip("/") or "uploads"

    # UWAGA: nie podpisujemy Content-Type — klient może PUT-ować z dowolnym typem.
    # Podpisany Content-Type wymaga identycznego nagłówka po stronie klienta i często
    # powoduje 403 SignatureDoesNotMatch (biblioteki HTTP modyfikują wartość).
    key = f"{prefix}/{uuid.uuid4()}-{filename}"
    url = s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": BUCKET, "Key": key},
        ExpiresIn=URL_TTL,
    )
    return _resp(200, {"uploadUrl": url, "key": key})


def _resp(status, data):
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
        },
        "body": json.dumps(data),
    }
