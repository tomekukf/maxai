import { useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import ReactCrop, { type Crop, type PixelCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { searchByImage, detectItems, type SearchResult, type DetectedItem } from '../lib/api';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const CAPTURE_WIDTH = 1000;
const DISPLAY_MAX = 720;

const btnPrimary =
  'rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50';
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

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const hiddenRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  function resetForNewImage() {
    setItems([]);
    setActiveItem(null);
    setCrop(undefined);
    setCompletedCrop(null);
    setResults(null);
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
    setBusy(true);
    setMsg(null);
    try {
      const res = await searchByImage(b64);
      setResults(res);
      if (!res.length) setMsg('Brak dobrego dopasowania w bazie (nic wystarczająco podobnego).');
    } catch (e) {
      setMsg(`Błąd wyszukiwania: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
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
            <h3 className="font-medium">Propozycje ({results.length})</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {results.map((r, i) => (
                <ResultCard key={i} r={r} rank={i + 1} />
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function ResultCard({ r, rank }: { r: SearchResult; rank: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="mb-2 aspect-square overflow-hidden rounded bg-slate-100">
        <img src={r.imageUrl} alt={r.name} className="h-full w-full object-contain" />
      </div>
      <div className="text-xs text-slate-500">
        #{rank} · podobieństwo {(r.similarity * 100).toFixed(0)}%
      </div>
      <div className="line-clamp-2 text-sm font-medium">{r.name}</div>
      <div className="mt-2 flex items-center gap-2">
        <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{r.optimaId}</code>
        <button
          onClick={() => {
            navigator.clipboard.writeText(r.optimaId);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="text-xs text-blue-700 hover:underline"
        >
          {copied ? 'skopiowano ✓' : 'kopiuj ID'}
        </button>
      </div>
    </div>
  );
}
