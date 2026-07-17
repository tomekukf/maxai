import { useState, type ReactNode } from 'react';
import { uploadFile, extractParams, saveProduct } from '../lib/api';

const inputCls =
  'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400';
const btnPrimary =
  'rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50';
const btnSecondary =
  'mt-2 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50';

export default function IngestPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [optimaId, setOptimaId] = useState('');
  const [name, setName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [description, setDescription] = useState('');
  const [paramsText, setParamsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function handleExtract() {
    setMsg(null);
    if (!description.trim()) {
      setMsg({ kind: 'err', text: 'Wpisz opis produktu.' });
      return;
    }
    setBusy(true);
    try {
      const params = await extractParams(description.trim());
      setParamsText(JSON.stringify(params, null, 2));
      setMsg({ kind: 'ok', text: 'Wyciągnięto parametry — sprawdź i popraw jeśli trzeba.' });
    } catch (e) {
      setMsg({ kind: 'err', text: `Błąd ekstrakcji: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    setMsg(null);
    if (!files.length) {
      setMsg({ kind: 'err', text: 'Wybierz co najmniej jedno zdjęcie.' });
      return;
    }
    if (!optimaId.trim()) {
      setMsg({ kind: 'err', text: 'Podaj ID Optima.' });
      return;
    }
    let params: Record<string, unknown> = {};
    if (paramsText.trim()) {
      try {
        params = JSON.parse(paramsText);
      } catch {
        setMsg({ kind: 'err', text: 'Parametry nie są poprawnym JSON.' });
        return;
      }
    }
    setBusy(true);
    try {
      const imageKeys: string[] = [];
      for (const f of files) imageKeys.push(await uploadFile(f));
      const { id, images } = await saveProduct({
        optimaId: optimaId.trim(),
        name: name.trim() || undefined,
        sourceUrl: sourceUrl.trim() || undefined,
        imageKeys,
        params,
      });
      setMsg({ kind: 'ok', text: `Zapisano produkt (id: ${id}, zdjęć: ${images}).` });
      setFiles([]);
      setDescription('');
      setParamsText('');
      setName('');
      setSourceUrl('');
    } catch (e) {
      setMsg({ kind: 'err', text: `Błąd zapisu: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b bg-white">
        <div className="mx-auto max-w-3xl px-4 py-4">
          <h1 className="text-xl font-semibold">maxai — zasilanie bazy</h1>
          <p className="text-sm text-slate-500">Dodaj produkt: zdjęcie + opis → parametry → zapis.</p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-5 px-4 py-6">
        <Field label="Zdjęcia produktu (można wiele)">
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className="block w-full text-sm"
          />
          {files.length > 0 && (
            <p className="mt-1 text-xs text-slate-500">
              {files.length} plik(ów): {files.map((f) => f.name).join(', ')}
            </p>
          )}
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="ID Optima *">
            <input
              value={optimaId}
              onChange={(e) => setOptimaId(e.target.value)}
              placeholder="AGATA-VER-3F-GRN"
              className={inputCls}
            />
          </Field>
          <Field label="Nazwa">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Sofa VERONA"
              className={inputCls}
            />
          </Field>
        </div>

        <Field label="Link do produktu (opcjonalnie)">
          <input
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://www.agatameble.pl/..."
            className={inputCls}
          />
        </Field>

        <Field label="Surowy opis producenta">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={5}
            placeholder="Wklej opis produktu..."
            className={inputCls}
          />
          <button onClick={handleExtract} disabled={busy} className={btnSecondary}>
            Wyciągnij parametry (Haiku)
          </button>
        </Field>

        <Field label="Parametry (JSON — edytowalne)">
          <textarea
            value={paramsText}
            onChange={(e) => setParamsText(e.target.value)}
            rows={10}
            placeholder="{ ... }"
            className={`${inputCls} font-mono text-xs`}
          />
        </Field>

        <div className="flex items-center gap-3">
          <button onClick={handleSave} disabled={busy} className={btnPrimary}>
            {busy ? 'Pracuję...' : 'Zapisz produkt'}
          </button>
          {msg && (
            <span className={msg.kind === 'ok' ? 'text-sm text-green-700' : 'text-sm text-red-700'}>
              {msg.text}
            </span>
          )}
        </div>
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
