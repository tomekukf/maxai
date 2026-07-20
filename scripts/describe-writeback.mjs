// Faza 8.5: zapis opisów wizualnych do bazy. Czyta attributes.json ({ "<imageKey>": {…schemat…}, … })
// i robi UPDATE product_images SET attributes = … WHERE image_s3_url = imageKey. BEZ re-embeddingu.
//
// Env/arg: FILE=<attributes.json> (domyślnie ./describe-batch/attributes.json)
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const REGION = process.env.AWS_REGION ?? 'eu-central-1';
const FILE = process.env.FILE || process.argv[2] || 'describe-batch/attributes.json';
const data = JSON.parse(readFileSync(FILE, 'utf8'));
const entries = Object.entries(data);
if (!entries.length) { console.error('Pusty attributes.json'); process.exit(1); }

const s = JSON.parse(execSync(`aws secretsmanager get-secret-value --secret-id MaxaiStackDbSecretB9D43B913-81U2KSCaaX3M --region ${REGION} --query SecretString --output text`, { encoding: 'utf8' }));
const c = new pg.Client({ host: s.host, port: Number(s.port ?? 5432), user: s.username, password: s.password, database: s.dbname ?? 'maxai', ssl: { rejectUnauthorized: false } });
await c.connect();

let ok = 0, miss = 0;
for (const [imageKey, attrs] of entries) {
  const r = await c.query('UPDATE product_images SET attributes = $1 WHERE image_s3_url = $2', [JSON.stringify(attrs), imageKey]);
  if (r.rowCount) ok += r.rowCount; else { miss++; console.error(`  brak dopasowania dla klucza: ${imageKey}`); }
}
await c.end();
console.log(`Zapisano attributes dla ${ok} zdjęć (${miss} bez dopasowania) z ${entries.length} wpisów.`);
