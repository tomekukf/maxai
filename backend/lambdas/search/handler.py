"""Lambda: wyszukiwanie substytutów (embedding wycinka → pgvector cosine → TOP N).

Wejście (JSON body): { imageBase64, topK? }
Wyjście: { results: [{ optimaId, name, params, imageUrl, similarity }] }

imageUrl to presigned GET (do podglądu w UI). Sygnał główny: podobieństwo wizualne.
"""
import base64
import json
import os
import re
import ssl

import boto3
import pg8000.native  # vendorowane (pip install -t)
from botocore.config import Config

REGION = os.environ.get("AWS_REGION", "eu-central-1")
FILES_BUCKET = os.environ["FILES_BUCKET"]
DB_SECRET_ARN = os.environ["DB_SECRET_ARN"]
EMBED_MODEL_ID = os.environ["EMBED_MODEL_ID"]
RERANK_MODEL_ID = os.environ.get("RERANK_MODEL_ID")  # Sonnet 4.5 (rerank; opcjonalne)
# Opis wycinka + kontekst z rysunku — tańszy Haiku (fallback: to co rerank). Rerank zostaje na Sonnet.
DESCRIBE_MODEL_ID = os.environ.get("DESCRIBE_MODEL_ID") or RERANK_MODEL_ID

# Poniżej tej oceny sędziego uznajemy, że w asortymencie NIE MA odpowiednika (UI pokazuje to wprost,
# zamiast podawać 10-15% jako „propozycję"). Wyniki nadal zwracamy — jako „najbliższe wizualnie".
WEAK_MATCH_BELOW = int(os.environ.get("WEAK_MATCH_BELOW", "30"))

# Kategorie siostrzane dla bramki. Granica taksonomii nie zawsze pokrywa się z intencją:
# „płytki podłogowe" opisujemy jako `podlogi` (u nas = panele/deski), a ceramika leży w `plytki`;
# „szafka łazienkowa" trafia na `szafka` (meble pokojowe), a szafki podumywalkowe są w `lazienka`.
# Bramka pozostaje TWARDA — poszerzamy tylko jej granicę o kategorie realnie wymienne.
_SIBLING_CATEGORIES = {
    "plytki": ("podlogi",),
    "podlogi": ("plytki",),
    "szafka": ("komoda", "mebel", "lazienka"),
    "komoda": ("szafka", "mebel"),
    "regal": ("szafka", "mebel"),
    "mebel": ("szafka", "komoda", "regal"),
    "stol": ("stolik",),
    "stolik": ("stol",),
    "sofa": ("naroznik",),
    "naroznik": ("sofa",),
}

# --- Sufity kosztu jednego zapytania (zdjęcia to ~90% rachunku za rerank) ---
RERANK_IMG_BUDGET = int(os.environ.get("RERANK_IMG_BUDGET", "8"))   # maks. zdjęć kandydatów na 1 rerank
MAX_RECALL_QUALITY = int(os.environ.get("MAX_RECALL_QUALITY", "12"))  # maks. kandydatów do oceny sędziego
MAX_RECALL_FAST = int(os.environ.get("MAX_RECALL_FAST", "60"))        # tryb szybki nie woła Sonneta → można głębiej

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


def _page_image_url(pdf_s3_url, catalog_page):
    """Lekki obraz strony katalogu (JPEG) zamiast całego PDF: <prefix>/pages/p{idx}.jpg (idx = strona-1)."""
    if not pdf_s3_url or not catalog_page:
        return None
    prefix = pdf_s3_url.rsplit("/", 1)[0]  # s3://.../catalogs/<folder>
    return _presign_get(f"{prefix}/pages/p{int(catalog_page) - 1}.jpg")


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
    "sofa, naroznik, fotel, krzeslo, stol, stolik, lozko, szafka, komoda, regal, mebel, "
    "oswietlenie, plytki, podlogi, lazienka, drzwi, tapety, sztukateria, lustro, dywan, dekoracja, inne"
)
DESCRIBE_SYSTEM = (
    "Jesteś ekspertem od opisu wizualnego mebli i produktów wnętrzarskich (meble, oświetlenie, "
    "płytki, dywany…). Na podstawie zdjęcia opisz produkt WYŁĄCZNIE tym, co widać. NAJPIERW ustal "
    f"'kategoria' (kanoniczny slug: {CANON_CATEGORIES}) oraz 'subtype' (generyczny podtyp w obrębie "
    "kategorii, np. dla oświetlenia: wiszaca/kinkiet/plafon/stolowa/podlogowa/reflektor_szynowy/"
    "downlight/zyrandol). Zwróć wyłącznie poprawny JSON o kluczach: kategoria, subtype, typ, "
    "ksztalt_ogolny, material, kolor_dominujacy, kolory_dodatkowe[], wzor_faktura, styl, cechy[], "
    "atrybuty_kategorii{}, opis_swobodny. Po polsku, zwięźle, skupiając się na cechach różnicujących "
    "wygląd. Czego nie widać → null (lub []). Bez markdown, bez komentarzy. "
    # Powierzchnie wzorzyste (płytki/mozaiki/tapety/podłogi): najczęstszy błąd to nazwanie
    # każdego regularnego rastra 'heksagonem'. Wymuszamy obejrzenie OBRYSU pojedynczego elementu.
    "POWIERZCHNIE WZORZYSTE (płytki, mozaiki, tapety, podłogi): opisz KSZTAŁT POJEDYNCZEGO ELEMENTU, "
    "patrząc na jego obrys, nie na ogólne wrażenie rastra. Nazwij go z listy: heksagon/plaster miodu "
    "(sześciokąt, 6 prostych boków), łuska/rybia łuska (dolna krawędź prosta, górna zaokrąglona), "
    "pióro/wachlarz (wydłużony element zakończony półokrągło), arabeska/jaskółczy ogon (falowane boki), "
    "romb, trójkąt, cegiełka/prostokąt (kafel poziomy lub pionowy), kwadrat, listwa/prążek (wąskie pionowe "
    "lub poziome żłobienia), terrazzo/lastryko, wielkoformatowa płyta. UWAGA: element z zaokrągloną górną "
    "krawędzią to NIE heksagon — heksagon ma sześć PROSTYCH boków i ostre wierzchołki. Jeśli nie masz "
    "pewności, wpisz kształt opisowo (np. 'wydłużony łuk') zamiast zgadywać nazwę geometryczną. "
    "Wynik wpisz do 'ksztalt_ogolny'. "
    "W 'wzor_faktura' podaj ZAWSZE dwie rzeczy osobno: (a) ORIENTACJĘ elementów — pionowo / poziomo / ukośnie; "
    "(b) UKŁAD — w równych rzędach (stack bond, elementy jeden nad drugim) / przesunięty (cegiełkowy) / jodełka / "
    "plaster miodu / losowy / modułowy. Nie pisz 'przesunięty', jeśli elementy tworzą równe kolumny lub rzędy — "
    "sprawdź, czy fugi biegną nieprzerwaną linią (wtedy: w równych rzędach). Dopiero potem faktura (mat/połysk/struktura)."
)

# Normalizacja kategorii zwróconej przez model → kanoniczny slug (bramka).
_CAT_SYNONYMS = {
    "lampa": "oswietlenie", "lampy": "oswietlenie", "oswietlenie": "oswietlenie",
    "oświetlenie": "oswietlenie", "light": "oswietlenie", "lighting": "oswietlenie",
    "zyrandol": "oswietlenie", "kinkiet": "oswietlenie", "plafon": "oswietlenie",
    "kanapa": "sofa", "sofa": "sofa", "naroznik": "naroznik", "narożnik": "naroznik",
    "fotel": "fotel", "krzeslo": "krzeslo", "krzesło": "krzeslo", "stol": "stol",
    "stół": "stol", "stolik": "stolik", "lozko": "lozko", "łóżko": "lozko",
    "szafka": "szafka", "komoda": "komoda", "regal": "regal", "regał": "regal", "mebel": "mebel",
    "plytki": "plytki", "płytki": "plytki", "gres": "plytki", "dywan": "dywan",
    # kategorie z oferty maxfliz:
    "podlogi": "podlogi", "podłoga": "podlogi", "podloga": "podlogi", "panel": "podlogi", "panele": "podlogi",
    "lazienka": "lazienka", "łazienka": "lazienka", "umywalka": "lazienka", "bateria": "lazienka",
    "prysznic": "lazienka", "wanna": "lazienka", "wc": "lazienka", "armatura": "lazienka", "brodzik": "lazienka",
    "drzwi": "drzwi", "tapeta": "tapety", "tapety": "tapety", "fototapeta": "tapety",
    "sztukateria": "sztukateria", "listwa": "sztukateria", "rozeta": "sztukateria",
    "lustro": "lustro", "lustra": "lustro", "dekoracja": "dekoracja",
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


def _describe_query(image_bytes: bytes, hint: str = None):
    """Opisz wycinek zapytania tym samym schematem (drugi sygnał dopasowania).

    hint (opcjonalny) = etykieta z auto-detekcji, np. 'stolik kawowy'. Naprowadza opis na WŁAŚCIWY
    obiekt, gdy w kadrze jest tło (np. stolik na pierwszym planie + pół kanapy w tle). Sygnał MIĘKKI:
    finalną kategorię i tak ustala model (odporność na błędną detekcję)."""
    if not DESCRIBE_MODEL_ID:
        return None
    hint = (hint or "").strip()
    if hint:
        prompt = (
            f"To wycinek z wizualizacji wnętrza. GŁÓWNYM obiektem zapytania jest: «{hint}» — "
            "opisz WŁAŚNIE ten obiekt (pierwszy plan / centrum kadru), a inne meble/produkty w tle "
            "ZIGNORUJ. Jeśli wskazanego obiektu naprawdę nie ma w kadrze, opisz obiekt dominujący. "
            "Zwróć JSON wg schematu."
        )
    else:
        prompt = "Opisz ten mebel wg schematu (JSON). To wycinek z wizualizacji wnętrza."
    try:
        out = bedrock.converse(
            modelId=DESCRIBE_MODEL_ID,
            system=[{"text": DESCRIBE_SYSTEM}],
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"image": {"format": _img_format(image_bytes), "source": {"bytes": image_bytes}}},
                        {"text": prompt},
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


CONTEXT_SYSTEM = (
    "Analizujesz DODATKOWE źródło dołączone do zapytania o produkt wnętrzarski: rysunek techniczny, "
    "kartę katalogową, spec lub zdjęcie detalu. Twoim zadaniem jest wyłuskać PEWNE informacje o produkcie. "
    "ZASADA NADRZĘDNA: podawaj tylko to, co WYRAŹNIE widać/czytasz. Czego nie widać jednoznacznie → null "
    "(dla list → []). NIE ZGADUJ, nie interpoluj, nie wymyślaj marki ani wymiarów. Wymiary podaj TYLKO jeśli "
    "są wypisane liczbami (z jednostką) lub jednoznacznie zwymiarowane na rysunku. "
    'Zwróć WYŁĄCZNIE JSON: {"typ":..,"ksztalt":..,"material":..,"cechy":[..],'
    '"wymiary_cm":{"szerokosc":..,"glebokosc":..,"wysokosc":..,"srednica":..,"dlugosc":..},'
    '"czytelnosc":"dobra|slaba"}. Bez markdown, bez komentarzy.'
)


def _extract_context(image_bytes: bytes):
    """Wyciąga PEWNE cechy z dodatkowego źródła (rysunek/spec). Zwraca dict albo None.
    Anti-halucynacja: model raportuje tylko czytelne pola; niepewne → null."""
    if not DESCRIBE_MODEL_ID:
        return None
    try:
        out = bedrock.converse(
            modelId=DESCRIBE_MODEL_ID,
            system=[{"text": CONTEXT_SYSTEM}],
            messages=[{"role": "user", "content": [
                {"image": {"format": _img_format(image_bytes), "source": {"bytes": image_bytes}}},
                {"text": "Wyłuskaj PEWNE informacje o produkcie z tego źródła (JSON). Niepewne → null."},
            ]}],
            inferenceConfig={"maxTokens": 500, "temperature": 0},
        )
        data = _parse_json(out["output"]["message"]["content"][0]["text"])
        print(f"[context] z rysunku: {json.dumps(data, ensure_ascii=False)[:300]}")
        return data if isinstance(data, dict) else None
    except Exception as e:  # noqa: BLE001
        print(f"[context] BLAD: {e}")
        return None


def _rerank(query_bytes, cands, query_attrs=None, query_context=None):
    """Sonnet 4.5 sędzia: rankuje kandydatów na zdjęciach, odrzuca niepasujących.
    Zwraca listę indeksów (best→worst) pasujących kandydatów.
    query_context = pewne cechy z dołączonego rysunku/spec (typ/kształt/wymiary) — sygnał MIĘKKI."""
    if not RERANK_MODEL_ID or len(cands) <= 1:
        print(f"[rerank] pomijam (model={RERANK_MODEL_ID}, cands={len(cands)})")
        return list(range(len(cands))), {}, {}
    try:
        q_attrs = json.dumps(query_attrs or {}, ensure_ascii=False)[:500]
        content = [
            {"text": "ZAPYTANIE — mebel do dopasowania (wycinek z wizualizacji wnętrza):"},
            {"image": {"format": _img_format(query_bytes), "source": {"bytes": query_bytes}}},
            {"text": (
                "Atrybuty ZAPYTANIA (opis wizualny) — UWAGA: to HIPOTEZA innego modelu z TEGO SAMEGO zdjęcia, "
                f"bywa błędna: {q_attrs}"
            )},
        ]
        if isinstance(query_context, dict):
            ctx_bits = {k: query_context.get(k) for k in ("typ", "ksztalt", "material", "cechy", "wymiary_cm")
                        if query_context.get(k)}
            if ctx_bits:
                content.append({"text": (
                    "DODATKOWY KONTEKST ZAPYTANIA z rysunku/specyfikacji (od użytkownika, doprecyzowuje intencję): "
                    + json.dumps(ctx_bits, ensure_ascii=False)[:400]
                    + ". Traktuj to jako sygnał MIĘKKI: WYMIARY orientacyjnie (bliższe = lepiej, ale nie odrzucaj z "
                      "powodu samej różnicy rozmiaru); typ/kształt wspierają dopasowanie."
                )})
        imgs = 0
        # TWARDY budżet obrazów (zdjęcia = ~90% kosztu Sonnet). Nie rośnie z liczbą kandydatów:
        # przy większym recallK nadwyżkowi kandydaci są oceniani po nazwie/opisie/parametrach, bez zdjęć.
        # Dzięki temu koszt pojedynczego zapytania ma sufit niezależny od ustawień z UI.
        #
        # Podział budżetu jest NIERÓWNY: czołówka (najwyższy wynik po sygnałach miękkich) dostaje
        # 2 ujęcia, reszta po 1. Drugie ujęcie najbardziej pomaga tam, gdzie decyduje się wynik —
        # przy tym samym koszcie. `cands` jest już posortowane malejąco przez _soft_rescore.
        base = max(1, min(3, RERANK_IMG_BUDGET // max(1, len(cands))))
        spare = max(0, RERANK_IMG_BUDGET - base * len(cands))  # ile zdjęć zostaje na czołówkę
        top_n = min(3, spare) if base < 3 else 0               # ilu kandydatom dołożyć +1 ujęcie
        for i, c in enumerate(cands):
            per_cand = base + 1 if i < top_n else base
            attrs = json.dumps(c.get("attributes") or {}, ensure_ascii=False)[:400]
            params = json.dumps(c.get("params") or {}, ensure_ascii=False)[:400]
            no_img = imgs >= RERANK_IMG_BUDGET
            # Kontekst kandydata: nazwa + podtyp + opis wizualny + PARAMETRY (specyfikacja techniczna).
            content.append({
                "text": f"Kandydat {i}: {c.get('name') or ''} (podtyp: {c.get('subtype') or '?'}). "
                        f"Opis: {attrs}. Parametry/specyfikacja: {params}"
                        + (" [BEZ ZDJĘCIA — oceniaj po opisie i parametrach; przy niepewności oceniaj ostrożnie]"
                           if no_img else "")
            })
            if no_img:
                continue
            # Zdjęcia kandydata (wiele ujęć, w ramach budżetu obrazów).
            for url in (c.get("image_urls") or [c.get("image_s3_url")])[:per_cand]:
                if imgs >= RERANK_IMG_BUDGET:
                    break
                b = _get_s3_bytes(url) if url else None
                if b:
                    content.append({"image": {"format": _img_format(b), "source": {"bytes": b}}})
                    imgs += 1
        content.append(
            {
                "text": (
                    "Oceń każdego kandydata jako STOPIEŃ DOPASOWANIA do ZAPYTANIA w skali 0-100. "
                    "Każdy kandydat może mieć KILKA zdjęć (różne ujęcia/warianty) — oceniaj po całości. "
                    "RUBRYKA (trzymaj się jej, nie zawyżaj): "
                    "90-100 = ten sam lub bliźniaczy produkt: zgadza się kształt/bryła ORAZ kolor i wykończenie; "
                    "70-89 = ten sam typ i kształt, ale wyraźnie inny kolor, materiał lub wykończenie; "
                    "50-69 = pokrewna forma, widoczne różnice w proporcjach, konstrukcji lub układzie; "
                    "30-49 = ten sam typ produktu, ale inna bryła/kształt; "
                    "0-29 = inny typ produktu albo inna funkcja. "
                    "Ocena 90+ jest ZAREZERWOWANA dla przypadków, w których handlowiec mógłby powiedzieć "
                    "'to jest ten sam produkt'. Różnica orientacji układu (pionowo vs poziomo), formatu lub "
                    "wykończenia (mat vs połysk) sama w sobie zdejmuje ocenę poniżej 90. "
                    "NAJWAŻNIEJSZE (decyduje o ocenie): BRYŁA, KSZTAŁT, PROPORCJE, SYLWETKA, KONSTRUKCJA/DETALE i typ — "
                    "to one wskazują ten sam model. Duży nacisk na zgodność opisu wizualnego (kształt/forma). "
                    + (
                        # Powierzchnie: kolor i wzór SĄ produktem — szara płytka i miętowa to nie warianty.
                        "UWAGA — to kategoria POWIERZCHNI (płytki/podłogi/tapety/dywany). Tutaj KOLOR i WZÓR są "
                        "kryterium GŁÓWNYM, na równi z kształtem i formatem: produkt w innym odcieniu to INNY "
                        "produkt, a nie wariant. Wyraźna różnica koloru (np. szary vs beżowy vs miętowy) obniża "
                        "ocenę do maks. 60, nawet jeśli format i układ są identyczne. Zwróć też uwagę na "
                        "ORIENTACJĘ układu (pionowo vs poziomo) i wykończenie (mat vs połysk). "
                        if (query_attrs or {}).get("kategoria") in ("plytki", "podlogi", "tapety", "dywan")
                        else
                        "KOLOR i MATERIAŁ traktuj jako DRUGORZĘDNE: ten sam produkt często występuje w różnych "
                        "kolorach/tkaninach/wykończeniach (warianty), więc RÓŻNICA koloru lub materiału NIE obniża "
                        "mocno oceny, jeśli bryła i kształt się zgadzają. Nie odrzucaj dobrego dopasowania kształtem "
                        "tylko z powodu koloru. "
                    ) +
                    "Kandydaci mogą mieć PARAMETRY/specyfikację (moc W, barwa K, IP, kąt °, źródło światła, wymiary) — "
                    "użyj ich pomocniczo do potwierdzenia/rozróżnienia. Nie przeceniaj samej wielkości ani tła renderu. "
                    "POMIŃ tylko kandydatów o wyraźnie innej bryle/kształcie lub innym typie (nie umieszczaj ich w wynikach). "
                    "ANTY-ZAKOTWICZENIE (ważne): opis zapytania i etykieta użytkownika to HIPOTEZY, nie fakty — "
                    "kształt, wzór i układ oceniaj WYŁĄCZNIE z obrazu ZAPYTANIA powyżej. Jeśli obraz przeczy opisowi "
                    "(np. opis mówi 'heksagon', a na zdjęciu są łuski/pióra/prostokąty), zignoruj opis i kieruj się obrazem. "
                    "Nigdy nie przypisuj kandydatowi cechy, której nie widać na jego zdjęciu; w 'powod' opisuj tylko to, "
                    "co faktycznie widzisz na obu obrazach. "
                    "Dla każdego kandydata podaj też 'powod' — krótkie (do ~14 słów) uzasadnienie oceny "
                    "(przede wszystkim: kształt/bryła/typ; kolor/materiał tylko wtórnie). "
                    'Zwróć WYŁĄCZNIE JSON posortowany od najlepszego: '
                    '{"wyniki":[{"i":<indeks>,"dopasowanie":<0-100>,"powod":"..."}], "uzasadnienie":"1 zdanie"}. '
                    "Bez markdown."
                )
            }
        )
        print(f"[rerank] start: cands={len(cands)}, zdjec_kandydatow={imgs}, model={RERANK_MODEL_ID}")
        # maxTokens hojnie (koniec ucinania JSON przy wielu kandydatach) + 1 retry (transient/parse).
        for attempt in range(2):
            out = bedrock.converse(
                modelId=RERANK_MODEL_ID,
                messages=[{"role": "user", "content": content}],
                inferenceConfig={"maxTokens": 2000, "temperature": 0},
            )
            stop = out.get("stopReason")
            raw = out["output"]["message"]["content"][0]["text"]
            print(f"[rerank] proba={attempt + 1} stopReason={stop} odpowiedz={raw[:400]}")
            parsed = _parse_rerank(raw, len(cands))
            if parsed:
                order, scores, reasons = parsed
                print(f"[rerank] ranking={order}, oceny={scores}")
                return order, scores, reasons
            print(f"[rerank] proba={attempt + 1}: brak poprawnych wynikow (stopReason={stop})")
    except Exception as e:  # noqa: BLE001
        print(f"[rerank] BLAD: {e}")
    print("[rerank] fallback wizualny (kolejność kosinusowa)")
    return list(range(len(cands))), {}, {}


def _parse_rerank(raw, n):
    """Zamień odpowiedź sędziego na (order, scores, reasons). Odporne na ucięty JSON:
    gdy pełne parsowanie zawiedzie, odzyskujemy kompletne obiekty wyników regexem."""
    data = _parse_json(raw)
    if isinstance(data, dict) and data.get("uzasadnienie"):
        print(f"[rerank] uzasadnienie: {data['uzasadnienie']}")
    wyniki = data.get("wyniki") if isinstance(data, dict) else None
    if not isinstance(wyniki, list) or not wyniki:
        wyniki = _salvage_rerank_items(raw)  # ratunek z (potencjalnie uciętego) tekstu
    if not isinstance(wyniki, list) or not wyniki:
        return None
    order, scores, reasons = [], {}, {}
    for w in wyniki:
        if not isinstance(w, dict):
            continue
        try:
            i = int(w.get("i"))
        except (TypeError, ValueError):
            continue
        if not (0 <= i < n) or i in scores:
            continue
        order.append(i)
        try:
            scores[i] = max(0, min(100, int(round(float(w.get("dopasowanie"))))))
        except (TypeError, ValueError):
            scores[i] = None
        if w.get("powod"):
            reasons[i] = str(w.get("powod"))[:200]
    return (order, scores, reasons) if order else None


# Wyłuskuje kompletne obiekty {"i":..,"dopasowanie":..,"powod":".."} nawet gdy całość JSON jest ucięta.
_RERANK_ITEM_RE = re.compile(
    r'"i"\s*:\s*(\d+)\s*,\s*"dopasowanie"\s*:\s*(\d+)(?:\s*,\s*"powod"\s*:\s*"([^"]*)")?'
)


def _salvage_rerank_items(raw):
    items = [{"i": int(m.group(1)), "dopasowanie": int(m.group(2)), "powod": m.group(3) or ""}
             for m in _RERANK_ITEM_RE.finditer(raw or "")]
    if items:
        print(f"[rerank] odzyskano {len(items)} wynikow z uciętej/niepełnej odpowiedzi")
    return items


# ---------------------------------------------------------------------------
# Miękkie sygnały nie-wizualne (podtyp / nazwa / wymiary). Zero kosztu modeli.
# Powód: embedding Titana nie zna skali ani funkcji — katalogowe zdjęcie wanny
# wolnostojącej (biała owalna misa na białym tle) leży blisko okrągłej umywalki.
# Kategoria zostaje JEDYNYM twardym filtrem; to tylko przesuwa kolejność.
# ---------------------------------------------------------------------------
_PL_MAP = str.maketrans("ąćęłńóśźż", "acelnoszz")
W_SUBTYPE_OK = 0.05      # kandydat ma ten sam podtyp co zapytanie
W_SUBTYPE_BAD = -0.08    # kandydat ma inny podtyp (np. wanna przy zapytaniu o umywalkę)
W_NAME_OK = 0.05         # nazwa produktu zawiera słowo-klucz zapytania
W_NAME_RIVAL = -0.08     # nazwa wskazuje inny typ z tej samej kategorii
W_DIMS_BAD = -0.05       # wymiary rozjeżdżone o rząd wielkości (gdy znane po obu stronach)
W_ATTR_KW = 0.06         # opis wizualny kandydata zawiera słowo kształtu/wzoru z zapytania

# Słowa nieróżnicujące — nie nadają się na klucz kształtu/wzoru.
_KW_STOP = {
    "gladka", "gładka", "gladki", "gładki", "delikatnym", "delikatna", "delikatne", "regularny",
    "regularnym", "nowoczesny", "nowoczesnym", "geometryczny", "geometrycznym", "powierzchnia",
    "kolorze", "kolor", "wzorem", "wzor", "wzór", "ukladzie", "układzie", "uklad", "układ",
    "plytki", "płytki", "plytka", "płytka", "scienne", "ścienne", "podlogowe", "podłogowe",
    "matowa", "matowe", "polysk", "połysk", "jasny", "jasnym", "jasne", "bialy", "biały", "biale",
    "ceramika", "ceramiczna", "ceramiczne", "minimalistyczny", "fugami", "fugowaniem",
}


def _query_keywords(query_attrs, hint_raw):
    """Słowa-klucze kształtu/wzoru zapytania — do doszukania kandydatów po OPISIE (nie tylko pikselach)."""
    src = []
    if isinstance(query_attrs, dict):
        for k in ("ksztalt_ogolny", "wzor_faktura", "typ", "subtype"):
            v = query_attrs.get(k)
            if isinstance(v, str):
                src.append(v)
    if hint_raw:
        src.append(hint_raw)
    out = []
    for s in src:
        for w in re.split(r"[^\wąćęłńóśźż]+", s.lower()):
            if len(w) >= 5 and w not in _KW_STOP:
                # Zgrubny rdzeń (polska fleksja): 'pióro'→'piór' złapie 'pióra', 'łuska'→'łusk' → 'łuski'.
                stem = w[: max(4, len(w) - 2)]
                if stem not in out:
                    out.append(stem)
    return out[:3]


def _norm_txt(s):
    return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower().translate(_PL_MAP)).strip()


def _head(s):
    """Słowo-klucz: pierwszy człon podtypu/etykiety ('wanna_wolnostojaca' → 'wanna')."""
    t = _norm_txt(s).split()
    return t[0] if t else None


def _max_dim(d):
    if not isinstance(d, dict):
        return None
    vals = [v for v in d.values() if isinstance(v, (int, float)) and v > 0]
    return max(vals) if vals else None


def _soft_rescore(cands, query_attrs, hint_raw, query_context, keywords=None):
    """Dolicza miękkie sygnały do cosinusa i zwraca listę posortowaną malejąco.

    Słowa-klucze zapytania biorą się z opisu (subtype/typ) ORAZ z etykiety zaznaczenia
    (hint) — świadomy wybór użytkownika ma wpływ na wynik. „Rywale" (inne typy w tej
    samej kategorii) wyliczamy z danych: z podtypów kandydatów w tym zestawie, bez
    żadnego zaszytego słownika.
    """
    q_heads = set()
    if isinstance(query_attrs, dict):
        for k in ("subtype", "typ"):
            h = _head(query_attrs.get(k))
            if h:
                q_heads.add(h)
    h = _head(hint_raw)
    if h:
        q_heads.add(h)
    q_heads = {x for x in q_heads if len(x) >= 4 and not x.isdigit()}

    cand_heads = {_head(c.get("subtype")) for c in cands}
    rivals = {x for x in cand_heads if x and len(x) >= 4 and x.isalpha() and x not in q_heads}

    q_dim = None
    if isinstance(query_context, dict):
        q_dim = _max_dim(query_context.get("wymiary_cm"))
    if q_dim is None and isinstance(query_attrs, dict):
        q_dim = _max_dim(query_attrs.get("wymiary_cm"))

    for c in cands:
        detail = {}
        adj = 0.0
        c_head = _head(c.get("subtype"))
        c_name = _norm_txt(c.get("name"))
        if q_heads and c_head:
            if c_head in q_heads:
                adj += W_SUBTYPE_OK
                detail["podtyp"] = W_SUBTYPE_OK
            elif len(c_head) >= 4 and c_head.isalpha():
                adj += W_SUBTYPE_BAD
                detail["podtyp"] = W_SUBTYPE_BAD
        if q_heads and c_name:
            if any(qh in c_name for qh in q_heads):
                adj += W_NAME_OK
                detail["nazwa"] = W_NAME_OK
            elif any(rv in c_name for rv in rivals):
                adj += W_NAME_RIVAL
                detail["nazwa"] = W_NAME_RIVAL
        if q_dim:
            c_dim = _max_dim((c.get("params") or {}).get("wymiary_cm"))
            if c_dim and (max(q_dim, c_dim) / min(q_dim, c_dim)) > 2.5:
                adj += W_DIMS_BAD
                detail["wymiary"] = W_DIMS_BAD
        # Opis wizualny kandydata (jeśli istnieje) zawiera słowo kształtu/wzoru z zapytania —
        # jedyny sygnał kształtu tam, gdzie nazwa to kod produktu (np. płytki).
        if keywords and c.get("attributes"):
            blob = json.dumps(c["attributes"], ensure_ascii=False).lower()
            if any(kw in blob for kw in keywords):
                adj += W_ATTR_KW
                detail["opis"] = W_ATTR_KW
        c["soft"] = detail or None
        c["adj"] = round(min(1.0, max(0.0, c["sim"] + adj)), 4)

    cands.sort(key=lambda c: c["adj"], reverse=True)
    top = ", ".join(f"{c['name'][:24]}={c['adj']}({c['sim']})" for c in cands[:5])
    print(f"[soft] slowa_klucze={sorted(q_heads)} rywale={sorted(rivals)} | {top}")
    return cands


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
    fast = bool(body.get("fast"))  # tryb „szybki": sam cosinus (bez wizyjnego reranku Sonnet) — ~darmowy, do porównań/oszczędności
    # Kandydaci do oceny. Limit zależny od trybu: w trybie jakości każdy kandydat kosztuje (tekst + ew. zdjęcie),
    # w szybkim nie ma wywołania Sonneta, więc można patrzeć głębiej za darmo.
    recall_k = max(top_k, min(int(body.get("recallK", 8)), MAX_RECALL_FAST if fast else MAX_RECALL_QUALITY))
    emb = _embed_image(image_bytes)
    vec = "[" + ",".join(str(x) for x in emb) + "]"

    # F2a: opcjonalny 2. obraz (rysunek techniczny / spec) → wyłuskanie pewnych cech (typ/kształt/wymiary).
    query_context = None
    ctx_b64 = body.get("contextImageBase64")
    if ctx_b64:
        if isinstance(ctx_b64, str) and ctx_b64.startswith("data:") and "," in ctx_b64:
            ctx_b64 = ctx_b64.split(",", 1)[1]
        try:
            query_context = _extract_context(base64.b64decode(ctx_b64))
        except Exception:  # noqa: BLE001
            query_context = None

    # hint = etykieta z auto-detekcji (np. 'stolik kawowy') + doprecyzowanie z rysunku (typ/kształt).
    hint_raw = (body.get("hint") or "").strip()  # sama etykieta zaznaczenia — sygnał miękki w rankingu
    hint = hint_raw
    if isinstance(query_context, dict):
        parts = [f"{lab}={query_context[k]}" for k, lab in (("typ", "typ"), ("ksztalt", "kształt"))
                 if query_context.get(k)]
        if parts:
            hint = (hint + (" ; " if hint else "") + "z rysunku/spec: " + ", ".join(parts))

    # Opis wycinka zapytania NAJPIERW — daje kategorię (twarda bramka) + drugi sygnał do rerankingu.
    query_attrs = _describe_query(image_bytes, hint)
    cat = None
    if body.get("category"):
        cat = _norm_category(body.get("category"))  # jawne wymuszenie z UI (opcjonalne)
    elif isinstance(query_attrs, dict):
        cat = _norm_category(query_attrs.get("kategoria"))
    # Bramka = kategoria + kategorie siostrzane (patrz _SIBLING_CATEGORIES).
    gate_cats = [cat] + list(_SIBLING_CATEGORIES.get(cat, ())) if cat else []
    print(f"[gate] kategoria zapytania: {cat} | pula kategorii: {gate_cats}")

    # Pula kandydatów szersza niż recall_k: miękkie sygnały mogą wyciągnąć w górę produkt,
    # który po samym cosinusie byłby poza zestawem dla sędziego (lepszy recall, koszt = tylko DB).
    pool_k = min(200, max(int(body.get("poolK") or 0), recall_k * 5, 40))

    # TWARDA bramka kategorii: substytut zawsze w tej samej (lub siostrzanej) kategorii — nie 'lampa zamiast sofy'.
    cat_args = {f"c{i}": c for i, c in enumerate(gate_cats)}
    where = (
        "WHERE p.category IN (" + ", ".join(f":c{i}" for i in range(len(gate_cats))) + ") "
        if gate_cats else ""
    )

    def query():
        # Retrieve: TOP pool_k produktów (najlepsze ujęcie per produkt), z atrybutami i źródłem.
        sql = (
            "SELECT * FROM ("
            "  SELECT DISTINCT ON (product_id) product_id, optima_id, name, params, subtype, group_id, image_s3_url,"
            "         attributes, source, category, manufacturer, catalog_page, catalog_name, catalog_pdf, sim"
            "  FROM ("
            "    SELECT p.id AS product_id, p.optima_id, p.name, p.params, p.subtype, p.group_id, pi.image_s3_url,"
            "           pi.attributes, p.source, p.category, p.manufacturer, p.catalog_page,"
            "           c.name AS catalog_name, c.pdf_s3_url AS catalog_pdf,"
            "           1 - (pi.embedding <=> CAST(:q AS vector)) AS sim"
            "    FROM product_images pi JOIN products p ON p.id = pi.product_id"
            "    LEFT JOIN catalogs c ON c.id = p.catalog_id "
            + where +
            "  ) x"
            "  ORDER BY product_id, sim DESC"
            ") y "
            "ORDER BY sim DESC "
            f"LIMIT {pool_k}"
        )
        return _db().run(sql, q=vec, **cat_args)

    # Doszukanie po OPISIE: produkty, których opis wizualny/nazwa zawiera słowo kształtu z zapytania,
    # nawet gdy kosinus wypycha je poza pulę (Titan na płaskich wzorach patrzy na ton i gęstość faktury,
    # nie na obrys pojedynczego elementu). Działa tylko dla produktów, które MAJĄ opis (Faza 8.5).
    keywords = _query_keywords(query_attrs, hint_raw)

    def query_by_text():
        if not keywords:
            return []
        conds = " OR ".join(f"pi.attributes::text ILIKE :kw{i} OR p.name ILIKE :kw{i}" for i in range(len(keywords)))
        sql = (
            "SELECT * FROM ("
            "  SELECT DISTINCT ON (product_id) product_id, optima_id, name, params, subtype, group_id, image_s3_url,"
            "         attributes, source, category, manufacturer, catalog_page, catalog_name, catalog_pdf, sim"
            "  FROM ("
            "    SELECT p.id AS product_id, p.optima_id, p.name, p.params, p.subtype, p.group_id, pi.image_s3_url,"
            "           pi.attributes, p.source, p.category, p.manufacturer, p.catalog_page,"
            "           c.name AS catalog_name, c.pdf_s3_url AS catalog_pdf,"
            "           1 - (pi.embedding <=> CAST(:q AS vector)) AS sim"
            "    FROM product_images pi JOIN products p ON p.id = pi.product_id"
            "    LEFT JOIN catalogs c ON c.id = p.catalog_id "
            + (where + "AND (" if where else "WHERE (") + conds + ")"
            "  ) x"
            "  ORDER BY product_id, sim DESC"
            ") y ORDER BY sim DESC LIMIT 12"
        )
        args = {f"kw{i}": f"%{k}%" for i, k in enumerate(keywords)}
        args.update(cat_args)
        return _db().run(sql, q=vec, **args)

    try:
        rows = query()
    except Exception:  # noqa: BLE001
        _conn = None
        rows = query()

    try:
        extra = query_by_text()
    except Exception as e:  # noqa: BLE001
        print(f"[recall-tekst] blad: {str(e)[:120]}")
        extra = []
    if extra:
        seen = {str(r[0]) for r in rows}
        added = [r for r in extra if str(r[0]) not in seen]
        print(f"[recall-tekst] slowa={keywords} | dociagnieto {len(added)} kandydatow spoza puli wizualnej")
        rows = list(rows) + added

    cands = [
        {
            "product_id": str(product_id), "optimaId": optima_id, "name": name, "params": params,
            "subtype": subtype, "group_id": group_id, "image_s3_url": image_s3_url, "attributes": attributes,
            "source": source, "category": category, "manufacturer": manufacturer,
            "catalog_page": catalog_page, "catalog_name": catalog_name, "catalog_pdf": catalog_pdf,
            "sim": round(float(sim), 4),
        }
        for (product_id, optima_id, name, params, subtype, group_id, image_s3_url, attributes, source, category,
             manufacturer, catalog_page, catalog_name, catalog_pdf, sim) in rows
    ]

    # Miękkie sygnały (podtyp/nazwa/wymiary) → przesortowanie puli i przycięcie do recall_k.
    cands = _soft_rescore(cands, query_attrs, hint_raw, query_context, keywords)[:recall_k]

    # Wszystkie zdjęcia kandydata (do rerankingu wielozdjęciowego); w wyniku pokazujemy jedno.
    for c in cands:
        try:
            imgs = _db().run(
                "SELECT image_s3_url FROM product_images WHERE product_id = CAST(:pid AS uuid) "
                "ORDER BY sort_order, created_at LIMIT 4",
                pid=c["product_id"],
            )
            c["image_urls"] = [u for (u,) in imgs] or [c["image_s3_url"]]
        except Exception:  # noqa: BLE001
            c["image_urls"] = [c["image_s3_url"]]

    # Tryb „szybki": kolejność z cosinusa + miękkich sygnałów (lista już posortowana), BEZ reranku Sonnet.
    if fast:
        print("[mode] fast — ranking po cosinusie + sygnalach miekkich (bez rerank Sonnet)")
        order, scores, reasons = list(range(len(cands))), {}, {}
    else:
        # Rerank Sonnet 4.5 na zdjęciach + atrybutach + specyfikacji (kandydaci w tej samej kategorii).
        order, scores, reasons = _rerank(image_bytes, cands, query_attrs, query_context)

    results = []
    for idx in order[:top_k]:
        c = cands[idx]
        score = scores.get(idx)  # ocena dopasowania 0-100 z rerankingu (gdy dostępna)
        # Wyświetlany wynik = ocena rerankingu (spójna z kolejnością); fallback: cosinus + sygnały miękkie.
        match = round(score / 100, 4) if score is not None else c.get("adj", c["sim"])
        item = {
            "id": c["product_id"],
            "optimaId": c["optimaId"],
            "name": c["name"],
            "subtype": c["subtype"],
            "groupId": c["group_id"],
            "params": c["params"],
            "imageUrl": _presign_get(c["image_s3_url"]),
            "similarity": match,
            "visualSimilarity": c["sim"],  # surowy cosinus Titana (pomocniczo)
            "adjustedSimilarity": c.get("adj"),  # cosinus + sygnały miękkie (kolejność retrieve)
            "softSignals": c.get("soft"),        # co dołożyło/odjęło (podtyp/nazwa/wymiary)
            "reranked": score is not None,
            "source": c["source"],
            "category": c["category"],
            # Wyjaśnialność (analityka): ocena rerankingu + powód + atrybuty kandydata.
            "rerankScore": score,            # 0-100 lub null (fallback wizualny)
            "reason": reasons.get(idx),       # krótkie uzasadnienie modelu
            "attributes": c["attributes"],    # opis wizualny produktu (jeśli jest)
        }
        # Odniesienie do źródła: produkt z katalogu → link do PDF w S3 otwierany na właściwej stronie.
        if c["source"] == "catalog" and c["catalog_pdf"]:
            item["manufacturer"] = c["manufacturer"]
            item["catalogName"] = c["catalog_name"]
            item["catalogPage"] = c["catalog_page"]
            item["catalogUrl"] = _presign_get(c["catalog_pdf"])  # cały PDF (do pobrania)
            item["catalogPageImageUrl"] = _page_image_url(c["catalog_pdf"], c["catalog_page"])  # lekki obraz strony
        results.append(item)
    # queryAttributes: co system „zrozumiał" z wycinka (do panelu „dlaczego podobne").
    # „Nie mamy odpowiednika": sędzia ocenił WSZYSTKICH poniżej progu. Wyniki zwracamy dalej
    # (zasada „zawsze najbliższe"), ale UI ma powiedzieć wprost, że to nie są substytuty.
    best = max((s for s in scores.values()), default=None)
    weak = (not fast) and best is not None and best < WEAK_MATCH_BELOW
    if weak:
        print(f"[weak] najlepsza ocena {best}% < {WEAK_MATCH_BELOW}% — brak odpowiednika w asortymencie")
    return _resp(200, {"results": results, "queryCategory": cat, "queryCategories": gate_cats,
                       "queryAttributes": query_attrs,
                       "queryContext": query_context, "mode": "fast" if fast else "quality",
                       "weakMatch": weak, "bestScore": best,
                       # Faktycznie użyte (po przycięciu limitem) — do diagnostyki i kontroli kosztu.
                       "recallK": recall_k, "imageBudget": None if fast else RERANK_IMG_BUDGET})


def _resp(status, data):
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
        },
        "body": json.dumps(data, ensure_ascii=False),
    }
