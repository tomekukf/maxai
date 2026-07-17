// Test Kroku 1.3: /extract — Haiku 4.5 wyciąga parametry z surowego opisu.
// Użycie: API=<bazowy-URL-HTTP-API> node scripts/test-extract.mjs
const api = process.env.API;
if (!api) {
  console.error('Brak zmiennej API (bazowy URL HTTP API).');
  process.exit(1);
}

const description =
  'Sofa 3-osobowa VERONA, tapicerka welurowa w kolorze butelkowej zieleni, ' +
  'szerokosc 220 cm, glebokosc 95 cm, wysokosc 88 cm, funkcja spania, ' +
  'pojemnik na posciel. Cena 2499 zl. Kod: VER-3F-GRN.';

const r = await fetch(`${api}/extract`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ description }),
});
console.log('HTTP', r.status);
console.log(JSON.stringify(await r.json(), null, 2));
