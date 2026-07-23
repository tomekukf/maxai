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

// Miniatura wycinka (do panelu podpowiedzi) — pełny data URL, przeskalowana do `max` px.
function thumbFromNatural(
  image: HTMLImageElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  max = 200,
): string | null {
  if (sw < 4 || sh < 4) return null;
  const scale = Math.min(1, max / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
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
  queryContext?: Record<string, unknown> | null; // odczytane z dołączonego rysunku/spec (F2a)
  mode?: 'quality' | 'fast';
  recallK?: number; // ilu kandydatów widział sędzia (do diagnostyki)
  results: SearchResult[];
  busy: boolean;
  loadingMore: boolean;
  error: string | null;
};

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
const numBadge = (n: number) => CIRCLED[n - 1] ?? `(${n})`;

// Plik (rysunek/spec) → base64 JPEG (białe tło pod ew. przezroczystość rysunków).
async function fileToJpegB64(file: File, maxSize = 1400): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.9).split(',')[1];
}

// Czytelny odczyt kontekstu z rysunku (do pokazania użytkownikowi — weryfikacja/anti-halucynacja).
function contextSummary(ctx: Record<string, unknown> | null | undefined): string | null {
  if (!ctx) return null;
  const bits: string[] = [];
  const add = (label: string, v: unknown) => { if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) bits.push(`${label}: ${Array.isArray(v) ? v.join(', ') : v}`); };
  add('typ', ctx.typ); add('kształt', ctx.ksztalt); add('materiał', ctx.material);
  const dim = ctx.wymiary_cm as Record<string, unknown> | undefined;
  if (dim && typeof dim === 'object') {
    const d = ['szerokosc', 'glebokosc', 'wysokosc', 'srednica', 'dlugosc'].map((k) => dim[k]).filter((x) => x != null);
    if (d.length) add('wymiary(cm)', Object.entries(dim).filter(([, v]) => v != null).map(([k, v]) => `${k}:${v}`).join(' '));
  }
  add('cechy', ctx.cechy);
  return bits.length ? bits.join(' · ') : null;
}

export default function SearchPage({ admin: adminProp }: { admin?: boolean } = {}) {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [pageImg, setPageImg] = useState<string | null>(null);

  const [items, setItems] = useState<DetectedItem[]>([]);
  const [thumbs, setThumbs] = useState<string[]>([]); // miniatury wykrytych produktów (panel po prawej)
  const [hiddenCount, setHiddenCount] = useState(0); // odfiltrowane (kategoria spoza bazy)
  const [dbCats, setDbCats] = useState<Set<string> | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [activeItem, setActiveItem] = useState<number | null>(null);

  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set()); // wykryte produkty zaznaczone do batcha
  const [cropByItem, setCropByItem] = useState<Map<number, PixelCrop>>(new Map()); // zapamiętany (przesunięty) kadr per produkt
  const [groups, setGroups] = useState<SearchGroup[]>([]); // wyniki: 1 grupa = 1 produkt
  const [manualHint, setManualHint] = useState(''); // „czego szukasz?" dla ręcznego kadru
  const [contextB64, setContextB64] = useState<string | null>(null); // rysunek techniczny/spec (F2a)
  const [contextName, setContextName] = useState<string | null>(null);
  const [fastMode, setFastMode] = useState(false); // tryb „szybki" (sam cosinus, bez Sonnet) — admin/testy
  const [recallK, setRecallK] = useState(8); // ilu kandydatów widzi sędzia (debug „czemu nie ma produktu X")
  // Narzędzia admina (tryb szybki, diagnostyka) — rola z propa z App, fallback na sesję z localStorage.
  const [adminFromSession] = useState(() => isAdmin(loadSession()));
  const admin = adminProp ?? adminFromSession;
  const [diag, setDiag] = useState(false);

  const [msg, setMsg] = useState<string | null>(null);

  const hiddenRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Kategorie obecne w bazie — do filtrowania podpowiedzi detekcji (nie proponuj czego nie mamy).
  useEffect(() => {
    getCategories().then((cs) => setDbCats(new Set(cs.map((c) => c.category)))).catch(() => {});
  }, []);

  // Miniatury podpowiedzi — liczone lokalnie z wgranego obrazu (bez kosztów, bez sieci).
  useEffect(() => {
    const image = imgRef.current;
    if (!image || !items.length) {
      setThumbs([]);
      return;
    }
    const nw = image.naturalWidth;
    const nh = image.naturalHeight;
    setThumbs(items.map((it) => thumbFromNatural(image, it.box.x * nw, it.box.y * nh, it.box.w * nw, it.box.h * nh) ?? ''));
  }, [items]);

  function resetForNewImage() {
    setItems([]);
    setThumbs([]);
    setHiddenCount(0);
    setActiveItem(null);
    setCrop(undefined);
    setCompletedCrop(null);
    setSelected(new Set());
    setCropByItem(new Map());
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

  // Klik w produkt: zaznacz do wyszukania ORAZ wczytaj jego proponowaną ramkę jako ruchomy kadr
  // (jeden, przesuwalny obszar — bez „dwóch zaznaczeń"). Ponowny klik odznacza i czyści kadr.
  function toggleSelect(i: number) {
    if (selected.has(i)) {
      setSelected((s) => {
        const n = new Set(s);
        n.delete(i);
        return n;
      });
      if (activeItem === i) clearCrop();
    } else {
      setSelected((s) => new Set(s).add(i));
      loadIntoCrop(i);
    }
  }

  // Wczytaj ramkę produktu do ruchomego kadru: jeśli był już PRZESUNIĘTY, użyj zapamiętanego; inaczej box z detekcji.
  function loadIntoCrop(i: number) {
    const image = imgRef.current;
    if (!image) return;
    const b = items[i].box;
    const saved = cropByItem.get(i);
    const c: PixelCrop = saved ?? { unit: 'px', x: b.x * image.width, y: b.y * image.height, width: b.w * image.width, height: b.h * image.height };
    setActiveItem(i);
    setManualHint(items[i].label); // podpowiedź prefill z etykiety detekcji
    setCrop(c);
    setCompletedCrop(c);
  }

  // Zakończenie edycji kadru → zapamiętaj dla aktywnego produktu (żeby przesunięcie przetrwało odznaczenie/przełączenie).
  function onCropComplete(c: PixelCrop) {
    setCompletedCrop(c);
    if (activeItem != null && c.width >= 5 && c.height >= 5) {
      setCropByItem((m) => new Map(m).set(activeItem, c));
      // Miniatura w panelu ma pokazywać to, co realnie pójdzie do analizy (poprawiony kadr).
      const image = imgRef.current;
      if (image) {
        const sx = image.naturalWidth / image.width;
        const sy = image.naturalHeight / image.height;
        const t = thumbFromNatural(image, c.x * sx, c.y * sy, c.width * sx, c.height * sy);
        if (t) setThumbs((ts) => ts.map((old, i) => (i === activeItem ? t : old)));
      }
    }
  }

  function clearCrop() {
    setActiveItem(null);
    setCrop(undefined);
    setCompletedCrop(null);
    setManualHint('');
  }

  function clearSelection() {
    setSelected(new Set());
    clearCrop();
  }

  // F2a: dołączenie/zdjęcie rysunku technicznego/spec (dodatkowy kontekst dla wyszukiwania).
  async function onPickContext(f: File | null) {
    if (!f) { setContextB64(null); setContextName(null); return; }
    try {
      setContextB64(await fileToJpegB64(f));
      setContextName(f.name);
    } catch {
      setMsg('Nie mogę odczytać rysunku (obsługiwane: obraz JPG/PNG).');
    }
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
    const sx = image.naturalWidth / image.width;
    const sy = image.naturalHeight / image.height;
    const newGroups: SearchGroup[] = idxs.map((i, n) => {
      // Zapamiętany (przesunięty) kadr produktu, a jeśli go nie ruszano — automatyczna ramka detekcji.
      const saved = cropByItem.get(i);
      const b64 = saved
        ? cropToBase64(image, saved.x * sx, saved.y * sy, saved.width * sx, saved.height * sy)
        : cropBox(image, items[i].box);
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
      const res = await searchByImage(b64, k, hint, contextB64 ?? undefined, fastMode, recallK);
      setGroups((gs) => gs.map((g, i) => (i === gi
        ? { ...g, results: res.results, queryAttrs: res.queryAttributes ?? null, queryCategory: res.queryCategory ?? null, queryContext: res.queryContext ?? null, mode: res.mode, recallK, busy: false, error: res.results.length ? null : 'Brak dobrego dopasowania w bazie.' }
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
      const res = await searchByImage(g.b64, g.results.length + 3, g.hint, contextB64 ?? undefined, fastMode, recallK);
      setGroups((gs) => gs.map((x, i) => (i === gi ? { ...x, results: res.results, loadingMore: false } : x)));
    } catch (e) {
      setGroups((gs) => gs.map((x, i) => (i === gi ? { ...x, loadingMore: false, error: (e as Error).message } : x)));
    }
  }

  const anyBusy = groups.some((g) => g.busy);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <main className="mx-auto max-w-6xl space-y-5 px-4 py-6">
        <div>
          <h2 className="text-lg font-semibold">Wyszukiwanie substytutów</h2>
          <p className="text-sm text-slate-500">
            Wgraj wizualizację (PDF) lub zdjęcie — analiza rusza automatycznie. Po prawej zaznacz
            checkboxami, które wykryte produkty wysłać do wyszukania. Możesz też zaznaczyć dowolny
            fragment ręcznie na obrazie.
          </p>
        </div>

        {/* Pasek narzędzi admina — widoczny od razu (nie chowa się za uploadem). */}
        {admin && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2 text-xs">
            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-500">admin</span>
            <label
              className="flex cursor-pointer items-center gap-1.5 text-slate-700"
              title="Szybki: ranking po samym kosinusie Titana, bez wizyjnego reranku Sonnet (~darmowy, do porównań). Jakość: pełny rerank."
            >
              <input type="checkbox" checked={fastMode} onChange={(e) => setFastMode(e.target.checked)} className="h-4 w-4 accent-brand" />
              ⚡ Tryb szybki (bez rerankingu Sonnet)
            </label>
            <span className="text-slate-400">
              {fastMode ? 'ranking = kosinus Titana, 0 kosztu Bedrock (poza embeddingiem)' : 'ranking = pełny rerank Sonnet (domyślny, płatny)'}
            </span>
            <label
              className="flex items-center gap-1 text-slate-700"
              title="Ilu kandydatów z retrieve trafia do oceny sędziego. Więcej = większa szansa, że produkt spoza ścisłej czołówki kosinusa w ogóle zostanie oceniony, ale i wyższy koszt Sonnet."
            >
              kandydatów do oceny
              <input
                type="number"
                min={3}
                max={60}
                value={recallK}
                onChange={(e) => setRecallK(Math.max(3, Math.min(60, Number(e.target.value) || 8)))}
                className="w-14 rounded border border-slate-300 px-1 py-0.5"
              />
              {recallK > 12 && !fastMode && <span className="text-amber-700">(drożej)</span>}
            </label>
          </div>
        )}

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
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
            {/* LEWA KOLUMNA: obraz z edytowalnym kadrem + nakładka numerowanych ramek */}
            <div className="space-y-2">
              <div className="relative inline-block border bg-white">
                <ReactCrop crop={crop} onChange={(c) => setCrop(c)} onComplete={(c) => onCropComplete(c)}>
                  <img
                    ref={imgRef}
                    src={pageImg}
                    alt="wizualizacja"
                    onLoad={onImgLoad}
                    style={{ maxWidth: DISPLAY_MAX, display: 'block' }}
                  />
                </ReactCrop>
                {/* Nakładka = tylko PODPOWIEDŹ (nieklikana, przerywana). Aktywny produkt pokazujemy jako ruchomy kadr, nie tu. */}
                <div className="pointer-events-none absolute inset-0">
                  {items.map((it, i) =>
                    i === activeItem ? null : (
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
                    ),
                  )}
                </div>
              </div>

              {/* Ręczny kadr — gdy detekcja czegoś nie złapała lub trzeba czegoś innego */}
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={searchManualCrop} disabled={anyBusy || !completedCrop} className={navBtn + ' text-xs'}>
                  Szukaj tego kadru
                </button>
                <input
                  value={manualHint}
                  onChange={(e) => setManualHint(e.target.value)}
                  placeholder="czego szukasz? (np. stolik kawowy)"
                  title="Podpowiedź: który obiekt w kadrze jest głównym — pomaga, gdy w tle są inne meble"
                  className="w-52 rounded border border-slate-300 px-2 py-1 text-xs"
                />
                <label className="flex cursor-pointer items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100" title="Dołącz rysunek techniczny / kartę katalogową — doprecyzuje typ/kształt/wymiary (opcjonalnie)">
                  📎 <input type="file" accept="image/*" onChange={(e) => onPickContext(e.target.files?.[0] ?? null)} className="hidden" />
                  {contextName ? `rysunek: ${contextName.slice(0, 18)}` : 'Dołącz rysunek/spec'}
                </label>
                {contextB64 && <button onClick={() => onPickContext(null)} className="text-xs text-red-600 hover:underline">usuń</button>}
              </div>
              {msg && <div className="text-sm text-red-700">{msg}</div>}
            </div>

            {/* PRAWA KOLUMNA: podpowiadaczka — co wykryto i co wysłać do analizy */}
            <aside className="rounded-lg border border-slate-200 bg-white p-3 lg:sticky lg:top-4">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">Wykryte produkty</h3>
                <button
                  onClick={runDetect}
                  disabled={detecting}
                  className="text-xs text-blue-700 hover:underline disabled:opacity-40"
                  title="Przeanalizuj obraz jeszcze raz"
                >
                  {detecting ? 'analizuję…' : '↻ analizuj'}
                </button>
              </div>
              <p className="mt-0.5 text-xs text-slate-500">
                Zaznacz, które produkty wysłać do wyszukania substytutów.
              </p>

              {detecting && items.length === 0 && (
                <div className="mt-3 space-y-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="flex animate-pulse items-center gap-2">
                      <div className="h-12 w-12 rounded bg-slate-100" />
                      <div className="h-3 w-32 rounded bg-slate-100" />
                    </div>
                  ))}
                </div>
              )}

              {!detecting && items.length === 0 && (
                <div className="mt-3 text-xs text-slate-500">
                  Nic nie wykryto — zaznacz produkt ręcznie na obrazie i użyj „Szukaj tego kadru".
                </div>
              )}

              {items.length > 0 && (
                <ul className="mt-3 max-h-[28rem] space-y-1 overflow-y-auto pr-1">
                  {items.map((it, i) => (
                    <li key={i}>
                      <label
                        className={
                          'flex cursor-pointer items-center gap-2 rounded border p-1.5 ' +
                          (selected.has(i) ? 'border-brand bg-brand/5' : 'border-transparent hover:bg-slate-50')
                        }
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(i)}
                          onChange={() => toggleSelect(i)}
                          className="h-4 w-4 shrink-0 accent-brand"
                          title="Wyślij ten produkt do analizy"
                        />
                        {thumbs[i] ? (
                          <img src={thumbs[i]} alt="" className="h-12 w-12 shrink-0 rounded border bg-white object-contain" />
                        ) : (
                          <div className="h-12 w-12 shrink-0 rounded bg-slate-100" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">
                            <span className="font-semibold">{numBadge(i + 1)}</span> {it.label}
                          </span>
                          <button
                            onClick={(e) => { e.preventDefault(); loadIntoCrop(i); }}
                            className="text-[11px] text-blue-700 hover:underline"
                            title="Wczytaj ramkę tego produktu jako ruchomy kadr — możesz ją poprawić myszą"
                          >
                            popraw kadr
                          </button>
                          {activeItem === i && <span className="ml-1 text-[11px] text-slate-400">(edytujesz)</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}

              {items.length > 1 && (
                <button
                  onClick={() => (selected.size ? clearSelection() : setSelected(new Set(items.map((_, i) => i))))}
                  className="mt-2 text-xs text-blue-700 hover:underline"
                >
                  {selected.size ? 'Odznacz wszystkie' : 'Zaznacz wszystkie'}
                </button>
              )}

              {hiddenCount > 0 && (
                <div className="mt-2 text-[11px] text-slate-400">{hiddenCount} spoza asortymentu pominięto</div>
              )}

              <button
                onClick={searchSelected}
                disabled={anyBusy || selected.size === 0}
                className={btnPrimary + ' mt-3 w-full'}
              >
                {anyBusy ? 'Szukam…' : `Szukaj zaznaczonych${selected.size ? ` (${selected.size})` : ''}`}
              </button>

              {admin && fastMode && (
                <div className="mt-2 text-center text-[11px] text-slate-500">⚡ tryb szybki włączony (bez Sonneta)</div>
              )}
            </aside>
          </div>
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
                <>
                  <button onClick={() => setDiag((d) => !d)} className="text-xs text-blue-700 hover:underline">
                    {diag ? 'Ukryj diagnostykę' : '🔬 Tryb diagnostyczny'}
                  </button>
                  <button
                    onClick={() => exportDiag(groups)}
                    disabled={anyBusy || !groups.some((g) => g.results.length)}
                    className="text-xs text-blue-700 hover:underline disabled:opacity-40"
                    title="Zapisz plik JSON ze wszystkim, co potrzebne do debugu rankingu (obraz zapytania, opis, kosinus, sygnały miękkie, oceny sędziego)"
                  >
                    ⬇ Eksport diagnostyki (JSON)
                  </button>
                  <button
                    onClick={() => copyDiag(groups)}
                    disabled={anyBusy || !groups.some((g) => g.results.length)}
                    className="text-xs text-blue-700 hover:underline disabled:opacity-40"
                    title="Skopiuj zwięzłe podsumowanie tekstowe (bez obrazów) — do wklejenia w zgłoszeniu"
                  >
                    📋 Kopiuj podsumowanie
                  </button>
                </>
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
            {g.mode === 'fast' && <span className="ml-1 rounded bg-slate-200 px-1 text-[10px] text-slate-600">tryb szybki (cosinus)</span>}
          </div>
        </div>
      </div>

      {contextSummary(g.queryContext) && (
        <div className="rounded border border-accent/40 bg-accent/5 px-2 py-1 text-xs text-slate-600">
          📎 Z rysunku/spec odczytano: <span className="text-slate-800">{contextSummary(g.queryContext)}</span>
          <span className="ml-1 text-slate-400">(sygnał pomocniczy; wymiary orientacyjnie)</span>
        </div>
      )}
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

// --- Eksport diagnostyki (admin) -------------------------------------------
// Cel: zebrać w jednym pliku wszystko, co potrzebne do debugu rankingu — obraz zapytania,
// co model z niego zrozumiał, bramkę kategorii, tryb oraz per kandydat: kosinus, sygnały
// miękkie, ocenę sędziego i uzasadnienie. Plik można oddać do analizy 1:1.
function diagPayload(groups: SearchGroup[], note: string | null) {
  return {
    app: 'maxai',
    format: 'diag-1',
    czas: new Date().toISOString(),
    uwagaUzytkownika: note || null,
    zapytania: groups.map((g) => ({
      etykieta: g.label,
      hint: g.hint ?? null,
      tryb: g.mode ?? 'quality',
      recallK: g.recallK ?? null, // ilu kandydatów trafiło do oceny (kluczowe przy „czemu nie ma X")
      kategoriaBramki: g.queryCategory,
      opisWycinka: g.queryAttrs,
      kontekstRysunku: g.queryContext ?? null,
      obrazZapytaniaDataUrl: g.queryImg || null,
      blad: g.error ?? null,
      wyniki: g.results.map((r, i) => ({
        pozycja: i + 1,
        id: r.id ?? null,
        nazwa: r.name,
        sku: variantCode(r) || null,
        podtyp: r.subtype ?? null,
        kategoria: r.category ?? null,
        zrodlo: r.source ?? null,
        dopasowanieProc: Math.round((r.similarity ?? 0) * 100),
        rerankScore: r.rerankScore ?? null,
        kosinusTitan: r.visualSimilarity != null ? Math.round(r.visualSimilarity * 100) : null,
        poKorekcieMiekkiej: r.adjustedSimilarity != null ? Math.round(r.adjustedSimilarity * 100) : null,
        sygnalyMiekkie: r.softSignals ?? null,
        powodSedziego: r.reason ?? null,
        atrybutyProduktu: r.attributes ?? null,
        params: r.params ?? null,
      })),
    })),
  };
}

// Zwięzła wersja tekstowa — do wklejenia w czacie/zgłoszeniu (bez obrazów i JSON-ów).
function diagText(groups: SearchGroup[], note: string | null): string {
  const lines: string[] = [`maxai — diagnostyka wyszukiwania (${new Date().toLocaleString('pl-PL')})`];
  if (note) lines.push(`Uwaga: ${note}`);
  for (const g of groups) {
    const a = (g.queryAttrs ?? {}) as Record<string, unknown>;
    lines.push('');
    lines.push(`== ${g.label} | tryb: ${g.mode ?? 'quality'} | recallK: ${g.recallK ?? '—'} | hint: ${g.hint ?? '—'} | bramka: ${g.queryCategory ?? '—'}`);
    lines.push(`   opis wycinka: subtype=${String(a.subtype ?? '—')}, typ=${String(a.typ ?? '—')}, kształt=${String(a.ksztalt_ogolny ?? '—')}, materiał=${String(a.material ?? '—')}, kolor=${String(a.kolor_dominujacy ?? '—')}`);
    g.results.forEach((r, i) => {
      const soft = r.softSignals
        ? Object.entries(r.softSignals).map(([k, v]) => `${k}${v > 0 ? '+' : ''}${Math.round(v * 100)}`).join(' ')
        : '—';
      lines.push(
        `   ${i + 1}. ${Math.round((r.similarity ?? 0) * 100)}% [${r.subtype ?? '—'}] ${r.name}` +
          ` | cos=${r.visualSimilarity != null ? Math.round(r.visualSimilarity * 100) : '—'}` +
          ` adj=${r.adjustedSimilarity != null ? Math.round(r.adjustedSimilarity * 100) : '—'}` +
          ` rerank=${r.rerankScore ?? '—'} | miękkie: ${soft}` +
          (r.reason ? ` | powód: ${r.reason}` : ''),
      );
    });
  }
  return lines.join('\n');
}

function exportDiag(groups: SearchGroup[]) {
  const withResults = groups.filter((g) => g.results.length || g.error);
  if (!withResults.length) return;
  const note = window.prompt('Uwaga do wyników (trafi do pliku — opcjonalnie):', '') ?? null;
  const payload = diagPayload(withResults, note);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `maxai-diag-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyDiag(groups: SearchGroup[]) {
  const withResults = groups.filter((g) => g.results.length || g.error);
  if (!withResults.length) return;
  const note = window.prompt('Uwaga do wyników (trafi do schowka — opcjonalnie):', '') ?? null;
  try {
    await navigator.clipboard.writeText(diagText(withResults, note));
    alert('Skopiowano podsumowanie diagnostyki do schowka.');
  } catch {
    alert('Nie udało się skopiować — użyj eksportu do pliku JSON.');
  }
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
                <th className="text-left font-normal">sygnały miękkie</th>
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
                  <td className="pr-2 whitespace-nowrap">
                    {r.softSignals && Object.keys(r.softSignals).length ? (
                      <>
                        {Object.entries(r.softSignals).map(([k, v]) => (
                          <span key={k} className={v >= 0 ? 'mr-1 text-emerald-700' : 'mr-1 text-red-700'}>
                            {k} {v > 0 ? '+' : ''}{(v * 100).toFixed(0)}
                          </span>
                        ))}
                        {r.adjustedSimilarity != null && (
                          <span className="text-slate-500">= {(r.adjustedSimilarity * 100).toFixed(0)}%</span>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
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
          onClick={() => toggleShortlist({ id: sid, name: r.name, code, sku: (r.params?.sku as string | undefined) ?? null, source: r.source, manufacturer: r.manufacturer, imageUrl: r.imageUrl, ref: (r.params?.product_url as string | undefined) ?? r.catalogPageImageUrl ?? r.catalogUrl ?? null })}
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
