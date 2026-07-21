// Faza 8.5: pobiera z S3 zdjęcia BEZ opisu wizualnego (attributes) do lokalnego opisania (Claude Code).
// Zapisuje pliki + manifest.json. Potem: Claude opisuje wg docs/product-description-spec.md → attributes.json
// → scripts/describe-writeback.mjs (UPDATE product_images.attributes, bez re-embeddingu).
//
// Env: OUT=<dir> [CATEGORY=lazienka] [SUBTYPE_LIKE=umywal] [NAME_LIKE=umywal] [PRIMARY_ONLY=1] [LIMIT=16]
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const BUCKET = 'maxaistack-filesbucket16450113-3fnndonlqpsv';
const REGION = process.env.AWS_REGION ?? 'eu-central-1';
const OUT = process.env.OUT || join(process.cwd(), 'describe-batch');
const CATEGORY = process.env.CATEGORY || null;
const SUBTYPE_LIKE = process.env.SUBTYPE_LIKE || null;
const NAME_LIKE = process.env.NAME_LIKE || null;
const NAME_NOT_LIKE = process.env.NAME_NOT_LIKE || null; // wyklucz (np. bateria)
const PRIMARY_ONLY = process.env.PRIMARY_ONLY === '1';
const LIMIT = Number(process.env.LIMIT || 16);

const keyOf = (u) => {
  if (!u) return u;
  if (u.startsWith('s3://')) return u.replace(/^s3:\/\/[^/]+\//, '');
  if (u.includes('://')) return new URL(u).pathname.replace(/^\//, '');
  return u;
};

const s = JSON.parse(execSync(`aws secretsmanager get-secret-value --secret-id MaxaiStackDbSecretB9D43B913-81U2KSCaaX3M --region ${REGION} --query SecretString --output text`, { encoding: 'utf8' }));
const c = new pg.Client({ host: s.host, port: Number(s.port ?? 5432), user: s.username, password: s.password, database: s.dbname ?? 'maxai', ssl: { rejectUnauthorized: false } });
await c.connect();

const where = ["(pi.attributes IS NULL OR pi.attributes::text = '{}')"];
const params = [];
if (CATEGORY) {
  const cats = CATEGORY.split(',').map((x) => x.trim()).filter(Boolean);
  params.push(cats);
  where.push(`p.category = ANY($${params.length})`);
}
if (NAME_LIKE) {
  params.push(`%${NAME_LIKE.toLowerCase()}%`);
  where.push(`lower(p.name) LIKE $${params.length}`);
}
if (SUBTYPE_LIKE) {
  params.push(`%${SUBTYPE_LIKE.toLowerCase()}%`);
  where.push(`lower(coalesce(p.subtype,'')) LIKE $${params.length}`);
}
for (const ex of (NAME_NOT_LIKE ? NAME_NOT_LIKE.split(',') : [])) {
  params.push(`%${ex.trim().toLowerCase()}%`);
  where.push(`lower(p.name) NOT LIKE $${params.length}`);
}
const whereSql = where.join(' AND ');
const sql = PRIMARY_ONLY
  ? `SELECT * FROM (
       SELECT DISTINCT ON (pi.product_id) pi.id, pi.image_s3_url, pi.sort_order,
              p.name, p.category, p.subtype, p.params
       FROM product_images pi JOIN products p ON p.id = pi.product_id
       WHERE ${whereSql}
       ORDER BY pi.product_id, pi.sort_order
     ) t ORDER BY name LIMIT ${LIMIT}`
  : `SELECT pi.id, pi.image_s3_url, pi.sort_order, p.name, p.category, p.subtype, p.params
     FROM product_images pi JOIN products p ON p.id = pi.product_id
     WHERE ${whereSql} ORDER BY p.name, pi.sort_order LIMIT ${LIMIT}`;

const rows = (await c.query(sql, params)).rows;
await c.end();

mkdirSync(OUT, { recursive: true });
const manifest = [];
let ok = 0;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const key = keyOf(r.image_s3_url);
  const file = `${String(i).padStart(3, '0')}.jpg`;
  try {
    execSync(`aws s3 cp "s3://${BUCKET}/${key}" "${join(OUT, file)}" --region ${REGION}`, { stdio: 'pipe' });
    manifest.push({ file, id: r.id, imageKey: r.image_s3_url, name: r.name, category: r.category, subtype: r.subtype, specs: r.params?.specs ?? null });
    ok++;
  } catch (e) {
    console.error(`  [${i}] ${r.name} — pobranie nieudane: ${String(e.message).slice(0, 80)}`);
  }
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Pobrano ${ok}/${rows.length} zdjęć do ${OUT}\nManifest: ${join(OUT, 'manifest.json')}`);
console.log('Filtry:', { CATEGORY, SUBTYPE_LIKE, NAME_LIKE, PRIMARY_ONLY, LIMIT });
