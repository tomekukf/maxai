// Podgląd struktury JSON-LD z pobranej strony kategorii BRW.
// Użycie: node scripts/inspect-brw.mjs rawdata/brw-sofy.html
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? 'rawdata/brw-sofy.html';
const html = readFileSync(path, 'utf8');

const blocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].map(
  (m) => m[1],
);
console.log('bloki ld+json:', blocks.length);

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
    if (node['@type'] === 'Product') products.push(node);
    if (node['@type'] === 'ItemList' && Array.isArray(node.itemListElement)) {
      for (const li of node.itemListElement) {
        const item = li.item ?? li;
        if (item && item['@type'] === 'Product') products.push(item);
      }
    }
  }
}

console.log('znalezione Product:', products.length);
console.log('--- klucze pierwszego ---');
console.log(products[0] ? Object.keys(products[0]) : '(brak)');
console.log('--- pierwsze 2 produkty ---');
console.log(JSON.stringify(products.slice(0, 2), null, 2));
