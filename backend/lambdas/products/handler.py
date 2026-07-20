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


def _delete_prefix(prefix_url: str):
    """Usuń wszystkie obiekty S3 pod prefiksem (np. .../pages/)."""
    try:
        without = prefix_url.replace("s3://", "", 1)
        bucket, prefix = without.split("/", 1)
        token = None
        while True:
            kw = {"Bucket": bucket, "Prefix": prefix}
            if token:
                kw["ContinuationToken"] = token
            resp = s3.list_objects_v2(**kw)
            objs = [{"Key": o["Key"]} for o in resp.get("Contents", [])]
            if objs:
                s3.delete_objects(Bucket=bucket, Delete={"Objects": objs})
            if resp.get("IsTruncated"):
                token = resp.get("NextContinuationToken")
            else:
                break
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
    if not images or not (optima_id or manufacturer_code or body.get("name")):
        return _resp(400, {"error": "Wymagane: images[] oraz optimaId, manufacturerCode lub name"})

    name = body.get("name")
    source_url = body.get("sourceUrl")
    params = body.get("params") or {}
    category = body.get("category")
    subtype = body.get("subtype")
    catalog_id = body.get("catalogId")
    catalog_page = body.get("catalogPage")
    group_id = body.get("groupId")
    source = body.get("source") or ("catalog" if catalog_id else "optima")
    # Opis wizualny LLM tylko gdy włączony (seed katalogu: describe=false → brak kosztu Sonnet).
    do_describe = bool(DESCRIBE_MODEL_ID) and body.get("describe", True) is not False

    def insert_product():
        return _db().run(
            "INSERT INTO products (optima_id, name, params, source_url, source, category, subtype, "
            "manufacturer, manufacturer_code, catalog_id, catalog_page, group_id) "
            "VALUES (:o, :n, CAST(:p AS jsonb), :su, :src, :cat, :st, :mf, :mc, "
            "CAST(:cid AS uuid), :cp, :gid) RETURNING id",
            o=optima_id, n=name, p=json.dumps(params, ensure_ascii=False), su=source_url,
            src=source, cat=category, st=subtype, mf=manufacturer, mc=manufacturer_code,
            cid=catalog_id, cp=catalog_page, gid=group_id,
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
            attrs = im.get("attributes")  # gotowe atrybuty (jeśli przekazane) mają priorytet
            emb_in = im.get("embedding")  # gotowy embedding (import kolekcji) → pomija Titan
            img_bytes = None
            # Bajty zdjęcia potrzebne tylko gdy liczymy embedding lub opis.
            if emb_in is None or (attrs is None and do_describe):
                img_bytes = s3.get_object(Bucket=FILES_BUCKET, Key=key)["Body"].read()
            if emb_in is not None:
                vec = emb_in if isinstance(emb_in, str) else "[" + ",".join(str(x) for x in emb_in) + "]"
            else:
                vec = "[" + ",".join(str(x) for x in _embed_image(img_bytes)) + "]"
            if attrs is None and do_describe and img_bytes is not None:
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


def _page_image_url(pdf_s3_url, catalog_page):
    """Lekki obraz strony katalogu zamiast całego PDF: <prefix>/pages/p{idx}.jpg (idx = strona-1)."""
    if not pdf_s3_url or not catalog_page:
        return None
    prefix = pdf_s3_url.rsplit("/", 1)[0]
    return _presign_get(f"{prefix}/pages/p{int(catalog_page) - 1}.jpg")


def _categories():
    rows = _db().run("SELECT category, count(*) n FROM products WHERE category IS NOT NULL GROUP BY category ORDER BY n DESC")
    return _resp(200, {"items": [{"category": c, "count": int(n)} for c, n in rows]})


def _list(qs):
    qs = qs or {}
    try:
        limit = max(1, min(int(qs.get("limit", 60)), 200))
        offset = max(0, int(qs.get("offset", 0)))
    except (TypeError, ValueError):
        limit, offset = 60, 0
    q = (qs.get("q") or "").strip()
    category = qs.get("category") or None
    source = qs.get("source") or None
    slim = str(qs.get("slim") or "").lower() in ("1", "true", "yes")  # bez presignów (statystyki)

    where, kw = [], {}
    if category:
        where.append("p.category = :cat")
        kw["cat"] = category
    if source:
        where.append("p.source = :src")
        kw["src"] = source
    if q:
        # jeden named-param :q (pg8000 nie lubi powtórzeń) — łączymy pola w jedno wyrażenie
        where.append(
            "((p.name || ' ' || coalesce(p.manufacturer_code,'') || ' ' || coalesce(p.optima_id,'') "
            "|| ' ' || coalesce(p.params->>'sku','') || ' ' || coalesce(p.subtype,'')) ILIKE :q)"
        )
        kw["q"] = f"%{q}%"
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    total = int(_db().run(f"SELECT count(*) FROM products p {where_sql}", **kw)[0][0])

    if slim:
        rows = _db().run(
            "SELECT p.id, p.optima_id, p.name, p.source, p.category, p.subtype, p.manufacturer_code, "
            "(SELECT count(*) FROM product_images pi WHERE pi.product_id = p.id) AS image_count "
            f"FROM products p {where_sql} ORDER BY p.created_at DESC LIMIT {limit} OFFSET {offset}",
            **kw,
        )
        items = [
            {"id": str(pid), "optimaId": oid, "name": name, "source": src, "category": cat_,
             "subtype": sub, "manufacturerCode": code, "imageUrl": None, "imageCount": int(ic)}
            for pid, oid, name, src, cat_, sub, code, ic in rows
        ]
        return _resp(200, {"items": items, "total": total, "limit": limit, "offset": offset})

    rows = _db().run(
        "SELECT p.id, p.optima_id, p.name, p.params, p.source, p.category, p.subtype, p.manufacturer_code, "
        "p.group_id, "
        "(SELECT image_s3_url FROM product_images pi WHERE pi.product_id = p.id "
        " ORDER BY sort_order, created_at LIMIT 1) AS primary_image, "
        "(SELECT count(*) FROM product_images pi WHERE pi.product_id = p.id) AS image_count "
        f"FROM products p {where_sql} ORDER BY p.created_at DESC LIMIT {limit} OFFSET {offset}",
        **kw,
    )
    items = [
        {
            "id": str(pid), "optimaId": optima_id, "name": name, "params": params, "source": source,
            "category": category_, "subtype": subtype, "manufacturerCode": mfr_code, "groupId": group_id,
            "imageUrl": _presign_get(primary_image) if primary_image else None, "imageCount": int(image_count),
        }
        for pid, optima_id, name, params, source, category_, subtype, mfr_code, group_id, primary_image, image_count in rows
    ]
    return _resp(200, {"items": items, "total": total, "limit": limit, "offset": offset})


def _detail(pid):
    rows = _db().run(
        "SELECT p.optima_id, p.name, p.params, p.source, p.category, p.subtype, p.manufacturer, "
        "p.manufacturer_code, p.group_id, p.catalog_page, c.name, c.pdf_s3_url "
        "FROM products p LEFT JOIN catalogs c ON c.id = p.catalog_id "
        "WHERE p.id = CAST(:id AS uuid)",
        id=pid,
    )
    if not rows:
        return _resp(404, {"error": "Nie znaleziono produktu"})
    (optima_id, name, params, source, category, subtype, manufacturer, mfr_code,
     group_id, catalog_page, catalog_name, catalog_pdf) = rows[0]
    imgs = _db().run(
        "SELECT image_s3_url, attributes, sort_order FROM product_images "
        "WHERE product_id = CAST(:id AS uuid) ORDER BY sort_order, created_at",
        id=pid,
    )
    images = [{"imageUrl": _presign_get(u), "attributes": a, "sortOrder": so} for (u, a, so) in imgs]
    product = {
        "id": pid, "optimaId": optima_id, "name": name, "params": params, "source": source,
        "category": category, "subtype": subtype, "manufacturer": manufacturer,
        "manufacturerCode": mfr_code, "groupId": group_id, "images": images,
    }
    if source == "catalog" and catalog_pdf:
        product["catalog"] = {
            "name": catalog_name, "page": catalog_page, "pdfUrl": _presign_get(catalog_pdf),
            "pageImageUrl": _page_image_url(catalog_pdf, catalog_page),
        }
    return _resp(200, {"product": product})


# Edytowalne metadane (bez ruszania embeddingu/zdjęć).
_EDITABLE = {
    "name": "name", "optimaId": "optima_id", "category": "category", "subtype": "subtype",
    "sourceUrl": "source_url", "manufacturer": "manufacturer", "manufacturerCode": "manufacturer_code",
    "groupId": "group_id",
}


def _update(pid, body):
    if not pid:
        return _resp(400, {"error": "Brak id"})
    sets, kw = [], {"id": pid}
    for key, col in _EDITABLE.items():
        if key in body:
            sets.append(f"{col} = :{col}")
            kw[col] = body[key]
    if "params" in body:
        sets.append("params = CAST(:params AS jsonb)")
        kw["params"] = json.dumps(body["params"], ensure_ascii=False)
    if not sets:
        return _resp(400, {"error": "Brak pól do aktualizacji"})
    try:
        rows = _db().run(
            f"UPDATE products SET {', '.join(sets)} WHERE id = CAST(:id AS uuid) RETURNING id", **kw
        )
    except Exception as e:  # noqa: BLE001
        if _is_dup(str(e)):
            return _resp(409, {"error": "Kod produktu już istnieje (manufacturer+code)"})
        raise
    if not rows:
        return _resp(404, {"error": "Nie znaleziono produktu"})
    return _resp(200, {"id": str(rows[0][0]), "updated": True})


def _delete_by_id(pid):
    conn = _db()
    img_rows = conn.run(
        "SELECT image_s3_url FROM product_images WHERE product_id = CAST(:id AS uuid)", id=pid
    )
    n = int(conn.run("SELECT count(*) FROM products WHERE id = CAST(:id AS uuid)", id=pid)[0][0])
    for (url,) in img_rows:
        _delete_s3(url)
    conn.run("DELETE FROM products WHERE id = CAST(:id AS uuid)", id=pid)  # cascade → product_images
    return _resp(200, {"deleted": n})


def _delete_all():
    conn = _db()
    for (url,) in conn.run("SELECT image_s3_url FROM product_images"):
        _delete_s3(url)
    n = int(conn.run("SELECT count(*) FROM products")[0][0])
    conn.run("DELETE FROM products")  # cascade
    return _resp(200, {"deleted": n})


# ---------- katalogi (import/eksport kolekcji) ----------

def _catalog_create(body):
    name = body.get("name")
    manufacturer = body.get("manufacturer")
    domain = body.get("domainCategory")
    pdf_key = body.get("pdfKey")
    page_count = body.get("pageCount")
    pdf_url = f"s3://{FILES_BUCKET}/{pdf_key}" if pdf_key else ""
    rows = _db().run(
        "INSERT INTO catalogs (name, manufacturer, domain_category, pdf_s3_url, page_count, status) "
        "VALUES (:n, :m, :d, :u, :pc, 'ready') RETURNING id",
        n=name, m=manufacturer, d=domain, u=pdf_url, pc=page_count,
    )
    return _resp(200, {"id": str(rows[0][0])})


def _catalog_list():
    rows = _db().run(
        "SELECT c.id, c.name, c.manufacturer, c.domain_category, c.page_count, "
        "(SELECT count(*) FROM products p WHERE p.catalog_id = c.id) AS product_count "
        "FROM catalogs c ORDER BY c.created_at DESC"
    )
    items = [
        {"id": str(cid), "name": n, "manufacturer": m, "domainCategory": d,
         "pageCount": pc, "productCount": int(cnt)}
        for cid, n, m, d, pc, cnt in rows
    ]
    return _resp(200, {"items": items})


def _catalog_export(cid):
    crow = _db().run(
        "SELECT name, manufacturer, domain_category, pdf_s3_url, page_count "
        "FROM catalogs WHERE id = CAST(:id AS uuid)", id=cid,
    )
    if not crow:
        return _resp(404, {"error": "Nie znaleziono katalogu"})
    name, manufacturer, domain, pdf_url, page_count = crow[0]
    prows = _db().run(
        "SELECT id, optima_id, name, params, category, subtype, manufacturer, manufacturer_code, catalog_page, group_id "
        "FROM products WHERE catalog_id = CAST(:id AS uuid) ORDER BY catalog_page, created_at", id=cid,
    )
    products = []
    for (pid, optima_id, pname, params, category, subtype, mfr, mfr_code, cpage, group_id) in prows:
        imgs = _db().run(
            "SELECT image_s3_url, attributes, sort_order, embedding::text "
            "FROM product_images WHERE product_id = CAST(:id AS uuid) ORDER BY sort_order, created_at", id=str(pid),
        )
        images = [
            {"key": u.replace(f"s3://{FILES_BUCKET}/", "", 1), "attributes": a,
             "sortOrder": so, "embedding": emb}
            for (u, a, so, emb) in imgs
        ]
        products.append({
            "optimaId": optima_id, "name": pname, "params": params, "category": category,
            "subtype": subtype, "manufacturer": mfr, "manufacturerCode": mfr_code,
            "catalogPage": cpage, "groupId": group_id, "images": images,
        })
    pkg = {
        "catalog": {"name": name, "manufacturer": manufacturer, "domainCategory": domain,
                    "pdfKey": pdf_url.replace(f"s3://{FILES_BUCKET}/", "", 1) if pdf_url else None,
                    "pageCount": page_count},
        "products": products,
    }
    # Paczka bywa duża (embeddingi) → zapis do S3 + presigned URL do pobrania (omija limit 6 MB API GW).
    key = f"exports/{cid}.json"
    s3.put_object(
        Bucket=FILES_BUCKET, Key=key,
        Body=json.dumps(pkg, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
    )
    return _resp(200, {
        "downloadUrl": _presign_get(f"s3://{FILES_BUCKET}/{key}"),
        "catalog": pkg["catalog"], "productCount": len(products),
    })


def _catalog_delete(cid):
    """Usuń całe źródło: katalog + jego produkty (kaskada) + zdjęcia/pdf/strony z S3."""
    if not cid:
        return _resp(400, {"error": "Brak id"})
    conn = _db()
    crow = conn.run("SELECT pdf_s3_url FROM catalogs WHERE id = CAST(:id AS uuid)", id=cid)
    if not crow:
        return _resp(404, {"error": "Nie znaleziono źródła"})
    imgs = conn.run(
        "SELECT pi.image_s3_url FROM product_images pi JOIN products p ON p.id = pi.product_id "
        "WHERE p.catalog_id = CAST(:id AS uuid)", id=cid,
    )
    n = int(conn.run("SELECT count(*) FROM products WHERE catalog_id = CAST(:id AS uuid)", id=cid)[0][0])
    for (u,) in imgs:
        _delete_s3(u)
    pdf = crow[0][0]
    if pdf:
        _delete_s3(pdf)
        _delete_prefix(pdf.rsplit("/", 1)[0] + "/pages/")  # lekkie strony katalogu
    _delete_s3(f"s3://{FILES_BUCKET}/exports/{cid}.json")  # ewentualny eksport
    conn.run("DELETE FROM catalogs WHERE id = CAST(:id AS uuid)", id=cid)  # cascade → products → product_images
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


def _is_admin(event) -> bool:
    """Grupa 'admin' z claims JWT (authorizer Cognito). Operacje mutujące tylko dla admina."""
    try:
        claims = event["requestContext"]["authorizer"]["jwt"]["claims"]
    except (KeyError, TypeError):
        return False
    g = claims.get("cognito:groups", "")
    return "admin" in g if isinstance(g, list) else "admin" in str(g)


def lambda_handler(event, _ctx):
    http = event.get("requestContext", {}).get("http", {})
    method = http.get("method", "POST")
    path = event.get("rawPath") or http.get("path", "") or ""
    pp = event.get("pathParameters") or {}
    pid = pp.get("id") or pp.get("optimaId")  # ścieżka używa zmiennej {optimaId}, ale przyjmujemy UUID
    mutating = method in ("POST", "PUT", "DELETE")
    if mutating and not _is_admin(event):
        return _resp(403, {"error": "Brak uprawnień (wymagana rola admin)"})

    # --- katalogi ---
    if path.startswith("/catalogs"):
        if method == "GET" and path.endswith("/export"):
            return _with_retry(lambda: _catalog_export(pp.get("id")))
        if method == "GET":
            return _with_retry(_catalog_list)
        if method == "DELETE":
            return _with_retry(lambda: _catalog_delete(pp.get("id")))
        if method == "POST":
            try:
                body = json.loads(event.get("body") or "{}")
            except json.JSONDecodeError:
                return _resp(400, {"error": "Nieprawidłowy JSON"})
            return _with_retry(lambda: _catalog_create(body))
        return _resp(405, {"error": "Metoda nieobsługiwana"})

    # --- kategorie ---
    if path.startswith("/categories") and method == "GET":
        return _with_retry(_categories)

    # --- produkty ---
    if method == "GET":
        qs = event.get("queryStringParameters") or {}
        return _with_retry((lambda: _detail(pid)) if pid else (lambda: _list(qs)))
    if method == "DELETE":
        return _with_retry((lambda: _delete_by_id(pid)) if pid else _delete_all)
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"error": "Nieprawidłowy JSON"})
    if method == "PUT":
        return _with_retry(lambda: _update(pid, body))
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
