-- maxai — migracja inicjalna
-- Uruchom raz, po postawieniu bazy RDS (Krok 1.1).

-- pgvector: wyszukiwanie wektorowe
CREATE EXTENSION IF NOT EXISTS vector;

-- Tabela produktów: metadane + wektor obraz+tekst (Titan Multimodal, 1024 wym.)
CREATE TABLE IF NOT EXISTS products (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    optima_id    TEXT NOT NULL,            -- syntetyczne: AGATA-<kod>
    name         TEXT,
    params       JSONB,                    -- {wymiary, kolor, styl, materiał, cena, kod, ...}
    image_s3_url TEXT NOT NULL,
    source_url   TEXT,                     -- link do strony produktu (pomocniczo)
    embedding    vector(1024),             -- Titan Multimodal
    created_at   TIMESTAMPTZ DEFAULT now()
);

-- Filtry po parametrach (miękkie/opcjonalne w zapytaniach)
CREATE INDEX IF NOT EXISTS products_params_idx
    ON products USING gin (params);

-- Indeks wektorowy (ivfflat). Dla małego seed-setu (~20-30) brute-force i tak wystarcza;
-- przy większych danych warto przebudować po załadowaniu (lepszy recall).
CREATE INDEX IF NOT EXISTS products_embedding_idx
    ON products USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
