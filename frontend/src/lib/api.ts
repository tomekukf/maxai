const API_URL = import.meta.env.VITE_API_URL as string;

if (!API_URL) {
  // eslint-disable-next-line no-console
  console.warn('Brak VITE_API_URL — ustaw w frontend/.env.local');
}

// Token JWT (Cognito) do operacji admina; ustawiany po zalogowaniu.
let authToken: string | null = null;
export function setAuthToken(t: string | null) {
  authToken = t;
}
function authHeaders(): Record<string, string> {
  return authToken ? { authorization: `Bearer ${authToken}` } : {};
}

export async function presign(
  filename: string,
  prefix: string,
): Promise<{ uploadUrl: string; key: string }> {
  const r = await fetch(`${API_URL}/uploads/presign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ filename, prefix }),
  });
  if (!r.ok) throw new Error(`presign: ${r.status}`);
  return r.json();
}

/**
 * Konwertuje dowolny obraz dekodowalny przez przeglądarkę (AVIF/WebP/PNG/JPEG/…)
 * na JPEG i skaluje do maxSize (dłuższy bok). Titan przyjmuje tylko JPEG/PNG.
 */
async function toJpeg(file: File, maxSize = 1568, quality = 0.9): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Nie moge odczytac obrazu (nieobslugiwany format).');
  }
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Brak kontekstu canvas.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Konwersja do JPEG nieudana.'))), 'image/jpeg', quality),
  );
}

export async function uploadFile(file: File, prefix = 'product-images'): Promise<string> {
  const jpeg = await toJpeg(file);
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  const { uploadUrl, key } = await presign(name, prefix);
  const put = await fetch(uploadUrl, { method: 'PUT', body: jpeg });
  if (!put.ok) throw new Error(`upload: ${put.status}`);
  return key;
}

// Upload pliku BEZ konwersji (import kolekcji — zdjęcia już są JPEG/PNG z ekstrakcji lokalnej).
export async function uploadRaw(file: File, prefix = 'imported'): Promise<string> {
  const { uploadUrl, key } = await presign(file.name, prefix);
  const put = await fetch(uploadUrl, { method: 'PUT', body: file });
  if (!put.ok) throw new Error(`upload: ${put.status}`);
  return key;
}

export type CatalogMeta = {
  name?: string;
  manufacturer?: string;
  domainCategory?: string;
  pdfKey?: string;
  pageCount?: number;
};

export async function createCatalog(meta: CatalogMeta): Promise<{ id: string }> {
  const r = await fetch(`${API_URL}/catalogs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(meta),
  });
  if (!r.ok) throw new Error(`catalogs: ${r.status}`);
  return r.json();
}

export type CatalogListItem = {
  id: string;
  name: string;
  manufacturer: string;
  domainCategory: string;
  pageCount: number;
  productCount: number;
};

export async function listCatalogs(): Promise<CatalogListItem[]> {
  const r = await fetch(`${API_URL}/catalogs`, { method: 'GET' });
  if (!r.ok) throw new Error(`catalogs list: ${r.status}`);
  return (await r.json()).items ?? [];
}

export async function exportCatalog(id: string): Promise<{ downloadUrl: string; productCount: number }> {
  const r = await fetch(`${API_URL}/catalogs/${encodeURIComponent(id)}/export`, { method: 'GET' });
  if (!r.ok) throw new Error(`export: ${r.status}`);
  return r.json();
}

// Usuń całe źródło (katalog) + jego produkty/zdjęcia (kaskada + S3). Tylko admin.
export async function deleteCatalog(id: string): Promise<{ deleted: number }> {
  const r = await fetch(`${API_URL}/catalogs/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() });
  if (!r.ok) throw new Error(`delete catalog: ${r.status}`);
  return r.json();
}

// Zapis produktu z importu (surowe body — pola katalogowe, images z embeddingiem/attributes).
export async function importProduct(body: Record<string, unknown>): Promise<{ id?: string; duplicate?: boolean }> {
  const r = await fetch(`${API_URL}/products`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error((e as { error?: string }).error ?? `products: ${r.status}`);
  }
  return r.json();
}

export async function extractParams(description: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${API_URL}/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description }),
  });
  if (!r.ok) throw new Error(`extract: ${r.status}`);
  const data = await r.json();
  return data.params;
}

export async function saveProduct(input: {
  optimaId: string;
  name?: string;
  imageKeys: string[];
  sourceUrl?: string;
  params: Record<string, unknown>;
}): Promise<{ id: string; images: number }> {
  const r = await fetch(`${API_URL}/products`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`products: ${r.status}`);
  return r.json();
}

export type SearchResult = {
  id?: string;
  optimaId: string | null;
  name: string;
  subtype?: string | null;
  groupId?: string | null;
  params: Record<string, unknown>;
  imageUrl: string;
  similarity: number; // ocena dopasowania (rerank 0-1) lub cosinus Titana (fallback)
  visualSimilarity?: number; // surowy cosinus Titana
  reranked?: boolean;
  source?: string; // 'optima' | 'catalog'
  category?: string;
  // Wyjaśnialność (analityka):
  rerankScore?: number | null; // ocena rerankingu 0-100 (null = fallback wizualny)
  reason?: string | null; // krótkie uzasadnienie modelu
  attributes?: Record<string, unknown> | null; // opis wizualny produktu (jeśli jest)
  // Odniesienie do katalogu producenta (gdy source === 'catalog'):
  manufacturer?: string;
  catalogName?: string;
  catalogPage?: number; // strona PDF (1-based) do #page=N
  catalogUrl?: string; // presigned link do PDF w S3 (cały katalog)
  catalogPageImageUrl?: string; // lekki obraz pojedynczej strony katalogu
};

export type SearchResponse = {
  results: SearchResult[];
  queryCategory?: string | null;
  queryAttributes?: Record<string, unknown> | null; // co system „zrozumiał" z wycinka
};

export async function searchByImage(imageBase64: string, topK = 3, hint?: string): Promise<SearchResponse> {
  const r = await fetch(`${API_URL}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // hint = etykieta z detekcji (np. „stolik kawowy") — naprowadza opis zapytania na właściwy obiekt.
    body: JSON.stringify({ imageBase64, topK, ...(hint ? { hint } : {}) }),
  });
  if (!r.ok) throw new Error(`search: ${r.status}`);
  const data = await r.json();
  return {
    results: (data.results ?? []) as SearchResult[],
    queryCategory: data.queryCategory ?? null,
    queryAttributes: data.queryAttributes ?? null,
  };
}

export type Product = {
  id: string;
  optimaId: string | null;
  name: string;
  params: Record<string, unknown>;
  source?: string;
  category?: string;
  subtype?: string;
  groupId?: string | null;
  manufacturerCode?: string;
  imageUrl: string;
  imageCount?: number;
};

export type ProductImage = {
  imageUrl: string;
  attributes?: Record<string, unknown> | null;
  sortOrder: number;
};

export type ProductDetail = {
  id: string;
  optimaId: string | null;
  name: string;
  params: Record<string, unknown>;
  source?: string;
  category?: string;
  subtype?: string;
  manufacturer?: string;
  manufacturerCode?: string;
  groupId?: string | null;
  images: ProductImage[];
  catalog?: { name: string; page: number; pdfUrl: string; pageImageUrl?: string };
};

// Pola edytowalne w panelu (PUT /products/{id}).
export type ProductPatch = Partial<{
  name: string;
  optimaId: string;
  category: string;
  subtype: string;
  manufacturer: string;
  manufacturerCode: string;
  groupId: string;
  sourceUrl: string;
  params: Record<string, unknown>;
}>;

export type ProductQuery = {
  q?: string;
  category?: string;
  source?: string;
  limit?: number;
  offset?: number;
  slim?: boolean; // bez presignów (statystyki)
};

export type ProductPage = {
  items: Product[];
  total: number;
  limit: number;
  offset: number;
};

export async function listProducts(query: ProductQuery = {}): Promise<ProductPage> {
  const p = new URLSearchParams();
  if (query.q) p.set('q', query.q);
  if (query.category) p.set('category', query.category);
  if (query.source) p.set('source', query.source);
  if (query.slim) p.set('slim', '1');
  p.set('limit', String(query.limit ?? 60));
  p.set('offset', String(query.offset ?? 0));
  const r = await fetch(`${API_URL}/products?${p.toString()}`, { method: 'GET' });
  if (!r.ok) throw new Error(`products list: ${r.status}`);
  const data = await r.json();
  return {
    items: (data.items ?? []) as Product[],
    total: Number(data.total ?? (data.items?.length ?? 0)),
    limit: Number(data.limit ?? query.limit ?? 60),
    offset: Number(data.offset ?? query.offset ?? 0),
  };
}

export type CategoryCount = { category: string; count: number };

export async function getCategories(): Promise<CategoryCount[]> {
  const r = await fetch(`${API_URL}/categories`, { method: 'GET' });
  if (!r.ok) throw new Error(`categories: ${r.status}`);
  const data = await r.json();
  return (data.items ?? []) as CategoryCount[];
}

export async function getProduct(id: string): Promise<ProductDetail> {
  const r = await fetch(`${API_URL}/products/${encodeURIComponent(id)}`, { method: 'GET' });
  if (!r.ok) throw new Error(`product detail: ${r.status}`);
  const data = await r.json();
  return data.product as ProductDetail;
}

export async function updateProduct(id: string, patch: ProductPatch): Promise<{ id: string; updated: boolean }> {
  const r = await fetch(`${API_URL}/products/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error((e as { error?: string }).error ?? `update: ${r.status}`);
  }
  return r.json();
}

export async function deleteProduct(id: string): Promise<{ deleted: number }> {
  const r = await fetch(`${API_URL}/products/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() });
  if (!r.ok) throw new Error(`delete: ${r.status}`);
  return r.json();
}

export async function deleteAllProducts(): Promise<{ deleted: number }> {
  const r = await fetch(`${API_URL}/products`, { method: 'DELETE', headers: authHeaders() });
  if (!r.ok) throw new Error(`delete all: ${r.status}`);
  return r.json();
}

export type Box = { x: number; y: number; w: number; h: number };
export type DetectedItem = { label: string; box: Box };

export async function detectItems(imageBase64: string): Promise<DetectedItem[]> {
  const r = await fetch(`${API_URL}/detect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageBase64 }),
  });
  if (!r.ok) throw new Error(`detect: ${r.status}`);
  const data = await r.json();
  return (data.items ?? []) as DetectedItem[];
}
