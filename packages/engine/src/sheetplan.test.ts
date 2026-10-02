import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSheetUrl, planSheetWrite } from './sheetplan.ts';

const cols = ['Nomor WA', 'Sales', 'Status'];

test('tab kosong: header ditulis, semua baris ditambahkan', () => {
  const p = planSheetWrite({ existing: [], columns: cols, rows: [['628', 'A', 'baru']], mode: 'append', keyColumns: [] });
  assert.deepEqual(p.header, cols);
  assert.deepEqual(p.appends, [['628', 'A', 'baru']]);
});

test('append: kolom dipetakan lewat nama, urutan sheet berbeda, kolom tak dikenal diabaikan', () => {
  const existing = [['status', 'No.', 'nomor_wa', 'Catatan']];
  const p = planSheetWrite({ existing, columns: [...cols, 'Extra'], rows: [['628', 'A', 'baru', 'x']], mode: 'append', keyColumns: [] });
  assert.equal(p.header, null);
  assert.deepEqual(p.appends, [['baru', '', '628', '']]);
  assert.deepEqual(p.ignoredColumns, ['Sales', 'Extra']);
});

test('dedup: kunci gabungan, yang sudah ada dan kembar dalam batch dilewati', () => {
  const existing = [cols, ['628', 'A', 'lama']];
  const p = planSheetWrite({
    existing,
    columns: cols,
    rows: [['628', 'a', 'baru'], ['628', 'B', 'baru'], ['628', 'B', 'kembar'], ['', '', 'tanpa kunci']],
    mode: 'dedup',
    keyColumns: ['nomor wa', 'SALES'],
  });
  assert.deepEqual(p.appends, [['628', 'B', 'baru'], ['', '', 'tanpa kunci']]);
  assert.equal(p.skipped, 2);
  assert.deepEqual(p.updates, []);
});

test('upsert: baris cocok diperbarui di tempat, sel lain dipertahankan, sisanya ditambahkan', () => {
  const existing = [['Nomor WA', 'Sales', 'Status', 'Catatan'], ['628', 'A', 'lama', 'jangan hilang'], ['629', 'A', 'lama', '']];
  const p = planSheetWrite({
    existing,
    columns: cols,
    rows: [['628', 'A', 'closing'], ['630', 'A', 'baru'], ['630', 'A', 'baru-2']],
    mode: 'upsert',
    keyColumns: ['Nomor WA', 'Sales'],
  });
  assert.deepEqual(p.updates, [{ row: 2, values: ['628', 'A', 'closing', 'jangan hilang'] }]);
  assert.deepEqual(p.appends, [['630', 'A', 'baru-2', '']]);
});

test('kolom kunci tidak ada di sheet: tidak ada yang ditulis', () => {
  const p = planSheetWrite({ existing: [cols], columns: cols, rows: [['1', 'A', 'x']], mode: 'upsert', keyColumns: ['ID'] });
  assert.deepEqual(p.missingKeys, ['ID']);
  assert.deepEqual([p.appends, p.updates], [[], []]);
});

test('tautan spreadsheet', () => {
  assert.deepEqual(parseSheetUrl('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd/edit?gid=1168404419#gid=1168404419'), {
    id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd',
    gid: 1168404419,
  });
  assert.deepEqual(parseSheetUrl('1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd'), { id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd', gid: null });
  assert.equal(parseSheetUrl('https://example.com'), null);
});
