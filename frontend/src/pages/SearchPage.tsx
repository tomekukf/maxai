import { useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import ReactCrop, { type Crop, type PixelCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { searchByImage, detectItems, getCategories, type SearchResult, type DetectedItem } from '../lib/api';

// Mapowanie swobodnej etykiety detekcji (PL) na kanoniczną kategorię bazy.
const LABEL_CAT: [RegExp, string][] = [
  [/naroż|naroz/, 'naroznik'],
  [/sofa|kanap/, 'sofa'],
  [/fotel/, 'fotel'],
  [/krzes/, 'krzeslo'],
  [/stolik|ława|lawa|kawow/, 'stolik'],
  [/stół|stol\b|stoł/, 'stol'],
  [/łóż|loz|lóz/, 'lozko'],
  [/materac/, 'materac'],
  [/komod/, 'komoda'],
  [/szaf|nocn/, 'szafka'],
  [/lamp|żyrand|zyrand|kinkiet|plafon|oświet|oswiet|spot|oczk|żarów|reflektor|taśm|tasm/, 'oswietlenie'],
  [/wann|umywal|bateri|prysznic|kabin|brodzik|\bwc\b|bidet|toalet|grzejnik/, 'lazienka'],
  [/płytk|plytk|kafel/, 'plytki'],
  [/podłog|podlog|panel|deska/, 'podlogi'],
  [/tapet/, 'tapety'],
  [/dywan/, 'dywan'],
  [/drzwi/, 'drzwi'],
  [/lustr/, 'lustro'],
  [/sztukater|listw|rozet/, 'sztukateria'],
  [/regał|regal|witryn|mebl|komoda|szafk/, 'mebel'],
];
function labelToCategory(label: string): string | null {
  const s = label.toLowerCase();
  for (const [re, cat] of LABEL_CAT) if (re.test(s)) return cat;
  return null;
}
import { loadSession, isAdmin } from '../lib/auth';
import { useShortlist, toggleShortlist } from '../lib/shortlist';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const CAPTURE_WIDTH = 1000;
const DISPLAY_MAX = 720;

const btnPrimary =
  'rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50';
const navBtn = 'rounded border border-slate-300 px-2 py-1 disabled:opacity-40';

function cropToBase64(
  image: HTMLImageElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): string | null {
  if (sw < 4 || sh < 4) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
}

// Wyniki jednego wyszukiwania (jeden produkt). Kilka grup = kilka list obok siebie.
type SearchGroup = {
  key: string;
  label: string;
  hint?: string; // etykieta detekcji przekazana do /search (naprowadza opis na właściwy obiekt)
  b64: string;
  queryImg: string;
  queryCategory: string | null;
  queryAttrs: Record<string, unknown> | null;
  results: SearchResult[];
  busy: boolean;
  loadingMore: boolean;
  error: string | null;
};

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
const numBadge = (n: number) => CIRCLED[n - 1] ?? `(${n})`;

export default function SearchPage() {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [pageImg, setPageImg] = useState<string | null>(null);

  const [items, setItems] = useState<DetectedItem[]>([]);
  const [hiddenCount, setHiddenCount] = useState(0); // odfiltrowane (kategoria spoza bazy)
  const [dbCats, setDbCats] = useState<Set<string> | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [activeItem, setActiveItem] = useState<number | null>(null);

  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set()); // wykryte produkty zaznaczone do batcha
  const [groups, setGroups] = useState<SearchGroup[]>([]); // wyniki: 1 grupa = 1 produkt
  const [manualHint, setManualHint] = useState(''); // „czego szukasz?" dla ręcznego kadru
  // Tryb diagnostyczny — tylko dla zalogowanego admina (podgląd flow zapytania).
  const [admin] = useState(() => isAdmin(loadSession()));
  const [diag, setDiag] = useState(false);

  const [msg, setMsg] = useState<string | null>(null);

  const hiddenRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Kategorie obecne w bazie — do filtrowania podpowiedzi detekcji (nie proponuj czego nie mamy).
  useEffect(() => {
    getCategories().then((cs) => setDbCats(new Set(cs.map((c) => c.category)))).catch(() => {});
  }, []);

  function resetForNewImage() {
    setItems([]);
    setHiddenCount(0);
    setActiveItem(null);
    setCrop(undefined);
    setCompletedCrop(null);
    setSelected(new Set());
    setGroups([]);
    setManualHint('');
    setMsg(null);
  }

  function onPickFile(f: File | null) {
    setPageImg(null);
    setNumPages(0);
    setPageNum(1);
    resetForNewImage();
    if (!f) {
      setPdfFile(null);
      return;
    }
    const isPdf = f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
    if (isPdf) {
      setPdfFile(f);
    } else {
      setPdfFile(null);
      setPageImg(URL.createObjectURL(f));
    }
  }

  function captureCanvas() {
    const canvas = hiddenRef.current?.querySelector('canvas');
    if (canvas) setPageImg(canvas.toDataURL('image/png'));
  }

  async function runDetect() {
    const image = imgRef.current;
    if (!image) return;
    const full = cropToBase64(image, 0, 0, image.naturalWidth, image.naturalHeight);
    if (!full) return;
    setDetecting(true);
    setItems([]);
    setMsg(null);
    try {
      const its = await detectItems(full);
      // Zostaw tylko podpowiedzi z kategorii obecnych w bazie (nieznane mapowanie → zostawiamy).
      const visible = dbCats
        ? its.filter((it) => { const c = labelToCategory(it.label); return !c || dbCats.has(c); })
        : its;
      setItems(visible);
      setHiddenCount(its.length - visible.length);
      if (!visible.length) {
        setMsg(its.length
          ? 'Wykryte elementy są spoza naszego asortymentu — zaznacz produkt ręcznie.'
          : 'Model nie wykrył produktów — zaznacz produkt ręcznie.');
      }
    } catch (e) {
      setMsg(`Błąd detekcji: ${(e as Error).message}`);
    } finally {
      setDetecting(false);
    }
  }

  function onImgLoad() {
    runDetect();
  }

  // Zaznacz/odznacz wykryty produkt do wyszukiwania wsadowego.
  function toggleSelect(i: number) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });
  }

  // „Popraw kadr" — wczytaj ramkę wykrytego produktu do edytowalnego kadru (precyzyjny, pojedynczy przypadek).
  function loadIntoCrop(i: number) {
    const image = imgRef.current;
    if (!image) return;
    const b = items[i].box;
    const c: PixelCrop = { unit: 'px', x: b.x * image.width, y: b.y * image.height, width: b.w * image.width, height: b.h * image.height };
    setActiveItem(i);
    setManualHint(items[i].label); // podpowiedź prefill z etykiety detekcji
    setCrop(c);
    setCompletedCrop(c);
  }

  // Wycinek base64 z boxa znormalizowanego (0-1) — w rozdzielczości oryginału.
  function cropBox(image: HTMLImageElement, b: { x: number; y: number; w: number; h: number }): string | null {
    return cropToBase64(image, b.x * image.naturalWidth, b.y * image.naturalHeight, b.w * image.naturalWidth, b.h * image.naturalHeight);
  }

  // Batch: dla każdego zaznaczonego produktu osobne wyszukiwanie → osobna lista wyników.
  async function searchSelected() {
    const image = imgRef.current;
    if (!image || selected.size === 0) {
      setMsg('Zaznacz co najmniej jeden wykryty produkt.');
      return;
    }
    setMsg(null);
    const idxs = [...selected].sort((a, b) => a - b);
    const newGroups: SearchGroup[] = idxs.map((i, n) => {
      const b64 = cropBox(image, items[i].box);
      return {
        key: `d${i}`,
        label: `${numBadge(n + 1)} ${items[i].label}`,
        hint: items[i].label,
        b64: b64 ?? '',
        queryImg: b64 ? 'data:image/jpeg;base64,' + b64 : '',
        queryCategory: null, queryAttrs: null, results: [],
        busy: !!b64, loadingMore: false, error: b64 ? null : 'Wycinek za mały.',
      };
    });
    setGroups(newGroups);
    await Promise.all(newGroups.map((g, gi) => (g.b64 ? runGroupSearch(gi, g.b64, 3, g.hint) : Promise.resolve())));
  }

  // Ręczny kadr → pojedyncza grupa wyników.
  async function searchManualCrop() {
    const image = imgRef.current;
    if (!image || !completedCrop || completedCrop.width < 5 || completedCrop.height < 5) {
      setMsg('Zaznacz fragment ręcznie na obrazie.');
      return;
    }
    const scaleX = image.naturalWidth / image.width;
    const scaleY = image.naturalHeight / image.height;
    const b64 = cropToBase64(image, completedCrop.x * scaleX, completedCrop.y * scaleY, completedCrop.width * scaleX, completedCrop.height * scaleY);
    if (!b64) {
      setMsg('Zaznaczenie za małe.');
      return;
    }
    setMsg(null);
    const hint = manualHint.trim() || undefined;
    setGroups([{
      key: 'manual', label: hint ? `Ręczny wybór — ${hint}` : 'Ręczny wybór', hint, b64,
      queryImg: 'data:image/jpeg;base64,' + b64,
      queryCategory: null, queryAttrs: null, results: [], busy: true, loadingMore: false, error: null,
    }]);
    await runGroupSearch(0, b64, 3, hint);
  }

  async function runGroupSearch(gi: number, b64: string, k: number, hint?: string) {
    setGroups((gs) => gs.map((g, i) => (i === gi ? { ...g, busy: true, error: null } : g)));
    try {
      const res = await searchByImage(b64, k, hint);
      setGroups((gs) => gs.map((g, i) => (i === gi
        ? { ...g, results: res.results, queryAttrs: res.queryAttributes ?? null, queryCategory: res.queryCategory ?? null, busy: false, error: res.results.length ? null : 'Brak dobrego dopasowania w bazie.' }
        : g)));
    } catch (e) {
      setGroups((gs) => gs.map((g, i) => (i === gi ? { ...g, busy: false, error: (e as Error).message } : g)));
    }
  }

  async function loadMoreGroup(gi: number) {
    const g = groups[gi];
    if (!g || !g.b64) return;
    setGroups((gs) => gs.map((x, i) => (i === gi ? { ...x, loadingMore: true } : x)));
    try {
      const res = await searchByImage(g.b64, g.results.length + 3, g.hint);
      setGroups((gs) => gs.map((x, i) => (i === gi ? { ...x, results: res.results, loadingMore: false } : x)));
    } catch (e) {
      setGroups((gs) => gs.map((x, i) => (i === gi ? { ...x, loadingMore: false, error: (e as Error).message } : x)));
    }
  }

  const anyBusy = groups.some((g) => g.busy);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <main className="mx-auto max-w-4xl space-y-5 px-4 py-6">
        <div>
          <h2 className="text-lg font-semibold">Wyszukiwanie substytutów</h2>
          <p className="text-sm text-slate-500">
            Wgraj wizualizację (PDF) lub zdjęcie. Model podpowie wykryte meble — kliknij podpowiedź,
            popraw ramkę i szukaj. Możesz też zaznaczyć dowolny fragment ręcznie.
          </p>
        </div>

        <input
          type="file"
          accept="application/pdf,image/*"
          onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
          className="block text-sm"
        />

        {pdfFile && (
          <div ref={hiddenRef} style={{ position: 'absolute', left: -99999, top: 0 }} aria-hidden>
            <Document file={pdfFile} onLoadSuccess={({ numPages: n }) => setNumPages(n)}>
              <Page
                key={pageNum}
                pageNumber={pageNum}
                width={CAPTURE_WIDTH}
                renderTextLayer={false}
                renderAnnotationLayer={false}
                onRenderSuccess={captureCanvas}
              />
            </Document>
          </div>
        )}

        {numPages > 1 && pageImg && (
          <div className="flex items-center gap-2 text-sm">
            <button
              disabled={pageNum <= 1}
              onClick={() => {
                setPageImg(null);
                resetForNewImage();
                setPageNum((p) => p - 1);
              }}
              className={navBtn}
            >
              ‹ Poprzednia
            </button>
            <span>
              Strona {pageNum} / {numPages}
            </span>
            <button
              disabled={pageNum >= numPages}
              onClick={() => {
                setPageImg(null);
                resetForNewImage();
                setPageNum((p) => p + 1);
              }}
              className={navBtn}
            >
              Następna ›
            </button>
          </div>
        )}

        {pageImg && (
          <>
            {/* podpowiedzi wykrytych produktów — numerowane, wielokrotny wybór */}
            <div className="space-y-1">
              <div className="text-sm font-medium">
                Wykryte produkty {detecting && <span className="text-slate-400">(analizuję…)</span>}
                {hiddenCount > 0 && (
                  <span className="ml-1 font-normal text-slate-400">
                    ({hiddenCount} spoza asortymentu pominięto)
                  </span>
                )}
              </div>
              {items.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {items.map((it, i) => (
                    <span
                      key={i}
                      className={
                        'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs ' +
                        (selected.has(i) ? 'border-brand bg-brand text-white' : 'border-slate-300 hover:bg-slate-100') +
                        (activeItem === i ? ' ring-2 ring-accent' : '')
                      }
                    >
                      <button onClick={() => toggleSelect(i)} className="flex items-center gap-1" title="Zaznacz do wyszukania">
                        <span className="font-semibold">{numBadge(i + 1)}</span>
                        {it.label}
                      </button>
                      <button
                        onClick={() => loadIntoCrop(i)}
                        title="Wczytaj ramkę do ręcznej korekty"
                        className={'ml-1 rounded px-1 ' + (selected.has(i) ? 'text-white/80 hover:bg-white/20' : 'text-slate-400 hover:bg-slate-200')}
                      >
                        ✎
                      </button>
                    </span>
                  ))}
                  {items.length > 1 && (
                    <button
                      onClick={() => setSelected((s) => (s.size === items.length ? new Set() : new Set(items.map((_, i) => i))))}
                      className="text-xs text-blue-700 hover:underline"
                    >
                      {selected.size === items.length ? 'Odznacz wszystkie' : 'Zaznacz wszystkie'}
                    </button>
                  )}
                </div>
              )}
              <p className="text-xs text-slate-500">
                <b>Szybko:</b> zaznacz produkty na liście → „Szukaj zaznaczonych" (używa <b>automatycznych</b> ramek, kropkowanych na obrazie).
                <br />
                <b>Precyzyjnie:</b> narysuj/popraw ramkę myszą na obrazie (albo wczytaj ikoną ✎) → „Szukaj tego kadru".
                Kropkowane ramki to tylko podpowiedź — kadr rysujesz i przesuwasz swobodnie.
              </p>
            </div>

            {/* obraz z edytowalnym kadrem + nakładka numerowanych ramek */}
            <div className="relative inline-block border bg-white">
              <ReactCrop crop={crop} onChange={(c) => setCrop(c)} onComplete={(c) => setCompletedCrop(c)}>
                <img
                  ref={imgRef}
                  src={pageImg}
                  alt="wizualizacja"
                  onLoad={onImgLoad}
                  style={{ maxWidth: DISPLAY_MAX, display: 'block' }}
                />
              </ReactCrop>
              {/* Nakładka = tylko PODPOWIEDŹ (nieklikana, przerywana), żeby nie mylić z kadrem i nie blokować przeciągania. */}
              <div className="pointer-events-none absolute inset-0">
                {items.map((it, i) => (
                  <div
                    key={i}
                    className={'absolute border border-dashed ' + (selected.has(i) ? 'border-brand' : 'border-white/80')}
                    style={{ left: `${it.box.x * 100}%`, top: `${it.box.y * 100}%`, width: `${it.box.w * 100}%`, height: `${it.box.h * 100}%` }}
                  >
                    <span
                      className={
                        'absolute -left-0.5 -top-3 rounded px-1 text-[11px] font-bold shadow ' +
                        (selected.has(i) ? 'bg-brand text-white' : 'bg-white/90 text-slate-700')
                      }
                    >
                      {i + 1}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button onClick={searchSelected} disabled={anyBusy || selected.size === 0} className={btnPrimary}>
                {anyBusy ? 'Szukam…' : `Szukaj zaznaczonych${selected.size ? ` (${selected.size})` : ''}`}
              </button>
              <span className="flex items-center gap-2">
                <button onClick={searchManualCrop} disabled={anyBusy || !completedCrop} className={navBtn}>
                  Szukaj tego kadru
                </button>
                <input
                  value={manualHint}
                  onChange={(e) => setManualHint(e.target.value)}
                  placeholder="czego szukasz? (np. stolik kawowy)"
                  title="Podpowiedź: który obiekt w kadrze jest głównym — pomaga, gdy w tle są inne meble"
                  className="w-52 rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </span>
              {msg && <span className="text-sm text-red-700">{msg}</span>}
            </div>
          </>
        )}

        {/* Wyniki — osobna sekcja na każdy produkt */}
        {groups.length > 0 && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="font-medium">Wyniki dla {groups.length} {groups.length === 1 ? 'produktu' : 'produktów'}</h3>
              <button
                onClick={() => printSummary(groups)}
                disabled={anyBusy || !groups.some((g) => g.results.length)}
                className="text-xs text-blue-700 hover:underline disabled:opacity-40"
              >
                🖨️ Drukuj / zapisz PDF
              </button>
              {admin && (
                <button onClick={() => setDiag((d) => !d)} className="text-xs text-blue-700 hover:underline">
                  {diag ? 'Ukryj diagnostykę' : '🔬 Tryb diagnostyczny'}
                </button>
              )}
            </div>
            {groups.map((g, gi) => (
              <GroupSection
                key={g.key}
                g={g}
                admin={admin}
                diag={diag}
                onLoadMore={() => loadMoreGroup(gi)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// Sekcja wyników jednego produktu (nagłówek + miniatura zapytania + karty + „wczytaj kolejne").
function GroupSection({
  g, admin, diag, onLoadMore,
}: {
  g: SearchGroup; admin: boolean; diag: boolean; onLoadMore: () => void;
}) {
  const grouped = groupResults(g.results);
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3">
      <div className="flex items-center gap-3">
        {g.queryImg && <img src={g.queryImg} alt="" className="h-12 w-12 rounded border bg-white object-contain" />}
        <div>
          <div className="text-sm font-medium">{g.label}</div>
          <div className="text-xs text-slate-500">
            {g.busy ? 'Szukam…' : g.queryCategory ? `kategoria: ${g.queryCategory} · ${grouped.length} propozycji` : `${grouped.length} propozycji`}
          </div>
        </div>
      </div>

      {g.error && <div className="text-sm text-red-700">{g.error}</div>}
      {admin && diag && !g.busy && g.results.length > 0 && (
        <DiagPanel queryImg={g.queryImg || null} category={g.queryCategory} attrs={g.queryAttrs} results={g.results} />
      )}

      {grouped.length > 0 && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {grouped.map((gr, i) => (
              <ResultCard key={i} r={gr.rep} rank={i + 1} queryAttrs={g.queryAttrs} variants={gr.variants} />
            ))}
          </div>
          <div className="pt-1">
            <button onClick={onLoadMore} disabled={g.loadingMore} className={navBtn}>
              {g.loadingMore ? 'Wczytuję…' : 'Wczytaj kolejne'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

type Grouped = { rep: SearchResult; variants: SearchResult[] };

// Zwijanie wariantów tego samego produktu (group_id) w jedną kartę; reprezentant = najlepszy wynik.
function groupResults(results: SearchResult[]): Grouped[] {
  const map = new Map<string, Grouped>();
  const order: string[] = [];
  for (const r of results) {
    const key = r.groupId || r.id || r.optimaId || r.name;
    const g = map.get(key);
    if (g) g.variants.push(r);
    else {
      map.set(key, { rep: r, variants: [r] });
      order.push(key);
    }
  }
  return order.map((k) => map.get(k) as Grouped);
}

// Podsumowanie wyszukiwania do druku/PDF — nowe okno z samodzielnym HTML (zdjęcia jako <img>,
// bez CORS/canvas), auto-print po załadowaniu obrazów. „Zapisz jako PDF" w oknie druku przeglądarki.
function printSummary(groups: SearchGroup[]) {
  const w = window.open('', '_blank');
  if (!w) {
    alert('Przeglądarka zablokowała okno druku — zezwól na wyskakujące okna dla tej strony.');
    return;
  }
  const esc = (s: unknown) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  const sections = groups
    .filter((g) => g.results.length)
    .map((g) => {
      const cards = groupResults(g.results)
        .map((gr, i) => {
          const r = gr.rep;
          const code = r.optimaId ?? (r.params?.sku as string | undefined) ?? (r.params?.codes as string[] | undefined)?.[0] ?? '';
          const page = (r.params?.printed_page as number | undefined) ?? r.catalogPage;
          const katalog = r.catalogName ? `${r.catalogName}${page != null ? `, str. ${page}` : ''}` : '';
          return `<div class="card">
            <img src="${esc(r.imageUrl)}" />
            <div class="pct">${(r.similarity * 100).toFixed(0)}%</div>
            <div class="name">#${i + 1} ${esc(r.name)}</div>
            ${code ? `<div class="code">${esc(code)}</div>` : ''}
            ${r.manufacturer ? `<div class="mfr">${esc(r.manufacturer)}</div>` : ''}
            ${katalog ? `<div class="cat">${esc(katalog)}</div>` : ''}
          </div>`;
        })
        .join('');
      return `<section>
        <h2>${g.queryImg ? `<img class="q" src="${esc(g.queryImg)}" />` : ''}<span>${esc(g.label)}${g.queryCategory ? ` · ${esc(g.queryCategory)}` : ''}</span></h2>
        <div class="grid">${cards}</div>
      </section>`;
    })
    .join('');
  const html = `<!doctype html><html lang="pl"><head><meta charset="utf-8" />
<title>maxai — propozycje produktów</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Jost, system-ui, sans-serif; color: #1e293b; margin: 24px; }
  header { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 2px solid #760039; padding-bottom: 8px; margin-bottom: 16px; }
  h1 { color: #760039; font-size: 20px; margin: 0; }
  .date { color: #64748b; font-size: 12px; }
  section { margin-bottom: 20px; page-break-inside: avoid; }
  h2 { font-size: 14px; display: flex; align-items: center; gap: 8px; background: #f1f5f9; padding: 6px 8px; border-radius: 6px; }
  h2 .q { height: 32px; width: 32px; object-fit: contain; background: #fff; border: 1px solid #e2e8f0; border-radius: 4px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 8px; }
  .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px; position: relative; page-break-inside: avoid; }
  .card img { width: 100%; height: 130px; object-fit: contain; background: #f8fafc; border-radius: 4px; }
  .pct { position: absolute; top: 12px; left: 12px; background: #108474; color: #fff; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 999px; }
  .name { font-size: 12px; font-weight: 600; margin-top: 6px; }
  .code { font-family: monospace; font-size: 11px; background: #f1f5f9; display: inline-block; padding: 1px 4px; border-radius: 3px; margin-top: 2px; }
  .mfr, .cat { font-size: 11px; color: #475569; margin-top: 2px; }
  @media print { body { margin: 12mm; } a { text-decoration: none; } }
</style></head>
<body>
  <header><h1>maxai — propozycje produktów</h1><div class="date">${esc(new Date().toLocaleString('pl-PL'))}</div></header>
  ${sections || '<p>Brak wyników do podsumowania.</p>'}
  <script>
    window.addEventListener('load', function () {
      var imgs = Array.prototype.slice.call(document.images);
      Promise.all(imgs.map(function (im) { return im.complete ? 1 : new Promise(function (r) { im.onload = im.onerror = r; }); }))
        .then(function () { setTimeout(function () { window.print(); }, 150); });
    });
  <\/script>
</body></html>`;
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function DiagPanel({
  queryImg,
  category,
  attrs,
  results,
}: {
  queryImg: string | null;
  category: string | null;
  attrs: Record<string, unknown> | null;
  results: SearchResult[];
}) {
  const a = attrs ?? {};
  const key = (k: string) => (a[k] != null && a[k] !== '' ? (Array.isArray(a[k]) ? (a[k] as unknown[]).join(', ') : String(a[k])) : '—');
  return (
    <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs">
      <div className="font-medium text-amber-800">🔬 Diagnostyka wyszukiwania (widoczne tylko dla admina)</div>

      <div className="flex flex-wrap gap-4">
        <div>
          <div className="mb-1 text-slate-500">Obraz zapytania (wysłany do modelu):</div>
          {queryImg ? (
            <img src={queryImg} alt="wycinek zapytania" className="max-h-40 rounded border bg-white object-contain" />
          ) : (
            <div className="text-slate-400">—</div>
          )}
        </div>
        <div className="min-w-[240px] flex-1">
          <div className="mb-1 text-slate-500">
            Bramka kategorii: <span className="font-medium text-slate-800">{category ?? '— (brak, bez filtra)'}</span>
          </div>
          <div className="text-slate-500">Jak LLM (Sonnet) opisał wycinek:</div>
          <dl className="grid grid-cols-2 gap-x-3">
            {['kategoria', 'subtype', 'typ', 'kolor_dominujacy', 'material', 'styl', 'ksztalt_ogolny'].map((k) => (
              <div key={k} className="flex justify-between border-b border-amber-200/60 py-0.5">
                <dt className="text-slate-500">{k}</dt>
                <dd className="ml-2 truncate font-medium">{key(k)}</dd>
              </div>
            ))}
          </dl>
          {a['opis_swobodny'] ? <div className="mt-1 italic text-slate-600">„{String(a['opis_swobodny'])}"</div> : null}
        </div>
      </div>

      <div>
        <div className="mb-1 text-slate-500">Co wpłynęło na wynik (per kandydat):</div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-slate-400">
                <th className="text-left font-normal">#</th>
                <th className="text-left font-normal">produkt</th>
                <th className="text-left font-normal">rerank</th>
                <th className="text-left font-normal">kosinus (Titan)</th>
                <th className="text-left font-normal">powód (sędzia)</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i} className="border-t border-amber-200/60 align-top">
                  <td className="pr-2">{i + 1}</td>
                  <td className="pr-2">{r.name} <span className="text-slate-400">{(r.params?.codes as string[] | undefined)?.[0] ?? ''}</span></td>
                  <td className="pr-2 font-medium">{r.rerankScore != null ? `${r.rerankScore}%` : '—'}</td>
                  <td className="pr-2">{r.visualSimilarity != null ? `${(r.visualSimilarity * 100).toFixed(0)}%` : '—'}</td>
                  <td className="text-slate-600">{r.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details className="mt-2">
          <summary className="cursor-pointer text-slate-500">Pełny opis wycinka (JSON)</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-white p-2">{JSON.stringify(attrs, null, 2)}</pre>
        </details>
      </div>
    </div>
  );
}

function variantCode(x: SearchResult): string {
  return (x.params?.codes as string[] | undefined)?.[0] ?? x.optimaId ?? '';
}

function ResultCard({
  r,
  rank,
  queryAttrs,
  variants = [],
}: {
  r: SearchResult;
  rank: number;
  queryAttrs: Record<string, unknown> | null;
  variants?: SearchResult[];
}) {
  const [copied, setCopied] = useState(false);
  const [skuCopied, setSkuCopied] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const shortlist = useShortlist();
  const sid = r.id ?? r.optimaId ?? r.name;
  const inShortlist = shortlist.some((x) => x.id === sid);
  const code = r.optimaId ?? (r.params?.sku as string | undefined) ?? (r.params?.codes as string[] | undefined)?.[0] ?? null;
  return (
    <div className="overflow-hidden rounded-xl border bg-white shadow-card transition hover:shadow-md">
      <div className="aspect-square overflow-hidden bg-slate-100">
        <img src={r.imageUrl} alt={r.name} className="h-full w-full object-cover transition duration-300 hover:scale-[1.03]" />
      </div>
      <div className="p-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="rounded-full bg-accent/10 px-2 py-0.5 font-medium text-accent-dark">{(r.similarity * 100).toFixed(0)}%</span>
        <span className="text-slate-400">#{rank}</span>
      </div>
      <div className="mt-1 line-clamp-2 text-sm font-medium">{r.name}</div>

      {r.optimaId && (
        <div className="mt-2 flex items-center gap-2">
          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{r.optimaId}</code>
          <button
            onClick={() => {
              navigator.clipboard.writeText(r.optimaId!);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="text-xs text-blue-700 hover:underline"
          >
            {copied ? 'skopiowano ✓' : 'kopiuj ID'}
          </button>
        </div>
      )}

      {variants.length > 1 && (
        <div className="mt-1 text-xs text-slate-600">
          Warianty ({variants.length}):{' '}
          {variants.map((v) => (
            <code key={v.id ?? variantCode(v)} className="mr-1 rounded bg-slate-100 px-1">{variantCode(v)}</code>
          ))}
        </div>
      )}

      {(r.source === 'catalog' || r.source === 'web') && (
        <div className="mt-2 space-y-0.5 text-xs text-slate-600">
          {r.manufacturer && <div className="font-medium">{r.manufacturer}</div>}
          {r.params?.sku != null && r.params.sku !== '' && (
            <div className="flex items-center gap-2">
              <span>SKU: <code className="rounded bg-slate-100 px-1">{String(r.params.sku)}</code></span>
              <button
                onClick={() => { navigator.clipboard.writeText(String(r.params!.sku)); setSkuCopied(true); setTimeout(() => setSkuCopied(false), 1200); }}
                className="text-blue-700 hover:underline"
              >
                {skuCopied ? 'skopiowano ✓' : 'kopiuj SKU'}
              </button>
            </div>
          )}
          {r.source === 'web' && r.params?.product_url != null && (
            <a href={String(r.params.product_url)} target="maxfliz" rel="noreferrer" className="text-blue-700 hover:underline">
              🔗 Zobacz na maxfliz ↗
            </a>
          )}
          {r.source === 'catalog' && (r.catalogPageImageUrl || r.catalogUrl) && (
            <div className="flex flex-wrap gap-2">
              <a href={r.catalogPageImageUrl ?? r.catalogUrl} target="maxai-katalog" rel="noreferrer" className="text-blue-700 hover:underline">
                📄 {r.catalogName ?? 'Katalog'}
                {r.params?.printed_page != null ? `, str. ${r.params.printed_page}` : r.catalogPage ? `, str. ${r.catalogPage}` : ''} ↗
              </a>
              {r.catalogUrl && (
                <a href={r.catalogPage ? `${r.catalogUrl}#page=${r.catalogPage}` : r.catalogUrl} target="_blank" rel="noreferrer" className="text-slate-400 hover:underline">
                  (cały PDF)
                </a>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={() => toggleShortlist({ id: sid, name: r.name, code, source: r.source, manufacturer: r.manufacturer, imageUrl: r.imageUrl })}
          className={inShortlist ? 'text-xs font-medium text-accent-dark' : 'text-xs text-slate-500 hover:text-brand'}
        >
          {inShortlist ? '★ W schowku' : '☆ Do schowka'}
        </button>
        <button onClick={() => setShowWhy((s) => !s)} className="text-xs text-blue-700 hover:underline">
          {showWhy ? 'Ukryj' : 'Dlaczego podobne?'}
        </button>
      </div>
      {showWhy && <WhyPanel r={r} queryAttrs={queryAttrs} />}
      </div>
    </div>
  );
}

function pick(o: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  if (!o) return null;
  for (const k of keys) {
    const v = o[k];
    if (v != null && v !== '') return Array.isArray(v) ? v.join(', ') : String(v);
  }
  return null;
}

function WhyPanel({ r, queryAttrs }: { r: SearchResult; queryAttrs: Record<string, unknown> | null }) {
  const cand = { ...(r.params ?? {}), ...(r.attributes ?? {}) } as Record<string, unknown>;
  const rows: { label: string; q: string | null; c: string | null }[] = [
    { label: 'Kategoria', q: pick(queryAttrs, 'kategoria'), c: r.category ?? null },
    { label: 'Podtyp', q: pick(queryAttrs, 'subtype'), c: pick(cand, 'subtype') },
    { label: 'Materiał', q: pick(queryAttrs, 'material'), c: pick(cand, 'material', 'finish') },
    { label: 'Kolor', q: pick(queryAttrs, 'kolor_dominujacy'), c: pick(cand, 'kolor_dominujacy', 'finish') },
    { label: 'Styl', q: pick(queryAttrs, 'styl'), c: pick(cand, 'styl') },
  ];
  const same = (a: string | null, b: string | null) =>
    !!a && !!b && (a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase()));
  return (
    <div className="mt-2 space-y-1 rounded bg-slate-50 p-2 text-xs">
      <div className="flex gap-3">
        <span>
          Dopasowanie (rerank):{' '}
          <b>{r.rerankScore != null ? `${r.rerankScore}%` : '—'}</b>
        </span>
        <span>
          Wizualne (cosinus):{' '}
          <b>{r.visualSimilarity != null ? `${(r.visualSimilarity * 100).toFixed(0)}%` : '—'}</b>
        </span>
      </div>
      {r.reason && <div className="italic text-slate-600">„{r.reason}"</div>}
      <table className="w-full">
        <thead>
          <tr className="text-slate-400">
            <th className="text-left font-normal">cecha</th>
            <th className="text-left font-normal">zapytanie</th>
            <th className="text-left font-normal">kandydat</th>
          </tr>
        </thead>
        <tbody>
          {rows
            .filter((x) => x.q || x.c)
            .map((x) => (
              <tr key={x.label} className={same(x.q, x.c) ? 'text-green-700' : ''}>
                <td className="pr-2 text-slate-500">{x.label}</td>
                <td className="pr-2">{x.q ?? '—'}</td>
                <td>{x.c ?? '—'}</td>
              </tr>
            ))}
        </tbody>
      </table>
      <div className="text-[10px] text-slate-400">
        Zielony = zgodność zapytania i kandydata. Dla katalogów bez opisu wizualnego część cech pochodzi z
        parametrów technicznych (materiał/wykończenie).
      </div>
    </div>
  );
}
