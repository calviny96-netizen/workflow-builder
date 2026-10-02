// Membaca tabel Markdown dari laporan AI. Murni, tanpa dependensi.

export interface MdTable {
  columns: string[];
  rows: string[][];
}

// Memecah satu baris tabel; "\|" di dalam sel tidak dianggap pemisah.
function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (body[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += body[i];
  }
  cells.push(cur.trim());
  return cells;
}

const isSeparator = (line: string) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());
const isRow = (line: string) => line.trim().startsWith('|') && line.trim().length > 1;

// Membersihkan hiasan Markdown di dalam sel: **tebal**, `kode`, <br>.
function cleanCell(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

export function parseMarkdownTables(text: string): MdTable[] {
  // Pagar kode dibuang, isinya dipertahankan: AI sering membungkus tabel dengan ```markdown.
  const lines = String(text ?? '').replace(/```[a-zA-Z]*\s*$/gm, '').split(/\r?\n/);
  const tables: MdTable[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!(isRow(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1]))) {
      i++;
      continue;
    }
    const columns = splitRow(lines[i]).map(cleanCell);
    const rows: string[][] = [];
    i += 2;
    while (i < lines.length && isRow(lines[i])) {
      if (!isSeparator(lines[i])) {
        const cells = splitRow(lines[i]).map(cleanCell);
        // Header yang diulang AI di tengah tabel panjang dilewati.
        const repeated = cells.length === columns.length && cells.every((c, k) => c === columns[k]);
        if (!repeated && cells.some((c) => c !== '')) {
          rows.push(columns.map((_, k) => cells[k] ?? ''));
        }
      }
      i++;
    }
    tables.push({ columns, rows });
  }
  return tables;
}

// Menggabungkan tabel dari banyak laporan. Tabel dengan header sama (tanpa peduli huruf besar/spasi)
// menjadi satu; kolom tambahan di depan menandai asal tiap baris.
export function mergeTables(inputs: { tables: MdTable[]; extra: Record<string, string> }[]): MdTable[] {
  const norm = (c: string) => c.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const out = new Map<string, MdTable>();
  for (const inp of inputs) {
    const extraCols = Object.keys(inp.extra);
    for (const t of inp.tables) {
      const key = t.columns.map(norm).join('|');
      if (!out.has(key)) out.set(key, { columns: [...extraCols, ...t.columns], rows: [] });
      const target = out.get(key)!;
      for (const r of t.rows) target.rows.push([...extraCols.map((c) => inp.extra[c]), ...r]);
    }
  }
  return [...out.values()];
}

// Markdown → teks polos untuk unduhan .txt
export function plainText(md: string): string {
  return String(md ?? '')
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}
