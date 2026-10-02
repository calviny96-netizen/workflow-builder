import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeTables, parseMarkdownTables, plainText } from './table.ts';

test('tabel sederhana dengan teks di sekitarnya', () => {
  const t = parseMarkdownTables('# Rekap\n\nAda 2 komplain.\n\n| No | Pelanggan | Masalah |\n|---|:--|--:|\n| 1 | Ibu Sari | Luntur |\n| 2 | Pak Budi | Terlambat |\n\nSelesai.');
  assert.equal(t.length, 1);
  assert.deepEqual(t[0].columns, ['No', 'Pelanggan', 'Masalah']);
  assert.deepEqual(t[0].rows, [['1', 'Ibu Sari', 'Luntur'], ['2', 'Pak Budi', 'Terlambat']]);
});

test('pagar kode, header berulang, sel kurang/lebih, hiasan markdown, pipa ter-escape', () => {
  const md = '```markdown\n| A | B | C |\n| --- | --- | --- |\n| **x** | `y` | a\\|b |\n| A | B | C |\n| 1 | 2 |\n| 1 | 2 | 3 | 4 |\n|  |  |  |\n```';
  const t = parseMarkdownTables(md);
  assert.equal(t.length, 1);
  assert.deepEqual(t[0].rows, [['x', 'y', 'a|b'], ['1', '2', ''], ['1', '2', '3']]);
});

test('dua tabel dalam satu laporan, dan laporan tanpa tabel', () => {
  const t = parseMarkdownTables('| A |\n|---|\n| 1 |\n\nteks\n\n| X | Y |\n|---|---|\n| p | q |\n');
  assert.deepEqual(t.map((x) => x.columns), [['A'], ['X', 'Y']]);
  assert.deepEqual(parseMarkdownTables('Tidak ada komplain pada periode ini.'), []);
  assert.deepEqual(parseMarkdownTables('| bukan tabel karena tanpa garis pemisah |'), []);
});

test('gabung tabel: header sama menjadi satu, kolom asal ditambahkan', () => {
  const a = parseMarkdownTables('| No | Nama |\n|---|---|\n| 1 | A |');
  const b = parseMarkdownTables('| no | NAMA |\n|---|---|\n| 1 | B |\n\n| Lain |\n|---|\n| z |');
  const m = mergeTables([
    { tables: a, extra: { Sumber: 'Cabang 1', Bagian: '1-5 Jul' } },
    { tables: b, extra: { Sumber: 'Cabang 2', Bagian: '1-5 Jul' } },
  ]);
  assert.equal(m.length, 2);
  assert.deepEqual(m[0].columns, ['Sumber', 'Bagian', 'No', 'Nama']);
  assert.deepEqual(m[0].rows, [['Cabang 1', '1-5 Jul', '1', 'A'], ['Cabang 2', '1-5 Jul', '1', 'B']]);
  assert.deepEqual(m[1].rows, [['Cabang 2', '1-5 Jul', 'z']]);
});

test('teks polos', () => {
  assert.equal(plainText('# Judul\n\n**tebal** dan `kode`'), 'Judul\n\ntebal dan kode');
});
