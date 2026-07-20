import { useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import ReactCrop, { type Crop, type PixelCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { searchByImage, detectItems, type SearchResult, type DetectedItem } from '../lib/api';
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

export default function SearchPage() {
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [pageImg, setPageImg] = useState<string | null>(null);

  const [items, setItems] = useState<DetectedItem[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [activeItem, setActiveItem] = useState<number | null>(null);

  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop | null>(null);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [queryAttrs, setQueryAttrs] = useState<Record<string, unknown> | null>(null);
  const [queryCategory, setQueryCategory] = useState<string | null>(null);
  const [queryImg, setQueryImg] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Tryb diagnostyczny — tylko dla zalogowanego admina (podgląd flow zapytania).
  const [admin] = useState(() => isAdmin(loadSession()));
  const [diag, setDiag] = useState(false);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const hiddenRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const lastB64 = useRef<string | null>(null);

  function resetForNewImage() {
    setItems([]);
    setActiveItem(null);
    setCrop(undefined);
    setCompletedCrop(null);
    setResults(null);
    setQueryAttrs(null);
    setQueryCategory(null);
    setQueryImg(null);
    lastB64.current = null;
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
      setItems(its);
      if (!its.length) setMsg('Model nie wykrył mebli — zaznacz mebel ręcznie.');
    } catch (e) {
      setMsg(`Błąd detekcji: ${(e as Error).message}`);
    } finally {
      setDetecting(false);
    }
  }

  function onImgLoad() {
    runDetect();
  }

  // Klik w podpowiedź → ustaw wstępną ramkę (na wymiarach wyświetlanego obrazu)
  function pickDetected(i: number) {
    const image = imgRef.current;
    if (!image) return;
    const b = items[i].box;
    const c: PixelCrop = {
      unit: 'px',
      x: b.x * image.width,
      y: b.y * image.height,
      width: b.w * image.width,
      height: b.h * image.height,
    };
    setActiveItem(i);
    setCrop(c);
    setCompletedCrop(c);
  }

  async function handleSearch() {
    const image = imgRef.current;
    if (!image || !completedCrop || completedCrop.width < 5 || completedCrop.height < 5) {
      setMsg('Zaznacz mebel na obrazie (lub wybierz podpowiedź i popraw ramkę).');
      return;
    }
    const scaleX = image.naturalWidth / image.width;
    const scaleY = image.naturalHeight / image.height;
    const b64 = cropToBase64(
      image,
      completedCrop.x * scaleX,
      completedCrop.y * scaleY,
      completedCrop.width * scaleX,
      completedCrop.height * scaleY,
    );
    if (!b64) {
      setMsg('Zaznaczenie za małe.');
      return;
    }
    lastB64.current = b64;
    setQueryImg('data:image/jpeg;base64,' + b64);
    await runSearch(b64, 3, false);
  }

  async function runSearch(b64: string, k: number, more: boolean) {
    (more ? setLoadingMore : setBusy)(true);
    setMsg(null);
    try {
      const res = await searchByImage(b64, k);
      setResults(res.results);
      setQueryAttrs(res.queryAttributes ?? null);
      setQueryCategory(res.queryCategory ?? null);
      if (!res.results.length) setMsg('Brak dobrego dopasowania w bazie (nic wystarczająco podobnego).');
    } catch (e) {
      setMsg(`Błąd wyszukiwania: ${(e as Error).message}`);
    } finally {
      (more ? setLoadingMore : setBusy)(false);
    }
  }

  async function loadMore() {
    if (!lastB64.current || !results) return;
    await runSearch(lastB64.current, results.length + 3, true);
  }

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
            {/* podpowiedzi wykrytych mebli */}
            <div className="space-y-1">
              <div className="text-sm font-medium">
                Wykryte meble {detecting && <span className="text-slate-400">(analizuję…)</span>}
              </div>
              {items.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {items.map((it, i) => (
                    <button
                      key={i}
                      onClick={() => pickDetected(i)}
                      className={
                        activeItem === i
                          ? 'rounded-full bg-slate-900 px-3 py-1 text-xs text-white'
                          : 'rounded-full border border-slate-300 px-3 py-1 text-xs hover:bg-slate-100'
                      }
                    >
                      {it.label}
                    </button>
                  ))}
                </div>
              )}
              <p className="text-xs text-slate-500">
                Kliknij mebel → pojawi się ramka do poprawienia. Potem „Znajdź podobne".
              </p>
            </div>

            {/* obraz z edytowalnym kadrem */}
            <div className="inline-block border bg-white">
              <ReactCrop crop={crop} onChange={(c) => setCrop(c)} onComplete={(c) => setCompletedCrop(c)}>
                <img
                  ref={imgRef}
                  src={pageImg}
                  alt="wizualizacja"
                  onLoad={onImgLoad}
                  style={{ maxWidth: DISPLAY_MAX, display: 'block' }}
                />
              </ReactCrop>
            </div>

            <div className="flex items-center gap-3">
              <button onClick={handleSearch} disabled={busy} className={btnPrimary}>
                {busy ? 'Szukam…' : 'Znajdź podobne'}
              </button>
              {msg && <span className="text-sm text-red-700">{msg}</span>}
            </div>
          </>
        )}

        {results && results.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <h3 className="font-medium">Propozycje ({groupResults(results).length})</h3>
              {admin && (
                <button onClick={() => setDiag((d) => !d)} className="text-xs text-blue-700 hover:underline">
                  {diag ? 'Ukryj diagnostykę' : '🔬 Tryb diagnostyczny'}
                </button>
              )}
            </div>
            {admin && diag && (
              <DiagPanel queryImg={queryImg} category={queryCategory} attrs={queryAttrs} results={results} />
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {groupResults(results).map((g, i) => (
                <ResultCard key={i} r={g.rep} rank={i + 1} queryAttrs={queryAttrs} variants={g.variants} />
              ))}
            </div>
            <div className="pt-1">
              <button onClick={loadMore} disabled={loadingMore} className={navBtn}>
                {loadingMore ? 'Wczytuję…' : 'Wczytaj kolejne'}
              </button>
            </div>
          </div>
        )}
      </main>
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
