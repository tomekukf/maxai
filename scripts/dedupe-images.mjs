// Usuwa z bazy DUPLIKATY UJĘĆ w obrębie produktu (te same kadry) — mniej szumu w retrieve.
//
// Algorytm (zachłanny, po sort_order): pierwsze zdjęcie (główne) zostaje zawsze; kolejne
// zostaje tylko wtedy, gdy jego maksymalne podobieństwo do JUŻ ZACHOWANYCH ujęć < próg.
// Dzięki temu wykrywa też pary duplikatów, które nie są duplikatem zdjęcia głównego.
//
// Bezpieczniki: nigdy nie usuwa zdjęcia głównego ani ostatniego zdjęcia produktu;
// kasuje TYLKO wiersze w bazie — pliki w S3 zostają (odwracalne re-importem).
//
// Użycie (git-bash):
//   export DB_SECRET=<id sekretu>
//   node scripts/dedupe-images.mjs                 # dry-run, próg 0.90
//   THRESHOLD=0.95 node scripts/dedupe-images.mjs  # dry-run, inny próg
//   APPLY=1 node scripts/dedupe-images.mjs         # faktyczne usunięcie
import { execSync } from 'node:child_process';
import pg from 'pg';

const region = process.env.AWS_REGION ?? 'eu-central-1';
const THRESHOLD = Number(process.env.THRESHOLD ?? 0.9);
const APPLY = process.env.APPLY === '1';
if (!process.env.DB_SECRET) {
  console.error('Brak DB_SECRET.');
  process.exit(1);
}

const s = JSON.parse(
  execSync(
    `aws secretsmanager get-secret-value --secret-id ${process.env.DB_SECRET} --region ${region} --query SecretString --output text`,
    { encoding: 'utf8' },
  ),
);
const c = new pg.Client({
  host: s.host, port: Number(s.port ?? 5432), user: s.username,
  password: s.password, database: s.dbname ?? 'maxai', ssl: { rejectUnauthorized: false },
});
await c.connect();

// Produkty z >1 zdjęciem — tylko tam jest co deduplikować.
const prods = await c.query(
  `SELECT product_id FROM product_images GROUP BY product_id HAVING count(*) > 1`,
);
console.log(`Próg=${THRESHOLD} | produktów z >1 zdjęciem: ${prods.rows.length} | tryb: ${APPLY ? 'USUWANIE' : 'dry-run'}`);

const doomed = [];
for (const { product_id } of prods.rows) {
  // Macierz podobieństw w obrębie produktu liczona po stronie bazy (pgvector).
  const rows = (await c.query(
    `SELECT a.id AS id_a, a.sort_order AS so_a, b.id AS id_b, b.sort_order AS so_b,
            1 - (a.embedding <=> b.embedding) AS sim
     FROM product_images a JOIN product_images b
       ON b.product_id = a.product_id AND b.id <> a.id
     WHERE a.product_id = $1::uuid
     ORDER BY a.sort_order, a.created_at`,
    [product_id],
  )).rows;
  const order = [...new Set(rows.map((r) => r.id_a))]; // kolejność wg sort_order
  const sim = new Map(rows.map((r) => [`${r.id_a}|${r.id_b}`, Number(r.sim)]));
  const kept = [];
  for (const id of order) {
    if (kept.length === 0) { kept.push(id); continue; } // główne zostaje zawsze
    const maxSim = Math.max(...kept.map((k) => sim.get(`${id}|${k}`) ?? 0));
    if (maxSim >= THRESHOLD) doomed.push({ id, product_id, maxSim });
    else kept.push(id);
  }
}

const byBucket = {};
for (const d of doomed) {
  const b = d.maxSim >= 0.98 ? '0.98+' : d.maxSim >= 0.95 ? '0.95–0.98' : '0.90–0.95';
  byBucket[b] = (byBucket[b] ?? 0) + 1;
}
const total = (await c.query('SELECT count(*)::int AS n FROM product_images')).rows[0].n;
console.log(`Do usunięcia: ${doomed.length} z ${total} zdjęć (${((doomed.length / total) * 100).toFixed(1)}%)`);
console.log('Rozkład podobieństwa:', JSON.stringify(byBucket));

if (!APPLY) {
  console.log('\nDRY-RUN — nic nie usunięto. Uruchom z APPLY=1, aby wykonać.');
} else if (doomed.length) {
  const ids = doomed.map((d) => d.id);
  const res = await c.query('DELETE FROM product_images WHERE id = ANY($1::uuid[])', [ids]);
  console.log(`Usunięto wierszy: ${res.rowCount} (pliki w S3 nietknięte)`);
  const left = await c.query(
    `SELECT count(*)::int AS n FROM products p
     WHERE NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = p.id)`);
  console.log(`Kontrola: produktów bez zdjęć po operacji: ${left.rows[0].n} (musi być 0)`);
}
await c.end();
