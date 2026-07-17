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
  imageKey: string;
  sourceUrl?: string;
  params: Record<string, unknown>;
}): Promise<{ id: string }> {
  const r = await fetch(`${API_URL}/products`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`products: ${r.status}`);
  return r.json();
}
