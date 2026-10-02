import assert from 'node:assert/strict';
import { test } from 'node:test';
import { correlationId, fingerprint, planMergeTiers, recommendChunk, splitByContacts, splitByDays } from './plan.ts';

test('pecah tanggal: 1-30 Juli per 5 hari = 6 bagian', () => {
  const { slices, warnings } = splitByDays('2026-07-01', '2026-07-30', 5);
  assert.equal(slices.length, 6);
  assert.deepEqual(slices[0], { part: 1, start_date: '2026-07-01', end_date: '2026-07-05', days: 5 });
  assert.deepEqual(slices[5], { part: 6, start_date: '2026-07-26', end_date: '2026-07-30', days: 5 });
  assert.equal(warnings.length, 0);
});

test('pecah tanggal: 31 hari menyisakan bagian 1 hari, lintas bulan aman', () => {
  const { slices } = splitByDays('2026-07-01', '2026-07-31', 5);
  assert.equal(slices.length, 7);
  assert.deepEqual(slices[6], { part: 7, start_date: '2026-07-31', end_date: '2026-07-31', days: 1 });
  const x = splitByDays('2026-02-27', '2026-03-02', 3).slices;
  assert.deepEqual(x.map((s) => [s.start_date, s.end_date]), [['2026-02-27', '2026-03-01'], ['2026-03-02', '2026-03-02']]);
});

test('pecah tanggal: rem pengaman menggabung sisa ke bagian terakhir', () => {
  const { slices, warnings } = splitByDays('2026-01-01', '2026-01-10', 1, 4);
  assert.equal(slices.length, 4);
  assert.deepEqual(slices[3], { part: 4, start_date: '2026-01-04', end_date: '2026-01-10', days: 7 });
  assert.equal(slices.reduce((n, s) => n + s.days, 0), 10);
  assert.equal(warnings.length, 1);
});

test('pecah tanggal: rentang terbalik ditolak', () => {
  assert.throws(() => splitByDays('2026-01-10', '2026-01-01', 5));
});

test('pecah kontak: bergiliran dari yang terberat, tanpa duplikat', () => {
  const contacts = [
    { phone_number: 'a', message_count: 100 },
    { phone_number: 'b', message_count: 90 },
    { phone_number: 'c', message_count: 10 },
    { phone_number: 'd', message_count: 5 },
    { phone_number: 'a', message_count: 100 },
    { chat_key: 'e@g.us', message_count: 1 },
  ];
  const { slices } = splitByContacts(contacts, 2);
  assert.equal(slices.length, 3);
  assert.deepEqual(slices.map((s) => s.chat_numbers), [['a', 'd'], ['b', 'e@g.us'], ['c']]);
  assert.equal(slices.reduce((n, s) => n + s.contacts, 0), 5);
  assert.equal(slices[0].messages, 105);
});

test('pecah kontak: kosong dan batas maksimum bagian', () => {
  assert.deepEqual(splitByContacts([], 10).slices, []);
  const many = Array.from({ length: 100 }, (_, i) => ({ phone_number: String(i), message_count: i }));
  const { slices, warnings } = splitByContacts(many, 1, 40);
  assert.equal(slices.length, 40);
  assert.equal(slices.reduce((n, s) => n + s.contacts, 0), 100);
  assert.equal(warnings.length, 1);
});

test('usulan chunk mengikuti batas keluaran dan konteks', () => {
  // konteks longgar: dibatasi 40 baris keluaran
  const a = recommendChunk({ contacts: 200, tokens: 100_000, fixedTokens: 5_000, usableContext: 1_000_000, days: 30 });
  assert.equal(a.contactsPerPart, 40);
  assert.equal(a.daysPerPart, 6); // 200/30 kontak per hari → 40 baris ≈ 6 hari
  // konteks sempit: dibatasi token
  const b = recommendChunk({ contacts: 200, tokens: 2_000_000, fixedTokens: 0, usableContext: 100_000, days: 30 });
  assert.equal(b.contactsPerPart, 6); // 60.000 / 10.000 token per kontak
  assert.equal(b.daysPerPart, 1);
  // data kecil: tidak perlu dipecah
  const c = recommendChunk({ contacts: 16, tokens: 8_000, fixedTokens: 500, usableContext: 900_000, days: 1 });
  assert.deepEqual(c, { daysPerPart: 1, contactsPerPart: 16 });
});

test('merge bertingkat: kelompok 2-10, tidak ada kelompok berisi 1', () => {
  assert.deepEqual(planMergeTiers(1), []);
  assert.deepEqual(planMergeTiers(2), [[2]]);
  assert.deepEqual(planMergeTiers(10), [[10]]);
  assert.deepEqual(planMergeTiers(11), [[6, 5], [2]]);
  assert.deepEqual(planMergeTiers(30), [[10, 10, 10], [3]]);
  const t = planMergeTiers(101);
  assert.deepEqual(t.map((x) => x.length), [11, 2, 1]);
  for (const tier of t) for (const g of tier) assert.ok(g >= 2 && g <= 10);
  assert.equal(t[0].reduce((a, b) => a + b, 0), 101);
});

test('fingerprint: stabil terhadap urutan, berubah bila prompt atau filter berubah', () => {
  const base = {
    promptText: 'Audit komplain',
    model: 'qwen/qwen3.7-plus',
    memoryIds: [3, 1],
    filter: { start_date: '2026-07-01', end_date: '2026-07-05', chat_type: 'individual' },
    runBySuperadmin: true,
    source: { channel: 'whatsapp', id: 118 },
  };
  const same = { ...base, memoryIds: [1, 3], filter: { chat_type: 'individual', end_date: '2026-07-05', start_date: '2026-07-01' } };
  assert.equal(fingerprint(base), fingerprint(same));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, promptText: 'Audit komplain.' }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, filter: { ...base.filter, end_date: '2026-07-06' } }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, runBySuperadmin: false }));
});

test('correlation id unik walau dibuat beruntun', () => {
  const ids = new Set(Array.from({ length: 500 }, (_, i) => correlationId('r1', 'n1', i % 3)));
  assert.equal(ids.size, 500);
});
