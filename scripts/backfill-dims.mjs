// F2b: backfill wymiarów do produktów maxfliz (source='web'). Lokalnie, 0 Bedrock.
// Ponownie pobiera publiczne /products.json (Crawl-delay 1s), wyciąga wymiary z body_html (heurystyki PL),
// dopasowuje po SKU/handle i UPDATE params.wymiary_cm (tylko gdy brak). Sygnał MIĘKKI do reranku.
//
// Użycie: node scripts/backfill-dims.mjs   [LIMIT_PAGES=0 = wszystkie]
import { execSync } from 'node:child_process';
import pg from 'pg';

const BASE = 'https://maxfliz.pl';
const UA = 'maxai-catalog-sync/1.0 (+kontakt sklep)';
const LIMIT_PAGES = Number(process.env.LIMIT_PAGES ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wyciąga wymiary (cm) z opisu HTML. Zwraca {szerokosc,glebokosc,wysokosc,srednica,dlugosc} (tylko znalezione).
function parseDims(html) {
  if (!html) return null;
  const t = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  const out = {};
  const num = (re) => { const m = t.match(re); return m ? parseFloat(m[1].replace(',', '.')) : null; };
  const S = num(/(?:szer(?:okość|\.)?)\s*[:=]?\s*(\d+[.,]?\d*)\s*cm/);
  const G = num(/(?:gł(?:ębokość|\.)?|glebokosc)\s*[:=]?\s*(\d+[.,]?\d*)\s*cm/);
  const W = num(/(?:wys(?:okość|\.)?)\s*[:=]?\s*(\d+[.,]?\d*)\s*cm/);
  const D = num(/(?:dł(?:ugość|\.)?|dlugosc)\s*[:=]?\s*(\d+[.,]?\d*)\s*cm/);
  const Sr = num(/(?:śr(?:ednica|\.)?|średnica|srednica|ø)\s*[:=]?\s*(\d+[.,]?\d*)\s*cm/);
  if (S) out.szerokosc = S; if (G) out.glebokosc = G; if (W) out.wysokosc = W; if (D) out.dlugosc = D; if (Sr) out.srednica = Sr;
  // wzorzec „NN x NN [x NN] cm" (wym. gabarytowe) — gdy brak pól nazwanych
  if (!Object.keys(out).length) {
    const m = t.match(/(\d+[.,]?\d*)\s*[x×]\s*(\d+[.,]?\d*)(?:\s*[x×]\s*(\d+[.,]?\d*))?\s*cm/);
    if (m) {
      out.szerokosc = parseFloat(m[1].replace(',', '.'));
      out.glebokosc = parseFloat(m[2].replace(',', '.'));
      if (m[3]) out.wysokosc = parseFloat(m[3].replace(',', '.'));
    }
  }
  return Object.keys(out).length ? out : null;
}

async function scrapeDims() {
  const bySku = new Map(); // sku/handle → dims
  for (let page = 1; ; page++) {
    if (LIMIT_PAGES && page > LIMIT_PAGES) break;
    const url = `${BASE}/products.json?limit=250&page=${page}`;
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) { console.error(`page ${page}: HTTP ${r.status}`); break; }
    const { products } = await r.json();
    if (!products || !products.length) break;
    for (const p of products) {
      const dims = parseDims(p.body_html);
      if (!dims) continue;
      if (p.handle) bySku.set('h:' + p.handle.toLowerCase(), dims);
      for (const v of p.variants ?? []) if (v.sku) bySku.set('s:' + String(v.sku).toLowerCase(), dims);
    }
    process.stdout.write(`\r… strona ${page}, z wymiarami: ${bySku.size}`);
    await sleep(1000); // Crawl-delay
  }
  console.log('');
  return bySku;
}

async function main() {
  console.log('Pobieram wymiary z maxfliz…');
  const dims = await scrapeDims();
  console.log(`Znaleziono wymiary dla ${dims.size} kluczy (sku/handle).`);

  const s = JSON.parse(execSync(`aws secretsmanager get-secret-value --secret-id MaxaiStackDbSecretB9D43B913-81U2KSCaaX3M --region eu-central-1 --query SecretString --output text`, { encoding: 'utf8' }));
  const c = new pg.Client({ host: s.host, port: Number(s.port ?? 5432), user: s.username, password: s.password, database: s.dbname ?? 'maxai', ssl: { rejectUnauthorized: false } });
  await c.connect();
  const rows = (await c.query("SELECT id, params FROM products WHERE source='web'")).rows;
  let upd = 0, skip = 0;
  for (const row of rows) {
    const p = row.params || {};
    if (p.wymiary_cm) { skip++; continue; } // już ma
    const sku = p.sku ? 's:' + String(p.sku).toLowerCase() : null;
    const handle = p.handle ? 'h:' + String(p.handle).toLowerCase() : null;
    const d = (sku && dims.get(sku)) || (handle && dims.get(handle));
    if (!d) continue;
    await c.query('UPDATE products SET params = params || $1::jsonb WHERE id = $2', [JSON.stringify({ wymiary_cm: d }), row.id]);
    upd++;
  }
  await c.end();
  console.log(`Zaktualizowano wymiary: ${upd} produktów (pominięto ${skip} z już wpisanymi).`);
}

main();
