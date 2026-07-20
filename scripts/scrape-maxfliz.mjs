// Zaciąg oferty publicznej maxfliz.pl (Shopify) → rawdata/maxfliz/ (Faza 10.1).
// Publiczny endpoint /products.json (robots.txt pozwala, Crawl-delay: 1). BEZ CEN.
// Wynik: collection.json (jedno „źródło" = wszystkie produkty) + images/ — gotowe do Importu w panelu admina.
//
// Użycie:  [LIMIT=0] [VENDOR=MAXLIGHT] [NOIMAGES=1] node scripts/scrape-maxfliz.mjs
//   LIMIT   – maks. produktów (0 = wszystkie)
//   VENDOR  – tylko dany producent (np. MAXLIGHT); pusty = wszyscy
//   NOIMAGES=1 – nie pobieraj zdjęć (tylko metadane + URL-e CDN)
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'https://maxfliz.pl';
const DELAY = 1100; // ms — respekt Crawl-delay: 1
const OUT = 'rawdata/maxfliz';
const IMG = `${OUT}/images`;
const LIMIT = Number(process.env.LIMIT ?? 0);
const VENDOR = (process.env.VENDOR ?? '').trim().toUpperCase();
const NOIMAGES = !!process.env.NOIMAGES;
const UA = 'maxai-catalog-sync/1.0 (+kontakt: maxfliz)';

const TILE = new Set(['COEM', 'GRESPANIA', 'MIRAGE', 'ATLAS CONCORDE', 'RAGNO', 'EQUIPE', 'PROVENZA', 'PORCELANOSA', 'MARAZZI', 'CERAMICA']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const codeOf = (title) => (title.match(/\b([A-Z]\d{3,4}[A-Z]?)\b/) || [])[1] ?? null;

function categoryOf(vendor, title) {
  const v = (vendor || '').toUpperCase();
  const t = (title || '').toLowerCase();
  if (v === 'MAXLIGHT' || /\blamp|kinkiet|żyrandol|plafon|reflektor|oczko|listwa/.test(t)) return 'oswietlenie';
  if (TILE.has(v) || /\bpłytk|gres|mozaik/.test(t)) return 'plytki';
  if (/\bsofa|kanapa|naroż/.test(t)) return 'sofa';
  if (/\bfotel/.test(t)) return 'fotel';
  if (/\bkrzes/.test(t)) return 'krzeslo';
  if (/\bstolik/.test(t)) return 'stolik';
  if (/\bst[oó][łl]/.test(t)) return 'stol';
  if (/\bdywan/.test(t)) return 'dywan';
  return 'inne';
}

const PREFIX_SUB = { P: 'wiszaca', W: 'kinkiet', C: 'plafon', T: 'stolowa', F: 'podlogowa', S: 'reflektor_szynowy', H: 'downlight' };
function subtypeOf(cat, title, code) {
  if (cat !== 'oswietlenie') return null;
  const t = (title || '').toLowerCase();
  if (/wisząc|wiszac/.test(t)) return 'wiszaca';
  if (/kinkiet/.test(t)) return 'kinkiet';
  if (/plafon|sufitow/.test(t)) return 'plafon';
  if (/podłogow|podlogow/.test(t)) return 'podlogowa';
  if (/stołow|stolow|biurkow/.test(t)) return 'stolowa';
  if (/żyrandol|zyrandol/.test(t)) return 'zyrandol';
  return code ? PREFIX_SUB[code[0]] ?? null : null; // fallback: prefiks kodu (Maxlight)
}

async function main() {
  mkdirSync(IMG, { recursive: true });
  const products = [];
  let page = 1;
  let scanned = 0;
  while (true) {
    const url = `${BASE}/products.json?limit=250&page=${page}`;
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) { console.error(`Strona ${page}: HTTP ${r.status}, stop`); break; }
    const batch = (await r.json()).products ?? [];
    if (!batch.length) break;
    scanned += batch.length;
    for (const p of batch) {
      if (VENDOR && (p.vendor || '').toUpperCase() !== VENDOR) continue;
      const title = (p.title || '').trim();
      const cat = categoryOf(p.vendor, title);
      const code = codeOf(title);
      const imgs = (p.images || []).map((im, i) => ({ src: im.src, i }));
      products.push({
        name: title,
        manufacturer: p.vendor || null,
        manufacturerCode: code,
        category: cat,
        subtype: subtypeOf(cat, title, code),
        group_id: slug(`${p.vendor}-${title.replace(/\b[A-Z]\d{3,4}[A-Z]?\b/, '').trim()}`) || slug(p.handle),
        source: 'web',
        params: {
          handle: p.handle,
          product_url: `${BASE}/products/${p.handle}`,
          codes: codeOf(title) ? [codeOf(title)] : [],
          body_html_len: (p.body_html || '').length,
        },
        _images: imgs, // do pobrania / referencji (bez cen)
      });
      if (LIMIT && products.length >= LIMIT) break;
    }
    console.log(`… strona ${page}: +${batch.length} (zebrano ${products.length})`);
    if (LIMIT && products.length >= LIMIT) break;
    page += 1;
    await sleep(DELAY);
  }

  // Pobieranie zdjęć + budowa collection.json
  let downloaded = 0;
  for (const p of products) {
    const saved = [];
    for (const im of p._images) {
      const ext = (im.src.split('?')[0].match(/\.(jpg|jpeg|png|webp|avif)$/i) || [, 'jpg'])[1].toLowerCase();
      const file = `${slug(p.manufacturerCode || p.name).slice(0, 40)}_${im.i}.${ext}`;
      if (!NOIMAGES) {
        try {
          const ir = await fetch(im.src, { headers: { 'user-agent': UA } });
          if (ir.ok) {
            writeFileSync(`${IMG}/${file}`, Buffer.from(await ir.arrayBuffer()));
            downloaded++;
          }
        } catch { /* pomiń */ }
      }
      saved.push({ file, src: im.src, role: im.i === 0 ? 'cutout' : 'lifestyle', sortOrder: im.i });
    }
    p.images = saved;
    delete p._images;
  }

  const pkg = {
    catalog: { name: 'maxfliz — oferta publiczna', manufacturer: 'maxfliz', domainCategory: 'mixed', pageCount: 0 },
    products,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/collection.json`, JSON.stringify(pkg, null, 2));
  const byCat = products.reduce((m, p) => ((m[p.category] = (m[p.category] || 0) + 1), m), {});
  console.log(`\nGotowe: produktów=${products.length} (przeskanowano ${scanned}), zdjęć pobrano=${downloaded}`);
  console.log('kategorie:', byCat);
  console.log(`Zapisano: ${OUT}/collection.json + ${IMG}/`);
}

main();
