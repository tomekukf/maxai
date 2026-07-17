// maxai — runner migracji SQL (brak lokalnego psql).
// Pobiera dane połączenia z Secrets Manager (przez AWS CLI), wykonuje plik .sql
// i weryfikuje wynik (rozszerzenie vector + tabela products).
//
// Użycie (z katalogu projektu):
//   DB_SECRET=<nazwa-lub-ARN-sekretu> node scripts/migrate.mjs backend/migrations/001_init.sql
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import pg from 'pg';

const sqlPath = process.argv[2];
if (!sqlPath) {
  console.error('Uzycie: DB_SECRET=<sekret> node scripts/migrate.mjs <plik.sql>');
  process.exit(1);
}
const secretId = process.env.DB_SECRET;
if (!secretId) {
  console.error('Brak zmiennej DB_SECRET (nazwa lub ARN sekretu w Secrets Manager).');
  process.exit(1);
}
const region = process.env.AWS_REGION ?? 'eu-central-1';

const sql = readFileSync(sqlPath, 'utf8');

// Dane logowania z Secrets Manager (RDS zapisuje tu host/port/dbname/username/password).
const raw = execSync(
  `aws secretsmanager get-secret-value --secret-id ${secretId} --region ${region} --query SecretString --output text`,
  { encoding: 'utf8' },
);
const s = JSON.parse(raw);

const client = new pg.Client({
  host: s.host,
  port: Number(s.port ?? 5432),
  user: s.username,
  password: s.password,
  database: s.dbname ?? 'maxai',
  ssl: { rejectUnauthorized: false }, // MVP: szyfrowanie bez weryfikacji CA
});

try {
  await client.connect();
  await client.query(sql);
  const ext = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
  const tbl = await client.query("SELECT to_regclass('public.products') AS t");
  console.log(
    `OK migracja | pgvector: ${ext.rowCount ? 'jest' : 'BRAK'} | tabela products: ${tbl.rows[0].t ? 'jest' : 'BRAK'}`,
  );
} catch (e) {
  console.error('BLAD migracji:', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
