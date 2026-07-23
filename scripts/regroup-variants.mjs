// Przelicza `group_id` tak, by warianty KOLORYSTYCZNE / WYKOŃCZENIOWE tego samego modelu
// trafiały do jednej karty w wynikach (np. KINKIET FAYETTE ZŁOTY / CZARNY → jeden produkt z wariantami).
//
// Metoda: z dotychczasowego `group_id` (slug nazwy) usuwamy tokeny koloru i wykończenia.
// WAŻNE: pomijamy kategorie POWIERZCHNI (plytki/podlogi/tapety/dywan) — tam kolor JEST produktem,
// więc szara i beżowa płytka to dwa różne produkty, a nie warianty (spójne z regułą reranku).
//
// Użycie (git-bash):
//   export DB_SECRET=<id sekretu>
//   node scripts/regroup-variants.mjs           # dry-run (pokazuje przykłady)
//   APPLY=1 node scripts/regroup-variants.mjs   # zapis do bazy
import { execSync } from 'node:child_process';
import pg from 'pg';

const region = process.env.AWS_REGION ?? 'eu-central-1';
const APPLY = process.env.APPLY === '1';
const SKIP_CATEGORIES = ['plytki', 'podlogi', 'tapety', 'dywan'];

// Kolory, odcienie, wykończenia i gatunki drewna — wszystko, co odróżnia WARIANT, a nie model.
const VARIANT_TOKENS = new Set([
  'bialy', 'biala', 'biale', 'czarny', 'czarna', 'czarne', 'szary', 'szara', 'szare',
  'zloty', 'zlota', 'zlote', 'srebrny', 'srebrna', 'srebrne', 'chrom', 'chromowany',
  'bezowy', 'bezowa', 'bezowe', 'braz', 'brazowy', 'brazowa', 'kremowy', 'kremowa',
  'zielony', 'zielona', 'niebieski', 'niebieska', 'jasnoniebieski', 'granatowy',
  'rozowy', 'rozowa', 'miętowy', 'mietowy', 'grafitowy', 'grafit', 'antracyt', 'antracytowy',
  'popielaty', 'mosiadz', 'mosiezny', 'nikiel', 'niklowy', 'miedz', 'miedziany', 'bursztynowy',
  'przezroczysty', 'mleczny', 'transparentny', 'zloto', 'srebro', 'jasny', 'jasna', 'ciemny', 'ciemna',
  // gatunki i wykończenia drewna
  'dab', 'debowy', 'orzech', 'sonoma', 'wenge', 'jesion', 'buk', 'olcha', 'kasztan', 'palony', 'naturalny',
  // wykończenie powierzchni
  'mat', 'matowy', 'matowa', 'polysk', 'polyskowy', 'blyszczacy',
]);

const strip = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[ąàâ]/g, 'a').replace(/[ćç]/g, 'c').replace(/[ęè]/g, 'e').replace(/ł/g, 'l')
    .replace(/ń/g, 'n').replace(/[óô]/g, 'o').replace(/[śş]/g, 's').replace(/[źż]/g, 'z');

function baseGroup(groupId) {
  const kept = strip(groupId).split('-').filter((t) => t && !VARIANT_TOKENS.has(t));
  return kept.join('-');
}

if (!process.env.DB_SECRET) { console.error('Brak DB_SECRET.'); process.exit(1); }
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

const rows = (await c.query(
  `SELECT id, name, category, subtype, group_id, params FROM products
   WHERE group_id IS NOT NULL AND category <> ALL($1::text[])`,
  [SKIP_CATEGORIES],
)).rows;

// Odcisk „tego samego modelu": podtyp + specyfikacja + wymiary. Dwa produkty scalamy TYLKO wtedy,
// gdy różnią się wyłącznie tokenami koloru/wykończenia, a parametry mają identyczne.
// Bez tego warunku scalają się różne modele o tej samej nazwie handlowej (np. 35 paneli ORAC W108/W110,
// albo kinkiety FAYETTE różniące się długością) — a to ukrywałoby produkty przed handlowcem.
function fingerprint(r) {
  const p = r.params || {};
  const specs = p.specs || {};
  const dims = p.wymiary_cm || {};
  return JSON.stringify([
    r.subtype ?? null,
    specs.power_w ?? null, specs.lumens ?? null, specs.cct_k ?? null, specs.beam_deg ?? null,
    dims.szerokosc ?? null, dims.glebokosc ?? null, dims.wysokosc ?? null,
    dims.srednica ?? null, dims.dlugosc ?? null,
    p.format_cm ?? null,
  ]);
}

const candidates = new Map(); // kandydacki group_id → [wiersze]
for (const r of rows) {
  const next = baseGroup(r.group_id);
  if (!next) continue;
  if (!candidates.has(next)) candidates.set(next, []);
  candidates.get(next).push(r);
}

const changed = [];
const groups = new Map(); // zaakceptowany group_id → nazwy
let blocked = 0;
for (const [next, items] of candidates) {
  // W obrębie kandydackiej grupy scalamy tylko podzbiory o identycznym odcisku parametrów.
  const byFp = new Map();
  for (const r of items) {
    const fp = fingerprint(r);
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push(r);
  }
  if (byFp.size > 1) blocked += items.length; // rózne parametry → to nie są warianty koloru
  let n = 0;
  for (const [fp, sub] of byFp) {
    if (sub.length < 2) continue; // pojedynczy produkt: nie ma czego scalać
    // Bez ŻADNEGO parametru nie mamy dowodu, że to ten sam model — a nazwy bywają identyczne
    // dla różnych produktów (35 paneli ORAC „PANEL 3D ŚCIENNY OD ORAC"). Nie scalamy w ciemno.
    // (podtyp to za mało — pomijamy go w teście: liczą się tylko realne specyfikacje i wymiary)
    if (JSON.parse(fp).slice(1).every((v) => v === null)) { blocked += sub.length; continue; }
    const gid = byFp.size === 1 ? next : `${next}-w${++n}`;
    groups.set(gid, sub.map((r) => r.name));
    for (const r of sub) if (r.group_id !== gid) changed.push({ id: r.id, name: r.name, from: r.group_id, to: gid });
  }
}
const multi = [...groups.entries()].filter(([, v]) => v.length > 1);
console.log(`Produkty w grze: ${rows.length} (pominięto kategorie: ${SKIP_CATEGORIES.join(', ')})`);
console.log(`Zmiana group_id: ${changed.length} produktów`);
console.log(`Grup wariantow po weryfikacji parametrow: ${multi.length} (obejmuja ${multi.reduce((a, [, v]) => a + v.length, 0)} produktow) | zablokowane przez rozne parametry: ${blocked}`);
console.log('\nPrzykłady scaleń:');
for (const [g, names] of multi.sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
  console.log(`  ${g} (${names.length}): ${names.slice(0, 3).map((n) => n.slice(0, 40)).join(' | ')}${names.length > 3 ? ' …' : ''}`);
}

if (!APPLY) {
  console.log('\nDRY-RUN — nic nie zapisano. Uruchom z APPLY=1.');
} else {
  for (const ch of changed) {
    await c.query('UPDATE products SET group_id = $1 WHERE id = $2::uuid', [ch.to, ch.id]);
  }
  console.log(`\nZapisano: ${changed.length} produktów.`);
}
await c.end();
