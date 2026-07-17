import { useState } from 'react';
import IngestPage from './pages/IngestPage';
import SearchPage from './pages/SearchPage';
import CatalogPage from './pages/CatalogPage';

type View = 'search' | 'catalog' | 'ingest';

export default function App() {
  const [view, setView] = useState<View>('search');
  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="border-b bg-white">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3">
          <span className="mr-4 font-semibold">maxai</span>
          <button className={tab(view === 'search')} onClick={() => setView('search')}>
            Wyszukiwanie
          </button>
          <button className={tab(view === 'catalog')} onClick={() => setView('catalog')}>
            Katalog
          </button>
          <button className={tab(view === 'ingest')} onClick={() => setView('ingest')}>
            Zasilanie bazy
          </button>
        </div>
      </nav>
      {view === 'search' ? <SearchPage /> : view === 'catalog' ? <CatalogPage /> : <IngestPage />}
    </div>
  );
}

function tab(active: boolean): string {
  return active
    ? 'rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white'
    : 'rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100';
}
