// Test Fazy 2: /search — podobieństwo wizualne (substytuty).
// Bierze sofę z rawdata/brw-products.json (domyślnie IDX=30, czyli SPOZA seeda 0..24),
// pobiera jej zdjęcie, wysyła jako base64 do /search i pokazuje TOP 3.
// Użycie: API=<url> [IDX=30] node scripts/test-search.mjs
import { readFileSync } from 'node:fs';

const API = process.env.API;
if (!API) {
  console.error('Brak zmiennej API.');
  process.exit(1);
}
const IDX = Number(process.env.IDX ?? 30);

const all = JSON.parse(readFileSync('rawdata/brw-products.json', 'utf8'));
const p = all[IDX];
if (!p) {
  console.error(`Brak produktu o indeksie ${IDX} (mamy ${all.length}).`);
  process.exit(1);
}
const inBase = IDX < 25;
console.log(`Zapytanie: [${IDX}] ${p.name}`);
console.log(inBase ? '(sofa JEST w bazie — test dokładny, oczekuj jej na #1)' : '(sofa SPOZA bazy — test substytutów, oczekuj podobnych)');

const imgUrl = p.images?.[0] ?? p.imageUrl;
const bytes = Buffer.from(await (await fetch(imgUrl)).arrayBuffer());
const b64 = bytes.toString('base64');

const r = await fetch(`${API}/search`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ imageBase64: b64 }),
});
const data = await r.json();
console.log('HTTP', r.status, '| wyników:', data.results?.length ?? '—');
for (const [i, res] of (data.results ?? []).entries()) {
  console.log(`  #${i + 1}  sim=${res.similarity}  ${res.optimaId}  ${(res.name ?? '').slice(0, 55)}`);
}
if (!data.results?.length) console.log('RAW:', JSON.stringify(data, null, 2));
