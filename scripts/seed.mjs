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

const all = JSON.parse(readFileSync('rawdata/brw-products.json', 'utf8'));
const products = all.slice(0, LIMIT);
console.log(`Ładuję ${products.length} z ${all.length} produktów...`);

let ok = 0;
for (const [i, p] of products.entries()) {
  const tag = `[${i + 1}/${products.length}]`;
  try {
    // 1) pobierz zdjęcie (JPEG z static.brw.pl)
    const imgRes = await fetch(p.imageUrl);
    if (!imgRes.ok) {
      console.log(`${tag} SKIP obraz HTTP ${imgRes.status}`);
      continue;
    }
    const bytes = Buffer.from(await imgRes.arrayBuffer());

    // 2) presign + upload
    const pre = await (
      await fetch(`${API}/uploads/presign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: `${p.code}.jpg`, prefix: 'product-images' }),
      })
    ).json();
    const put = await fetch(pre.uploadUrl, { method: 'PUT', body: bytes });
    if (!put.ok) {
      console.log(`${tag} SKIP upload HTTP ${put.status}`);
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
        imageKey: pre.key,
        sourceUrl: p.url,
        params,
      }),
    });
    const out = await save.json();
    if (save.ok) {
      ok++;
      console.log(`${tag} OK  ${p.name.slice(0, 45)}  → ${out.id}`);
    } else {
      console.log(`${tag} FAIL ${save.status} ${JSON.stringify(out).slice(0, 120)}`);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  } catch (e) {
    console.log(`${tag} ERROR ${e.message}`);
  }
}
console.log(`\nGotowe. Zapisano: ${ok}/${products.length}`);
