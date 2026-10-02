// Nama file hasil export. Dipakai server saat membuat file dan kanvas saat menampilkan contoh.

export const DEFAULT_FILE_PATTERN = '{{sales}}-{{periode}}-{{judul}}';

export interface FileNameVars {
  sales: string;
  periode: string;
  judul: string;
  workflow: string;
  bagian: string;
}

// "2026-09-01" + "2026-09-07" → "2026-09-01 sd 2026-09-07"; satu hari cukup satu tanggal.
export function periodText(start?: string | null, end?: string | null): string {
  const a = String(start ?? '').slice(0, 10);
  const b = String(end ?? '').slice(0, 10);
  if (!a && !b) return '';
  if (!b || a === b) return a;
  if (!a) return b;
  return `${a} sd ${b}`;
}

// Karakter yang dilarang sistem berkas dibuang; bagian kosong tidak meninggalkan tanda hubung ganda.
export function fileNameFrom(pattern: string, vars: FileNameVars): string {
  const filled = String(pattern || DEFAULT_FILE_PATTERN).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => (k in vars ? String((vars as any)[k] ?? '') : m));
  const clean = filled
    .replace(/[\\/:*?"<>|\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(\s*-\s*){2,}/g, '-')
    .replace(/^[\s\-_.]+|[\s\-_.]+$/g, '')
    .slice(0, 150);
  return clean || 'laporan';
}

// Nama kembar diberi nomor: "a.pdf", "a (2).pdf".
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const count = (seen.get(n.toLowerCase()) ?? 0) + 1;
    seen.set(n.toLowerCase(), count);
    if (count === 1) return n;
    const dot = n.lastIndexOf('.');
    return dot > 0 ? `${n.slice(0, dot)} (${count})${n.slice(dot)}` : `${n} (${count})`;
  });
}
