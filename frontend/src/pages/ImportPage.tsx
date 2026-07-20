import { useEffect, useState } from 'react';
import {
  createCatalog,
  uploadRaw,
  importProduct,
  listCatalogs,
  deleteCatalog,
  exportCatalog,
  type CatalogListItem,
} from '../lib/api';

type PkgImage = { file: string; role?: string; attributes?: unknown; embedding?: unknown };
type PkgProduct = {
  name?: string;
  optimaId?: string;
  category?: string;
  subtype?: string;
  manufacturer?: string;
  manufacturerCode?: string;
  params?: Record<string, unknown>;
  catalogPage?: number;
  images: PkgImage[];
};
type Pkg = {
  catalog?: { name?: string; manufacturer?: string; domainCategory?: string; pageCount?: number };
  products: PkgProduct[];
};

const base = (path: string) => path.split('/').pop() ?? path;

export default function ImportPage() {
  const [pkg, setPkg] = useState<Pkg | null>(null);
  const [images, setImages] = useState<Map<string, File>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; ok: number; dup: number; err: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [sources, setSources] = useState<CatalogListItem[] | null>(null);

  function loadSources() {
    listCatalogs().then(setSources).catch(() => setSources([]));
  }
  useEffect(loadSources, []);

  async function onDeleteSource(id: string, name: string) {
    if (!confirm(`Usunąć źródło „${name}" wraz ze wszystkimi jego produktami i zdjęciami? Tej operacji nie da się cofnąć.`)) return;
    try {
      const { deleted } = await deleteCatalog(id);
      alert(`Usunięto źródło (${deleted} produktów).`);
      loadSources();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function onExportSource(id: string) {
    try {
      const { downloadUrl } = await exportCatalog(id);
      window.open(downloadUrl, '_blank');
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  function onPick(files: FileList | null) {
    setErr(null);
    setPkg(null);
    setProgress(null);
    setLog([]);
    if (!files || !files.length) return;
    const arr = [...files];
    const jsonFile = arr.find((f) => f.name === 'collection.json');
    if (!jsonFile) {
      setErr('Nie znaleziono collection.json w wybranym folderze.');
      return;
    }
    const imgMap = new Map<string, File>();
    for (const f of arr) if (f !== jsonFile) imgMap.set(base(f.webkitRelativePath || f.name), f);
    setImages(imgMap);
    jsonFile
      .text()
      .then((t) => {
        const parsed = JSON.parse(t) as Pkg;
        if (!Array.isArray(parsed.products)) throw new Error('collection.json: brak listy products');
        setPkg(parsed);
      })
      .catch((e) => setErr(`collection.json: ${(e as Error).message}`));
  }

  async function runImport() {
    if (!pkg) return;
    setBusy(true);
    setErr(null);
    const addLog = (s: string) => setLog((l) => [s, ...l].slice(0, 200));
    try {
      const { id: catalogId } = await createCatalog({
        name: pkg.catalog?.name,
        manufacturer: pkg.catalog?.manufacturer,
        domainCategory: pkg.catalog?.domainCategory,
        pageCount: pkg.catalog?.pageCount,
      });
      addLog(`Utworzono katalog ${catalogId}`);

      let ok = 0, dup = 0, e = 0;
      const total = pkg.products.length;
      setProgress({ done: 0, total, ok, dup, err: e });

      for (let i = 0; i < pkg.products.length; i++) {
        const p = pkg.products[i];
        try {
          const imgs: Record<string, unknown>[] = [];
          for (let k = 0; k < p.images.length; k++) {
            const im = p.images[k];
            const file = images.get(base(im.file));
            if (!file) { addLog(`⚠ brak pliku ${im.file} (${p.name})`); continue; }
            const key = await uploadRaw(file, `products/import/${catalogId}`);
            imgs.push({ key, sortOrder: k, attributes: im.attributes ?? null, embedding: im.embedding ?? undefined });
          }
          if (!imgs.length) { e++; addLog(`✗ ${p.name}: brak zdjęć`); }
          else {
            const res = await importProduct({
              name: p.name,
              optimaId: p.optimaId,
              category: p.category,
              subtype: p.subtype,
              manufacturer: p.manufacturer ?? pkg.catalog?.manufacturer,
              manufacturerCode: p.manufacturerCode,
              source: 'catalog',
              catalogId,
              catalogPage: p.catalogPage ?? (p.params?.viewer_page as number | undefined),
              params: p.params ?? {},
              describe: false,
              images: imgs,
            });
            if (res.duplicate) dup++;
            else ok++;
          }
        } catch (ex) {
          e++; addLog(`✗ ${p.name}: ${(ex as Error).message}`);
        }
        setProgress({ done: i + 1, total, ok, dup, err: e });
      }
      addLog(`Gotowe: ok=${ok}, duplikaty=${dup}, błędy=${e}`);
      loadSources();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <div>
          <h2 className="text-lg font-semibold">Import kolekcji</h2>
          <p className="text-sm text-slate-500">
            Wybierz folder kolekcji przygotowanej lokalnie (musi zawierać <code>collection.json</code> i zdjęcia).
            Import nie używa Bedrock vision; embedding liczony przez Titan (lub brany z paczki, jeśli jest).
          </p>
        </div>

        {/* Źródła w bazie — każdy import to „źródło", które można usunąć w całości i dodać od nowa. */}
        <div className="rounded-lg border bg-white p-3">
          <div className="mb-2 flex items-center gap-2">
            <h3 className="text-sm font-semibold">Źródła w bazie</h3>
            <button onClick={loadSources} className="text-xs text-blue-700 hover:underline">Odśwież</button>
          </div>
          {!sources && <div className="text-xs text-slate-500">Ładuję…</div>}
          {sources && sources.length === 0 && <div className="text-xs text-slate-400">Brak źródeł.</div>}
          {sources && sources.length > 0 && (
            <table className="w-full text-sm">
              <tbody>
                {sources.map((s) => (
                  <tr key={s.id} className="border-t first:border-0">
                    <td className="py-1">
                      <div className="font-medium">{s.name ?? '—'}</div>
                      <div className="text-xs text-slate-500">{s.manufacturer ?? '—'} · {s.productCount} produktów</div>
                    </td>
                    <td className="py-1 text-right">
                      <button onClick={() => onExportSource(s.id)} className="mr-3 text-xs text-blue-700 hover:underline">Eksport</button>
                      <button onClick={() => onDeleteSource(s.id, s.name ?? s.id)} className="text-xs text-red-600 hover:underline">Usuń źródło</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <details className="rounded-lg border bg-white p-3 text-xs text-slate-600">
          <summary className="cursor-pointer font-medium text-slate-700">Jak przygotować dane do importu?</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>Katalog PDF: <code>python scripts/prepare-catalog.py &lt;pdf&gt; &lt;nazwa&gt;</code> → poproś Claude „przygotuj katalog &lt;nazwa&gt;" → powstaje <code>rawdata/&lt;nazwa&gt;/collection.json</code> + zdjęcia.</li>
            <li>Oferta maxfliz: <code>node scripts/scrape-maxfliz.mjs</code> → <code>rawdata/maxfliz/</code>.</li>
            <li>Tu: wybierz folder z <code>collection.json</code> i kliknij „Importuj do bazy". Pełny opis: zakładka Dokumentacja.</li>
          </ol>
        </details>

        <input
          type="file"
          multiple
          ref={(el) => el && el.setAttribute('webkitdirectory', '')}
          onChange={(e) => onPick(e.target.files)}
          className="block text-sm"
        />

        {err && <div className="text-sm text-red-700">Błąd: {err}</div>}

        {pkg && (
          <div className="rounded-lg border bg-white p-3 text-sm">
            <div>
              Katalog: <b>{pkg.catalog?.name ?? '—'}</b> ({pkg.catalog?.manufacturer ?? '—'},{' '}
              {pkg.catalog?.domainCategory ?? '—'})
            </div>
            <div>Produktów w paczce: <b>{pkg.products.length}</b> · plików zdjęć: <b>{images.size}</b></div>
            <button
              onClick={runImport}
              disabled={busy}
              className="mt-3 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
            >
              {busy ? 'Importuję…' : 'Importuj do bazy'}
            </button>
          </div>
        )}

        {progress && (
          <div className="rounded-lg border bg-white p-3 text-sm">
            <div className="mb-2 h-2 w-full overflow-hidden rounded bg-slate-100">
              <div className="h-full bg-slate-900" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </div>
            <div>
              {progress.done}/{progress.total} · ok={progress.ok} · duplikaty={progress.dup} · błędy={progress.err}
            </div>
          </div>
        )}

        {log.length > 0 && (
          <pre className="max-h-64 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">{log.join('\n')}</pre>
        )}
      </main>
    </div>
  );
}
