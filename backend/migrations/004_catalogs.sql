-- Faza 5: import katalogów PDF producentów.
-- Tabela źródeł (catalogs) + rozszerzenie products o źródło/kategorię/podtyp/odniesienie do katalogu.
-- Uruchom raz, po 003. Additywna i bezpieczna dla istniejących danych.

CREATE TABLE IF NOT EXISTS catalogs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT,
    manufacturer    TEXT,
    domain_category TEXT,                 -- deklarowana domena: 'oswietlenie' | 'sofy' | 'mixed' ...
    pdf_s3_url      TEXT NOT NULL,
    pdf_sha256      TEXT,                 -- wykrycie ponownego importu tego samego pliku
    page_count      INT,
    status          TEXT DEFAULT 'ready', -- uploaded|processing|ready|error
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Rozszerzenie products (istniejące wiersze BRW: source='optima' domyślnie — nie przeszkadza w MVP)
ALTER TABLE products ADD COLUMN IF NOT EXISTS source            TEXT DEFAULT 'optima'; -- 'optima'|'catalog'
ALTER TABLE products ADD COLUMN IF NOT EXISTS category          TEXT;                  -- kanoniczny slug — TWARDA bramka
ALTER TABLE products ADD COLUMN IF NOT EXISTS subtype           TEXT;                  -- generyczny podtyp w obrębie kategorii
ALTER TABLE products ADD COLUMN IF NOT EXISTS manufacturer      TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS manufacturer_code TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS catalog_id        UUID REFERENCES catalogs(id) ON DELETE CASCADE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS catalog_page      INT;                   -- strona PDF do podglądu (#page=N)
ALTER TABLE products ALTER COLUMN optima_id DROP NOT NULL;                             -- produkt z katalogu może nie mieć ID Optima

-- Twardy unikat produktu producenta (tylko gdy jest kod) — ochrona przed duplikatami przy re-imporcie.
CREATE UNIQUE INDEX IF NOT EXISTS products_mfr_code_uq
    ON products (manufacturer, manufacturer_code) WHERE manufacturer_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS products_category_idx ON products (category);
CREATE INDEX IF NOT EXISTS products_subtype_idx  ON products (subtype);
CREATE INDEX IF NOT EXISTS products_catalog_idx  ON products (catalog_id);
