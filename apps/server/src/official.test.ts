import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '../../../packages/autoaudit/src/index.ts';
import { salesBehind, salesSourceKey } from '../../../packages/nodes/src/index.ts';
import type { Graph } from '../../../packages/nodes/src/index.ts';
import { buildPlan } from './planner.ts';
import { advanceSync } from './steps-io.ts';

function graph(chunk = false): Graph {
  const nodes: Graph['nodes'] = [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 'sales', type: 'sales', position: { x: 0, y: 0 }, config: { sales: [{ id: 28, name: 'Sales lama' }, { id: 28, name: 'Official', channel: 'whatsapp_official' }] } },
    { id: 'sync', type: 'sync', position: { x: 0, y: 0 }, config: { policy: 'stale', staleMinutes: 30 } },
    { id: 'prompt', type: 'prompt', position: { x: 0, y: 0 }, config: { mode: 'text', text: 'Ringkas chat.' } },
    { id: 'aw', type: 'aw', position: { x: 0, y: 0 }, config: { model: 'mock/model', runBySuperadmin: true } },
  ];
  if (chunk) nodes.push({ id: 'chunk', type: 'chunk', position: { x: 0, y: 0 }, config: { mode: 'contacts', size: 1 } });
  const edge = (source: string, target: string, targetHandle: string) => ({ id: `${source}-${target}`, source, sourceHandle: 'out', target, targetHandle });
  return { nodes, edges: [edge('trigger', 'sales', 'in'), edge('sales', 'sync', 'in'), edge('sync', chunk ? 'chunk' : 'aw', chunk ? 'in' : 'source'), ...(chunk ? [edge('chunk', 'aw', 'source')] : []), edge('prompt', 'aw', 'prompt')] };
}

function mockApi(pages?: any[], rejectOfficial = false) {
  const calls: { path: string; body: any }[] = [];
  const api = createClient({ baseUrl: 'https://mock.test', token: 'test', fetch: (async (url, init) => {
    const path = new URL(String(url)).pathname.replace('/api/v1/integrations', '');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body });
    let data: any;
    if (path === '/audital-work/models') data = { items: [{ model_name: 'mock/model' }] };
    else if (path.endsWith('/preflight')) {
      if (rejectOfficial && path.includes('whatsapp-official')) return new Response(JSON.stringify({ error: { code: 'invalid_filter' } }), { status: 400 });
      data = { can_start: true, preview: { dataset: { filtered_contacts: body.filter.chat_numbers?.length || 2, filtered_messages: 10, token_after_filter: 100 }, token_breakdown: { total_context_tokens: 100 }, context: { usable_context_length: 100000, percent: 1 } } };
    } else if (path.endsWith('/text-messages')) data = pages!.shift();
    else if (path === '/sales/28') data = { last_sync_at: new Date().toISOString() };
    else throw new Error(`Endpoint tak diharapkan: ${path}`);
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch });
  return { api, calls };
}

const params = { start_date: '2026-09-01', end_date: '2026-09-01' };

test('jenis sumber dan ID tetap berbeda melalui Sync dan Chunk, termasuk workflow lama', () => {
  const sources = salesBehind(graph(true), 'chunk');
  assert.deepEqual(sources.map(salesSourceKey), ['whatsapp:28', 'whatsapp_official:28']);
});

test('rencana campuran menghasilkan payload dan fingerprint terpisah untuk ID yang sama', async () => {
  const { api, calls } = mockApi();
  const plan = await buildPlan({ api, graph: graph(), params, companyId: 167 });
  assert.equal(plan.units.length, 2);
  assert.equal(plan.units[0].payload.sales_id, 28);
  assert.equal(plan.units[0].payload.whatsapp_official_account_id, undefined);
  assert.equal(plan.units[1].payload.whatsapp_official_account_id, 28);
  assert.equal(plan.units[1].payload.sales_id, undefined);
  assert.notEqual(plan.units[0].fingerprint, plan.units[1].fingerprint);
  assert.equal(calls.filter((c) => c.path.endsWith('/preflight')).length, 2);
});

test('chunk kontak Official mengikuti cursor meskipun halaman terpotong, tanpa membaca sales OTP', async () => {
  const g = graph(true);
  g.nodes.find((n) => n.id === 'sales')!.config.sales.shift();
  const { api, calls } = mockApi([
    { items: [{ contact_wa_id: '628111111111' }], truncated: true, next_cursor: 'cursor-2' },
    { items: [{ contact_wa_id: '628111111111' }, { contact_wa_id: '628222222222' }], next_cursor: null },
  ]);
  const plan = await buildPlan({ api, graph: g, params, companyId: 167 });
  assert.equal(plan.units.length, 2);
  assert.deepEqual(plan.units.flatMap((u) => u.payload.filter!.chat_numbers).sort(), ['628111111111', '628222222222']);
  assert.deepEqual(calls.filter((c) => c.path.endsWith('/text-messages')).map((c) => c.body.cursor), [null, 'cursor-2']);
  assert.ok(calls.every((c) => !c.path.startsWith('/sales/')));
});

test('Official melewati sync, Sales ID identik tetap diperiksa', async () => {
  const g = graph();
  const { api, calls } = mockApi();
  const result = await advanceSync(api, { graph: g, company_id: 167 }, g.nodes.find((n) => n.id === 'sync')!, null);
  assert.equal(result.status, 'done');
  assert.equal(result.output.jobs.length, 2);
  assert.equal(result.output.jobs[1].channel, 'whatsapp_official');
  assert.equal(result.output.jobs[1].status, 'skipped');
  assert.equal(calls.filter((c) => c.path === '/sales/28').length, 1);
});

test('filter grup dan kegagalan preflight Official ditolak dengan jelas', async () => {
  const g = graph();
  g.nodes.find((n) => n.id === 'aw')!.config.chatType = 'group';
  await assert.rejects(() => buildPlan({ api: mockApi().api, graph: g, params, companyId: 167 }), /WhatsApp Official mendukung chat private/);
  await assert.rejects(() => buildPlan({ api: mockApi(undefined, true).api, graph: graph(), params, companyId: 167 }), /preflight WhatsApp Official ditolak/);
});

test('cursor Official berulang tidak menghasilkan rencana kontak parsial', async () => {
  const g = graph(true);
  g.nodes.find((n) => n.id === 'sales')!.config.sales.shift();
  const { api } = mockApi([{ items: [], next_cursor: 'same' }, { items: [], next_cursor: 'same' }]);
  await assert.rejects(() => buildPlan({ api, graph: g, params, companyId: 167 }), /Cursor pesan WhatsApp Official tidak maju/);
});

test('periode AW sendiri dipakai untuk preflight dan chunk tanggal, termasuk tanggal acuan yang dibekukan', async () => {
  const g = graph(true);
  const aw = g.nodes.find(n=>n.id==='aw')!;
  aw.config.analysisPeriod = {mode:'half_month'};
  const chunk = g.nodes.find(n=>n.id==='chunk')!;
  chunk.config = {mode:'days',size:7};
  const {api,calls} = mockApi();
  const plan = await buildPlan({api,graph:g,params:{...params,analysis_date:'2026-03-01'},companyId:167});
  assert.equal(plan.units.length,4);
  assert.deepEqual(plan.groups[0].period,{start_date:'2026-02-16',end_date:'2026-02-28',days:13});
  assert.deepEqual(plan.units.slice(0,2).map(u=>[u.payload.filter!.start_date,u.payload.filter!.end_date]),[['2026-02-16','2026-02-22'],['2026-02-23','2026-02-28']]);
  assert.ok(calls.filter(c=>c.path.endsWith('/preflight')).every(c=>c.body.filter.start_date >= '2026-02-16' && c.body.filter.end_date <= '2026-02-28'));
});

test('dua AW memakai periode berbeda dengan tanggal run yang sama', async () => {
  const g = graph();
  g.nodes.find(n=>n.id==='aw')!.config.analysisPeriod={mode:'yesterday'};
  g.nodes.push({...g.nodes.find(n=>n.id==='aw')!,id:'aw2',config:{model:'mock/model',analysisPeriod:{mode:'previous_month'}}});
  g.edges.push(...g.edges.filter(e=>e.target==='aw').map(e=>({...e,id:e.id+'2',target:'aw2'})));
  const plan=await buildPlan({api:mockApi().api,graph:g,params:{...params,analysis_date:'2026-10-01'},companyId:167});
  assert.deepEqual(plan.units.filter(u=>u.source.channel==='whatsapp').map(u=>[u.payload.filter!.start_date,u.payload.filter!.end_date]),[['2026-09-30','2026-09-30'],['2026-09-01','2026-09-30']]);
});
