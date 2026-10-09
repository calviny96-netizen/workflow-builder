import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '../../../packages/autoaudit/src/index.ts';
import { normalizeChatId } from '../../../packages/nodes/src/chat-ids.ts';
import type { Graph } from '../../../packages/nodes/src/index.ts';
import { buildPlan } from './planner.ts';

const first = '120363123456789012';
const second = '120363123456789013';
const privatePhone = '6281234567890';
const params = { start_date: '2026-10-01', end_date: '2026-10-08' };

function graph(numbers: string, mode = 'only', chunk?: 'contacts' | 'days', chatType = 'group'): Graph {
  return { nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 's', type: 'sales', position: { x: 0, y: 0 }, config: { sales: [{ id: 1, name: 'Sales' }] } },
    { id: 'p', type: 'prompt', position: { x: 0, y: 0 }, config: { mode: 'text', text: 'Ringkas chat.' } },
    { id: 'a', type: 'aw', position: { x: 0, y: 0 }, config: { model: 'mock/model', runBySuperadmin: true, chatType, contactMode: mode, contactNumbers: numbers } },
    ...(chunk ? [{ id: 'c', type: 'chunk' as const, position: { x: 0, y: 0 }, config: { mode: chunk, size: chunk === 'contacts' ? 1 : 4 } }] : []),
  ], edges: [
    { id: 'e1', source: 't', sourceHandle: 'out', target: 's', targetHandle: 'in' },
    { id: 'e2', source: 's', sourceHandle: 'out', target: chunk ? 'c' : 'a', targetHandle: chunk ? 'in' : 'source' },
    { id: 'e3', source: 'p', sourceHandle: 'out', target: 'a', targetHandle: 'prompt' },
    ...(chunk ? [{ id: 'e4', source: 'c', sourceHandle: 'out', target: 'a', targetHandle: 'source' }] : []),
  ] };
}

function mockApi() {
  const calls: { path: string; query: URLSearchParams; body: any }[] = [];
  const contacts = [
    { phone_number: first, chat_key: first, chat_type: 'group', message_count: 226 },
    { phone_number: null, chat_key: `${second}@g.us`, chat_type: 'group', message_count: 40 },
    { phone_number: privatePhone, chat_type: 'individual', message_count: 10 },
  ];
  const api = createClient({ baseUrl: 'https://mock.test', token: 'test', fetch: (async (url, init) => {
    const u = new URL(String(url));
    const path = u.pathname.replace('/api/v1/integrations', '');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body, query: u.searchParams });
    if (path === '/audital-work/models') return Response.json({ data: { items: [{ model_name: 'mock/model' }] } });
    if (path.endsWith('/contacts')) {
      const type = u.searchParams.get('chat_type');
      const list = contacts.filter(c => type === 'both' || c.chat_type === type);
      const page = Number(u.searchParams.get('page'));
      return Response.json({ data: list.slice(page - 1, page), pagination: { total_pages: list.length } });
    }
    if (path.endsWith('/preflight')) {
      const f = body.filter;
      const selected = new Set((f.chat_numbers ?? []).map(normalizeChatId));
      const list = contacts.filter(c => (f.chat_type === 'both' || c.chat_type === f.chat_type)
        && (!selected.size || selected.has(normalizeChatId(c.phone_number || c.chat_key)) !== !!f.is_excluded));
      const count = list.length;
      return Response.json({ data: { can_start: count > 0, ...(count ? {} : { error: { code: 'empty_filter_result' } }), preview: {
        dataset: { filtered_contacts: count, filtered_messages: list.reduce((sum, c) => sum + c.message_count, 0), token_after_filter: count * 100 },
        token_breakdown: { total_context_tokens: count * 100 }, context: { usable_context_length: 100000, percent: 1 },
      } } });
    }
    if (path === '/audital-work/runs') return Response.json({ data: { history_id: 1 } }, { status: 202 });
    throw new Error(`Endpoint tak diharapkan: ${path}`);
  }) as typeof fetch });
  return { api, calls };
}

test('hanya grup: ID panjang dan @g.us melewati validasi, preview, preflight, dan payload start', async () => {
  for (const value of [first, `${first}@g.us`]) {
    const { api, calls } = mockApi();
    const g = graph(value);
    const preview = await buildPlan({ api, graph: g, params, companyId: 1, previewOnly: true });
    assert.equal(preview.groups[0].full!.messages, 226);
    const plan = await buildPlan({ api, graph: g, params, companyId: 1 });
    const u = plan.units[0];
    assert.deepEqual(u.payload.filter!.chat_numbers, [first]);
    assert.equal(u.payload.filter!.chat_type, 'group');
    assert.equal(u.skip, false);
    await api.startRun(u.payload); // AutoAudit tiruan saja.
    assert.deepEqual(calls.filter(c => c.path.endsWith('/preflight')).map(c => c.body.filter), [u.payload.filter, u.payload.filter]);
    assert.deepEqual(calls.at(-1)!.body.filter, u.payload.filter);
  }
});

test('grup terpilih tetap utuh pada setiap chunk tanggal', async () => {
  const { api } = mockApi();
  const plan = await buildPlan({ api, graph: graph(`${first}@g.us`, 'only', 'days'), params, companyId: 1 });
  assert.equal(plan.units.length, 2);
  for (const u of plan.units) assert.deepEqual(u.payload.filter!.chat_numbers, [first]);
});

test('chunk kontak mencocokkan ID grup angka, suffix, dan fallback chat_key melalui pagination', async () => {
  const { api, calls } = mockApi();
  const plan = await buildPlan({ api, graph: graph(`${first}@g.us\n${second}`, 'only', 'contacts'), params, companyId: 1 });
  assert.equal(plan.units.length, 2);
  assert.deepEqual(plan.units.flatMap(u => u.payload.filter!.chat_numbers!).map(normalizeChatId).sort(), [first, second].sort());
  assert.ok(plan.units.every(u => u.estimate.contacts === 1 && !u.skip));
  assert.deepEqual(calls.filter(c => c.path.endsWith('/contacts')).map(c => c.query.get('page')), ['1', '2']);
  assert.ok(calls.filter(c => c.path.endsWith('/contacts')).every(c => c.query.get('chat_type') === 'group'));
});

test('kecualikan grup menyaring daftar sebelum chunk dan tidak membawa mode exclude ke bagian tersisa', async () => {
  const { api } = mockApi();
  const plan = await buildPlan({ api, graph: graph(`${second}@g.us`, 'exclude', 'contacts'), params, companyId: 1 });
  assert.equal(plan.units.length, 1);
  assert.deepEqual(plan.units[0].payload.filter!.chat_numbers, [first]);
  assert.equal(plan.units[0].payload.filter!.is_excluded, false);
  const direct = await buildPlan({ api, graph: graph(`${second}@g.us`, 'exclude'), params, companyId: 1 });
  assert.equal(direct.units[0].payload.filter!.is_excluded, true);
  assert.equal(direct.units[0].estimate.contacts, 1);
});

test('private + grup mempertahankan kedua pilihan tanpa mengubah ID grup menjadi nomor', async () => {
  const { api } = mockApi();
  const plan = await buildPlan({ api, graph: graph(`081234567890\n${first}@g.us`, 'only', undefined, 'both'), params, companyId: 1 });
  assert.deepEqual(plan.units[0].payload.filter!.chat_numbers, [privatePhone, first]);
  assert.equal(plan.units[0].estimate.contacts, 2);
});

test('jenis private dengan ID grup gagal sebelum API dipanggil; Official tetap menolak grup', async () => {
  const { api, calls } = mockApi();
  await assert.rejects(buildPlan({ api, graph: graph(first, 'only', undefined, 'individual'), params, companyId: 1 }), /Pilih jenis chat/);
  assert.equal(calls.length, 0);
  const g = graph(first);
  g.nodes.find(n => n.id === 's')!.config.sales[0].channel = 'whatsapp_official';
  await assert.rejects(buildPlan({ api, graph: g, params, companyId: 1 }), /WhatsApp Official mendukung chat private/);
});
