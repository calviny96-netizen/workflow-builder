import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseChatIds } from './chat-ids.ts';
import { validateGraph } from './index.ts';
import type { Graph } from './index.ts';

const id = '120363123456789012';

test('ID grup panjang tetap utuh dan bentuk @g.us tidak menjadi nomor telepon', () => {
  const r = parseChatIds(`${id}\n${id}@g.us\n6281234567890-1630000000@g.us`);
  assert.deepEqual(r.numbers, [id, '6281234567890-1630000000']);
  assert.deepEqual(r.groups, r.numbers);
  assert.deepEqual(r.invalid, []);
  assert.equal(r.duplicates, 1);
});

test('daftar private dan grup menerima format lama, separator, serta duplikat lintas bentuk', () => {
  const r = parseChatIds(`0812-3456-7890,+62 812 3456 7890;${id}@g.us\n${id}\n6281311112222@c.us`);
  assert.deepEqual(r.numbers, ['6281234567890', id, '6281311112222']);
  assert.deepEqual(r.groups, [id]);
  assert.equal(r.duplicates, 2);
  assert.deepEqual(r.invalid, []);
});

test('ID grup angka pada mode grup tidak mendapat awalan 62 atau kehilangan nol awal', () => {
  assert.deepEqual(parseChatIds('081234567890\n812345678901', 'group').numbers, ['081234567890', '812345678901']);
  assert.deepEqual(parseChatIds('6281234567890-1630000000', 'group').numbers, ['6281234567890-1630000000']);
  assert.deepEqual(parseChatIds('0812-34567890', 'both').numbers, ['6281234567890']);
});

test('nama grup dan ID salah tidak diubah menjadi nomor', () => {
  const r = parseChatIds(`Tim Sales\n${id}@g.com\n0812\n`);
  assert.deepEqual(r.numbers, []);
  assert.equal(r.invalid.length, 3);
  assert.deepEqual(parseChatIds(''), { numbers: [], groups: [], invalid: [], duplicates: 0 });
});

function graph(contactNumbers: string, chatType = 'group'): Graph {
  return { nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 's', type: 'sales', position: { x: 0, y: 0 }, config: { sales: [{ id: 1, name: 'Sales' }] } },
    { id: 'p', type: 'prompt', position: { x: 0, y: 0 }, config: { mode: 'text', text: 'Audit.' } },
    { id: 'a', type: 'aw', position: { x: 0, y: 0 }, config: { model: 'mock/model', contactMode: 'only', contactNumbers, chatType } },
  ], edges: [
    { id: 'e1', source: 't', sourceHandle: 'out', target: 's', targetHandle: 'in' },
    { id: 'e2', source: 's', sourceHandle: 'out', target: 'a', targetHandle: 'source' },
    { id: 'e3', source: 'p', sourceHandle: 'out', target: 'a', targetHandle: 'prompt' },
  ] };
}

test('validasi grup lolos, konflik jenis chat dan input salah menghentikan analisis', () => {
  assert.deepEqual(validateGraph(graph(id)), []);
  assert.deepEqual(validateGraph(graph(`${id}@g.us\n081234567890`, 'both')), []);
  assert.ok(validateGraph(graph(id, 'individual')).some(i => /Pilih jenis chat/.test(i.message)));
  assert.ok(validateGraph(graph(`${id}\nNama grup`)).some(i => /tidak valid/.test(i.message)));
  assert.ok(validateGraph(graph(`${id}\n+6281234567890`)).some(i => /daftar campuran/.test(i.message)));
});
