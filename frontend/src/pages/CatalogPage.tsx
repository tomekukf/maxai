import { useEffect, useState } from 'react';
import { listProducts, deleteProduct, deleteAllProducts, type Product } from '../lib/api';

export default function CatalogPage() {
  const [items, setItems] = useState<Product[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    setErr(null);
    listProducts()
      .then(setItems)
      .catch((e) => setErr((e as Error).message));
  }

  useEffect(() => {
    load();
  }, []);

  async function onDeleteOne(optimaId: string) {
    if (!confirm(`Usunąć produkt ${optimaId} (wraz ze zdjęciem)?`)) return;
    setBusy(true);
    try {
      await deleteProduct(optimaId);
      setItems((cur) => (cur ? cur.filter((p) => p.optimaId !== optimaId) : cur));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteAll() {
    if (!confirm('Usunąć WSZYSTKIE produkty z bazy (wraz ze zdjęciami)? Tej operacji nie da się cofnąć.')) return;
    setBusy(true);
    try {
      const { deleted } = await deleteAllProducts();
      alert(`Usunięto ${deleted} produktów.`);
      setItems([]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h2 className="text-lg font-semibold">Katalog produktów {items && `(${items.length})`}</h2>
            <p className="text-sm text-slate-500">Wszystkie produkty w bazie — ID Optima i zdjęcie.</p>
          </div>
          <div className="ml-auto flex gap-2">
            <button onClick={load} disabled={busy} className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50">
              Odśwież
            </button>
            <button
              onClick={onDeleteAll}
              disabled={busy || !items?.length}
              className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              Usuń wszystko
            </button>
          </div>
        </div>

        {err && <div className="text-sm text-red-700">Błąd: {err}</div>}
        {!items && !err && <div className="text-sm text-slate-500">Ładuję…</div>}

        {items && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {items.map((p) => (
              <div key={p.optimaId} className="relative rounded-lg border bg-white p-2">
                <button
                  onClick={() => onDeleteOne(p.optimaId)}
                  disabled={busy}
                  title="Usuń"
                  className="absolute right-1 top-1 z-10 rounded bg-white/90 px-1.5 py-0.5 text-xs text-red-600 shadow hover:bg-red-50 disabled:opacity-50"
                >
                  Usuń
                </button>
                <div className="mb-2 aspect-square overflow-hidden rounded bg-slate-100">
                  <img src={p.imageUrl} alt={p.name} className="h-full w-full object-contain" loading="lazy" />
                </div>
                <div className="text-[11px] text-slate-500">
                  <code>{p.optimaId}</code>
                </div>
                <div className="line-clamp-2 text-xs font-medium">{p.name}</div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
