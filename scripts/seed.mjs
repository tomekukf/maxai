// Seeder: ładuje produkty z rawdata/brw-products.json do bazy przez nasze API.
// Dla każdej sofy: pobierz zdjęcie (JPEG) → presign+upload → /extract(nazwa) → /products.
// Użycie: API=<url> LIMIT=25 node scripts/seed.mjs
import { readFileSync } from 'node:fs';

const API = process.env.API;
if (!API) {
  console.error('Brak zmiennej API (bazowy URL HTTP API).');
  process.exit(1);
}
const LIMIT = Number(process.env.LIMIT ?? 25);
const DELAY_MS = Number(process.env.DELAY_MS ?? 500); // rate limit

async function fetchBestImage(originalUrl) {
  // Preferuj większy wariant -large (lepszy embedding), z fallbackiem na oryginał.
  const bigUrl = originalUrl.replace(/-small\.jpg$/i, '-large.jpg');
  if (bigUrl !== originalUrl) {
    try {
      const r = await fetch(bigUrl);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 3000) return buf; // sensowny większy obraz (nie placeholder)
      }
    } catch {
      /* fallback niżej */
    }
  }
  try {
    const r = await fetch(originalUrl);
    if (r.ok) return Buffer.from(await r.arrayBuffer());
  } catch {
    /* nic */
  }
  return null;
}

const all = JSON.parse(readFileSync('rawdata/brw-products.json', 'utf8'));

// Wybór: CODES=718047,56327 (konkretne) + RANDOM=4 (losowe dodatkowe); inaczej LIMIT (od początku).
const CODES = (process.env.CODES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const RANDOM = Number(process.env.RANDOM ?? 0);

let products;
if (CODES.length || RANDOM) {
  const picked = [];
  const seen = new Set();
  for (const code of CODES) {
    const p = all.find((x) => x.code === code);
    if (p && !seen.has(code)) {
      picked.push(p);
      seen.add(code);
    } else if (!p) {
      console.log(`(uwaga) brak kodu ${code} w danych`);
    }
  }
  const pool = all.filter((x) => !seen.has(x.code));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  products = picked.concat(pool.slice(0, RANDOM));
} else {
  products = all.slice(0, LIMIT);
}
console.log(`Ładuję ${products.length} produktów (z ${all.length})...`);

let ok = 0;
for (const [i, p] of products.entries()) {
  const tag = `[${i + 1}/${products.length}]`;
  try {
    // 1-2) pobierz i wgraj WSZYSTKIE zdjęcia produktu (preferuj -large)
    const imageKeys = [];
    for (const url of p.images ?? []) {
      const bytes = await fetchBestImage(url);
      if (!bytes) continue;
      const pre = await (
        await fetch(`${API}/uploads/presign`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filename: `${p.code}-${imageKeys.length}.jpg`, prefix: 'product-images' }),
        })
      ).json();
      const put = await fetch(pre.uploadUrl, { method: 'PUT', body: bytes });
      if (put.ok) imageKeys.push(pre.key);
    }
    if (!imageKeys.length) {
      console.log(`${tag} SKIP brak zdjęć`);
      continue;
    }

    // 3) parametry (Haiku na bazie nazwy) + cena/kod z JSON-LD
    let params = {};
    try {
      const ex = await (
        await fetch(`${API}/extract`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ description: `${p.name}. Cena ${p.price} zł.` }),
        })
      ).json();
      params = ex.params ?? {};
    } catch {
      /* parametry opcjonalne */
    }
    if (params.cena_pln == null && p.price != null) params.cena_pln = Number(p.price);
    if (!params.kod_produktu) params.kod_produktu = p.code;

    // 4) zapis
    const save = await fetch(`${API}/products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        optimaId: `BRW-${p.code}`,
        name: p.name,
        imageKeys,
        sourceUrl: p.url,
        params,
      }),
    });
    const out = await save.json();
    if (save.ok) {
      ok++;
      console.log(`${tag} OK  ${p.name.slice(0, 40)}  (${imageKeys.length} zdj) → ${out.id}`);
    } else {
      console.log(`${tag} FAIL ${save.status} ${JSON.stringify(out).slice(0, 120)}`);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  } catch (e) {
    console.log(`${tag} ERROR ${e.message}`);
  }
}
console.log(`\nGotowe. Zapisano: ${ok}/${products.length}`);
