import { useState } from 'react';
import IngestPage from './pages/IngestPage';
import SearchPage from './pages/SearchPage';
import CatalogPage from './pages/CatalogPage';
import StatsPage from './pages/StatsPage';
import AdminDocsPage from './pages/AdminDocsPage';
import ImportPage from './pages/ImportPage';

type Area = 'user' | 'admin';
type UserView = 'search' | 'catalog';
type AdminView = 'catalog' | 'import' | 'ingest' | 'stats' | 'docs';

const ADMIN_PASSWORD = (import.meta.env.VITE_ADMIN_PASSWORD as string | undefined) ?? '';

export default function App() {
  const [area, setArea] = useState<Area>('user');
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [userView, setUserView] = useState<UserView>('search');
  const [adminView, setAdminView] = useState<AdminView>('catalog');

  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="border-b bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-3">
          <span className="mr-2 font-semibold">maxai</span>
          <span className="mr-2 text-xs text-slate-400">
            {area === 'admin' ? 'panel admina' : 'panel handlowca'}
          </span>

          {area === 'user' ? (
            <>
              <button className={tab(userView === 'search')} onClick={() => setUserView('search')}>Wyszukiwanie</button>
              <button className={tab(userView === 'catalog')} onClick={() => setUserView('catalog')}>Katalog</button>
              <button className="ml-auto rounded-md px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100" onClick={() => setArea('admin')}>
                Admin →
              </button>
            </>
          ) : adminUnlocked ? (
            <>
              <button className={tab(adminView === 'catalog')} onClick={() => setAdminView('catalog')}>Katalog</button>
              <button className={tab(adminView === 'import')} onClick={() => setAdminView('import')}>Import kolekcji</button>
              <button className={tab(adminView === 'ingest')} onClick={() => setAdminView('ingest')}>Zasilanie</button>
              <button className={tab(adminView === 'stats')} onClick={() => setAdminView('stats')}>Statystyki</button>
              <button className={tab(adminView === 'docs')} onClick={() => setAdminView('docs')}>Dokumentacja</button>
              <button className="ml-auto rounded-md px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100" onClick={() => setArea('user')}>
                ← Panel handlowca
              </button>
            </>
          ) : (
            <button className="ml-auto rounded-md px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100" onClick={() => setArea('user')}>
              ← Panel handlowca
            </button>
          )}
        </div>
      </nav>

      {area === 'user' && userView === 'search' && <SearchPage />}
      {area === 'user' && userView === 'catalog' && <CatalogPage admin={false} />}

      {area === 'admin' && !adminUnlocked && <AdminGate onUnlock={() => setAdminUnlocked(true)} />}
      {area === 'admin' && adminUnlocked && adminView === 'catalog' && <CatalogPage admin />}
      {area === 'admin' && adminUnlocked && adminView === 'import' && <ImportPage />}
      {area === 'admin' && adminUnlocked && adminView === 'ingest' && <IngestPage />}
      {area === 'admin' && adminUnlocked && adminView === 'stats' && <StatsPage />}
      {area === 'admin' && adminUnlocked && adminView === 'docs' && <AdminDocsPage />}
    </div>
  );
}

function AdminGate({ onUnlock }: { onUnlock: () => void }) {
  const [pwd, setPwd] = useState('');
  const [err, setErr] = useState(false);
  function submit() {
    // Interim: prosty gate UX. NIE zabezpiecza API (docelowo Cognito + authorizer, Krok 7.4).
    if (!ADMIN_PASSWORD || pwd === ADMIN_PASSWORD) onUnlock();
    else setErr(true);
  }
  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <div className="rounded-lg border bg-white p-5">
        <h2 className="text-lg font-semibold">Panel admina</h2>
        <p className="mt-1 text-sm text-slate-500">
          Podaj hasło administratora.
          {!ADMIN_PASSWORD && ' (Brak VITE_ADMIN_PASSWORD — tryb dev: dowolne hasło.)'}
        </p>
        <input
          type="password"
          value={pwd}
          onChange={(e) => { setPwd(e.target.value); setErr(false); }}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          className="mt-3 w-full rounded border border-slate-300 px-3 py-1.5 text-sm"
          placeholder="hasło"
        />
        {err && <div className="mt-1 text-xs text-red-700">Błędne hasło.</div>}
        <button onClick={submit} className="mt-3 w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">
          Wejdź
        </button>
        <p className="mt-3 text-[11px] text-slate-400">
          Uwaga: to rozdział interfejsu (UX). Zabezpieczenie API (role) — Cognito, Krok 7.4.
        </p>
      </div>
    </main>
  );
}

function tab(active: boolean): string {
  return active
    ? 'rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white'
    : 'rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100';
}
