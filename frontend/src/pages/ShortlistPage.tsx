import { useMemo, useState } from 'react';
import { useShortlist, removeFromShortlist, clearShortlist, type ShortItem } from '../lib/shortlist';

export default function ShortlistPage() {
  const items = useShortlist();
  const [copied, setCopied] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set()); // zaznaczone do PDF; puste = wszystkie

  const selectedItems = useMemo(
    () => (sel.size ? items.filter((it) => sel.has(it.id)) : items),
    [items, sel],
  );

  function toggle(id: string) {
    setSel((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  function copyList() {
    const text = selectedItems
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
            <div className="ml-auto flex flex-wrap gap-2">
              <button
                onClick={() => printTable(selectedItems)}
                disabled={selectedItems.length === 0}
                className="rounded bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
              >
                🖨️ PDF — tabela ({selectedItems.length})
              </button>
              <button onClick={copyList} className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100">
                {copied ? 'skopiowano ✓' : 'Kopiuj listę'}
              </button>
              <button
                onClick={() => confirm('Wyczyścić cały schowek?') && clearShortlist()}
                className="rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
              >
                Wyczyść
              </button>
            </div>
          )}
        </div>

        {items.length > 0 && (
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span>Zaznacz produkty do PDF (bez zaznaczenia = wszystkie).</span>
            {sel.size > 0 && (
              <button onClick={() => setSel(new Set())} className="text-blue-700 hover:underline">Wyczyść zaznaczenie ({sel.size})</button>
            )}
            <button onClick={() => setSel(new Set(items.map((i) => i.id)))} className="text-blue-700 hover:underline">Zaznacz wszystkie</button>
          </div>
        )}

        {items.length === 0 ? (
          <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-400 shadow-card">
            Schowek jest pusty. Dodawaj produkty przyciskiem „☆ Do schowka" w wyszukiwaniu lub katalogu.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {items.map((it) => (
              <Card key={it.id} it={it} selected={sel.has(it.id)} onToggle={() => toggle(it.id)} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function Card({ it, selected, onToggle }: { it: ShortItem; selected: boolean; onToggle: () => void }) {
  return (
    <div className={'relative rounded-xl border bg-white p-2 shadow-card ' + (selected ? 'ring-2 ring-brand' : '')}>
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        title="Zaznacz do PDF"
        className="absolute left-1 top-1 z-10 h-4 w-4 cursor-pointer"
      />
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

// Tabela do druku/PDF — nowe okno, samodzielny HTML (zdjęcia jako <img>, bez CORS), auto-print po załadowaniu.
function printTable(items: ShortItem[]) {
  const w = window.open('', '_blank');
  if (!w) {
    alert('Przeglądarka zablokowała okno druku — zezwól na wyskakujące okna dla tej strony.');
    return;
  }
  const esc = (s: unknown) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  const shortUrl = (u?: string | null) => {
    if (!u) return '';
    try { return new URL(u).host.replace(/^www\./, ''); } catch { return 'link'; }
  };
  const rows = items.map((it, i) => {
    const kod = it.code || it.sku || '';
    return `<tr>
      <td class="n">${i + 1}</td>
      <td class="img">${it.imageUrl ? `<img src="${esc(it.imageUrl)}" />` : ''}</td>
      <td class="name">${esc(it.name)}</td>
      <td class="code">${kod ? esc(kod) : '—'}</td>
      <td>${esc(it.manufacturer || '—')}</td>
      <td class="ref">${it.ref ? `<a href="${esc(it.ref)}">${esc(shortUrl(it.ref))} ↗</a>` : '—'}</td>
    </tr>`;
  }).join('');
  const html = `<!doctype html><html lang="pl"><head><meta charset="utf-8" />
<title>maxai — zestawienie produktów</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Jost, system-ui, sans-serif; color: #1e293b; margin: 20px; }
  header { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 2px solid #760039; padding-bottom: 8px; margin-bottom: 14px; }
  h1 { color: #760039; font-size: 18px; margin: 0; }
  .date { color: #64748b; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; vertical-align: middle; }
  th { background: #f1f5f9; font-weight: 600; }
  td.n { width: 28px; color: #94a3b8; text-align: center; }
  td.img { width: 84px; }
  td.img img { width: 72px; height: 72px; object-fit: contain; background: #f8fafc; border-radius: 4px; }
  td.name { font-weight: 600; }
  td.code { font-family: monospace; }
  td.ref a { color: #108474; text-decoration: none; }
  tr { page-break-inside: avoid; }
  @media print { body { margin: 12mm; } thead { display: table-header-group; } }
</style></head>
<body>
  <header><h1>maxai — zestawienie produktów</h1><div class="date">${esc(new Date().toLocaleString('pl-PL'))} · ${items.length} poz.</div></header>
  <table>
    <thead><tr><th></th><th>Zdjęcie</th><th>Nazwa</th><th>Kod / SKU</th><th>Producent</th><th>Odniesienie</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
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
