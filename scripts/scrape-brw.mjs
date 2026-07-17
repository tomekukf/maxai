// Scraper BRW: parsuje JSON-LD z kategorii sof → rawdata/brw-products.json.
// Respektuje robots (kategoria bazowa bez parametrów/paginacji, pojedynczy fetch).
// Użycie: node scripts/scrape-brw.mjs
import { writeFileSync } from 'node:fs';

const CATEGORY_URL = 'https://www.brw.pl/meble/meble-wypoczynkowe/sofy/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const html = await (await fetch(CATEGORY_URL, { headers: { 'user-agent': UA } })).text();

const blocks = [
  ...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi),
].map((m) => m[1]);

const products = [];
for (const b of blocks) {
  let data;
  try {
    data = JSON.parse(b);
  } catch {
    continue;
  }
  const nodes = Array.isArray(data) ? data : [data];
  for (const node of nodes) {
    const items =
      node['@type'] === 'ItemList' && Array.isArray(node.itemListElement)
        ? node.itemListElement.map((li) => li.item ?? li)
        : node['@type'] === 'Product'
          ? [node]
          : [];
    for (const it of items) {
      if (it?.['@type'] !== 'Product') continue;
      const imageUrl = Array.isArray(it.image) ? it.image[0] : it.image;
      const m = /,(\d+)(?:$|\?)/.exec(it.url || '');
      const code = m ? m[1] : (it.url || '').split('/').pop();
      products.push({
        name: it.name,
        imageUrl,
        price: it.offers?.price ?? null,
        url: it.url,
        code,
      });
    }
  }
}

// dedup po kodzie
const seen = new Set();
const uniq = products.filter((p) => p.code && p.imageUrl && !seen.has(p.code) && seen.add(p.code));

writeFileSync('rawdata/brw-products.json', JSON.stringify(uniq, null, 2));
console.log('produktów:', uniq.length);
console.log(uniq.slice(0, 3));
