"""Lambda: ekstrakcja parametrów mebla z surowego opisu (Claude Haiku 4.5 na Bedrock).

Wejście (JSON body): { description }
Wyjście: { params: {...} }  — ustrukturyzowane parametry.
"""
import json
import os

import boto3

bedrock = boto3.client(
    "bedrock-runtime",
    region_name=os.environ.get("AWS_REGION", "eu-central-1"),
)
MODEL_ID = os.environ["EXTRACT_MODEL_ID"]  # eu.anthropic.claude-haiku-4-5-...

# Kształt zgodny z docs/product-data-model.md (kanon params).
SYSTEM = (
    "Wyciągasz ustrukturyzowane parametry produktu (mebel/wnętrze) z surowego opisu producenta. "
    "Zwróć WYŁĄCZNIE poprawny JSON (bez markdown, bez komentarzy) o kluczach: "
    "kategoria (string|null), kod_produktu (string|null), cena_pln (number|null), "
    "material (string|null), kolor (string|null), styl (string|null), "
    "wymiary_cm (obiekt: szerokosc, glebokosc, wysokosc, wysokosc_siedziska, dlugosc_spania — liczby lub null), "
    "specyfikacja (obiekt: konstrukcja, wypelnienie, funkcje [lista], nosnosc_kg, gwarancja — null/[] gdy brak), "
    "warianty (lista obiektów {nazwa, kolor, material, kod} — [] gdy brak). "
    "Czego nie ma w opisie → null (lub [] dla list). Wymiary jako liczby w cm."
)


def lambda_handler(event, _ctx):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _resp(400, {"error": "Nieprawidłowy JSON"})

    desc = (body.get("description") or "").strip()
    if not desc:
        return _resp(400, {"error": "Brak pola 'description'"})

    out = bedrock.converse(
        modelId=MODEL_ID,
        system=[{"text": SYSTEM}],
        messages=[{"role": "user", "content": [{"text": desc}]}],
        inferenceConfig={"maxTokens": 800, "temperature": 0},
    )
    text = out["output"]["message"]["content"][0]["text"]

    params = _parse_json(text)
    if params is None:
        return _resp(502, {"error": "Model nie zwrócił poprawnego JSON", "raw": text})
    return _resp(200, {"params": params})


def _parse_json(text):
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # awaryjnie: wytnij pierwszy blok { ... }
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
