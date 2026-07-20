// Import kolekcji maxfliz do AWS (Faza 10.1). Czyta rawdata/maxfliz/collection.json,
// filtruje po kategorii (CATEGORY), pobiera zdjęcia z CDN → presign → S3 → POST /products.
// Sam odświeża token (Cognito REST, USER_PASSWORD_AUTH) — długi przebieg nie urwie się po 60 min.
// BEZ CEN. describe:false (bez Sonnet). Embedding = Titan w Lambdzie /products.
//
// Użycie (git-bash):
//   API_URL=... COGNITO_CLIENT_ID=... ADMIN_PASSWORD=... [ADMIN_USER=admin] [CATEGORY=oswietlenie] [LIMIT=0] node scripts/seed-maxfliz.mjs
import { readFileSync } from 'node:fs';

const CATEGORY = process.env.CATEGORY ?? 'oswietlenie';
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
  const pr = await fetch(`${API}/uploads/presign`, { method: 'POST', headers: AUTH(), body: JSON.stringify({ filename, prefix: 'products/maxfliz' }) });
  if (!pr.ok) throw new Error(`presign ${pr.status}`);
  const { uploadUrl, key } = await pr.json();
  const put = await fetch(uploadUrl, { method: 'PUT', body: bytes });
  if (!put.ok) throw new Error(`PUT ${put.status}`);
  return key;
}

async function main() {
  const all = JSON.parse(readFileSync('rawdata/maxfliz/collection.json', 'utf8')).products;
  let products = all.filter((p) => p.category === CATEGORY);
  if (LIMIT) products = products.slice(0, LIMIT);
  console.log(`API=${API}\nKategoria=${CATEGORY} → ${products.length} produktów (z ${all.length})`);
  await login();

  const cr = await fetch(`${API}/catalogs`, { method: 'POST', headers: AUTH(), body: JSON.stringify({ name: `maxfliz — ${CATEGORY}`, manufacturer: 'maxfliz', domainCategory: CATEGORY }) });
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
          const r = await fetch(im.src, { headers: { 'user-agent': 'maxai-catalog-sync/1.0' } });
          if (!r.ok) { imgErr++; continue; }
          const key = await presignPut(im.file, Buffer.from(await r.arrayBuffer()));
          images.push({ key, sortOrder: im.sortOrder ?? 0 });
        } catch { imgErr++; }
      }
      if (!images.length) { err++; console.log(`  [${i}] ${p.name} — brak zdjęć`); continue; }
      const res = await fetch(`${API}/products`, {
        method: 'POST', headers: AUTH(),
        body: JSON.stringify({
          name: p.name, manufacturer: p.manufacturer,
          manufacturerCode: p.manufacturerCode || p.params?.handle, // handle = stabilny klucz dedup gdy brak kodu
          source: 'web', category: p.category, subtype: p.subtype, groupId: p.group_id,
          catalogId, params: p.params ?? {}, describe: false, images,
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
