export class ApiError extends Error {
  status: number;
  issues: string[];
  constructor(message: string, status: number, issues: string[] = []) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // balasan bukan JSON (mis. server mati di balik proxy)
  }
  if (!res.ok) {
    if (res.status === 401 && !url.includes('/auth/')) window.dispatchEvent(new Event('aawb:unauthorized'));
    throw new ApiError(json?.error || `Server membalas ${res.status}`, res.status, json?.issues ?? []);
  }
  return json as T;
}

export const fmt = (n: number | null | undefined) => (n == null ? '-' : Number(n).toLocaleString('id-ID'));

export function fmtTime(iso: string | null | undefined) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export const STATUS_LABEL: Record<string, string> = {
  planning: 'Menyusun rencana',
  plan_failed: 'Rencana gagal',
  awaiting_chunk: 'Menunggu ukuran chunk',
  awaiting_approval: 'Menunggu persetujuan',
  running: 'Berjalan',
  completed: 'Selesai',
  failed: 'Gagal',
  cancelled: 'Dibatalkan',
  planned: 'Direncanakan',
  queued: 'Antre',
  starting: 'Memulai',
  done: 'Selesai',
  skipped: 'Dilewati',
  waiting: 'Menunggu',
};
