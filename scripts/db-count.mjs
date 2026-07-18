// Szybki podgląd bazy: liczba produktów i ile ma embedding.
// Użycie: DB_SECRET=<sekret> node scripts/db-count.mjs
import { execSync } from 'node:child_process';
import pg from 'pg';

const secretId = process.env.DB_SECRET;
if (!secretId) {
  console.error('Brak zmiennej DB_SECRET.');
  process.exit(1);
}
const region = process.env.AWS_REGION ?? 'eu-central-1';
const raw = execSync(
  `aws secretsmanager get-secret-value --secret-id ${secretId} --region ${region} --query SecretString --output text`,
  { encoding: 'utf8' },
);
const s = JSON.parse(raw);

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
  'SELECT (SELECT count(*) FROM products)::int AS produkty, ' +
    '(SELECT count(*) FROM product_images)::int AS zdjecia, ' +
    '(SELECT count(embedding) FROM product_images)::int AS z_embeddingiem, ' +
    '(SELECT count(attributes) FROM product_images)::int AS z_opisem',
);
console.log(r.rows[0]);
await c.end();
