import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileNameFrom, periodText, uniqueNames } from './filename.ts';

const v = { sales: 'Tion', periode: '2026-08-25 sd 2026-08-31', judul: '2 Weekly Report (Prime Hills)', workflow: 'Get Continues', bagian: '' };

test('pola bawaan: sales-periode-judul', () => {
  assert.equal(fileNameFrom('', v), 'Tion-2026-08-25 sd 2026-08-31-2 Weekly Report (Prime Hills)');
});

test('karakter terlarang dibuang, bagian kosong tidak meninggalkan tanda hubung ganda', () => {
  assert.equal(fileNameFrom('{{sales}}-{{bagian}}-{{judul}}', { ...v, sales: 'A/B: C?', judul: 'X' }), 'A B C-X');
  assert.equal(fileNameFrom('{{bagian}}', v), 'laporan');
  assert.equal(fileNameFrom('{{tidak_ada}} {{workflow}}', v), '{{tidak_ada}} Get Continues');
});

test('periode dan nama kembar', () => {
  assert.equal(periodText('2026-09-01', '2026-09-01'), '2026-09-01');
  assert.equal(periodText('2026-09-01T00:00:00', '2026-09-07'), '2026-09-01 sd 2026-09-07');
  assert.equal(periodText(null, null), '');
  assert.deepEqual(uniqueNames(['a.pdf', 'b.pdf', 'A.pdf', 'a.pdf']), ['a.pdf', 'b.pdf', 'A (2).pdf', 'a (3).pdf']);
});
