// Seed katalogu Maxlight do AWS (ścieżka offline): rawdata -> S3 + catalogs + /products.
// Używa KANONICZNEGO endpointu /products (embedding Titan w Lambdzie) — ten sam zapis co import z UI.
// describe:false => brak kosztu Sonnet (atrybuty wizualne odłożone na v1).
//
// Wymaga: aws CLI (креды), Node 18+ (fetch). Parametry pobiera z outputów stacku.
// Użycie:  [LIMIT=5] node scripts/seed-maxlight.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import pg from 'pg';

const REGION = process.env.AWS_REGION ?? 'eu-central-1';
const LIMIT = Number(process.env.LIMIT ?? 0);
const RAW = 'rawdata/maxlight/products.raw.json';
const IMG_DIR = 'rawdata/maxlight/images';
const PDF = 'rawdata/maxlight_2026.pdf';

function out(key) {
  return execSync(
    `aws cloudformation describe-stacks --stack-name MaxaiStack --region ${REGION} ` +
      `--query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" --output text`,
    { encoding: 'utf8' },
  ).trim();
}

const API = out('ApiUrl');
const BUCKET = out('FilesBucketName');
const SECRET = out('DbSecretName');
console.log(`API=${API}\nBUCKET=${BUCKET}`);

const secret = JSON.parse(
  execSync(
    `aws secretsmanager get-secret-value --secret-id ${SECRET} --region ${REGION} --query SecretString --output text`,
    { encoding: 'utf8' },
  ),
);
const db = new pg.Client({
  host: secret.host, port: +secret.port, user: secret.username, password: secret.password,
  database: secret.dbname ?? 'maxai', ssl: { rejectUnauthorized: false },
});
await db.connect();

let products = JSON.parse(readFileSync(RAW, 'utf8'));
if (LIMIT > 0) products = products.slice(0, LIMIT);
console.log(`Produktów do seedu: ${products.length}`);

// 1) Wiersz katalogu (+ miejsce PDF w S3)
const ins = await db.query(
  `INSERT INTO catalogs (name, manufacturer, domain_category, pdf_s3_url, page_count, status)
   VALUES ($1,$2,$3,$4,$5,'ready') RETURNING id`,
  ['Maxlight 2026', 'Maxlight', 'oswietlenie', '', 343],
);
const catalogId = ins.rows[0].id;
// Stabilne klucze S3 (niezależne od catalogId) → ponowne przebiegi nie wgrywają danych od nowa.
const pdfKey = `catalogs/maxlight_2026/original.pdf`;
const IMG_PREFIX = `products/maxlight`;
await db.query('UPDATE catalogs SET pdf_s3_url=$1 WHERE id=$2', [`s3://${BUCKET}/${pdfKey}`, catalogId]);
console.log(`catalogId=${catalogId}`);

// 2) Upload PDF (208 MB, jednorazowo) + wszystkich zdjęć — hurtem przez aws s3 cp
if (process.env.SKIP_UPLOAD) {
  console.log('SKIP_UPLOAD — pomijam wgrywanie do S3 (zakładam, że pliki już są).');
} else {
  console.log('Upload PDF do S3…');
  execSync(`aws s3 cp "${PDF}" "s3://${BUCKET}/${pdfKey}" --region ${REGION} --only-show-errors`, { stdio: 'inherit' });
  console.log('Upload zdjęć do S3…');
  execSync(`aws s3 cp "${IMG_DIR}" "s3://${BUCKET}/${IMG_PREFIX}/" --recursive --region ${REGION} --only-show-errors`, { stdio: 'inherit' });
}

const onDisk = new Set(readdirSync(IMG_DIR));

// 3) Per produkt -> POST /products (cutout(y) pierwsze, potem render aranżacyjny)
let ok = 0, dup = 0, err = 0;
for (const [i, p] of products.entries()) {
  const imgs = [...p.images].sort((a, b) => (a.role === b.role ? 0 : a.role === 'cutout' ? -1 : 1));
  const images = imgs
    .filter((im) => onDisk.has(im.file))
    .map((im, k) => ({ key: `${IMG_PREFIX}/${im.file}`, sortOrder: k }));
  if (!images.length) { err++; console.log(`  [${i}] ${p.name} — brak zdjęć, pomijam`); continue; }

  const body = {
    name: p.name,
    manufacturer: p.manufacturer,
    manufacturerCode: p.codes[0],
    source: 'catalog',
    category: p.category,
    subtype: p.subtype,
    catalogId,
    catalogPage: p.viewer_page,
    describe: false,
    params: {
      codes: p.codes, light_source: p.light_source, finish: p.finish,
      material: p.material, dimensions: p.dimensions, printed_page: p.printed_page,
    },
    images,
  };

  try {
    const r = await fetch(`${API}/products`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.duplicate) { dup++; }
    else if (j.id) { ok++; }
    else { err++; console.log(`  [${i}] ${p.name} — ${r.status} ${JSON.stringify(j).slice(0, 120)}`); }
  } catch (e) {
    err++; console.log(`  [${i}] ${p.name} — ${e.message}`);
  }
  if (i % 20 === 0) console.log(`… ${i + 1}/${products.length} (ok=${ok} dup=${dup} err=${err})`);
  await new Promise((res) => setTimeout(res, 120));
}

console.log(`\nGotowe: ok=${ok}, duplikaty=${dup}, błędy=${err}, catalogId=${catalogId}`);
await db.end();
