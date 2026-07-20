import { useEffect, useState } from 'react';
import { listProducts, type Product } from '../lib/api';

function tally(items: Product[], key: (p: Product) => string | undefined) {
  const m = new Map<string, number>();
  for (const p of items) {
    const k = key(p) || '—';
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export default function StatsPage() {
  const [items, setItems] = useState<Product[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    listProducts().then(setItems).catch((e) => setErr((e as Error).message));
  }, []);

  if (err) return <Wrap><div className="text-sm text-red-700">Błąd: {err}</div></Wrap>;
  if (!items) return <Wrap><div className="text-sm text-slate-500">Ładuję…</div></Wrap>;

  const totalImages = items.reduce((s, p) => s + (p.imageCount ?? 0), 0);

  return (
    <Wrap>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Produkty" value={items.length} />
        <Stat label="Zdjęcia" value={totalImages} />
        <Stat label="Kategorie" value={new Set(items.map((p) => p.category).filter(Boolean)).size} />
        <Stat label="Z ID Optima" value={items.filter((p) => p.optimaId).length} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Table title="Wg kategorii" rows={tally(items, (p) => p.category)} />
        <Table title="Wg podtypu" rows={tally(items, (p) => p.subtype)} />
        <Table title="Wg źródła" rows={tally(items, (p) => p.source)} />
      </div>
    </Wrap>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <main className="mx-auto max-w-4xl space-y-4 px-4 py-6">
        <h2 className="text-lg font-semibold">Statystyki bazy</h2>
        {children}
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-white p-3 shadow-card">
      <div className="text-2xl font-semibold text-brand">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

function Table({ title, rows }: { title: string; rows: [string, number][] }) {
  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="mb-2 text-sm font-medium">{title}</div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([k, n]) => (
            <tr key={k} className="border-t first:border-0">
              <td className="py-1 text-slate-600">{k}</td>
              <td className="py-1 text-right font-medium">{n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
