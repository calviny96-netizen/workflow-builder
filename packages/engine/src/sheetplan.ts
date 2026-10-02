// Menentukan apa yang ditulis ke sebuah tab Google Sheets. Murni: tidak memanggil Google.

export type SheetMode = 'append' | 'upsert' | 'dedup';

export interface SheetWritePlan {
  header: string[] | null; // diisi bila tab masih kosong dan header perlu ditulis
  appends: string[][];
  updates: { row: number; values: string[] }[]; // row = nomor baris di sheet (1 = header)
  skipped: number; // baris yang dilewati karena kuncinya sudah ada
  ignoredColumns: string[]; // kolom data yang tidak ada di header sheet
  missingKeys: string[]; // kolom kunci yang tidak ditemukan
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function planSheetWrite(input: {
  existing: string[][]; // seluruh isi tab, baris pertama = header
  columns: string[];
  rows: string[][];
  mode: SheetMode;
  keyColumns: string[];
}): SheetWritePlan {
  const { existing, columns, rows, mode } = input;
  const empty = existing.length === 0 || existing[0].every((c) => String(c ?? '').trim() === '');
  const header = empty ? columns : existing[0].map((c) => String(c ?? ''));

  // Kolom data dipetakan ke kolom sheet lewat nama yang dinormalkan.
  const sheetIndex = new Map(header.map((h, i) => [norm(h), i]));
  const map = columns.map((c) => sheetIndex.get(norm(c)));
  const ignoredColumns = columns.filter((_, i) => map[i] === undefined);
  const align = (r: string[]) => {
    const out = new Array<string>(header.length).fill('');
    r.forEach((v, i) => {
      if (map[i] !== undefined) out[map[i]!] = v ?? '';
    });
    return out;
  };

  const plan: SheetWritePlan = { header: empty ? header : null, appends: [], updates: [], skipped: 0, ignoredColumns, missingKeys: [] };
  if (mode === 'append') {
    plan.appends = rows.map(align);
    return plan;
  }

  const keyIdx = input.keyColumns.map((k) => sheetIndex.get(norm(k)));
  plan.missingKeys = input.keyColumns.filter((_, i) => keyIdx[i] === undefined);
  if (!input.keyColumns.length || plan.missingKeys.length) return plan; // pemanggil menolak menulis

  const keyOf = (r: string[]) => keyIdx.map((i) => norm(r[i!])).join('|');
  const seen = new Map<string, number>(); // kunci → nomor baris sheet, atau -1 bila baru ditambahkan di batch ini
  (empty ? [] : existing.slice(1)).forEach((r, i) => {
    const k = keyOf(r.map((c) => String(c ?? '')));
    if (k.replace(/\|/g, '') !== '') seen.set(k, i + 2);
  });

  for (const raw of rows) {
    const r = align(raw);
    const k = keyOf(r);
    if (k.replace(/\|/g, '') === '') {
      plan.appends.push(r); // baris tanpa kunci tidak bisa dicocokkan; ditambahkan apa adanya
      continue;
    }
    const at = seen.get(k);
    if (at === undefined) {
      seen.set(k, -1 - plan.appends.length);
      plan.appends.push(r);
    } else if (mode === 'dedup') {
      plan.skipped += 1;
    } else if (at > 0) {
      // Sel yang tidak dibawa data baru dipertahankan dari sheet.
      const old = existing[at - 1] ?? [];
      const merged = r.map((v, i) => (map.includes(i) ? v : String(old[i] ?? '')));
      const prev = plan.updates.findIndex((u) => u.row === at);
      if (prev >= 0) plan.updates[prev].values = merged;
      else plan.updates.push({ row: at, values: merged });
    } else {
      plan.appends[-1 - at] = r; // kunci sama muncul dua kali di batch: yang terakhir menang
    }
  }
  return plan;
}

// "https://docs.google.com/spreadsheets/d/<id>/edit#gid=123" → { id, gid }
export function parseSheetUrl(url: string): { id: string; gid: number | null } | null {
  const s = String(url ?? '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/) ?? s.match(/^([a-zA-Z0-9_-]{30,})$/);
  if (!m) return null;
  const g = s.match(/[#?&]gid=(\d+)/);
  return { id: m[1], gid: g ? Number(g[1]) : null };
}
