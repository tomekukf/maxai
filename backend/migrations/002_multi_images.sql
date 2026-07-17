-- Wiele zdjęć na produkt: osobna tabela product_images (embedding per zdjęcie).
-- Uruchom raz, po 001.

CREATE TABLE IF NOT EXISTS product_images (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id   UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    image_s3_url TEXT NOT NULL,
    embedding    vector(1024),
    sort_order   INT DEFAULT 0,
    created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_images_embedding_idx
    ON product_images USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS product_images_product_idx
    ON product_images (product_id);

-- Obraz i embedding przenoszą się z products do product_images.
-- Dane i tak przeładujemy (clear + re-seed), więc czyścimy stary schemat kolumn.
ALTER TABLE products DROP COLUMN IF EXISTS embedding;
ALTER TABLE products DROP COLUMN IF EXISTS image_s3_url;
