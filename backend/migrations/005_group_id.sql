-- Faza 9B: grupowanie wariantów tego samego produktu (np. EMPIRE chrom/złoto).
-- group_id łączy warianty (ta sama bryła/model, różne wykończenie/kolor). Uruchom raz, po 004.

ALTER TABLE products ADD COLUMN IF NOT EXISTS group_id TEXT;
CREATE INDEX IF NOT EXISTS products_group_idx ON products (group_id);
