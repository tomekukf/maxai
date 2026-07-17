// Test Kroku 1.4: /products — upload zdjęcia (presign) + embedding + zapis do bazy.
// Użycie: API=<bazowy-URL-HTTP-API> node scripts/test-products.mjs
import zlib from 'node:zlib';

const api = process.env.API;
if (!api) {
  console.error('Brak zmiennej API (bazowy URL HTTP API).');
  process.exit(1);
}

// Generuje poprawny PNG (solid color, RGB) — Titan wymaga prawdziwego obrazu,
// a 1x1 odrzuca jako "Truncated File Read".
function makePng(size = 64, [r, g, b] = [200, 80, 60]) {
  const rowLen = size * 3;
  const raw = Buffer.alloc((rowLen + 1) * size);
  for (let y = 0; y < size; y++) {
    const off = y * (rowLen + 1);
    raw[off] = 0; // filtr: none
    for (let x = 0; x < size; x++) {
      const p = off + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const png = makePng();

// 1) presign + PUT zdjęcia
const p = await (
  await fetch(`${api}/uploads/presign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'test.png', prefix: 'product-images' }),
  })
).json();
const put = await fetch(p.uploadUrl, { method: 'PUT', body: png });
console.log('upload PUT:', put.status);

// 2) /products
const r = await fetch(`${api}/products`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    optimaId: 'AGATA-TEST-001',
    name: 'Testowa sofa',
    imageKey: p.key,
    sourceUrl: 'https://example.com/test',
    params: { kategoria: 'sofa', kolor: 'czerwony', materialy: ['welur'], szerokosc_cm: 200 },
  }),
});
console.log('HTTP', r.status);
console.log(JSON.stringify(await r.json(), null, 2));
