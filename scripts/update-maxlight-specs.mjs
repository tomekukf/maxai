// Faza 8.2: scala params.specs (+ finish/material/light_source) do istniejacych produktow
// po manufacturer_code. Bezposrednio DB (bez re-embed). Zrodlo: rawdata/maxlight/products.raw.json
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import pg from 'pg';
const s = JSON.parse(execSync(`aws secretsmanager get-secret-value --secret-id ${process.env.DB_SECRET} --region eu-central-1 --query SecretString --output text`, { encoding: 'utf8' }));
const c = new pg.Client({ host: s.host, port: +s.port, user: s.username, password: s.password, database: s.dbname ?? 'maxai', ssl: { rejectUnauthorized: false } });
await c.connect();
const raw = JSON.parse(readFileSync('../rawdata/maxlight/products.raw.json', 'utf8'));
let upd = 0, miss = 0;
for (const p of raw) {
  const patch = {};
  if (p.specs) patch.specs = p.specs;
  if (p.finish) patch.finish = p.finish;
  if (p.material) patch.material = p.material;
  if (p.light_source) patch.light_source = p.light_source;
  if (p.dimensions) patch.dimensions = p.dimensions;
  if (!Object.keys(patch).length) continue;
  const r = await c.query('UPDATE products SET params = COALESCE(params,\'{}\'::jsonb) || $1::jsonb WHERE manufacturer_code=$2',
    [JSON.stringify(patch), p.codes[0]]);
  if (r.rowCount) upd += r.rowCount; else miss++;
}
console.log(`Zaktualizowano: ${upd}, bez dopasowania: ${miss}`);
const ns = await c.query(`SELECT count(*) n FROM products WHERE params->'specs' IS NULL`);
console.log('Produkty bez params.specs:', ns.rows[0].n);
await c.end();
