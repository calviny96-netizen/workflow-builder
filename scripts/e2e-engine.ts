// Uji mesin ujung ke ujung terhadap AutoAudit TIRUAN dan database uji terpisah (aawb_test).
// Tidak menyentuh production dan tidak memakai token AI.
//
//   npm run db            (di tab lain)
//   npm run test:engine

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import pg from 'pg';
import { createClient } from '../packages/autoaudit/src/index.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { hashPassword } from '../apps/server/src/auth.ts';
import { createPool, migrate } from '../apps/server/src/db.ts';
import { createExecutor } from '../apps/server/src/executor.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- AutoAudit tiruan
const mock = {
  runMs: 300,
  promptContent: 'Audit komplain v1',
  posts: 0,
  active: 0,
  maxActive: 0,
  syncPosts: [] as number[],
  syncMs: 250,
  syncFailOnce: new Set<number>(),
  lastSyncAgoMin: { 1: 5, 2: 600 } as Record<number, number>,
  notifId: 5000,
  mergeLive: true, // false = server belum memasang endpoint ai-runs (membalas halaman HTML)
  mergeMs: 150,
  mergeFailOnce: false,
  merges: [] as { id: number; body: any; doneAt: number; fail: boolean }[],
  emptyOnce: new Set<string>(),
  emptyIds: new Set<number>(),
  pdfFailOnce: false,
  pdfBodies: [] as any[],
  failOnce: new Set<string>(), // kunci `${sales_id}|${start_date}` yang gagal satu kali
  dropResponseOnce: new Set<string>(), // run diterima server, tapi koneksi diputus sebelum balasan
  runs: new Map<number, { payload: any; doneAt: number; fail: boolean; cancelled: boolean; counted: boolean }>(),
  notifications: [] as any[],
  nextId: 1000,
  contacts: { 1: 90, 2: 25, 3: 0 } as Record<number, number>, // jumlah kontak per sales
};

function contactsOf(salesId: number) {
  return Array.from({ length: mock.contacts[salesId] ?? 10 }, (_, i) => ({
    chat_key: `${salesId}${i}@c.us`,
    phone_number: `628${salesId}${String(i).padStart(9, '0')}`, // 13 digit, seperti nomor sungguhan
    message_count: 100 - i,
  }));
}

function settle() {
  for (const r of mock.runs.values()) {
    if (!r.counted && (Date.now() >= r.doneAt || r.cancelled)) {
      r.counted = true;
      mock.active -= 1;
    }
  }
}

const aa = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  const path = url.pathname.replace('/api/v1/integrations', '');
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
  const send = (status: number, json: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  };
  settle();

  if (path === '/audital-work/models') return send(200, { data: { items: [{ model_name: 'mock/model', is_enabled: 1 }], summary: { default_model: 'mock/model' } } });
  if (path === '/audital-work/whatsapp-official/accounts') return send(200, { data: { items: [{ id: 1, name: 'Official 1', display_phone_number: '+62 811', local_status: 'connected' }] } });
  if (path === '/audital-work/saved-prompts') return send(200, { data: { items: [{ id: 7, title: 'Komplain', content: mock.promptContent }] } });
  if (path === '/notifications') {
    const group = url.searchParams.get('group');
    const now = Date.now();
    const visible = mock.notifications.filter((n) => (!group || n.group_key === group) && (n.at ?? 0) <= now);
    return send(200, { data: visible.sort((a, b) => b.id - a.id).slice(0, Number(url.searchParams.get('limit') || 25)) });
  }
  if (path === '/continuous-audit/schedules/9/runs') {
    const all = [
      { id: 91, run_at: '2026-07-03T13:00:00Z', status: 'success', raw_status: 'completed' },
      { id: 90, run_at: '2026-07-02T13:00:00Z', status: 'failed', raw_status: 'failed' },
      { id: 89, run_at: '2026-07-01T13:00:00Z', status: 'success', raw_status: 'completed' },
    ];
    const from = url.searchParams.get('date_from');
    const to = url.searchParams.get('date_to');
    return send(200, { data: all.filter((r) => (!from || r.run_at.slice(0, 10) >= from) && (!to || r.run_at.slice(0, 10) <= to)) });
  }
  const cm = path.match(/^\/continuous-audit\/runs\/(\d+)$/);
  if (cm) {
    const rid = Number(cm[1]);
    return send(200, {
      data: {
        id: rid,
        sales: [
          { sales_id: 1, sales_name: 'SPV 1', status: 'success', raw_status: 'completed', history: { id: rid * 10 + 1 } },
          { sales_id: 2, sales_name: 'SPV 2', status: 'failed', raw_status: 'failed', history: null },
        ],
      },
    });
  }
  const fm = path.match(/^\/audital-work\/histories\/(7\d\d|89\d|91\d)$/);
  if (fm) {
    // History yang sudah ada sebelumnya (bukan dibuat lewat POST /runs). 777 = ada di sisi company saja.
    const hid = Number(fm[1]);
    if (hid === 777 && url.searchParams.get('run_by_superadmin') === 'true') return send(404, { error: { code: 'not_found' } });
    if (hid === 778) return send(200, { data: { status: 'idle', result: null } });
    return send(200, { data: { status: 'idle', title: `[Continuous] judul ${hid}`, filter: { startDate: '2026-06-24', endDate: '2026-06-30' }, result: { content: `# Laporan lama ${hid}\n\n| No | Outlet |\n|---|---|\n| 1 | A${hid} |\n`, token_usage: 50 } } });
  }
  let sm = path.match(/^\/sales\/(\d+)$/);
  if (sm && req.method === 'GET') {
    const ago = mock.lastSyncAgoMin[Number(sm[1])];
    return send(200, { data: { id: Number(sm[1]), status: 'connected', last_sync_at: ago == null ? null : new Date(Date.now() - ago * 60_000).toISOString() } });
  }
  sm = path.match(/^\/sales\/(\d+)\/sync(-max-priority|-no-skip)?$/);
  if (sm && req.method === 'POST') {
    const salesId = Number(sm[1]);
    mock.syncPosts.push(salesId);
    const jobId = mock.notifId++;
    const fail = mock.syncFailOnce.delete(salesId);
    mock.notifications.push({ id: mock.notifId++, group_key: 'sync', event_key: 'started', data: { sales_id: salesId, job_id: jobId } });
    // Notifikasi selesai baru "terlihat" setelah syncMs.
    mock.notifications.push({ id: mock.notifId++, at: Date.now() + mock.syncMs, group_key: 'sync', event_key: fail ? 'failed' : 'completed', data: { sales_id: salesId, job_id: jobId, error_reason: fail ? 'worker timeout' : null } });
    return send(202, { data: { sales_id: salesId, job_id: jobId, queue_status: 'queued' } });
  }

  let m = path.match(/^\/sales\/(\d+)\/contacts$/);
  if (m) {
    const all = contactsOf(Number(m[1]));
    const page = Number(url.searchParams.get('page') || 1);
    const limit = Math.min(100, Number(url.searchParams.get('limit') || 25));
    return send(200, { data: all.slice((page - 1) * limit, page * limit), pagination: { page, limit, total: all.length, total_pages: Math.max(1, Math.ceil(all.length / limit)) } });
  }

  if (path === '/audital-work/runs/preflight' || path === '/audital-work/whatsapp-official/runs/preflight') {
    const sourceId = body.whatsapp_official_account_id ?? body.sales_id;
    if (path.includes('whatsapp-official') && (body.sales_id !== undefined || !body.whatsapp_official_account_id)) return send(400, { error: { code: 'invalid_source' } });
    const total = mock.contacts[sourceId] ?? 10;
    // Hanya nomor yang benar-benar milik sales ini yang dihitung; is_excluded membalik artinya.
    const own = new Set(contactsOf(sourceId).map((x) => x.phone_number));
    const hit = (body.filter?.chat_numbers ?? []).filter((n: string) => own.has(n)).length;
    if (body.filter?.chat_numbers?.length && body.filter?.is_excluded) {
      const left = total - hit;
      return send(200, { data: { can_start: left > 0, preview: { dataset: { filtered_contacts: left, filtered_messages: left * 10, token_after_filter: left * 1000 }, token_breakdown: { fixed_context_tokens: 500, total_context_tokens: left * 1000 + 500 }, context: { usable_context_length: 1_000_000, percent: 1 } } } });
    }
    const picked = body.filter?.chat_numbers?.length ? hit : total;
    const days = Math.round((Date.parse(body.filter.end_date) - Date.parse(body.filter.start_date)) / 86400000) + 1;
    const contacts = body.filter?.chat_numbers?.length ? picked : Math.min(total, Math.ceil((total * days) / 30));
    if (contacts === 0) return send(200, { data: { can_start: false, error: { code: 'empty_filter_result' }, preview: { dataset: { filtered_contacts: 0 } } } });
    const tokens = contacts * 1000;
    return send(200, {
      data: {
        can_start: true,
        preview: {
          dataset: { filtered_contacts: contacts, filtered_messages: contacts * 10, token_after_filter: tokens },
          token_breakdown: { fixed_context_tokens: 500, total_context_tokens: tokens + 500 },
          context: { usable_context_length: 1_000_000, percent: 1, needs_chunking: false, is_over_context: false },
        },
      },
    });
  }

  if ((path === '/audital-work/runs' || path === '/audital-work/whatsapp-official/runs') && req.method === 'POST') {
    if (path.includes('whatsapp-official') && (body.sales_id !== undefined || !body.whatsapp_official_account_id)) return send(400, { error: { code: 'invalid_source' } });
    mock.posts += 1;
    const key = `${body.sales_id}|${body.filter.start_date}`;
    const id = mock.nextId++;
    const fail = mock.failOnce.delete(key);
    mock.runs.set(id, { payload: body, doneAt: Date.now() + mock.runMs, fail, cancelled: false, counted: false });
    mock.active += 1;
    mock.maxActive = Math.max(mock.maxActive, mock.active);
    mock.notifications.push({ id: mock.notifId++, group_key: 'audital_work', event_key: 'queued', data: { history_id: id, correlation_id: body.correlation_id } });
    if (mock.dropResponseOnce.delete(key)) return void req.socket.destroy();
    return send(202, { data: { history_id: id, status: 'queued' } });
  }

  if (path === '/audital-work/runs/status') {
    const r = mock.runs.get(Number(url.searchParams.get('history_id')));
    if (!r) return send(404, { error: { code: 'not_found' } });
    if (Date.now() < r.doneAt) return send(200, { data: { status: 'running', runtime: { run_status: 'running' } } });
    if (r.fail) return send(200, { data: { status: 'failed', runtime: { stream_error: 'provider timeout' } } });
    return send(200, { data: { status: 'completed', runtime: { run_status: 'idle', finished_at: 'x' } } });
  }

  m = path.match(/^\/audital-work\/histories\/(\d+)$/);
  if (m) {
    const r = mock.runs.get(Number(m[1]));
    if (!r) return send(404, {});
    const f = r.payload.filter;
    if (mock.emptyOnce.delete(`${r.payload.sales_id}|${f.start_date}|${m[1]}`) || mock.emptyIds.has(Number(m[1]))) {
      mock.emptyIds.add(Number(m[1]));
      return send(200, { data: { status: 'completed', result: null } });
    }
    return send(200, { data: { status: 'completed', result: { content: `# Laporan sales ${r.payload.sales_id} ${f.start_date}..${f.end_date}\n\n| No | Pelanggan | Masalah |\n|---|---|---|\n| 1 | Ibu Sari | Luntur |\n| 2 | Pak Budi | Terlambat |\n`, token_usage: 1234, model_used: 'mock/model', finish_reason: 'stop' } } });
  }

  m = path.match(/^\/audital-work\/runs\/(\d+)\/cancel$/);
  if (m) {
    const r = mock.runs.get(Number(m[1]));
    if (r) r.cancelled = true;
    return send(200, { data: { aborted: true } });
  }
  if (path === '/merge-reports/ai-runs' && req.method === 'POST') {
    if (!mock.mergeLive) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return void res.end('<!DOCTYPE html><html><body>login</body></html>');
    }
    if (!body.model) return send(500, { error: { code: 'internal_error', message: 'Failed to start report merge' } }); // perilaku server nyata
    if (!Array.isArray(body.source_history_ids) || body.source_history_ids.length < 2 || body.source_history_ids.length > 10) return send(400, { error: { code: 'invalid_sources', message: '2-10 sumber' } });
    if (!body.source_history_ids.includes(body.base_history_id)) return send(400, { error: { code: 'invalid_base_response', message: 'Base response must be part of selected sources.' } });
    const id = mock.nextId++;
    const fail = mock.mergeFailOnce;
    mock.mergeFailOnce = false;
    mock.merges.push({ id, body, doneAt: Date.now() + mock.mergeMs, fail });
    return send(202, { data: { history_id: id, status: 'queued' } });
  }
  const mr = path.match(/^\/merge-reports\/ai-runs\/(\d+)$/);
  if (mr) {
    const mg = mock.merges.find((x) => x.id === Number(mr[1]));
    if (!mg) return send(404, { error: { code: 'not_found' } });
    if (Date.now() < mg.doneAt) return send(200, { data: { history_id: mg.id, status: 'running', report_id: null } });
    if (mg.fail) return send(200, { data: { history_id: mg.id, status: 'failed', report_id: null, error: 'model timeout' } });
    return send(200, { data: { history_id: mg.id, status: 'completed', report_id: mg.id + 50000 } });
  }
  const cr = path.match(/^\/merge-reports\/custom\/(\d+)$/);
  if (cr) {
    const mg = mock.merges.find((x) => x.id + 50000 === Number(cr[1]))!;
    return send(200, { data: { id: Number(cr[1]), title: mg.body.title, source_count: mg.body.source_history_ids.length, content_markdown: `# ${mg.body.title}\n\nGabungan dari ${mg.body.source_history_ids.length} sumber.\n\n| No | Ringkasan |\n|---|---|\n| 1 | gabungan |\n` } });
  }
  if (path === '/audital-work/export/pdf') {
    if (mock.pdfFailOnce) {
      mock.pdfFailOnce = false;
      return send(501, { error: { code: 'not_implemented', message: 'adapter belum tersambung' } });
    }
    mock.pdfBodies.push(body);
    res.writeHead(200, { 'content-type': 'application/pdf' });
    return void res.end(Buffer.from('%PDF-1.4 tiruan'));
  }
  send(404, { error: { code: 'not_found', message: path } });
});

// ---------- Rangkaian uji
const adminUrl = process.env.DATABASE_URL!;
const testUrl = adminUrl.replace(/\/[^/]+$/, '/aawb_test');
let db: pg.Pool;
let api: ReturnType<typeof createClient>;
let app: ReturnType<typeof buildApp>;
let executor: ReturnType<typeof createExecutor>;
let cookie = '';

const filesDir = fileURLToPath(new URL('../.data/test-files', import.meta.url));
// Google Sheets tiruan di memori: satu spreadsheet, tab "Rekap" (gid 7).
const fakeSheet = { rows: [] as string[][] };
const sheets = {
  email: 'uji@tiruan',
  tabs: async () => ({ title: 'Buku Uji', spreadsheet: 'x', tabs: [{ gid: 7, title: 'Rekap' }] }),
  read: async () => fakeSheet.rows.map((r) => [...r]),
  append: async (_i: string, _t: string, rows: string[][]) => void fakeSheet.rows.push(...rows),
  update: async (_i: string, _t: string, ups: { row: number; values: string[] }[]) => void ups.forEach((u) => (fakeSheet.rows[u.row - 1] = u.values)),
};
// GOWA dan webhook tiruan: semua panggilan keluar selain ke AutoAudit ditangkap di sini.
const outbound: { url: string; headers: Record<string, string>; json?: any; form?: Record<string, any> }[] = [];
const fakeFetch = (async (input: any, init: any = {}) => {
  const entry: (typeof outbound)[number] = { url: String(input), headers: init.headers ?? {} };
  if (init.body instanceof FormData) entry.form = Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : { name: (v as File).name, size: (v as File).size }]));
  else if (init.body) entry.json = JSON.parse(init.body);
  outbound.push(entry);
  if (entry.url === 'https://openrouter.ai/api/v1/models') {
    return Response.json({ data: [{ id: 'besar/model', name: 'Besar', context_length: 1_000_000 }, { id: 'kecil/model', name: 'Kecil', context_length: 400 }] });
  }
  if (entry.url === 'https://openrouter.ai/api/v1/key') return entry.headers.Authorization === 'Bearer sk-or-benar-1234' ? Response.json({ data: { label: 'uji', limit: 10, usage: 2.5 } }) : new Response('{}', { status: 401 });
  if (entry.url === 'https://openrouter.ai/api/v1/chat/completions') {
    if (entry.headers.Authorization !== 'Bearer sk-or-benar-1234') return Response.json({ error: { message: 'No auth credentials found' } }, { status: 401 });
    const user: string = entry.json.messages[1].content;
    const n = (user.match(/^## Laporan \d+:/gm) ?? []).length;
    if (orMock.truncate) return Response.json({ choices: [{ message: { content: 'terpotong' }, finish_reason: 'length' }], usage: { total_tokens: 10 } });
    return Response.json({ choices: [{ message: { content: `# Hasil gabungan ${n} laporan\n\n| No | Ringkasan |\n|---|---|\n| 1 | ok |\n` }, finish_reason: 'stop' }], usage: { total_tokens: 100 * n } });
  }
  if (entry.url.includes('rusak')) return new Response('down', { status: 503 });
  return new Response('{"ok":true}', { status: 200 });
}) as typeof fetch;
const orMock = { truncate: false };
const masterKey = Buffer.alloc(32, 7);
const gowa = { baseUrl: 'https://gowa.test', user: 'u', password: 'p', deviceId: 'dev-1', gapMs: 0 };
const makeExecutor = () => createExecutor({ db, api, globalConcurrency: 5, filesDir, sheets, gowa, masterKey, fetch: fakeFetch, syncCheckMs: 60, tickMs: 60, pollMs: 80, recoverAfterMs: 400 });

async function call(method: string, url: string, payload?: unknown) {
  const res = await app.inject({ method: method as any, url, payload: payload as any, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, raw: res };
}

function graph(opts: { sales: number[]; chunk?: { mode: string; size: number | null }; sync?: Record<string, any> }) {
  const nodes: any[] = [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
    { id: 's', type: 'sales', position: { x: 0, y: 0 }, config: { sales: opts.sales.map((id) => ({ id, name: `Cabang ${id}` })) } },
    { id: 'p', type: 'prompt', position: { x: 0, y: 0 }, config: { mode: 'saved', savedPromptId: 7 } },
    { id: 'a', type: 'aw', position: { x: 0, y: 0 }, config: { model: 'mock/model', chatType: 'individual', runBySuperadmin: true, timeoutMin: 5 } },
    { id: 'v', type: 'viewer', position: { x: 0, y: 0 }, config: {} },
  ];
  const edges: any[] = [
    { id: 'e1', source: 't', sourceHandle: 'out', target: 's', targetHandle: 'in' },
    { id: 'e3', source: 'p', sourceHandle: 'out', target: 'a', targetHandle: 'prompt' },
    { id: 'e4', source: 'a', sourceHandle: 'out', target: 'v', targetHandle: 'in' },
  ];
  // Rantai sumber: Sales → (Sync) → (Chunk) → AW
  let from = 's';
  if (opts.sync) {
    nodes.push({ id: 'y', type: 'sync', position: { x: 0, y: 0 }, config: { mode: 'sync-max-priority', policy: 'stale', staleMinutes: 30, timeoutMin: 1, onTimeout: 'fail', ...opts.sync } });
    edges.push({ id: 'ey', source: from, sourceHandle: 'out', target: 'y', targetHandle: 'in' });
    from = 'y';
  }
  if (opts.chunk) {
    nodes.push({ id: 'c', type: 'chunk', position: { x: 0, y: 0 }, config: { ...opts.chunk, maxParts: 40 } });
    edges.push({ id: 'e2', source: from, sourceHandle: 'out', target: 'c', targetHandle: 'in' });
    from = 'c';
  }
  edges.push({ id: 'e5', source: from, sourceHandle: 'out', target: 'a', targetHandle: 'source' });
  return { nodes, edges };
}

async function newRun(g: any, params = { start_date: '2026-07-01', end_date: '2026-07-30' }) {
  const w = await call('POST', '/api/workflows', { name: 'uji', company_id: 1, company_name: 'Mock', graph: g, settings: {} });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  const r = await call('POST', `/api/workflows/${w.body.id}/runs`, params);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id as string;
}

async function waitFor(runId: string, statuses: string[], timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await call('GET', `/api/runs/${runId}`);
    // Uji lama tidak peduli langkah ukuran chunk: lewati dengan angka yang tersimpan di node.
    if (r.body.status === 'awaiting_chunk' && !statuses.includes('awaiting_chunk')) {
      await call('POST', `/api/runs/${runId}/replan`, { overrides: {} });
      continue;
    }
    if (statuses.includes(r.body.status)) return r.body;
    if (Date.now() > until) assert.fail(`run tetap ${r.body.status} (${r.body.error ?? ''}), menunggu ${statuses}`);
    await sleep(50);
  }
}

const count = (run: any, status: string) => run.units.filter((u: any) => u.status === status).length;

before(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query('drop database if exists aawb_test with (force)');
  await admin.query('create database aawb_test');
  await admin.end();

  await new Promise<void>((r) => aa.listen(0, '127.0.0.1', r));
  api = createClient({ baseUrl: `http://127.0.0.1:${(aa.address() as AddressInfo).port}`, token: 'mock', getRetries: 1 });
  db = createPool(testUrl);
  await migrate(db);
  await db.query('insert into users (email, password_hash) values ($1,$2)', ['uji@local.test', await hashPassword('uji-lokal')]);
  executor = makeExecutor();
  app = buildApp({ db, api, executor, filesDir, masterKey, fetch: fakeFetch, globalConcurrency: 5, secureCookie: false, publicHostname: 'wokflowbuilder.dbautoaudit.stream' });
  await app.ready();
  executor.start();
});

after(async () => {
  executor.stop();
  await app.close();
  await db.end();
  aa.close();
});

test('tanpa login ditolak, login berhasil', async () => {
  assert.equal((await call('GET', '/api/workflows')).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { email: 'uji@local.test', password: 'salah' })).status, 401);
  const ok = await call('POST', '/api/auth/login', { email: 'uji@local.test', password: 'uji-lokal' });
  assert.equal(ok.status, 200);
  cookie = String(ok.raw.headers['set-cookie']).split(';')[0];
  assert.equal((await call('GET', '/api/auth/me')).body.user.email, 'uji@local.test');
});

test('graf tidak lengkap ditolak saat run', async () => {
  const g = graph({ sales: [1] });
  g.nodes.find((n) => n.id === 's')!.config.sales = [];
  const w = await call('POST', '/api/workflows', { name: 'rusak', company_id: 1, company_name: 'Mock', graph: g, settings: {} });
  const r = await call('POST', `/api/workflows/${w.body.id}/runs`, { start_date: '2026-07-01', end_date: '2026-07-30' });
  assert.equal(r.status, 400);
  assert.match(r.body.issues.join(' '), /belum ada Sales ID atau akun WhatsApp Official/);
});

test('Sales ID dan Official dengan angka yang sama: daftar akun, simpan, estimasi, eksekusi, polling, dan laporan', async () => {
  const list = await call('GET', '/api/aa/official-accounts?company_id=1&q=Official');
  assert.equal(list.status, 200);
  assert.equal(list.body.items[0].channel, 'whatsapp_official');
  assert.equal(list.body.items[0].id, 1);
  assert.equal((await call('GET', '/api/aa/official-accounts?company_id=1&q=tidak-ada')).body.items.length, 0);
  const g = graph({ sales: [1] });
  g.nodes.find((n) => n.id === 's')!.config.sales.push({ id: 1, name: 'Official 1', channel: 'whatsapp_official' });
  const id = await newRun(g);
  const planned = await waitFor(id, ['awaiting_approval']);
  assert.deepEqual(planned.plan.units.map((u: any) => u.source.channel), ['whatsapp', 'whatsapp_official']);
  assert.equal((await call('POST', `/api/runs/${id}/approve`)).status, 200);
  const done = await waitFor(id, ['completed']);
  assert.equal(count(done, 'done'), 2);
  const official = done.units.find((u: any) => u.source.channel === 'whatsapp_official');
  const payload = mock.runs.get(official.history_id)!.payload;
  assert.equal(payload.whatsapp_official_account_id, 1);
  assert.equal(payload.sales_id, undefined);
  const report = await call('GET', `/api/units/${official.id}`);
  assert.match(report.body.content, /Laporan/);
});

test('2 sales x 30 hari per 5 hari: 12 AW, maksimal 5 bersamaan, semua selesai', async () => {
  mock.maxActive = 0;
  const posts = mock.posts;
  const id = await newRun(graph({ sales: [1, 2], chunk: { mode: 'days', size: 5 } }));
  const planned = await waitFor(id, ['awaiting_approval']);
  assert.equal(planned.plan.units.length, 12);
  assert.equal(planned.plan.groups[0].chunk.sizeFrom, 'manual');
  assert.equal(planned.units.length, 0); // belum ada yang jalan sebelum disetujui
  assert.equal(mock.posts, posts);

  assert.equal((await call('POST', `/api/runs/${id}/approve`)).status, 200);
  const done = await waitFor(id, ['completed']);
  assert.equal(count(done, 'done'), 12);
  assert.equal(mock.posts - posts, 12);
  assert.ok(mock.maxActive <= 5, `maks bersamaan ${mock.maxActive}`);
  assert.ok(mock.maxActive >= 4, `seharusnya paralel, ternyata ${mock.maxActive}`);

  const unit = await call('GET', `/api/units/${done.units[0].id}`);
  assert.match(unit.body.content, /^# Laporan sales 1 2026-07-01\.\.2026-07-05/);
  assert.equal(unit.body.token_usage, 1234);
});

test('usulan chunk dipakai bila angka kosong, dan bisa dihitung ulang dengan mode kontak', async () => {
  const id = await newRun(graph({ sales: [1], chunk: { mode: 'days', size: null } }));
  const planned = await waitFor(id, ['awaiting_approval']);
  const g = planned.plan.groups[0];
  assert.equal(g.chunk.sizeFrom, 'usulan');
  assert.equal(g.chunk.size, g.chunk.recommended.daysPerPart);
  assert.equal(g.chunk.size, 13); // 90 kontak / 30 hari → 40 baris keluaran ≈ 13 hari

  assert.equal((await call('POST', `/api/runs/${id}/replan`, { overrides: { c: { mode: 'contacts', size: 40 } } })).status, 200);
  const again = await waitFor(id, ['awaiting_approval']);
  assert.equal(again.plan.units.length, 3); // 90 kontak / 40
  assert.deepEqual(again.plan.units.map((u: any) => u.filter.chat_numbers.length), [30, 30, 30]);
  assert.equal(again.plan.units[0].filter.start_date, '2026-07-01'); // rentang tanggal tetap dikirim
  await call('POST', `/api/runs/${id}/cancel`);
});

test('sales tanpa chat dilewati, bukan gagal', async () => {
  const id = await newRun(graph({ sales: [2, 3] }));
  const planned = await waitFor(id, ['awaiting_approval']);
  assert.deepEqual(planned.plan.units.map((u: any) => u.skip), [false, true]);
  await call('POST', `/api/runs/${id}/approve`);
  const done = await waitFor(id, ['completed']);
  assert.equal(count(done, 'done'), 1);
  assert.equal(count(done, 'skipped'), 1);
});

test('satu gagal: run berhenti, yang berjalan selesai, lanjutkan hanya mengulang yang gagal', async () => {
  mock.failOnce.add('1|2026-07-06');
  const posts = mock.posts;
  const id = await newRun(graph({ sales: [1, 2], chunk: { mode: 'days', size: 5 } }));
  await waitFor(id, ['awaiting_approval']);
  await call('POST', `/api/runs/${id}/approve`);
  const failed = await waitFor(id, ['failed']);
  assert.equal(count(failed, 'failed'), 1);
  assert.equal(count(failed, 'running') + count(failed, 'starting'), 0); // yang sedang jalan dibiarkan selesai
  assert.ok(count(failed, 'queued') > 0, 'sisa antrean tidak dijalankan');
  assert.ok(count(failed, 'done') >= 1);
  const doneBefore = failed.units.filter((u: any) => u.status === 'done').map((u: any) => u.history_id);

  const resume = await call('POST', `/api/runs/${id}/resume`);
  assert.equal(resume.status, 200, JSON.stringify(resume.body));
  assert.equal(resume.body.retried, 1);
  const done = await waitFor(id, ['completed']);
  assert.equal(count(done, 'done'), 12);
  assert.equal(mock.posts - posts, 13); // 12 unit + 1 pengulangan
  for (const h of doneBefore) assert.ok(done.units.some((u: any) => u.history_id === h), 'unit sukses tidak dijalankan ulang');
  assert.equal(done.units.find((u: any) => u.label.includes('Cabang 1 · 2026-07-06')).attempt, 2);
});

test('lanjutkan ditolak bila isi prompt berubah', async () => {
  mock.failOnce.add('2|2026-07-01');
  const id = await newRun(graph({ sales: [2] }));
  await waitFor(id, ['awaiting_approval']);
  await call('POST', `/api/runs/${id}/approve`);
  await waitFor(id, ['failed']);
  mock.promptContent = 'Audit komplain v2 (diubah)';
  const resume = await call('POST', `/api/runs/${id}/resume`);
  assert.equal(resume.status, 409);
  assert.match(resume.body.error, /isi prompt berubah/);
  mock.promptContent = 'Audit komplain v1';
  assert.equal((await call('POST', `/api/runs/${id}/resume`)).status, 200);
  await waitFor(id, ['completed']);
});

test('server mati di tengah run: mesin baru melanjutkan tanpa AW ganda', async () => {
  mock.runMs = 600;
  const posts = mock.posts;
  const id = await newRun(graph({ sales: [1, 2], chunk: { mode: 'days', size: 5 } }));
  await waitFor(id, ['awaiting_approval']);
  await call('POST', `/api/runs/${id}/approve`);
  await sleep(250);
  executor.stop(); // "mati"
  const mid = (await call('GET', `/api/runs/${id}`)).body;
  assert.ok(count(mid, 'running') > 0);
  await sleep(300);
  executor = makeExecutor(); // "hidup lagi" dengan keadaan dari database
  executor.start();
  const done = await waitFor(id, ['completed']);
  assert.equal(count(done, 'done'), 12);
  assert.equal(mock.posts - posts, 12);
  assert.equal(new Set(done.units.map((u: any) => u.history_id)).size, 12);
  mock.runMs = 300;
});

test('balasan POST hilang: unit ditemukan lagi lewat correlation_id, tidak dikirim ulang', async () => {
  mock.dropResponseOnce.add('2|2026-07-01');
  const posts = mock.posts;
  const id = await newRun(graph({ sales: [2] }));
  await waitFor(id, ['awaiting_approval']);
  await call('POST', `/api/runs/${id}/approve`);
  const done = await waitFor(id, ['completed']);
  assert.equal(count(done, 'done'), 1);
  assert.equal(mock.posts - posts, 1);
});

test('batalkan run yang sedang jalan', async () => {
  mock.runMs = 2000;
  const id = await newRun(graph({ sales: [1, 2], chunk: { mode: 'days', size: 5 } }));
  await waitFor(id, ['awaiting_approval']);
  await call('POST', `/api/runs/${id}/approve`);
  await sleep(300);
  assert.equal((await call('POST', `/api/runs/${id}/cancel`)).status, 200);
  const r = (await call('GET', `/api/runs/${id}`)).body;
  assert.equal(r.status, 'cancelled');
  assert.equal(count(r, 'cancelled'), 12);
  const posts = mock.posts;
  await sleep(400);
  assert.equal(mock.posts, posts, 'tidak ada AW baru setelah dibatalkan');
  mock.runMs = 300;
});

test('parse tabel + export Excel, teks, dan PDF; PDF gagal lalu dilanjutkan tanpa mengulang AW', async () => {
  const g = graph({ sales: [1, 2], chunk: { mode: 'days', size: 15 } });
  g.nodes.push(
    { id: 'pt', type: 'parse', position: { x: 0, y: 0 }, config: { tables: 'all', addSource: true } },
    { id: 'x', type: 'export', position: { x: 0, y: 0 }, config: { format: 'xlsx', filename: 'rekap komplain', split: 'combined' } },
    { id: 'm', type: 'export', position: { x: 0, y: 0 }, config: { format: 'md', filename: '', split: 'combined' } },
    { id: 'f', type: 'export', position: { x: 0, y: 0 }, config: { format: 'pdf', filename: '', split: 'combined' } },
  );
  g.edges.push(
    { id: 'p1', source: 'a', sourceHandle: 'out', target: 'pt', targetHandle: 'in' },
    { id: 'p2', source: 'pt', sourceHandle: 'out', target: 'x', targetHandle: 'in' },
    { id: 'p3', source: 'a', sourceHandle: 'out', target: 'm', targetHandle: 'in' },
    { id: 'p4', source: 'a', sourceHandle: 'out', target: 'f', targetHandle: 'in' },
  );
  mock.pdfFailOnce = true;
  const posts = mock.posts;
  const id = await newRun(g);
  await waitFor(id, ['awaiting_approval']);
  await call('POST', `/api/runs/${id}/approve`);
  const failed = await waitFor(id, ['failed']);
  assert.match(failed.error, /Export PDF gagal.*501/);
  const st = (r: any, node: string) => r.steps.find((s: any) => s.node_id === node);
  assert.equal(st(failed, 'pt').status, 'done');
  assert.equal(st(failed, 'x').status, 'done');
  assert.equal(st(failed, 'f').status, 'failed');

  assert.equal((await call('POST', `/api/runs/${id}/resume`)).status, 200);
  const done = await waitFor(id, ['completed']);
  assert.equal(mock.posts - posts, 4, 'AW tidak diulang saat melanjutkan'); // 2 sales x 2 bagian
  assert.deepEqual(st(done, 'pt').summary, { kind: 'rows', reports: 4, tables: [{ columns: 5, rows: 8 }], rows: 8, withoutTable: [] });
  assert.equal(st(done, 'x').summary.name, 'rekap komplain.xlsx');
  assert.equal(st(done, 'x').summary.count, 1);
  assert.equal(st(done, 'f').summary.format, 'pdf');
  assert.match(mock.pdfBodies[0].htmlContent, /<table>[\s\S]*Ibu Sari/);
  assert.match(mock.pdfBodies[0].htmlContent, /Periode analisis: 2026-07-01 s[^<]*2026-07-\d\d/);
  assert.deepEqual(mock.pdfBodies[0].metaInfo, { model: 'mock/model', token: 4936 }, 'kotak Model Used dan Tokens pada PDF: jumlah token semua laporan di berkas itu');

  const preview = await call('GET', `/api/steps/${st(done, 'pt').id}`);
  assert.deepEqual(preview.body.tables[0].columns, ['Sumber', 'Bagian', 'No', 'Pelanggan', 'Masalah']);
  assert.deepEqual(preview.body.tables[0].rows[0], ['Cabang 1', '2026-07-01 s/d 2026-07-15', '1', 'Ibu Sari', 'Luntur']);

  const xlsx = await app.inject({ method: 'GET', url: `/api/steps/${st(done, 'x').id}/file`, headers: { cookie } });
  assert.equal(xlsx.statusCode, 200);
  assert.match(String(xlsx.headers['content-disposition']), /filename="rekap komplain\.xlsx"/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx.rawPayload as any);
  const ws = wb.worksheets[0];
  assert.equal(ws.rowCount, 9); // header + 8 baris
  assert.equal(ws.getRow(9).getCell(4).value, 'Pak Budi');

  const md = await app.inject({ method: 'GET', url: `/api/steps/${st(done, 'm').id}/file`, headers: { cookie } });
  assert.match(md.body, /^# Cabang 1 · 2026-07-01 s\/d 2026-07-15\n\n# Laporan sales 1/);
  assert.equal(md.body.split('\n---\n').length, 4);
});

test('export Excel langsung dari AW membaca tabel otomatis; PDF dari Parse Tabel ditolak', async () => {
  const g = graph({ sales: [2] });
  g.nodes.push({ id: 'x', type: 'export', position: { x: 0, y: 0 }, config: { format: 'xlsx' } });
  g.edges.push({ id: 'p1', source: 'a', sourceHandle: 'out', target: 'x', targetHandle: 'in' });
  const id = await newRun(g);
  await waitFor(id, ['awaiting_approval']);
  await call('POST', `/api/runs/${id}/approve`);
  const done = await waitFor(id, ['completed']);
  assert.equal(done.steps[0].summary.rows, 2);
  const file = await app.inject({ method: 'GET', url: `/api/steps/${done.steps[0].id}/file`, headers: { cookie } });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.rawPayload as any);
  // Satu file per laporan: kolom Sumber/Bagian tidak perlu, asalnya sudah ada di nama file.
  assert.deepEqual((wb.worksheets[0].getRow(1).values as any[]).slice(1), ['No', 'Pelanggan', 'Masalah']);
  assert.equal(done.steps[0].summary.name, 'Cabang 2-2026-07-01 sd 2026-07-30-uji.xlsx');

  const bad = graph({ sales: [2] });
  bad.nodes.push({ id: 'pt', type: 'parse', position: { x: 0, y: 0 }, config: {} }, { id: 'f', type: 'export', position: { x: 0, y: 0 }, config: { format: 'pdf' } });
  bad.edges.push({ id: 'p1', source: 'a', sourceHandle: 'out', target: 'pt', targetHandle: 'in' }, { id: 'p2', source: 'pt', sourceHandle: 'out', target: 'f', targetHandle: 'in' });
  const w = await call('POST', '/api/workflows', { name: 'salah', company_id: 1, company_name: 'Mock', graph: bad, settings: {} });
  const r = await call('POST', `/api/workflows/${w.body.id}/runs`, { start_date: '2026-07-01', end_date: '2026-07-30' });
  assert.equal(r.status, 400);
  assert.match(r.body.issues.join(' '), /butuh masukan laporan langsung dari Proses AW/);
});

test('tulis Sheets: header ditulis saat kosong, lalu upsert memperbarui tanpa menggandakan', async () => {
  fakeSheet.rows = [];
  const make = (mode: string) => {
    const g = graph({ sales: [2] });
    g.nodes.push({ id: 'gs', type: 'sheets', position: { x: 0, y: 0 }, config: { url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd/edit#gid=7', gid: 7, tabTitle: 'Rekap', mode, keyColumns: 'Sumber, No', table: 1 } });
    g.edges.push({ id: 'p1', source: 'a', sourceHandle: 'out', target: 'gs', targetHandle: 'in' });
    return g;
  };
  const go = async (mode: string) => {
    const id = await newRun(make(mode));
    await waitFor(id, ['awaiting_approval']);
    await call('POST', `/api/runs/${id}/approve`);
    return (await waitFor(id, ['completed', 'failed'])).steps[0];
  };

  const first = await go('append');
  assert.equal(first.status, 'done', first.error);
  assert.deepEqual([first.summary.appended, first.summary.wroteHeader], [2, true]);
  assert.deepEqual(fakeSheet.rows[0], ['Sumber', 'Bagian', 'No', 'Pelanggan', 'Masalah']);
  assert.equal(fakeSheet.rows.length, 3);

  fakeSheet.rows[1][4] = 'diubah manual';
  const second = await go('upsert');
  assert.deepEqual([second.summary.appended, second.summary.updated], [0, 2]);
  assert.equal(fakeSheet.rows.length, 3);
  assert.equal(fakeSheet.rows[1][4], 'Luntur');

  const third = await go('dedup');
  assert.deepEqual([third.summary.appended, third.summary.skipped], [0, 2]);

  fakeSheet.rows[0] = ['Kolom', 'Lain'];
  const bad = await go('upsert');
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /Kolom kunci tidak ada/);
});

test('AutoAudit bilang selesai tapi jawaban kosong: unit gagal, lanjutkan mengulangnya', async () => {
  const id = await newRun(graph({ sales: [2] }));
  await waitFor(id, ['awaiting_approval']);
  await call('POST', `/api/runs/${id}/approve`);
  // history pertama untuk sales 2 dibuat kosong
  for (let i = 0; i < 40 && ![...mock.runs.values()].some((r) => r.payload.sales_id === 2 && !r.counted); i++) await sleep(25);
  const hid = [...mock.runs.entries()].filter(([, r]) => r.payload.sales_id === 2).at(-1)![0];
  mock.emptyIds.add(hid);
  const failed = await waitFor(id, ['failed']);
  assert.match(failed.units[0].error, /jawaban AI kosong/);
  assert.equal((await call('POST', `/api/runs/${id}/resume`)).status, 200);
  const done = await waitFor(id, ['completed']);
  assert.equal(done.units[0].attempt, 2);
  assert.notEqual(done.units[0].history_id, hid);
});

test('sync sales: yang baru disinkron dilewati, AW menunggu sync selesai', async () => {
  mock.syncPosts = [];
  mock.syncMs = 500;
  const posts = mock.posts;
  const id = await newRun(graph({ sales: [1, 2], sync: {}, chunk: { mode: 'days', size: 15 } }));
  const planned = await waitFor(id, ['awaiting_approval']);
  assert.equal(planned.plan.units.length, 4, 'perencana melihat sales di balik Sync dan Chunk');
  await call('POST', `/api/runs/${id}/approve`);
  await sleep(300);
  const mid = (await call('GET', `/api/runs/${id}`)).body;
  assert.equal(mid.steps[0].status, 'running');
  assert.equal(mock.posts, posts, 'belum ada AW sebelum sync selesai');
  assert.equal(count(mid, 'queued'), 4);
  const done = await waitFor(id, ['completed']);
  assert.deepEqual(mock.syncPosts, [2], 'hanya sales 2 yang datanya lama');
  assert.deepEqual(done.steps[0].summary.jobs.map((j: any) => j.status), ['skipped', 'done']);
  assert.equal(mock.posts - posts, 4);
});

test('sync gagal: run berhenti tanpa menjalankan AW; lanjutkan hanya mengulang sales yang gagal', async () => {
  mock.syncPosts = [];
  mock.syncMs = 150;
  mock.lastSyncAgoMin[1] = 600;
  mock.syncFailOnce.add(2);
  const posts = mock.posts;
  const id = await newRun(graph({ sales: [1, 2], sync: {} }));
  await waitFor(id, ['awaiting_approval']);
  await call('POST', `/api/runs/${id}/approve`);
  const failed = await waitFor(id, ['failed']);
  assert.match(failed.error, /Cabang 2: Sync gagal: worker timeout/);
  assert.equal(mock.posts, posts);
  assert.equal((await call('POST', `/api/runs/${id}/resume`)).status, 200);
  await waitFor(id, ['completed']);
  assert.deepEqual(mock.syncPosts, [1, 2, 2]);
  assert.equal(mock.posts - posts, 2);
  mock.lastSyncAgoMin[1] = 5;
});

test('kirim pesan dengan file Excel dan HTTP request membawa laporan', async () => {
  outbound.length = 0;
  const g = graph({ sales: [2] });
  g.nodes.push(
    { id: 'x', type: 'export', position: { x: 0, y: 0 }, config: { format: 'xlsx', filename: 'rekap' } },
    { id: 'w', type: 'message', position: { x: 0, y: 0 }, config: { mode: 'file', targetType: 'Group', target: '120363@g.us', text: 'Selesai {{workflow}} {{periode}}: {{jumlah_aw}} AW', includeReports: false } },
    { id: 'w2', type: 'message', position: { x: 0, y: 0 }, config: { mode: 'text', targetType: 'Individual', target: '0811', text: 'Ringkas', includeReports: true } },
    { id: 'h', type: 'http', position: { x: 0, y: 0 }, config: { method: 'POST', url: 'https://hook.test/in', headers: 'X-Secret: abc' } },
  );
  g.edges.push(
    { id: 'm1', source: 'a', sourceHandle: 'out', target: 'x', targetHandle: 'in' },
    { id: 'm2', source: 'x', sourceHandle: 'out', target: 'w', targetHandle: 'in' },
    { id: 'm3', source: 'a', sourceHandle: 'out', target: 'w2', targetHandle: 'in' },
    { id: 'm4', source: 'a', sourceHandle: 'out', target: 'h', targetHandle: 'in' },
  );
  const id = await newRun(g);
  await waitFor(id, ['awaiting_approval']);
  await call('POST', `/api/runs/${id}/approve`);
  const done = await waitFor(id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);

  // Bentuk body mengikuti node HTTP Request di n8n: multipart berisi phone, caption, type, handler, file.
  const file = outbound.find((o) => o.url === 'https://gowa.test/send/file')!;
  assert.deepEqual(Object.keys(file.form!).sort(), ['caption', 'file', 'handler', 'phone', 'type']);
  assert.equal(file.form!.phone, '120363@g.us');
  assert.equal(file.form!.type, 'Group');
  assert.equal(file.form!.handler, 'Devina');
  assert.equal(file.form!.caption, 'Selesai uji 2026-07-01 s/d 2026-07-30: 1 AW');
  assert.equal(file.form!.file.name, 'Cabang 2-2026-07-01 sd 2026-07-30-uji.xlsx');
  assert.ok(file.form!.file.size > 100);
  assert.equal(file.headers['X-Device-Id'], 'dev-1');
  assert.equal(file.headers['Content-Type'], undefined);
  assert.equal(file.headers.Authorization, 'Basic ' + Buffer.from('u:p').toString('base64'));

  const texts = outbound.filter((o) => o.url === 'https://gowa.test/send/message');
  assert.deepEqual(texts.map((t) => [t.json.phone, t.json.type, t.json.handler]), [['62811', 'Individual', 'Devina'], ['62811', 'Individual', 'Devina']]);
  assert.match(texts[1].json.message, /^\*Cabang 2\*\n\n# Laporan sales 2/);

  const hook = outbound.find((o) => o.url === 'https://hook.test/in')!;
  assert.equal(hook.headers['X-Secret'], 'abc');
  assert.equal(hook.json.reports.length, 1);
  assert.equal(hook.json.params.start_date, '2026-07-01');
});

test('HTTP request ke alamat yang menolak membuat run gagal dengan pesan jelas', async () => {
  const g = graph({ sales: [2] });
  g.nodes.push({ id: 'h', type: 'http', position: { x: 0, y: 0 }, config: { method: 'POST', url: 'https://rusak.test/in', headers: '' } });
  g.edges.push({ id: 'm4', source: 'a', sourceHandle: 'out', target: 'h', targetHandle: 'in' });
  const id = await newRun(g);
  await waitFor(id, ['awaiting_approval']);
  await call('POST', `/api/runs/${id}/approve`);
  const failed = await waitFor(id, ['failed']);
  assert.match(failed.error, /rusak\.test membalas 503/);
});

function fetchGraph(node: any) {
  return {
    nodes: [
      { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
      node,
      { id: 'x', type: 'export', position: { x: 0, y: 0 }, config: { format: 'xlsx', filename: 'gabungan' } },
    ],
    edges: [
      { id: 'e1', source: 't', sourceHandle: 'out', target: node.id, targetHandle: 'in' },
      { id: 'e2', source: node.id, sourceHandle: 'out', target: 'x', targetHandle: 'in' },
    ],
  };
}

test('History AW: mengambil laporan lama tanpa menjalankan AW, lalu mengekspornya', async () => {
  const posts = mock.posts;
  const id = await newRun(fetchGraph({ id: 'h', type: 'history', position: { x: 0, y: 0 }, config: { items: [{ id: 777, title: 'Audit Juni', runBySuperadmin: false }, { id: 779, title: 'Audit Juli', runBySuperadmin: true }] } }));
  const planned = await waitFor(id, ['awaiting_approval']);
  assert.deepEqual(planned.plan.units.map((u: any) => u.label), ['#777 · Audit Juni', '#779 · Audit Juli']);
  await call('POST', `/api/runs/${id}/approve`);
  const done = await waitFor(id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(mock.posts, posts, 'tidak ada Audital Work baru');
  assert.equal(done.steps[0].summary.rows, 2);
  assert.match((await call('GET', `/api/units/${done.units[0].id}`)).body.content, /Laporan lama 777/);
});

test('History AW: salah sisi (superadmin) dan history tanpa laporan gagal dengan pesan jelas', async () => {
  const id = await newRun(fetchGraph({ id: 'h', type: 'history', position: { x: 0, y: 0 }, config: { items: [{ id: 777, title: 'x', runBySuperadmin: true }, { id: 778, title: 'kosong', runBySuperadmin: false }] } }));
  await waitFor(id, ['awaiting_approval']);
  await call('POST', `/api/runs/${id}/approve`);
  const failed = await waitFor(id, ['failed']);
  assert.match(failed.units[0].error, /tidak ditemukan di sisi Superadmin/);
  assert.match(failed.units[1].error, /belum punya laporan/);
});

test('Hasil Continuous: run terakhir, atau semua run pada rentang tanggal; sales yang gagal dicatat', async () => {
  const node = (pick: string) => ({ id: 'ca', type: 'continuous', position: { x: 0, y: 0 }, config: { scheduleId: 9, scheduleLabel: 'SOP Closing', pick, maxRuns: 31 } });
  const latest = await waitFor(await newRun(fetchGraph(node('latest'))), ['awaiting_approval']);
  assert.deepEqual(latest.plan.units.map((u: any) => u.label), ['SPV 1 · 2026-07-03']);
  assert.match(latest.plan.warnings.join(' '), /SPV 2 · 2026-07-03: tidak ada laporan/);

  const id = await newRun(fetchGraph(node('range')), { start_date: '2026-07-01', end_date: '2026-07-02' });
  const planned = await waitFor(id, ['awaiting_approval']);
  assert.deepEqual(planned.plan.units.map((u: any) => u.label), ['SPV 1 · 2026-07-01']); // run 2 Juli gagal, 3 Juli di luar rentang
  await call('POST', `/api/runs/${id}/approve`);
  const done = await waitFor(id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(done.units[0].history_id, 891);

  const none = await waitFor(await newRun(fetchGraph(node('range')), { start_date: '2026-08-01', end_date: '2026-08-02' }), ['awaiting_approval']);
  assert.equal(none.plan.units.length, 0);
  assert.match(none.plan.warnings.join(' '), /tidak ada run yang selesai/);
});

test('alur chunk bertahap: pratinjau data → angka chunk → rencana → kembali ubah → jalankan', async () => {
  const posts = mock.posts;
  const id = await newRun(graph({ sales: [1, 2], chunk: { mode: 'contacts', size: null } }));
  const step2 = await waitFor(id, ['awaiting_chunk']);
  assert.equal(step2.plan, null);
  assert.equal(step2.preview.preview, true);
  assert.equal(step2.preview.days, 30);
  assert.deepEqual(step2.preview.groups.map((g: any) => [g.source.name, g.chunk.mode, g.chunk.full.contacts, g.chunk.recommended.contactsPerPart]), [
    ['Cabang 1', 'contacts', 90, 40],
    ['Cabang 2', 'contacts', 25, 25],
  ]);
  assert.equal(step2.preview.totals.contacts, 115);
  assert.equal((await call('POST', `/api/runs/${id}/approve`)).status, 409, 'belum bisa dijalankan sebelum rencana disusun');

  await call('POST', `/api/runs/${id}/replan`, { overrides: { c: { size: 30 } } });
  const step3 = await waitFor(id, ['awaiting_approval']);
  assert.equal(step3.plan.units.length, 4); // 90/30 + 25/30
  assert.equal(step3.plan.groups[0].chunk.mode, 'contacts', 'mode tetap dari node');

  assert.equal((await call('POST', `/api/runs/${id}/rechunk`)).status, 200);
  const back = await waitFor(id, ['awaiting_chunk']);
  assert.equal(back.preview.totals.contacts, 115, 'pratinjau dipakai lagi tanpa dihitung ulang');
  await call('POST', `/api/runs/${id}/replan`, { overrides: { c: { size: 45 } } });
  const again = await waitFor(id, ['awaiting_approval']);
  assert.equal(again.plan.units.length, 3); // 90/45 + 25/45
  assert.equal(mock.posts, posts, 'belum ada AW sampai disetujui');
  await call('POST', `/api/runs/${id}/approve`);
  assert.equal(count(await waitFor(id, ['completed']), 'done'), 3);
});

test('pilihan sync saat Run mengalahkan pengaturan node', async () => {
  for (const [policy, expected] of [['skip', []], ['always', [1, 2]], ['stale', [2]]] as const) {
    mock.syncPosts = [];
    mock.syncMs = 100;
    const w = await call('POST', '/api/workflows', { name: 'uji', company_id: 1, company_name: 'Mock', graph: graph({ sales: [1, 2], sync: { policy: 'always' } }), settings: {} });
    const r = await call('POST', `/api/workflows/${w.body.id}/runs`, { start_date: '2026-07-01', end_date: '2026-07-30', sync_policy: policy });
    await waitFor(r.body.id, ['awaiting_approval']);
    await call('POST', `/api/runs/${r.body.id}/approve`);
    await waitFor(r.body.id, ['completed']);
    assert.deepEqual([...mock.syncPosts].sort(), expected, `sync_policy=${policy}`);
  }
});

test('workflow wajib punya company sejak dibuat, dan company tidak bisa diganti', async () => {
  const g = graph({ sales: [1] });
  const none = await call('POST', '/api/workflows', { name: 'x', company_id: null, company_name: '', graph: g, settings: {} });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /Pilih company dulu/);
  const w = await call('POST', '/api/workflows', { name: 'x', company_id: 1, company_name: 'Mock', graph: g, settings: {} });
  const put = await call('PUT', `/api/workflows/${w.body.id}`, { name: 'y', company_id: 99, company_name: 'Lain', graph: g, settings: {} });
  assert.deepEqual([put.body.name, put.body.company_id, put.body.company_name], ['y', 1, 'Mock']);
});

test('filter kontak: hanya nomor tertentu, atau mengecualikannya; nomor 08… diubah ke 62…', async () => {
  const withContacts = (mode: string, numbers: string, chunk?: any) => {
    const g = graph({ sales: [2], chunk });
    Object.assign(g.nodes.find((n) => n.id === 'a')!.config, { contactMode: mode, contactNumbers: numbers });
    return g;
  };
  const planOf = async (g: any) => (await waitFor(await newRun(g), ['awaiting_approval'])).plan;
  // Sales 2 punya 25 kontak: 6282000000000 … 6282000000024. Ditempel dalam format lokal dan campuran;
  // nomor terakhir bukan kontak sales ini.
  const paste = '082000000000\n+62 820-0000-0001\n6282000000002\n089999999999';

  const only = await planOf(withContacts('only', paste));
  assert.deepEqual(only.units[0].filter.chat_numbers, ['6282000000000', '6282000000001', '6282000000002', '6289999999999']);
  assert.equal(only.units[0].filter.is_excluded, false);
  assert.equal(only.units[0].estimate.contacts, 3);
  assert.deepEqual(only.groups[0].contacts, { mode: 'only', count: 4 });

  const excl = await planOf(withContacts('exclude', paste));
  assert.equal(excl.units[0].filter.is_excluded, true);
  assert.equal(excl.units[0].estimate.contacts, 22);

  // Dengan Chunk per kontak: daftar disaring dulu, tiap bagian membawa nomornya sendiri.
  const exclChunk = await planOf(withContacts('exclude', paste, { mode: 'contacts', size: 11 }));
  assert.deepEqual(exclChunk.units.map((u: any) => [u.filter.chat_numbers.length, u.filter.is_excluded]), [[11, false], [11, false]]);
  assert.ok(!exclChunk.units.some((u: any) => u.filter.chat_numbers.includes('6282000000000')));

  const onlyChunk = await planOf(withContacts('only', paste, { mode: 'contacts', size: 2 }));
  assert.deepEqual(onlyChunk.units.map((u: any) => u.filter.chat_numbers.length), [2, 1]);
  assert.match(onlyChunk.warnings.join(' '), /1 dari 4 nomor tidak punya chat/);

  // Dengan Chunk per hari: filter nomor ikut di setiap potongan tanggal.
  const exclDays = await planOf(withContacts('exclude', paste, { mode: 'days', size: 15 }));
  assert.deepEqual(exclDays.units.map((u: any) => [u.filter.start_date, u.filter.chat_numbers.length, u.filter.is_excluded]), [['2026-07-01', 4, true], ['2026-07-16', 4, true]]);

  const none = await call('POST', '/api/workflows', { name: 'x', company_id: 1, company_name: 'Mock', graph: withContacts('only', 'bukan nomor'), settings: {} });
  assert.match((await call('POST', `/api/workflows/${none.body.id}/runs`, { start_date: '2026-07-01', end_date: '2026-07-30' })).body.issues.join(' '), /daftar nomor.*masih kosong/);
});

test('export terpisah: satu file per laporan, dibungkus zip, dinamai sales-periode-judul', async () => {
  const cont = { id: 'ca', type: 'continuous', position: { x: 0, y: 0 }, config: { scheduleId: 9, scheduleLabel: 'SOP Closing: SPV/1', pick: 'range', maxRuns: 31 } };
  const g = fetchGraph(cont);
  Object.assign(g.nodes.find((n: any) => n.id === 'x')!.config, { format: 'pdf', filename: '' }); // split tidak diisi = terpisah
  g.nodes.push({ id: 'one', type: 'export', position: { x: 0, y: 0 }, config: { format: 'md', split: 'separate', pattern: '{{judul}} ({{sales}})' } } as any);
  g.nodes.push({ id: 'all', type: 'export', position: { x: 0, y: 0 }, config: { format: 'txt', split: 'combined', filename: 'semua' } } as any);
  g.edges.push({ id: 'e3', source: 'ca', sourceHandle: 'out', target: 'one', targetHandle: 'in' }, { id: 'e4', source: 'ca', sourceHandle: 'out', target: 'all', targetHandle: 'in' });
  mock.pdfBodies.length = 0;
  const id = await newRun(g, { start_date: '2026-07-01', end_date: '2026-07-03' });
  await waitFor(id, ['awaiting_approval']);
  await call('POST', `/api/runs/${id}/approve`);
  const done = await waitFor(id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  const st = (node: string) => done.steps.find((s: any) => s.node_id === node);

  // Dua run (1 dan 3 Juli) → dua laporan → dua PDF dalam satu zip. Periode diambil dari history, judul dari jadwal.
  const pdf = st('x').summary;
  assert.deepEqual([pdf.zipped, pdf.count, pdf.format], [true, 2, 'pdf']);
  assert.deepEqual(pdf.files, ['SPV 1-2026-06-24 sd 2026-06-30-SOP Closing SPV 1.pdf', 'SPV 1-2026-06-24 sd 2026-06-30-SOP Closing SPV 1 (2).pdf']);
  assert.equal(mock.pdfBodies.length, 2, 'satu panggilan PDF per laporan');
  const res = await app.inject({ method: 'GET', url: `/api/steps/${st('x').id}/file`, headers: { cookie } });
  assert.equal(res.headers['content-type'], 'application/zip');
  const zip = await JSZip.loadAsync(res.rawPayload);
  assert.deepEqual(Object.keys(zip.files), pdf.files);
  assert.equal((await zip.file(pdf.files[0])!.async('string')).slice(0, 5), '%PDF-');

  assert.deepEqual(st('one').summary.files, ['SOP Closing SPV 1 (SPV 1).md', 'SOP Closing SPV 1 (SPV 1) (2).md']);
  // Digabung: tetap satu file, bukan zip.
  assert.deepEqual([st('all').summary.zipped, st('all').summary.name], [false, 'semua.txt']);
});

function mergeGraph(sales: number[], chunk?: any) {
  const g = graph({ sales, chunk });
  g.nodes.push(
    { id: 'mg', type: 'merge', position: { x: 0, y: 0 }, config: { title: 'Rekap gabungan', prompt: 'Gabungkan semua laporan.', model: '' } },
    { id: 'x', type: 'export', position: { x: 0, y: 0 }, config: { format: 'md', split: 'combined', filename: 'gabungan' } },
  );
  g.edges.push({ id: 'g1', source: 'a', sourceHandle: 'out', target: 'mg', targetHandle: 'in' }, { id: 'g2', source: 'mg', sourceHandle: 'out', target: 'x', targetHandle: 'in' });
  return g;
}
const stepOf = (run: any, node: string) => run.steps.find((s: any) => s.node_id === node);

test('merge report: laporan AW digabung lewat id history, hasilnya diteruskan ke Export', async () => {
  mock.merges.length = 0;
  const id = await newRun(mergeGraph([1, 2]));
  await waitFor(id, ['awaiting_approval']);
  await call('POST', `/api/runs/${id}/approve`);
  const done = await waitFor(id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(mock.merges.length, 1);
  const sent = mock.merges[0].body;
  assert.deepEqual(sent.source_history_ids.sort(), done.units.map((u: any) => u.history_id).sort());
  assert.equal(sent.base_history_id, sent.source_history_ids[0]);
  assert.deepEqual([sent.title, sent.prompt, 'source_assistant_message_ids' in sent], ['Rekap gabungan', 'Gabungkan semua laporan.', false]);
  assert.equal(sent.model, 'mock/model', 'model bawaan company dikirim bila node tidak memilih');
  assert.deepEqual([stepOf(done, 'mg').summary.levels, stepOf(done, 'mg').summary.report_id > 0], [1, true]);
  const file = await app.inject({ method: 'GET', url: `/api/steps/${stepOf(done, 'x').id}/file`, headers: { cookie } });
  assert.match(file.body, /^# Rekap gabungan\n\nGabungan dari 2 sumber/);
  assert.match((await call('GET', `/api/steps/${stepOf(done, 'mg').id}`)).body.report.content, /Gabungan dari 2 sumber/);
});

test('merge report bertingkat: 12 laporan → dua merge 6 sumber, lalu satu merge akhir', async () => {
  mock.merges.length = 0;
  const id = await newRun(mergeGraph([1, 2], { mode: 'days', size: 5 }));
  await waitFor(id, ['awaiting_approval']);
  await call('POST', `/api/runs/${id}/approve`);
  const done = await waitFor(id, ['completed', 'failed'], 40_000);
  assert.equal(done.status, 'completed', done.error);
  assert.deepEqual(mock.merges.map((m) => m.body.source_history_ids.length), [6, 6, 2]);
  assert.deepEqual(mock.merges[2].body.source_history_ids, [mock.merges[0].id, mock.merges[1].id], 'tingkat 2 menggabung hasil tingkat 1');
  assert.match(mock.merges[0].body.title, /tingkat 1, bagian 1 dari 2/);
  assert.equal(mock.merges[2].body.title, 'Rekap gabungan');
  assert.equal(stepOf(done, 'mg').summary.levels, 2);
});

test('merge gagal: run berhenti; lanjutkan hanya mengulang merge, tanpa mengulang AW', async () => {
  mock.merges.length = 0;
  mock.mergeFailOnce = true;
  const posts = mock.posts;
  const id = await newRun(mergeGraph([1, 2]));
  await waitFor(id, ['awaiting_approval']);
  await call('POST', `/api/runs/${id}/approve`);
  const failed = await waitFor(id, ['failed']);
  assert.match(failed.error, /Merge gagal: model timeout/);
  assert.equal(stepOf(failed, 'x').status, 'waiting');
  assert.equal((await call('POST', `/api/runs/${id}/resume`)).status, 200);
  await waitFor(id, ['completed']);
  assert.equal(mock.merges.length, 2);
  assert.equal(mock.posts - posts, 2, 'AW tidak diulang');
});

test('merge: endpoint belum dipasang di server → pesan jelas; satu laporan → diteruskan tanpa merge', async () => {
  mock.mergeLive = false;
  const id = await newRun(mergeGraph([1, 2]));
  await waitFor(id, ['awaiting_approval']);
  await call('POST', `/api/runs/${id}/approve`);
  assert.match((await waitFor(id, ['failed'])).error, /belum tersedia di server AutoAudit/);

  mock.merges.length = 0;
  const one = await newRun(mergeGraph([2]));
  await waitFor(one, ['awaiting_approval']);
  await call('POST', `/api/runs/${one}/approve`);
  const done = await waitFor(one, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(mock.merges.length, 0);
  assert.match(stepOf(done, 'mg').summary.note, /diteruskan apa adanya/);
  mock.mergeLive = true;
});

function aiMergeGraph(sales: number[], cfg: Record<string, any>, chunk?: any) {
  const g = graph({ sales, chunk });
  g.nodes.push(
    { id: 'ai', type: 'aimerge', position: { x: 0, y: 0 }, config: { apiKey: '', apiKeyHint: '', model: 'besar/model', title: 'Gabungan AI', prompt: 'Gabungkan.', ...cfg } },
    { id: 'x', type: 'export', position: { x: 0, y: 0 }, config: { format: 'md', split: 'combined', filename: 'hasil ai' } },
  );
  g.edges.push({ id: 'a1', source: 'a', sourceHandle: 'out', target: 'ai', targetHandle: 'in' }, { id: 'a2', source: 'ai', sourceHandle: 'out', target: 'x', targetHandle: 'in' });
  return g;
}
async function runWorkflow(g: any) {
  const w = await call('POST', '/api/workflows', { name: 'uji ai', company_id: 1, company_name: 'Mock', graph: g, settings: {} });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  const r = await call('POST', `/api/workflows/${w.body.id}/runs`, { start_date: '2026-07-01', end_date: '2026-07-30' });
  return { w: w.body, r };
}

test('Merge AI: key disimpan terenkripsi, tidak pernah kembali ke browser, dan merge berjalan lewat OpenRouter', async () => {
  outbound.length = 0;
  const { w, r } = await runWorkflow(aiMergeGraph([1, 2], { apiKey: 'sk-or-benar-1234' }));
  // Balasan simpan, baca ulang, dan salinan graf di run tidak memuat key.
  const saved = w.graph.nodes.find((n: any) => n.id === 'ai').config;
  assert.deepEqual([saved.apiKey, saved.apiKeyHint], ['', '1234']);
  assert.ok(!JSON.stringify((await call('GET', `/api/workflows/${w.id}`)).body).includes('sk-or-benar'));
  const stored = (await db.query('select value_enc from node_secrets where workflow_id=$1', [w.id])).rows[0].value_enc;
  assert.ok(!stored.includes('sk-or-benar'), 'tersimpan terenkripsi');

  assert.equal(r.status, 200, JSON.stringify(r.body));
  await waitFor(r.body.id, ['awaiting_approval']);
  await call('POST', `/api/runs/${r.body.id}/approve`);
  const done = await waitFor(r.body.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.ok(!JSON.stringify(done).includes('sk-or-benar'), 'run tidak memuat key');

  const callOut = outbound.filter((o) => o.url.endsWith('/chat/completions'));
  assert.equal(callOut.length, 1);
  assert.equal(callOut[0].json.model, 'besar/model');
  assert.equal(callOut[0].json.messages[0].content, 'Gabungkan.');
  assert.match(callOut[0].json.messages[1].content, /## Laporan 1: Cabang 1[\s\S]*## Laporan 2: Cabang 2/);
  const sum = stepOf(done, 'ai').summary;
  assert.deepEqual([sum.sources, sum.calls, sum.tokens, sum.levels], [2, 1, 200, 1]);
  const file = await app.inject({ method: 'GET', url: `/api/steps/${stepOf(done, 'x').id}/file`, headers: { cookie } });
  assert.match(file.body, /^# Hasil gabungan 2 laporan/);

  // Menyimpan ulang tanpa mengisi key tidak menghapus key yang ada.
  const again = await call('PUT', `/api/workflows/${w.id}`, { name: 'uji ai', company_id: 1, company_name: 'Mock', graph: w.graph, settings: {} });
  assert.equal(again.body.graph.nodes.find((n: any) => n.id === 'ai').config.apiKeyHint, '1234');
  assert.deepEqual(again.body.issues, []);
});

test('Merge AI: tanpa key ditolak saat Run; key salah gagal dengan pesan jelas lalu bisa dilanjutkan setelah diganti', async () => {
  const none = await runWorkflow(aiMergeGraph([1, 2], {}));
  assert.equal(none.r.status, 400);
  assert.match(none.r.body.issues.join(' '), /API key OpenRouter belum diisi/);

  const posts = mock.posts;
  const { w, r } = await runWorkflow(aiMergeGraph([1, 2], { apiKey: 'sk-or-salah-9999' }));
  await waitFor(r.body.id, ['awaiting_approval']);
  await call('POST', `/api/runs/${r.body.id}/approve`);
  assert.match((await waitFor(r.body.id, ['failed'])).error, /API key OpenRouter ditolak/);

  const g = w.graph;
  g.nodes.find((n: any) => n.id === 'ai').config.apiKey = 'sk-or-benar-1234';
  await call('PUT', `/api/workflows/${w.id}`, { name: 'uji ai', company_id: 1, company_name: 'Mock', graph: g, settings: {} });
  assert.equal((await call('POST', `/api/runs/${r.body.id}/resume`)).status, 200);
  await waitFor(r.body.id, ['completed']);
  assert.equal(mock.posts - posts, 2, 'AW tidak diulang');
});

test('Merge AI: model berkonteks kecil → digabung bertingkat; jawaban terpotong → gagal dengan saran', async () => {
  outbound.length = 0;
  const { r } = await runWorkflow(aiMergeGraph([1, 2], { apiKey: 'sk-or-benar-1234', model: 'kecil/model' }, { mode: 'days', size: 5 }));
  await waitFor(r.body.id, ['awaiting_approval']);
  await call('POST', `/api/runs/${r.body.id}/approve`);
  const done = await waitFor(r.body.id, ['completed', 'failed'], 40_000);
  assert.equal(done.status, 'completed', done.error);
  const sum = stepOf(done, 'ai').summary;
  assert.equal(sum.sources, 12);
  assert.ok(sum.levels >= 2 && sum.calls > 2, `bertingkat: ${sum.levels} tingkat, ${sum.calls} panggilan`);
  assert.match(outbound.find((o) => o.url.endsWith('/chat/completions'))!.json.messages[0].content, /Ini bagian 1 dari \d+/);

  orMock.truncate = true;
  const cut = await runWorkflow(aiMergeGraph([1, 2], { apiKey: 'sk-or-benar-1234' }));
  await waitFor(cut.r.body.id, ['awaiting_approval']);
  await call('POST', `/api/runs/${cut.r.body.id}/approve`);
  assert.match((await waitFor(cut.r.body.id, ['failed'])).error, /terpotong karena batas panjang keluaran/);
  orMock.truncate = false;
});

test('OpenRouter: daftar model dan pemeriksaan key', async () => {
  const models = await call('GET', '/api/openrouter/models');
  assert.deepEqual(models.body.items.map((m: any) => m.id), ['besar/model', 'kecil/model']);
  assert.deepEqual((await call('POST', '/api/openrouter/check', { key: 'sk-or-benar-1234' })).body, { ok: true, message: 'Key valid (uji), sisa limit $7.50.' });
  assert.equal((await call('POST', '/api/openrouter/check', { key: 'sk-or-salah-9999' })).body.ok, false);
});

test('Merge AI → Export PDF: satu PDF dari laporan gabungan', async () => {
  mock.pdfBodies.length = 0;
  const g = aiMergeGraph([1, 2], { apiKey: 'sk-or-benar-1234', title: 'Rekap Mingguan' });
  Object.assign(g.nodes.find((n: any) => n.id === 'x')!.config, { format: 'pdf', split: 'separate', filename: '', pattern: '' });
  const { r } = await runWorkflow(g);
  await waitFor(r.body.id, ['awaiting_approval']);
  await call('POST', `/api/runs/${r.body.id}/approve`);
  const done = await waitFor(r.body.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  const sum = stepOf(done, 'x').summary;
  assert.deepEqual([sum.format, sum.count, sum.zipped], ['pdf', 1, false]);
  assert.equal(sum.name, 'Gabungan-2026-07-01 sd 2026-07-30-Rekap Mingguan.pdf');
  assert.equal(mock.pdfBodies.length, 1, 'satu PDF, bukan satu per laporan sumber');
  assert.match(mock.pdfBodies[0].htmlContent, /Hasil gabungan 2 laporan[\s\S]*<table>/);
  assert.equal(mock.pdfBodies[0].metaInfo.token, 200);
  const file = await app.inject({ method: 'GET', url: `/api/steps/${stepOf(done, 'x').id}/file`, headers: { cookie } });
  assert.equal(file.headers['content-type'], 'application/pdf');
});


test('Workflow lifecycle: publish, edit kembali Draft, unpublish, arsip read-only dan pulihkan; setting tersimpan di PostgreSQL', async () => {
  const body = { name: 'Lifecycle persistence', company_id: 1, company_name: 'Mock', graph: graph({ sales: [1] }), settings: { concurrency: 3, requireApproval: true } };
  const created = await call('POST', '/api/workflows', body);
  assert.equal(created.status, 200);
  const id = created.body.id;
  const lifecycle = (action: string) => call('POST', `/api/workflows/${id}/lifecycle`, { action });
  assert.equal(created.body.status, 'draft');
  assert.equal((await call('POST', `/api/workflows/${id}/runs`, { start_date: '2026-07-01', end_date: '2026-07-02', mode: 'published' })).status, 409);
  assert.equal((await lifecycle('publish')).body.status, 'published');
  assert.equal((await call('PUT', `/api/workflows/${id}`, body)).body.status, 'published', 'autosave identik mempertahankan publish');
  body.settings.concurrency = 4;
  assert.equal((await call('PUT', `/api/workflows/${id}`, body)).body.status, 'draft');
  assert.equal((await lifecycle('publish')).body.status, 'published');
  const publishedRun = await call('POST', `/api/workflows/${id}/runs`, { start_date: '2026-07-01', end_date: '2026-07-02', mode: 'published' });
  assert.equal(publishedRun.status, 200);
  await waitFor(publishedRun.body.id, ['awaiting_approval']);
  await call('POST', `/api/runs/${publishedRun.body.id}/cancel`);
  assert.equal((await lifecycle('unpublish')).body.status, 'draft');
  const separatePool = createPool(testUrl);
  assert.deepEqual((await separatePool.query('select settings from workflows where id=$1', [id])).rows[0].settings, body.settings);
  await separatePool.end();
  assert.equal((await call('DELETE', `/api/workflows/${id}`, { confirmation: 'DELETE' })).status, 409, 'wajib arsip');
  assert.equal((await lifecycle('archive')).body.status, 'archived');
  assert.equal((await call('PUT', `/api/workflows/${id}`, body)).status, 409);
  assert.equal((await lifecycle('publish')).status, 409);
  assert.equal((await call('POST', `/api/workflows/${id}/runs`, { start_date: '2026-07-01', end_date: '2026-07-02' })).status, 409);
  assert.equal((await lifecycle('restore')).body.status, 'draft');
  assert.deepEqual((await call('GET', `/api/workflows/${id}`)).body.settings, body.settings);
  await lifecycle('archive');
  assert.equal((await call('DELETE', `/api/workflows/${id}`)).status, 400);
  assert.equal((await call('DELETE', `/api/workflows/${id}`, { confirmation: 'delete' })).status, 400);
  assert.equal((await call('DELETE', `/api/workflows/${id}`, { confirmation: 'DELETE' })).status, 200);
  assert.equal((await call('GET', `/api/workflows/${id}`)).status, 404);
  assert.equal((await call('DELETE', `/api/workflows/${id}`, { confirmation: 'DELETE' })).status, 404);
});

test('Workflow: publish ditolak untuk graf tidak lengkap; arsip menolak run menunggu persetujuan', async () => {
  const empty = await call('POST', '/api/workflows', { name: 'Incomplete', company_id: 1, graph: { nodes: [], edges: [] } });
  assert.equal((await call('POST', `/api/workflows/${empty.body.id}/lifecycle`, { action: 'publish' })).status, 400);
  const { w, r } = await runWorkflow(graph({ sales: [1] }));
  await waitFor(r.body.id, ['awaiting_approval']);
  assert.equal((await call('POST', `/api/workflows/${w.id}/lifecycle`, { action: 'archive' })).status, 409);
  await call('POST', `/api/runs/${r.body.id}/cancel`);
  assert.equal((await call('POST', `/api/workflows/${w.id}/lifecycle`, { action: 'archive' })).status, 200);
  assert.equal((await call('POST', `/api/runs/${r.body.id}/replan`, { overrides: {} })).status, 409);
});

test('Permanent delete: cascade run, unit, step, node secret dan file; cleanup antrean pulih saat restart', async () => {
  const { w, r } = await runWorkflow(aiMergeGraph([1], { apiKey: 'sk-or-benar-1234' }));
  await waitFor(r.body.id, ['awaiting_approval']);
  await call('POST', `/api/runs/${r.body.id}/approve`);
  const done = await waitFor(r.body.id, ['completed']);
  assert.ok(done.units.length);
  const dir = join(filesDir, r.body.id);
  await access(dir);
  assert.equal((await db.query('select count(*)::int n from node_secrets where workflow_id=$1', [w.id])).rows[0].n, 1);
  await call('POST', `/api/workflows/${w.id}/lifecycle`, { action: 'archive' });
  assert.equal((await call('DELETE', `/api/workflows/${w.id}`, { confirmation: 'DELETE' })).status, 200);
  await assert.rejects(access(dir));
  for (const table of ['runs','units','steps']) {
    const column = table === 'runs' ? 'id' : 'run_id';
    assert.equal((await db.query(`select count(*)::int n from ${table} where ${column}=$1`, [r.body.id])).rows[0].n, 0);
  }
  assert.equal((await db.query('select count(*)::int n from node_secrets where workflow_id=$1', [w.id])).rows[0].n, 0);
  // Simulasi shutdown setelah commit delete sebelum cleanup filesystem.
  const orphan = '11111111-1111-4111-8111-111111111111';
  await mkdir(join(filesDir, orphan), { recursive: true });
  await writeFile(join(filesDir, orphan, 'report.txt'), 'fixture');
  await db.query('insert into file_cleanup(run_id) values ($1)', [orphan]);
  const restarted = buildApp({ db, api, executor, filesDir, masterKey, globalConcurrency: 5, secureCookie: false });
  await restarted.ready();
  await assert.rejects(access(join(filesDir, orphan)));
  assert.equal((await db.query('select count(*)::int n from file_cleanup')).rows[0].n, 0);
  await restarted.close();
});


test('HTTPS publik memakai Secure cookie; login localhost tetap dapat digunakan', async () => {
  const payload = { email: 'uji@local.test', password: 'uji-lokal' };
  const publicLogin = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: 'wokflowbuilder.dbautoaudit.stream' }, payload });
  assert.equal(publicLogin.statusCode, 200);
  assert.match(String(publicLogin.headers['set-cookie']), /; Secure(?:;|$)/i);
  const localLogin = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: '127.0.0.1:8787' }, payload });
  assert.equal(localLogin.statusCode, 200);
  assert.doesNotMatch(String(localLogin.headers['set-cookie']), /; Secure(?:;|$)/i);
});
