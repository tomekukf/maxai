// Test Kroku 1.2: pobiera presigned URL z /uploads/presign i wgrywa plik na S3.
// Użycie (z katalogu projektu):
//   API=<bazowy-URL-HTTP-API> node scripts/test-presign.mjs
const api = process.env.API;
if (!api) {
  console.error('Brak zmiennej API (bazowy URL HTTP API).');
  process.exit(1);
}

const r = await fetch(`${api}/uploads/presign`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ filename: 'test.txt', contentType: 'text/plain', prefix: 'test' }),
});
if (!r.ok) {
  console.error('presign HTTP', r.status, await r.text());
  process.exit(1);
}
const { uploadUrl, key } = await r.json();
console.log('presign OK, key =', key);

// Bez podpisanego Content-Type — PUT-ujemy samo body (dowolny typ zadziała).
const put = await fetch(uploadUrl, {
  method: 'PUT',
  body: 'hello maxai',
});
console.log('PUT status:', put.status, put.ok ? 'OK' : 'BLAD');
if (!put.ok) {
  console.error(await put.text());
  process.exit(1);
}
