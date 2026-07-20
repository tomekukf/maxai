import { useState } from 'react';
import { useShortlist, removeFromShortlist, clearShortlist, type ShortItem } from '../lib/shortlist';

export default function ShortlistPage() {
  const items = useShortlist();
  const [copied, setCopied] = useState(false);

  function copyList() {
    const text = items
      .map((it) => `• ${it.name}${it.code ? ` [${it.code}]` : ''}${it.manufacturer ? ` — ${it.manufacturer}` : ''}`)
      .join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h2 className="text-lg font-semibold">Schowek ofertowy {items.length > 0 && `(${items.length})`}</h2>
            <p className="text-sm text-slate-500">Produkty odłożone „do oferty dla klienta". Zapis lokalny (ta przeglądarka).</p>
          </div>
          {items.length > 0 && (
            <div className="ml-auto flex gap-2">
              <button onClick={copyList} className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100">
                {copied ? 'skopiowano ✓' : 'Kopiuj listę'}
              </button>
              <button
                onClick={() => confirm('Wyczyścić cały schowek?') && clearShortlist()}
                className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
              >
                Wyczyść
              </button>
            </div>
          )}
        </div>

        {items.length === 0 ? (
          <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-400 shadow-card">
            Schowek jest pusty. Dodawaj produkty przyciskiem „☆ Do schowka" w wyszukiwaniu lub katalogu.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {items.map((it) => (
              <Card key={it.id} it={it} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function Card({ it }: { it: ShortItem }) {
  return (
    <div className="relative rounded-xl border bg-white p-2 shadow-card">
      <button
        onClick={() => removeFromShortlist(it.id)}
        title="Usuń ze schowka"
        className="absolute right-1 top-1 z-10 rounded bg-white/90 px-1.5 py-0.5 text-xs text-red-600 shadow hover:bg-red-50"
      >
        Usuń
      </button>
      <div className="mb-2 aspect-square overflow-hidden rounded bg-slate-100">
        {it.imageUrl ? (
          <img src={it.imageUrl} alt={it.name} className="h-full w-full object-contain" loading="lazy" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-slate-300">brak zdjęcia</div>
        )}
      </div>
      {it.code && <div className="text-[11px] text-slate-500"><code>{it.code}</code></div>}
      <div className="line-clamp-2 text-xs font-medium">{it.name}</div>
      {it.manufacturer && <div className="text-[10px] text-slate-400">{it.manufacturer}</div>}
    </div>
  );
}
