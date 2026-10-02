import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePhones } from './phones.ts';

test('berbagai bentuk nomor diubah ke 62…', () => {
  const r = parsePhones('0812-3456-7890\n+62 813 1111 2222, 6281400003333; 81555554444\n08123456789');
  assert.deepEqual(r.numbers, ['6281234567890', '6281311112222', '6281400003333', '6281555554444', '628123456789']);
  assert.deepEqual(r.invalid, []);
});

test('duplikat dihitung sekali, yang bukan nomor dilaporkan', () => {
  const r = parsePhones('081234567890\n6281234567890\n\nIbu Sari\n0812\n  ');
  assert.deepEqual(r.numbers, ['6281234567890']);
  assert.equal(r.duplicates, 1);
  assert.deepEqual(r.invalid, ['Ibu Sari', '0812']);
});

test('kosong', () => {
  assert.deepEqual(parsePhones(''), { numbers: [], invalid: [], duplicates: 0 });
});
