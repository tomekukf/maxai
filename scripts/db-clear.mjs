// Usuwa produkty o danym prefiksie ID (domyślnie BRW-) — do re-seedu.
// Użycie: DB_SECRET=<sekret> [PREFIX=BRW-] node scripts/db-clear.mjs
import { execSync } from 'node:child_process';
import pg from 'pg';

const secretId = process.env.DB_SECRET;
if (!secretId) {
  console.error('Brak zmiennej DB_SECRET.');
  process.exit(1);
}
const prefix = process.env.PREFIX ?? 'BRW-';
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
const r = await c.query('DELETE FROM products WHERE optima_id LIKE $1', [prefix + '%']);
console.log(`Usunięto ${r.rowCount} produktów (prefix "${prefix}").`);
await c.end();
