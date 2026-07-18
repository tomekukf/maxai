// Podgląd opisów (attributes) produktu po ID Optima.
// Użycie: DB_SECRET=<sekret> OID=BRW-718047 node scripts/db-attrs.mjs
import { execSync } from 'node:child_process';
import pg from 'pg';

const secretId = process.env.DB_SECRET;
if (!secretId) {
  console.error('Brak DB_SECRET.');
  process.exit(1);
}
const oid = process.env.OID ?? process.argv[2];
if (!oid) {
  console.error('Podaj OID (np. OID=BRW-718047).');
  process.exit(1);
}
const region = process.env.AWS_REGION ?? 'eu-central-1';
const s = JSON.parse(
  execSync(
    `aws secretsmanager get-secret-value --secret-id ${secretId} --region ${region} --query SecretString --output text`,
    { encoding: 'utf8' },
  ),
);
const c = new pg.Client({
  host: s.host,
  port: Number(s.port ?? 5432),
  user: s.username,
  password: s.password,
  database: s.dbname ?? 'maxai',
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const r = await c.query(
  'SELECT p.name, pi.sort_order, pi.attributes FROM products p JOIN product_images pi ON pi.product_id = p.id WHERE p.optima_id = $1 ORDER BY pi.sort_order',
  [oid],
);
if (!r.rows.length) console.log('Brak produktu', oid);
for (const row of r.rows) {
  console.log(`\n[${oid}] "${row.name}" — zdjęcie ${row.sort_order}:`);
  console.log(JSON.stringify(row.attributes, null, 2));
}
await c.end();
