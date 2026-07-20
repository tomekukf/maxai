// Schowek ofertowy handlowca — lista produktów „do oferty", trzymana lokalnie (localStorage).
// Niezależny od backendu; pomaga zebrać kandydatów do przedstawienia klientowi.
import { useSyncExternalStore } from 'react';

export type ShortItem = {
  id: string;
  name: string;
  code?: string | null; // ID Optima / SKU / kod
  source?: string;
  manufacturer?: string;
  imageUrl?: string; // presigned (może wygasnąć po ~1h — to narzędzie sesyjne)
};

const KEY = 'maxai_shortlist';
const listeners = new Set<() => void>();

function read(): ShortItem[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}
function write(items: ShortItem[]) {
  localStorage.setItem(KEY, JSON.stringify(items));
  listeners.forEach((l) => l());
}

export function addToShortlist(item: ShortItem) {
  const items = read();
  if (!items.some((x) => x.id === item.id)) write([...items, item]);
}
export function removeFromShortlist(id: string) {
  write(read().filter((x) => x.id !== id));
}
export function clearShortlist() {
  write([]);
}
export function toggleShortlist(item: ShortItem) {
  const items = read();
  if (items.some((x) => x.id === item.id)) removeFromShortlist(item.id);
  else addToShortlist(item);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => e.key === KEY && cb();
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', onStorage);
  };
}

export function useShortlist(): ShortItem[] {
  return useSyncExternalStore(subscribe, read, () => []);
}
