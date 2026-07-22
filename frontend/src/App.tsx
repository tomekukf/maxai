import { useEffect, useState } from 'react';
import IngestPage from './pages/IngestPage';
import SearchPage from './pages/SearchPage';
import CatalogPage from './pages/CatalogPage';
import StatsPage from './pages/StatsPage';
import AdminDocsPage from './pages/AdminDocsPage';
import ImportPage from './pages/ImportPage';
import ShortlistPage from './pages/ShortlistPage';
import { login, loadSession, logout, isAdmin, type Session } from './lib/auth';
import { setAuthToken } from './lib/api';
import { useShortlist } from './lib/shortlist';

type Area = 'user' | 'admin';
type UserView = 'search' | 'catalog' | 'shortlist';
type AdminView = 'search' | 'catalog' | 'shortlist' | 'import' | 'ingest' | 'stats' | 'docs';

export default function App() {
  const [area, setArea] = useState<Area>('user');
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [userView, setUserView] = useState<UserView>('search');
  const [adminView, setAdminView] = useState<AdminView>('catalog');
  const shortlist = useShortlist();
  const schowekLabel = `Schowek${shortlist.length ? ` (${shortlist.length})` : ''}`;

  useEffect(() => {
    const s = loadSession();
    if (s) {
      setAuthToken(s.idToken);
      setSession(s);
    }
    setReady(true);
  }, []);

  function onLogin(s: Session) {
    setAuthToken(s.idToken);
    setSession(s);
  }
  function onLogout() {
    logout();
    setAuthToken(null);
    setSession(null);
    setArea('user');
  }

  const admin = isAdmin(session);

  if (!ready) return null;
  if (!session) return <LoginGate onLogin={onLogin} />;

  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="border-b bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-3">
          <span className="mr-2 text-lg font-semibold tracking-tight text-brand">maxai</span>
          <span className="mr-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
            {area === 'admin' ? 'panel admina' : 'panel handlowca'}
          </span>

          {area === 'user' ? (
            <>
              <button className={tab(userView === 'search')} onClick={() => setUserView('search')}>Wyszukiwanie</button>
              <button className={tab(userView === 'catalog')} onClick={() => setUserView('catalog')}>Katalog</button>
              <button className={tab(userView === 'shortlist')} onClick={() => setUserView('shortlist')}>{schowekLabel}</button>
              <span className="ml-auto text-xs text-slate-400">{session.username}</span>
              {admin && (
                <button className="rounded-md px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100" onClick={() => setArea('admin')}>
                  Admin →
                </button>
              )}
              <button className="rounded-md px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100" onClick={onLogout}>Wyloguj</button>
            </>
          ) : (
            <>
              <button className={tab(adminView === 'search')} onClick={() => setAdminView('search')}>Wyszukiwanie</button>
              <button className={tab(adminView === 'catalog')} onClick={() => setAdminView('catalog')}>Katalog</button>
              <button className={tab(adminView === 'shortlist')} onClick={() => setAdminView('shortlist')}>{schowekLabel}</button>
              <button className={tab(adminView === 'import')} onClick={() => setAdminView('import')}>Import kolekcji</button>
              <button className={tab(adminView === 'ingest')} onClick={() => setAdminView('ingest')}>Zasilanie</button>
              <button className={tab(adminView === 'stats')} onClick={() => setAdminView('stats')}>Statystyki</button>
              <button className={tab(adminView === 'docs')} onClick={() => setAdminView('docs')}>Dokumentacja</button>
              <span className="ml-auto text-xs text-slate-400">{session.username}</span>
              <button className="rounded-md px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100" onClick={() => setArea('user')}>
                ← Handlowiec
              </button>
              <button className="rounded-md px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100" onClick={onLogout}>Wyloguj</button>
            </>
          )}
        </div>
      </nav>

      {area === 'user' && userView === 'search' && <SearchPage admin={admin} />}
      {area === 'user' && userView === 'catalog' && <CatalogPage admin={false} />}
      {area === 'user' && userView === 'shortlist' && <ShortlistPage />}

      {area === 'admin' && admin && adminView === 'search' && <SearchPage admin />}
      {area === 'admin' && admin && adminView === 'catalog' && <CatalogPage admin />}
      {area === 'admin' && admin && adminView === 'shortlist' && <ShortlistPage />}
      {area === 'admin' && admin && adminView === 'import' && <ImportPage />}
      {area === 'admin' && admin && adminView === 'ingest' && <IngestPage />}
      {area === 'admin' && admin && adminView === 'stats' && <StatsPage />}
      {area === 'admin' && admin && adminView === 'docs' && <AdminDocsPage />}
    </div>
  );
}

function LoginGate({ onLogin }: { onLogin: (s: Session) => void }) {
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      onLogin(await login(u.trim(), p));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100">
      <main className="mx-auto max-w-sm px-4 py-20">
        <div className="rounded-2xl border bg-white p-6 shadow-card">
          <div className="mb-1 text-2xl font-semibold tracking-tight text-brand">maxai</div>
          <p className="mb-4 text-xs text-slate-400">Asystent doboru produktów — maxfliz</p>
          <h2 className="text-lg font-semibold">Logowanie</h2>
          <p className="mt-1 text-sm text-slate-500">Zaloguj się kontem handlowca lub administratora.</p>
          <input
            value={u}
            onChange={(e) => { setU(e.target.value); setErr(null); }}
            className="mt-3 w-full rounded border border-slate-300 px-3 py-1.5 text-sm"
            placeholder="login"
            autoComplete="username"
          />
          <input
            type="password"
            value={p}
            onChange={(e) => { setP(e.target.value); setErr(null); }}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            className="mt-2 w-full rounded border border-slate-300 px-3 py-1.5 text-sm"
            placeholder="hasło"
            autoComplete="current-password"
          />
          {err && <div className="mt-1 text-xs text-red-700">{err}</div>}
          <button onClick={submit} disabled={busy} className="mt-4 w-full rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50">
            {busy ? 'Logowanie…' : 'Zaloguj'}
          </button>
        </div>
      </main>
    </div>
  );
}

function tab(active: boolean): string {
  return active
    ? 'rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white'
    : 'rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100';
}
