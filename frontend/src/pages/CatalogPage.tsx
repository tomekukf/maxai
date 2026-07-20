import { useEffect, useMemo, useRef, useState } from 'react';
import {
  listProducts,
  getCategories,
  deleteProduct,
  deleteAllProducts,
  getProduct,
  updateProduct,
  type Product,
  type ProductDetail,
  type ProductImage,
  type ProductPatch,
  type CategoryCount,
} from '../lib/api';
import { useShortlist, toggleShortlist } from '../lib/shortlist';

const btn = 'rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50';
const PAGE = 60;

export default function CatalogPage({ admin = false }: { admin?: boolean }) {
  const [items, setItems] = useState<Product[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [sub, setSub] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [categories, setCategories] = useState<CategoryCount[]>([]);
  const reqId = useRef(0); // odrzucanie spóźnionych odpowiedzi (race przy szybkim pisaniu)

  // Pełna lista kategorii z bazy (nie tylko z załadowanej strony).
  useEffect(() => {
    getCategories().then(setCategories).catch(() => {});
  }, []);

  // Pobranie strony wyników (server-side: q + kategoria). reset=true → od nowa; inaczej dopisz.
  async function fetchPage(reset: boolean) {
    const my = ++reqId.current;
    reset ? setBusy(true) : setLoadingMore(true);
    setErr(null);
    try {
      const offset = reset ? 0 : items?.length ?? 0;
      const page = await listProducts({ q: q.trim(), category: cat, limit: PAGE, offset });
      if (my !== reqId.current) return; // przyszła nowsza odpowiedź
      setTotal(page.total);
      setItems((cur) => (reset || !cur ? page.items : [...cur, ...page.items]));
    } catch (e) {
      if (my === reqId.current) setErr((e as Error).message);
    } finally {
      if (my === reqId.current) { setBusy(false); setLoadingMore(false); }
    }
  }
  const load = () => fetchPage(true);

  // Debounce wyszukiwania + reakcja na zmianę kategorii → ładuj od nowa.
  useEffect(() => {
    const t = setTimeout(() => fetchPage(true), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, cat]);

  // Podtyp filtrujemy po stronie klienta (na załadowanych rekordach).
  const subtypes = useMemo(
    () => [...new Set((items ?? []).map((p) => p.subtype).filter(Boolean))] as string[],
    [items],
  );

  const filtered = useMemo(
    () => (items ?? []).filter((p) => !sub || p.subtype === sub),
    [items, sub],
  );

  // Zwijanie wariantów tego samego produktu (group_id) w jedną kafelkę.
  const grouped = useMemo(() => {
    const m = new Map<string, Product[]>();
    const order: string[] = [];
    for (const p of filtered) {
      const key = p.groupId || p.id;
      const g = m.get(key);
      if (g) g.push(p);
      else {
        m.set(key, [p]);
        order.push(key);
      }
    }
    return order.map((k) => m.get(k) as Product[]);
  }, [filtered]);

  const [dragKey, setDragKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const groupKey = (p: Product) => p.groupId || p.id;

  function toggleSel(key: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }

  // Scal wszystkie zaznaczone grupy w jedną (group_id pierwszej zaznaczonej).
  async function mergeSelected() {
    const sel = grouped.filter((g) => selected.has(groupKey(g[0])));
    if (sel.length < 2) return;
    const targetGid = groupKey(sel[0][0]);
    const toUpdate = sel.flatMap((g) => g).filter((p) => (p.groupId || p.id) !== targetGid);
    if (!confirm(`Połączyć ${sel.length} grup (${toUpdate.length + sel[0].length} produktów) w jedną?`)) return;
    setBusy(true);
    setErr(null);
    try {
      for (const p of toUpdate) await updateProduct(p.id, { groupId: targetGid });
      setSelected(new Set());
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Scal grupę źródłową (przeciąganą) do grupy docelowej: ustaw group_id wszystkich elementów.
  async function mergeInto(src: Product[], dst: Product[]) {
    const targetGid = groupKey(dst[0]);
    if (groupKey(src[0]) === targetGid) return; // ta sama grupa
    if (!confirm(`Połączyć „${src[0].name}" (${src.length} szt.) z grupą „${dst[0].name}"?`)) return;
    setBusy(true);
    setErr(null);
    try {
      for (const p of src) await updateProduct(p.id, { groupId: targetGid });
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteOne(id: string, label: string) {
    if (!confirm(`Usunąć produkt ${label} (wraz ze zdjęciami)?`)) return;
    setBusy(true);
    try {
      await deleteProduct(id);
      setItems((cur) => (cur ? cur.filter((p) => p.id !== id) : cur));
      setTotal((t) => Math.max(0, t - 1));
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
      setTotal(0);
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
            <h2 className="text-lg font-semibold">
              Katalog produktów {items && `(załadowano ${filtered.length} z ${total})`}
            </h2>
            <p className="text-sm text-slate-500">Szukaj, filtruj, kliknij produkt po szczegóły i edycję.</p>
          </div>
          <div className="ml-auto flex gap-2">
            <button onClick={load} disabled={busy} className={btn}>Odśwież</button>
            {admin && (
              <button
                onClick={onDeleteAll}
                disabled={busy || !items?.length}
                className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                Usuń wszystko
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Szukaj: nazwa, kod, ID Optima, podtyp…"
            className="min-w-[220px] flex-1 rounded border border-slate-300 px-3 py-1.5 text-sm"
          />
          <select value={cat} onChange={(e) => { setCat(e.target.value); setSub(''); }} className="rounded border border-slate-300 px-2 py-1.5 text-sm">
            <option value="">— kategoria (wszystkie) —</option>
            {categories.map((c) => <option key={c.category} value={c.category}>{c.category} ({c.count})</option>)}
          </select>
          <select value={sub} onChange={(e) => setSub(e.target.value)} className="rounded border border-slate-300 px-2 py-1.5 text-sm">
            <option value="">— podtyp —</option>
            {subtypes.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {err && <div className="text-sm text-red-700">Błąd: {err}</div>}
        {!items && !err && <div className="text-sm text-slate-500">Ładuję…</div>}

        {admin && items && (
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="text-slate-400">
              💡 Przeciągnij kafelek na inny albo zaznacz kilka (checkbox) i połącz w grupę. Rozłączanie: w podglądzie.
            </span>
            {selected.size > 0 && (
              <>
                <span className="text-slate-600">Zaznaczono: {selected.size}</span>
                <button
                  onClick={mergeSelected}
                  disabled={busy || selected.size < 2}
                  className="rounded bg-brand px-2 py-1 font-medium text-white hover:bg-brand-dark disabled:opacity-50"
                >
                  Połącz zaznaczone w grupę
                </button>
                <button onClick={() => setSelected(new Set())} className="rounded border border-slate-300 px-2 py-1">
                  Wyczyść
                </button>
              </>
            )}
          </div>
        )}

        {items && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {grouped.map((grp) => {
              const p = grp[0];
              return (
                <div
                  key={p.groupId || p.id}
                  className={`relative rounded-xl border bg-white p-2 shadow-card transition hover:shadow-md ${admin && dragKey && dragKey !== groupKey(p) ? 'ring-2 ring-dashed ring-accent' : ''}`}
                  draggable={admin}
                  onDragStart={() => setDragKey(groupKey(p))}
                  onDragEnd={() => setDragKey(null)}
                  onDragOver={admin ? (e) => e.preventDefault() : undefined}
                  onDrop={
                    admin
                      ? () => {
                          const src = grouped.find((g) => groupKey(g[0]) === dragKey);
                          if (src) mergeInto(src, grp);
                          setDragKey(null);
                        }
                      : undefined
                  }
                >
                  {admin && (
                    <button
                      onClick={() => onDeleteOne(p.id, p.optimaId ?? p.manufacturerCode ?? p.name ?? p.id)}
                      disabled={busy}
                      title="Usuń"
                      className="absolute right-1 top-1 z-10 rounded bg-white/90 px-1.5 py-0.5 text-xs text-red-600 shadow hover:bg-red-50 disabled:opacity-50"
                    >
                      Usuń
                    </button>
                  )}
                  {admin && (
                    <input
                      type="checkbox"
                      checked={selected.has(groupKey(p))}
                      onChange={() => toggleSel(groupKey(p))}
                      onClick={(e) => e.stopPropagation()}
                      title="Zaznacz do połączenia"
                      className="absolute left-1 top-1 z-10 h-4 w-4 cursor-pointer"
                    />
                  )}
                  <button onClick={() => setOpenId(p.id)} className="block w-full text-left">
                    <div className="mb-2 aspect-square overflow-hidden rounded bg-slate-100">
                      <img src={p.imageUrl} alt={p.name} className="h-full w-full object-contain" loading="lazy" />
                    </div>
                    <div className="text-[11px] text-slate-500">
                      <code>{p.optimaId ?? p.manufacturerCode ?? '—'}</code>
                      {p.subtype && <span className="ml-1 rounded bg-slate-100 px-1">{p.subtype}</span>}
                      {grp.length > 1 && <span className="ml-1 rounded bg-slate-900/80 px-1 text-white">{grp.length} war.</span>}
                    </div>
                    <div className="line-clamp-2 text-xs font-medium">{p.name}</div>
                    {grp.length > 1 && (
                      <div className="mt-0.5 truncate text-[10px] text-slate-400">
                        {grp.map((v) => v.manufacturerCode).filter(Boolean).join(', ')}
                      </div>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {items && items.length < total && (
          <div className="flex justify-center pt-2">
            <button onClick={() => fetchPage(false)} disabled={loadingMore || busy} className={btn}>
              {loadingMore ? 'Ładuję…' : `Pokaż więcej (${items.length} z ${total})`}
            </button>
          </div>
        )}
        {items && items.length === 0 && !busy && (
          <div className="py-8 text-center text-sm text-slate-400">Brak produktów dla tych filtrów.</div>
        )}
      </main>

      {openId && (
        <ProductModal
          id={openId}
          admin={admin}
          onClose={() => setOpenId(null)}
          onSaved={() => { setOpenId(null); load(); }}
        />
      )}
    </div>
  );
}

function ProductModal({ id, admin, onClose, onSaved }: { id: string; admin: boolean; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<ProductDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ProductPatch>({});
  const [paramsText, setParamsText] = useState('');
  const [zoom, setZoom] = useState<string | null>(null); // powiększone zdjęcie (lightbox)
  const shortlist = useShortlist();
  const inSL = !!d && shortlist.some((x) => x.id === d.id);

  useEffect(() => {
    getProduct(id)
      .then((pd) => {
        setD(pd);
        setForm({ name: pd.name, optimaId: pd.optimaId ?? '', category: pd.category, subtype: pd.subtype, groupId: pd.groupId ?? '' });
        setParamsText(JSON.stringify(pd.params ?? {}, null, 2));
      })
      .catch((e) => setErr((e as Error).message));
  }, [id]);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const patch: ProductPatch = { ...form };
      try {
        patch.params = JSON.parse(paramsText || '{}');
      } catch {
        throw new Error('Params: niepoprawny JSON');
      }
      await updateProduct(id, patch);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div className="my-8 w-full max-w-2xl rounded-lg bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="font-semibold">{d?.name ?? 'Produkt'}</h3>
          <div className="flex items-center gap-3">
            {d && (
              <button
                onClick={() => toggleShortlist({ id: d.id, name: d.name, code: d.optimaId ?? d.manufacturerCode ?? (d.params?.sku as string | undefined) ?? null, source: d.source, manufacturer: d.manufacturer, imageUrl: d.images[0]?.imageUrl })}
                className={inSL ? 'text-xs font-medium text-accent-dark' : 'text-xs text-slate-500 hover:text-brand'}
              >
                {inSL ? '★ W schowku' : '☆ Do schowka'}
              </button>
            )}
            <button onClick={onClose} className="text-slate-400 hover:text-slate-700">✕</button>
          </div>
        </div>

        {err && <div className="mb-2 text-sm text-red-700">{err}</div>}
        {!d && !err && <div className="text-sm text-slate-500">Ładuję…</div>}

        {d && (
          <div className="space-y-4">
            <div className="flex gap-2 overflow-x-auto">
              {d.images.map((im, i) => (
                <img
                  key={i}
                  src={im.imageUrl}
                  alt=""
                  onClick={() => setZoom(im.imageUrl)}
                  title="Kliknij, aby powiększyć"
                  className="h-32 w-32 flex-none cursor-zoom-in rounded border bg-slate-50 object-contain hover:ring-2 hover:ring-slate-400"
                />
              ))}
            </div>

            {d.catalog && (
              <div className="flex flex-wrap gap-3 text-sm">
                {/* Lekki obraz strony (~200 KB) zamiast całego PDF; ta sama karta. */}
                <a
                  href={d.catalog.pageImageUrl ?? d.catalog.pdfUrl}
                  target="maxai-katalog"
                  rel="noreferrer"
                  className="text-blue-700 hover:underline"
                >
                  📄 {d.catalog.name}, str. {(d.params?.printed_page as number) ?? d.catalog.page} ↗
                </a>
                <a href={`${d.catalog.pdfUrl}#page=${d.catalog.page}`} target="_blank" rel="noreferrer" className="text-slate-400 hover:underline">
                  (cały PDF)
                </a>
              </div>
            )}

            {!edit ? (
              <>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <Row k="ID Optima" v={d.optimaId ?? '—'} />
                  <Row k="Źródło" v={d.source ?? '—'} />
                  <Row k="Kategoria" v={d.category ?? '—'} />
                  <Row k="Podtyp" v={d.subtype ?? '—'} />
                  <Row k="Producent" v={d.manufacturer ?? '—'} />
                  <Row k="Kod" v={d.manufacturerCode ?? '—'} />
                </dl>
                <SpecView params={d.params} images={d.images} />
                <details>
                  <summary className="cursor-pointer text-xs text-slate-500">Parametry (surowy JSON)</summary>
                  <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(d.params, null, 2)}</pre>
                </details>
                {admin && (
                  <div className="flex justify-end gap-2">
                    {d.groupId && (
                      <button
                        onClick={async () => {
                          if (!confirm('Odłączyć ten produkt od grupy wariantów?')) return;
                          setSaving(true);
                          try {
                            await updateProduct(id, { groupId: id });
                            onSaved();
                          } catch (e) {
                            setErr((e as Error).message);
                          } finally {
                            setSaving(false);
                          }
                        }}
                        disabled={saving}
                        className={btn}
                      >
                        Odłącz od grupy
                      </button>
                    )}
                    <button onClick={() => setEdit(true)} className={btn}>Edytuj</button>
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-2">
                <Field label="Nazwa" value={form.name ?? ''} onChange={(v) => setForm((f) => ({ ...f, name: v }))} />
                <Field label="ID Optima" value={form.optimaId ?? ''} onChange={(v) => setForm((f) => ({ ...f, optimaId: v }))} />
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Kategoria" value={form.category ?? ''} onChange={(v) => setForm((f) => ({ ...f, category: v }))} />
                  <Field label="Podtyp" value={form.subtype ?? ''} onChange={(v) => setForm((f) => ({ ...f, subtype: v }))} />
                </div>
                <Field label="Grupa wariantów (group_id)" value={form.groupId ?? ''} onChange={(v) => setForm((f) => ({ ...f, groupId: v }))} />
                {d.groupId && <div className="text-xs text-slate-400">Warianty łączy wspólny group_id.</div>}
                <div>
                  <div className="mb-1 text-xs font-medium text-slate-500">Parametry (JSON)</div>
                  <textarea value={paramsText} onChange={(e) => setParamsText(e.target.value)} rows={8} className="w-full rounded border border-slate-300 p-2 font-mono text-xs" />
                </div>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setEdit(false)} disabled={saving} className={btn}>Anuluj</button>
                  <button onClick={save} disabled={saving} className="rounded bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50">
                    {saving ? 'Zapisuję…' : 'Zapisz'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
    {zoom && (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
        onClick={() => setZoom(null)}
        title="Kliknij, aby zamknąć"
      >
        <img src={zoom} alt="" className="max-h-full max-w-full cursor-zoom-out object-contain" />
      </div>
    )}
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-slate-500">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </>
  );
}

const SPEC_LABELS: Record<string, string> = {
  power_w: 'Moc (W)', lumens: 'Strumień (lm)', cct_k: 'Barwa (K)', ip: 'IP',
  beam_deg: 'Kąt (°)', voltage_v: 'Napięcie (V)', colors: 'Kolory',
};

function fmt(v: unknown): string {
  return Array.isArray(v) ? v.join(', ') : String(v);
}

function SpecView({ params, images }: { params: Record<string, unknown>; images: ProductImage[] }) {
  const specs = (params?.specs ?? {}) as Record<string, unknown>;
  const extra: [string, unknown][] = [
    ['Materiał', params?.material], ['Wykończenie', params?.finish], ['Źródło światła', params?.light_source],
  ];
  const specRows = [
    ...Object.entries(specs).map(([k, v]) => [SPEC_LABELS[k] ?? k, v] as [string, unknown]),
    ...extra,
  ].filter(([, v]) => v != null && v !== '');
  const desc = images.find((im) => im.attributes)?.attributes as Record<string, unknown> | undefined;

  return (
    <div className="space-y-2">
      <div>
        <div className="mb-1 text-xs font-medium text-slate-500">Specyfikacja</div>
        {specRows.length ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-sm sm:grid-cols-3">
            {specRows.map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-slate-100 py-0.5">
                <dt className="text-slate-500">{k}</dt>
                <dd className="font-medium">{fmt(v)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <div className="text-xs text-slate-400">Brak danych technicznych.</div>
        )}
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-slate-500">Opis wizualny</div>
        {desc ? (
          <p className="text-sm text-slate-700">{String(desc.opis_swobodny ?? JSON.stringify(desc))}</p>
        ) : (
          <div className="text-xs text-slate-400">Brak opisu wizualnego (do uzupełnienia — Faza 8.5).</div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block text-sm">
      <span className="mb-0.5 block text-xs font-medium text-slate-500">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm" />
    </label>
  );
}
