"""Lambda: auto-detekcja mebli/produktów na obrazie (Claude Haiku 4.5 vision).

Wejście (JSON body): { imageBase64 }  (JPEG w base64)
Wyjście: { items: [{ label, box:{x,y,w,h} }] }  (box znormalizowany 0-1)
"""
import base64
import json
import os

import boto3

bedrock = boto3.client(
    "bedrock-runtime",
    region_name=os.environ.get("AWS_REGION", "eu-central-1"),
)
MODEL_ID = os.environ["DETECT_MODEL_ID"]  # eu.anthropic.claude-haiku-4-5-...

SYSTEM = (
    "Analizujesz obraz (wizualizacja wnętrza lub zdjęcie). Zidentyfikuj widoczne MEBLE/PRODUKTY "
    "(np. sofa, narożnik, fotel, stół, krzesło, lampa, komoda, dywan, regał). "
    "Dla każdego podaj krótką etykietę po polsku (typ + ew. kolor/cecha) oraz przybliżony bounding box "
    "znormalizowany do 0-1: x,y = lewy górny róg, w,h = szerokość/wysokość (ułamki wymiarów obrazu). "
    'Zwróć WYŁĄCZNIE JSON: {"items":[{"label":"...","box":{"x":0.0,"y":0.0,"w":0.0,"h":0.0}}]}. '
    "Bez markdown, bez komentarzy. Gdy brak mebli — pusta lista. Maksymalnie 10 obiektów."
)


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


def lambda_handler(event, _ctx):
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

    out = bedrock.converse(
        modelId=MODEL_ID,
        system=[{"text": SYSTEM}],
        messages=[
            {
                "role": "user",
                "content": [
                    {"image": {"format": _img_format(image_bytes), "source": {"bytes": image_bytes}}},
                    {"text": "Wypisz meble/produkty z tego obrazu jako JSON."},
                ],
            }
        ],
        inferenceConfig={"maxTokens": 1200, "temperature": 0},
    )
    text = out["output"]["message"]["content"][0]["text"]
    data = _parse_json(text)
    raw_items = data.get("items", []) if isinstance(data, dict) else []

    items = []
    for it in raw_items:
        if not isinstance(it, dict):
            continue
        b = it.get("box") or {}
        try:
            box = {k: max(0.0, min(1.0, float(b.get(k, 0)))) for k in ("x", "y", "w", "h")}
        except (TypeError, ValueError):
            continue
        if box["w"] <= 0 or box["h"] <= 0:
            continue
        items.append({"label": str(it.get("label", "obiekt")), "box": box})

    return _resp(200, {"items": items})


def _parse_json(text):
    text = text.strip()
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


def _resp(status, data):
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
        },
        "body": json.dumps(data, ensure_ascii=False),
    }
