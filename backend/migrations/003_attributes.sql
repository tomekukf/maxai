-- Faza B: opis wizualny per zdjęcie (z modelu vision) w product_images.
-- Uruchom raz, po 002.

ALTER TABLE product_images ADD COLUMN IF NOT EXISTS attributes JSONB;
