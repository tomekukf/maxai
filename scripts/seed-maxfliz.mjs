// Import kolekcji do AWS (Faza 10.1). Czyta collection.json (env COLLECTION), zdjęcia z CDN (im.src)
// LUB lokalne (im.file z <dir>/images/), → presign → S3 → POST /products. Auto-refresh tokena.
// BEZ CEN. describe:false (bez Sonnet). Embedding = Titan w Lambdzie /products.
//
// Użycie (git-bash):
//   API_URL=... COGNITO_CLIENT_ID=... ADMIN_PASSWORD=... \
//   [COLLECTION=rawdata/maxfliz/collection.json] [CATEGORY=] [PDF_KEY=] [CATALOG_NAME=] [LIMIT=0] node scripts/seed-maxfliz.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const COLLECTION = process.env.COLLECTION ?? 'rawdata/maxfliz/collection.json';
const IMG_DIR = join(dirname(COLLECTION), 'images');
const CATEGORY = process.env.CATEGORY ?? ''; // pusty = wszystkie produkty z pliku
const PDF_KEY = process.env.PDF_KEY ?? null; // s3 key PDF katalogu (do linku „otwórz stronę")
const CATALOG_NAME = process.env.CATALOG_NAME ?? null;
const LIMIT = Number(process.env.LIMIT ?? 0);
const REGION = process.env.COGNITO_REGION ?? 'eu-central-1';
const API = process.env.API_URL;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const USER = process.env.ADMIN_USER ?? 'admin';
const PASS = process.env.ADMIN_PASSWORD;
if (!API || !CLIENT_ID || !PASS) { console.error('Brak API_URL / COGNITO_CLIENT_ID / ADMIN_PASSWORD'); process.exit(1); }

let TOKEN = null;
async function login() {
  const r = await fetch(`https://cognito-idp.${REGION}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
    body: JSON.stringify({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: CLIENT_ID, AuthParameters: { USERNAME: USER, PASSWORD: PASS } }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('login: ' + (j.message || r.status));
  TOKEN = j.AuthenticationResult.IdToken;
}
const AUTH = () => ({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function presignPut(filename, bytes) {
  const pr = await fetch(`${API}/uploads/presign`, { method: 'POST', headers: AUTH(), body: JSON.stringify({ filename, prefix: 'products/import' }) });
  if (!pr.ok) throw new Error(`presign ${pr.status}`);
  const { uploadUrl, key } = await pr.json();
  const put = await fetch(uploadUrl, { method: 'PUT', body: bytes });
  if (!put.ok) throw new Error(`PUT ${put.status}`);
  return key;
}

async function imgBytes(im) {
  if (im.src) return Buffer.from(await (await fetch(im.src, { headers: { 'user-agent': 'maxai-catalog-sync/1.0' } })).arrayBuffer());
  return readFileSync(join(IMG_DIR, im.file)); // zdjęcie lokalne
}

async function main() {
  const pkg = JSON.parse(readFileSync(COLLECTION, 'utf8'));
  const meta = pkg.catalog ?? {};
  let products = pkg.products;
  if (CATEGORY) products = products.filter((p) => p.category === CATEGORY);
  if (LIMIT) products = products.slice(0, LIMIT);
  console.log(`API=${API}\nPlik=${COLLECTION} | ${products.length} produktów${CATEGORY ? ` (kat=${CATEGORY})` : ''}`);
  await login();

  const cr = await fetch(`${API}/catalogs`, { method: 'POST', headers: AUTH(), body: JSON.stringify({
    name: CATALOG_NAME || meta.name || 'import', manufacturer: meta.manufacturer || null,
    domainCategory: meta.domainCategory || CATEGORY || null, pdfKey: PDF_KEY,
  }) });
  const { id: catalogId } = await cr.json();
  console.log(`catalogId=${catalogId}`);

  let ok = 0, dup = 0, err = 0, imgErr = 0;
  for (let i = 0; i < products.length; i++) {
    if (i > 0 && i % 250 === 0) { await login(); console.log('  (odświeżono token)'); }
    const p = products[i];
    try {
      const images = [];
      for (const im of p.images) {
        try {
          const key = await presignPut(im.file, await imgBytes(im));
          images.push({ key, sortOrder: im.sortOrder ?? 0 });
        } catch { imgErr++; }
      }
      if (!images.length) { err++; console.log(`  [${i}] ${p.name} — brak zdjęć`); continue; }
      const res = await fetch(`${API}/products`, {
        method: 'POST', headers: AUTH(),
        body: JSON.stringify({
          name: p.name, manufacturer: p.manufacturer,
          manufacturerCode: p.manufacturerCode || p.params?.handle || null,
          source: p.source || 'catalog', category: p.category, subtype: p.subtype, groupId: p.group_id,
          catalogId, catalogPage: p.catalogPage, params: p.params ?? {}, describe: false, images,
        }),
      });
      const j = await res.json();
      if (j.duplicate) dup++; else if (j.id) ok++; else { err++; console.log(`  [${i}] ${p.name} — ${JSON.stringify(j).slice(0, 100)}`); }
    } catch (e) {
      err++; console.log(`  [${i}] ${p.name} — ${e.message}`);
    }
    if (i % 20 === 0) console.log(`… ${i + 1}/${products.length} (ok=${ok} dup=${dup} err=${err} imgErr=${imgErr})`);
    await sleep(80);
  }
  console.log(`\nGotowe: ok=${ok}, duplikaty=${dup}, błędy=${err}, imgErr=${imgErr}, catalogId=${catalogId}`);
}

main();
