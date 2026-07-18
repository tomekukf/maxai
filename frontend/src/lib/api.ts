const API_URL = import.meta.env.VITE_API_URL as string;

if (!API_URL) {
  // eslint-disable-next-line no-console
  console.warn('Brak VITE_API_URL — ustaw w frontend/.env.local');
}

export async function presign(
  filename: string,
  prefix: string,
): Promise<{ uploadUrl: string; key: string }> {
  const r = await fetch(`${API_URL}/uploads/presign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`products: ${r.status}`);
  return r.json();
}

export type SearchResult = {
  optimaId: string | null;
  name: string;
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
  catalogUrl?: string; // presigned link do PDF w S3
};

export type SearchResponse = {
  results: SearchResult[];
  queryCategory?: string | null;
  queryAttributes?: Record<string, unknown> | null; // co system „zrozumiał" z wycinka
};

export async function searchByImage(imageBase64: string, topK = 3): Promise<SearchResponse> {
  const r = await fetch(`${API_URL}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageBase64, topK }),
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
  images: ProductImage[];
  catalog?: { name: string; page: number; pdfUrl: string };
};

// Pola edytowalne w panelu (PUT /products/{id}).
export type ProductPatch = Partial<{
  name: string;
  optimaId: string;
  category: string;
  subtype: string;
  manufacturer: string;
  manufacturerCode: string;
  sourceUrl: string;
  params: Record<string, unknown>;
}>;

export async function listProducts(): Promise<Product[]> {
  const r = await fetch(`${API_URL}/products`, { method: 'GET' });
  if (!r.ok) throw new Error(`products list: ${r.status}`);
  const data = await r.json();
  return (data.items ?? []) as Product[];
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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error((e as { error?: string }).error ?? `update: ${r.status}`);
  }
  return r.json();
}

export async function deleteProduct(id: string): Promise<{ deleted: number }> {
  const r = await fetch(`${API_URL}/products/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`delete: ${r.status}`);
  return r.json();
}

export async function deleteAllProducts(): Promise<{ deleted: number }> {
  const r = await fetch(`${API_URL}/products`, { method: 'DELETE' });
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
