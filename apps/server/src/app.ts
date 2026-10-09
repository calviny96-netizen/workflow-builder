import { executeCode, codeItems } from './code.ts';
import { createScheduler } from './scheduler.ts';
import { resolvePeriod, validDate, wibClock } from '../../../packages/nodes/src/calendar.ts';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { unwrap } from '../../../packages/autoaudit/src/index.ts';
import type { AutoAuditClient } from '../../../packages/autoaudit/src/index.ts';
import { fingerprint } from '../../../packages/engine/src/plan.ts';
import { incoming, validateGraph } from '../../../packages/nodes/src/index.ts';
import type { Graph } from '../../../packages/nodes/src/index.ts';
import { COOKIE, login, logout, updateAccount, userFromToken } from './auth.ts';
import type { SessionUser } from './auth.ts';
import type { Db } from './db.ts';
import type { Executor } from './executor.ts';
import { GoogleError } from './google.ts';
import type { SheetsClient } from './google.ts';
import { parseSheetUrl } from '../../../packages/engine/src/sheetplan.ts';
import { buildPlan, PlanError, resolvePrompt } from './planner.ts';
import { openRouterModels, stepNodes } from './steps.ts';
import { checkKey } from './steps-aimerge.ts';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {readSecret} from './secrets.ts';
import { stashSecrets } from './secrets.ts';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream, existsSync } from 'node:fs';
import type { Plan } from './planner.ts';

export interface AppDeps {
  db: Db;
  filesDir?: string;
  api: AutoAuditClient;
  executor: Executor;
  sheets?: SheetsClient | null;
  google?: ReturnType<typeof import('./google-settings.ts').googleSettings>;
  gowaReady?: boolean;
  masterKey: Buffer;
  fetch?: typeof fetch;
  globalConcurrency: number;
  secureCookie: boolean;
  publicHostname?: string;
}

const graphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string().min(1).max(64),
      type: z.string(),
      position: z.object({ x: z.number(), y: z.number() }),
      config: z.record(z.string(), z.any()).default({}),
    }),
  ),
  edges: z.array(
    z.object({ id: z.string(), source: z.string(), sourceHandle: z.string(), target: z.string(), targetHandle: z.string() }),
  ),
});

const workflowBody = z.object({
  name: z.string().trim().min(1).max(120),
  company_id: z.number().int().positive().nullable(),
  company_name: z.string().max(200).default(''),
  graph: graphSchema,
  settings: z.object({ concurrency: z.number().int().min(1).max(50).optional(), requireApproval: z.boolean().optional() }).default({}),
});

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const overridesSchema = z.record(
  z.string(),
  z.object({ mode: z.enum(['days', 'contacts']).optional(), size: z.number().int().min(1).max(10000).nullable().optional() }),
);
const uuid = z.string().uuid();

const UNIT_COLUMNS = `id, run_id, node_id, seq, label, source, estimate, status, history_id, attempt, error, token_usage, model_used,
  finish_reason, started_at, finished_at, payload->'filter' as filter, payload->>'run_by_superadmin' as run_by_superadmin, coalesce((payload->>'fetch')::boolean, false) as fetch`;

export function buildApp(deps: AppDeps) {
  const { db, api, executor } = deps;
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  app.register(cookie);

  const cache = new Map<string, { at: number; value: unknown }>();
  async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Input tidak valid.', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    if (err instanceof GoogleError) return reply.code(400).send({ error: err.message });
    if (err instanceof PlanError) return reply.code(400).send({ error: err.message, issues: err.issues });
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    console.error(err);
    reply.code(500).send({ error: 'Terjadi kesalahan di server.' });
  });

  // --- Auth
  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const session = await login(db, body.email, body.password);
    if (!session) return reply.code(401).send({ error: 'Email atau password salah.' });
    reply.setCookie(COOKIE, session.token, { httpOnly: true, sameSite: 'lax', secure: deps.secureCookie || (!!deps.publicHostname && req.headers.host?.split(':')[0] === deps.publicHostname), path: '/', maxAge: 7 * 86400 });
    return { user: session.user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await logout(db, req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  const users = new WeakMap<FastifyRequest, SessionUser>();
  const me = (req: FastifyRequest) => users.get(req)!;
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/auth/login') || req.url.startsWith('/api/health')) return;
    const user = await userFromToken(db, req.cookies[COOKIE]);
    if (!user) return reply.code(401).send({ error: 'Belum login.' });
    users.set(req, user);
  });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/auth/me', async (req) => ({ user: me(req) }));
  app.patch('/api/auth/account', async (req, reply) => {
    const body = z.object({
      email: z.string().trim().toLowerCase().email().max(254),
      currentPassword: z.string().min(1).max(1024),
      newPassword: z.string().min(8).max(128).optional(),
    }).parse(req.body);
    try {
      const user = await updateAccount(db, me(req).id, req.cookies[COOKIE]!, body.email, body.currentPassword, body.newPassword);
      if (!user) return reply.code(403).send({ error: 'Password saat ini salah.' });
      return { user };
    } catch (err: any) {
      if (err?.code === '23505') return reply.code(409).send({ error: 'Email sudah digunakan oleh akun lain.' });
      throw err;
    }
  });

  // --- Proxy AutoAudit untuk dropdown. Token tidak pernah sampai ke browser.
  const aaFail = (reply: FastifyReply, res: { status: number; body: any }) =>
    reply.code(502).send({ error: `AutoAudit membalas ${res.status}${res.body?.error?.message ? ': ' + res.body.error.message : ''}` });

  app.get('/api/aa/companies', async (req, reply) => {
    const q = z.object({ q: z.string().optional() }).parse(req.query);
    const res = await api.listCompanies({ page: 1, limit: 25, q: q.q || undefined, sort: 'name_asc' });
    if (!res.ok) return aaFail(reply, res);
    return { items: (res.body.data ?? []).map((c: any) => ({ id: c.id, name: c.name })) };
  });

  app.get('/api/aa/sales', async (req, reply) => {
    const q = z.object({ company_id: z.coerce.number().int().positive(), q: z.string().optional(), page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
    const res = await api.listSales({ company_id: q.company_id, page: q.page, limit: 100, q: q.q || undefined, sort: 'name_asc' });
    if (!res.ok) return aaFail(reply, res);
    return {
      items: (res.body.data ?? []).map((s: any) => ({
        id: s.id,
        name: s.name,
        phone_number: s.phone_number,
        status: s.status,
        division: s.division?.name ?? null,
        last_sync_at: s.last_sync_at,
      })),
      pagination: res.body.pagination,
    };
  });

  app.get('/api/aa/official-accounts', async (req, reply) => {
    const q = z.object({ company_id: z.coerce.number().int().positive(), q: z.string().default('') }).parse(req.query);
    const res = await api.listOfficialAccounts(q.company_id);
    if (!res.ok) return aaFail(reply, res);
    const words = q.q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const items = (unwrap<any>(res.body)?.items ?? []).map((a: any) => ({
      id: a.id, name: a.name || a.verified_name || `Official #${a.id}`,
      phone_number: a.display_phone_number ?? '', status: a.local_status ?? '',
      verified_name: a.verified_name ?? '', channel: 'whatsapp_official',
    })).filter((a: any) => words.every((w) => `${a.id} ${a.name} ${a.phone_number} ${a.verified_name}`.toLowerCase().includes(w)));
    return { items, pagination: { total: items.length } };
  });

  app.get('/api/aa/histories', async (req, reply) => {
    const q = z
      .object({ company_id: z.coerce.number().int().positive(), q: z.string().optional(), superadmin: z.enum(['true', 'false']).default('false'), page: z.coerce.number().int().min(1).default(1) })
      .parse(req.query);
    const res = await api.listHistories({ company_id: q.company_id, run_by_superadmin: q.superadmin === 'true', page: q.page, limit: 30, q: q.q || undefined });
    if (!res.ok) return aaFail(reply, res);
    const d = res.body?.data ?? {};
    return {
      items: (d.data ?? []).map((h: any) => ({ id: h.history_id, title: h.title, status: h.status, sales_name: h.sales_name ?? null, created_at: h.created_at })),
      pagination: d.pagination ?? null,
    };
  });

  app.get('/api/aa/schedules', async (req, reply) => {
    const q = z.object({ company_id: z.coerce.number().int().positive(), q: z.string().optional() }).parse(req.query);
    const res = await api.listSchedules({ company_id: q.company_id, page: 1, limit: 100, q: q.q || undefined });
    if (!res.ok) return aaFail(reply, res);
    return {
      items: (res.body?.data ?? []).map((s: any) => ({
        id: s.id, label: s.label, is_active: !!s.is_active, sales_count: s.sales_count, last_run_at: s.last_run_at, last_run_status: s.last_run_status,
      })),
    };
  });

  app.get('/api/aa/schedules/:id/runs', async (req, reply) => {
    const id = z.coerce.number().int().positive().parse((req.params as any).id);
    const q = z.object({ company_id: z.coerce.number().int().positive() }).parse(req.query);
    const res = await api.listScheduleRuns(id, { company_id: q.company_id, page: 1, limit: 5 });
    if (!res.ok) return aaFail(reply, res);
    return { items: (res.body?.data ?? []).map((r: any) => ({ id: r.id, run_at: r.run_at, status: r.status, sales: r.sales_summary })) };
  });

  app.get('/api/aa/catalog', async (req, reply) => {
    const q = z.object({ company_id: z.coerce.number().int().positive() }).parse(req.query);
    return cached(`catalog:${q.company_id}`, 60_000, async () => {
      const [prompts, memories, models, filters] = await Promise.all([
        api.listSavedPrompts(q.company_id),
        api.listMemories(q.company_id),
        api.listModels(q.company_id),
        api.getFilterOptions(q.company_id),
      ]);
      for (const r of [prompts, memories, models, filters]) if (!r.ok) throw Object.assign(new Error(`AutoAudit membalas ${r.status}`), { statusCode: 400 });
      const m = unwrap<any>(models.body);
      return {
        prompts: (unwrap<any>(prompts.body).items ?? []).filter((p: any) => !p.is_deleted).map((p: any) => ({ id: p.id, title: p.title })),
        memories: (unwrap<any>(memories.body).items ?? [])
          .filter((x: any) => !x.is_deleted)
          .map((x: any) => ({ id: x.id, title: x.title, token_count: x.token_count, type: x.memory_type })),
        models: (m.items ?? [])
          .filter((x: any) => x.is_enabled)
          .map((x: any) => ({ name: x.model_name, context_length: x.context_length, superadmin_only: !!x.is_superadmin_only })),
        default_model: m.summary?.default_model ?? null,
        filter_options: unwrap<any>(filters.body),
      };
    }).catch((e) => reply.code(502).send({ error: e.message }));
  });

  // --- OpenRouter: daftar model (publik) dan pemeriksaan key. Key hanya lewat di sini, tidak disimpan oleh rute ini.
  app.get('/api/openrouter/models', async (_req, reply) => {
    try {
      return { items: await openRouterModels(deps.fetch) };
    } catch (e: any) {
      return reply.code(502).send({ error: e.message });
    }
  });
  app.post('/api/openrouter/check', async (req) => {
    const b = z.object({ key: z.string().min(8).max(400) }).parse(req.body);
    return checkKey(b.key.trim(), deps.fetch);
  });

  app.get('/api/google/credentials', async () => deps.google?.status() ?? ({ configured: !!deps.sheets?.email, email: deps.sheets?.email ?? null, error: '' }));
  app.post('/api/google/credentials', async (req, reply) => {
    const body = z.object({ json: z.string().min(1).max(32_768) }).parse(req.body);
    if (!deps.google) return reply.code(503).send({ error: 'Pengaturan Google belum tersedia.' });
    return deps.google.configure(body.json);
  });

  // --- Google Sheets: daftar tab untuk panel konfigurasi
  app.get('/api/google/tabs', async (req, reply) => {
    const q = z.object({ url: z.string().min(1) }).parse(req.query);
    if (!deps.sheets) return reply.code(400).send({ error: 'Kunci service account Google belum dipasang di .secrets/google.json.' });
    const target = parseSheetUrl(q.url);
    if (!target) return reply.code(400).send({ error: 'Tautan spreadsheet tidak valid.' });
    const meta = await deps.sheets.tabs(target.id);
    const tabs = await Promise.all(
      meta.tabs.map(async (t) => ({ ...t, header: t.gid === (target.gid ?? meta.tabs[0]?.gid) ? ((await deps.sheets!.read(target.id, t.title))[0] ?? []) : null })),
    );
    return { title: meta.title, tabs, gid: target.gid, email: deps.sheets.email };
  });

  // Endpoint merge AI baru ada di dokumentasi per 2 Okt 2026 dan belum tentu sudah dipasang di server.
  // Body kosong pasti ditolak (400) bila rutenya ada, jadi pengecekan ini tidak pernah memulai merge.
  async function mergeAvailable(): Promise<boolean> {
    return cached('merge-available', 5 * 60_000, async () => {
      try {
        const r = await api.startMergeRun({});
        return r.body !== null && typeof r.body === 'object';
      } catch {
        return false;
      }
    });
  }
  app.get('/api/integrations', async () => ({ gowa: !!deps.gowaReady, sheets_email: deps.sheets?.email || null, merge: await mergeAvailable() }));

  const filesDir = deps.filesDir ?? fileURLToPath(new URL('../../../.data/files', import.meta.url));
  let cleaning = false;
  async function cleanupFiles() {
    if (cleaning) return;
    cleaning = true;
    try {
      for (const row of (await db.query('select run_id from file_cleanup')).rows) {
        await rm(join(filesDir, uuid.parse(row.run_id)), { recursive: true, force: true });
        await db.query('delete from file_cleanup where run_id=$1', [row.run_id]);
      }
    } catch (error) { console.error('[file cleanup]', error); }
    finally { cleaning = false; }
  }
  let cleanupTimer: ReturnType<typeof setInterval>;
  app.addHook('onReady', async () => {
    await cleanupFiles();
    cleanupTimer = setInterval(() => { void cleanupFiles(); }, 30_000);
    cleanupTimer.unref();
  });
  app.addHook('onClose', async () => { clearInterval(cleanupTimer); });

  async function activeRuns(client: Pick<Db, 'query'>, id: string) {
    return (await client.query(`select 1 from runs r where workflow_id=$1 and
      (r.status in ('planning','running','awaiting_chunk','awaiting_approval')
       or exists (select 1 from units u where u.run_id=r.id and u.status in ('starting','running'))
       or exists (select 1 from steps s where s.run_id=r.id and s.status='running')) limit 1`, [id])).rowCount;
  }

  // --- Workflow
  app.get('/api/workflows', async () => {
    const r = await db.query(
      `select w.id, w.name, w.company_id, w.company_name, w.updated_at, w.status, w.published_at, w.archived_at, jsonb_array_length(w.graph->'nodes') as node_count,
         (select row_to_json(x) from (select id, status, created_at from runs where workflow_id = w.id order by created_at desc limit 1) x) as last_run
       from workflows w order by w.updated_at desc`,
    );
    return { items: r.rows };
  });

  app.post('/api/workflows', async (req, reply) => {
    const b = workflowBody.parse(req.body);
    // Company wajib dipilih sebelum workflow dibuat; semua daftar di editor bergantung padanya.
    if (!b.company_id) return reply.code(400).send({ error: 'Pilih company dulu sebelum membuat workflow.' });
    const client = await db.connect();
    try {
      await client.query('begin');
      const r = await client.query(
        'insert into workflows (name, company_id, company_name, settings, created_by) values ($1,$2,$3,$4,$5) returning *',
        [b.name, b.company_id, b.company_name, JSON.stringify(b.settings), me(req).id],
      );
      const graph = await stashSecrets(client, deps.masterKey, r.rows[0].id, b.graph as Graph);
      await client.query('update workflows set graph=$2 where id=$1', [r.rows[0].id, JSON.stringify(graph)]);
      await client.query('commit');
      return { ...r.rows[0], graph };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  });

  app.get('/api/workflows/:id', async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const r = await db.query('select * from workflows where id=$1', [id]);
    if (!r.rows[0]) return reply.code(404).send({ error: 'Workflow tidak ditemukan.' });
    return { ...r.rows[0], issues: validateGraph(r.rows[0].graph) };
  });

  app.put('/api/workflows/:id', async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const b = workflowBody.parse(req.body);
    const client = await db.connect();
    try {
      await client.query('begin');
      const w = (await client.query('select * from workflows where id=$1 for update', [id])).rows[0];
      if (!w) return reply.code(404).send({ error: 'Workflow tidak ditemukan.' });
      if (w.status === 'archived') return reply.code(409).send({ error: 'Pulihkan workflow dari arsip sebelum mengubahnya.' });
      const safeGraph = await stashSecrets(client, deps.masterKey, id, b.graph as Graph);
      const r = await client.query(
        `update workflows set name=$2, company_id=coalesce(company_id, $3),
         company_name=case when company_id is null then $4 else company_name end,
         status=case when $7::boolean or name is distinct from $2 or graph is distinct from $5::jsonb or settings is distinct from $6::jsonb then 'draft' else status end,
         graph=$5, settings=$6, updated_at=now() where id=$1 returning *`,
        [id, b.name, b.company_id, b.company_name, JSON.stringify(safeGraph), JSON.stringify({...w.settings,...b.settings}), b.graph.nodes.some(n => ['apiKey','autobotApiKey','webhookToken'].some(field => String(n.config[field] ?? '').trim()))],
      );
      await client.query('commit');
      return { ...r.rows[0], issues: validateGraph(safeGraph) };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { await client.query('rollback'); client.release(); }
  });

  app.post('/api/workflows/:id/lifecycle', async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const { action } = z.object({ action: z.enum(['publish','unpublish','archive','restore']) }).parse(req.body);
    const client = await db.connect();
    try {
      await client.query('begin');
      const w = (await client.query('select * from workflows where id=$1 for update', [id])).rows[0];
      if (!w) return reply.code(404).send({ error: 'Workflow tidak ditemukan.' });
      if (action === 'restore') {
        if (w.status !== 'archived') return reply.code(409).send({ error: 'Workflow belum diarsipkan.' });
      } else if (w.status === 'archived') return reply.code(409).send({ error: 'Pulihkan workflow dari arsip terlebih dahulu.' });
      if (action === 'publish') {
        const issues = validateGraph(w.graph);
        if (!w.company_id || issues.length) return reply.code(400).send({ error: 'Lengkapi workflow sebelum publish.', issues: issues.map(i => i.message) });
      }
      if (action === 'archive' && await activeRuns(client, id)) return reply.code(409).send({ error: 'Masih ada run aktif atau menunggu persetujuan. Batalkan dulu sebelum mengarsipkan.' });
      const status = action === 'publish' ? 'published' : action === 'archive' ? 'archived' : 'draft';
      const r = await client.query(`update workflows set status=$2, updated_at=now(),
        published_at=case when $2='published' then now() else published_at end,
        archived_at=case when $2='archived' then now() else null end where id=$1 returning *`, [id, status]);
      await client.query('commit');
      return r.rows[0];
    } catch (error) { await client.query('rollback'); throw error; }
    finally { await client.query('rollback'); client.release(); }
  });

  app.delete('/api/workflows/:id', async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    z.object({ confirmation: z.literal('DELETE') }).parse(req.body);
    const client = await db.connect();
    try {
      await client.query('begin');
      const w = (await client.query('select status from workflows where id=$1 for update', [id])).rows[0];
      if (!w) return reply.code(404).send({ error: 'Workflow tidak ditemukan.' });
      if (w.status !== 'archived') return reply.code(409).send({ error: 'Arsipkan workflow sebelum menghapus permanen.' });
      if (await activeRuns(client, id)) return reply.code(409).send({ error: 'Masih ada run aktif. Batalkan dulu.' });
      await client.query(`insert into file_cleanup(run_id) select id from runs where workflow_id=$1 on conflict do nothing`, [id]);
      await client.query('delete from workflows where id=$1', [id]);
      await client.query('commit');
      await cleanupFiles();
      return { ok: true };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { await client.query('rollback'); client.release(); }
  });

  // --- Run
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'POST' || !/^\/api\/runs\/[^/]+\/(approve|resume|replan|rechunk)/.test(req.url)) return;
    const id = uuid.parse((req.params as any).id);
    const row = (await db.query('select w.status from runs r join workflows w on w.id=r.workflow_id where r.id=$1', [id])).rows[0];
    if (row?.status === 'archived') return reply.code(409).send({ error: 'Pulihkan workflow dari arsip sebelum melanjutkan run.' });
  });
  async function planRun(runId: string, opts: { interactive: boolean } = { interactive: true }) {
    const r = await db.query('select * from runs where id=$1', [runId]);
    const run = r.rows[0];
    if (!run) return;
    try {
      // Bila ada Chunk dan user belum menentukan angkanya, berhenti dulu di pratinjau data periode penuh.
      const needsChunkStep = opts.interactive && !run.chunk_confirmed && (run.graph as Graph).nodes.some((n) => n.type === 'chunk');
      if (needsChunkStep) {
        const preview = await buildPlan({ api, graph: run.graph, params: run.params, companyId: run.company_id, overrides: run.overrides, previewOnly: true });
        await db.query(`update runs set preview=$2, plan=null, status='awaiting_chunk', error=null where id=$1 and status='planning'`, [runId, JSON.stringify(preview)]);
        return;
      }
      const plan = await buildPlan({ api, graph: run.graph, params: run.params, companyId: run.company_id, overrides: run.overrides });
      await db.query(`update runs set plan=$2, status='awaiting_approval', error=null where id=$1 and status='planning'`, [runId, JSON.stringify(plan)]);
    } catch (err) {
      const message = err instanceof PlanError ? err.issues.join(' ') : `Gagal menyusun rencana: ${err instanceof Error ? err.message : err}`;
      await db.query(`update runs set status='plan_failed', error=$2, finished_at=now() where id=$1 and status='planning'`, [runId, message.slice(0, 2000)]);
    }
  }

  async function approve(runId: string): Promise<string | null> {
    const client = await db.connect();
    try {
      await client.query('begin');
      const r = await client.query(`select * from runs where id=$1 for update`, [runId]);
      const run = r.rows[0];
      if (!run || run.status !== 'awaiting_approval') {
        await client.query('rollback');
        return 'Run tidak sedang menunggu persetujuan.';
      }
      const plan: Plan = run.plan;
      const blocked = plan.units.filter((u) => !u.skip && !u.estimate.canStart);
      if (blocked.length) {
        await client.query('rollback');
        return `${blocked.length} Audital Work ditolak preflight (mis. ${blocked[0].label}: ${blocked[0].estimate.errorCode || 'tidak bisa dimulai'}). Ubah ukuran chunk lalu hitung ulang.`;
      }
      for (const u of plan.units) {
        await client.query(
          `insert into units (run_id, node_id, seq, label, source, payload, estimate, fp_input, fingerprint, timeout_min, status, error, finished_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            runId, u.nodeId, u.seq, u.label, JSON.stringify(u.source), JSON.stringify(u.payload), JSON.stringify(u.estimate),
            JSON.stringify(u.fpInput), u.fingerprint, u.timeoutMin,
            u.skip ? 'skipped' : 'queued', u.skip ? 'Tidak ada pesan pada rentang ini' : null, u.skip ? new Date() : null,
          ],
        );
      }
      for (const n of stepNodes(run.graph)) {
        await client.query('insert into steps (run_id, node_id, type) values ($1,$2,$3)', [runId, n.id, n.type]);
      }
      await client.query(`update runs set status='running', started_at=now() where id=$1`, [runId]);
      await client.query('commit');
      return null;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  const scheduler = createScheduler(db, async (id, requireApproval) => {
    const status = (await db.query('select status from runs where id=$1', [id])).rows[0]?.status;
    if (status === 'planning') await planRun(id, { interactive: false });
    if (!requireApproval) await approve(id);
  }, deps.globalConcurrency);
  app.addHook('onReady', async () => { scheduler.start(); });
  app.addHook('onClose', async () => { scheduler.stop(); });

  app.post('/api/code/test', async (req) => {
    const body = z.object({language:z.enum(['javascript','python']),code:z.string().min(1).max(100000),runMode:z.enum(['all','each']).default('all'),timeoutSeconds:z.number().int().min(1).max(30).default(10),items:z.any().default([])}).parse(req.body);
    try {return await executeCode(body,body.items);} catch(error) {throw new PlanError([error instanceof Error ? error.message : String(error)]);}
  });

  app.get('/api/workflows/:id/runs', async (req) => {
    const id = uuid.parse((req.params as any).id);
    const r = await db.query(
      `select r.id, r.status, r.params, r.error, r.created_at, r.started_at, r.finished_at, u.email as created_by,
         (select count(*)::int from units x where x.run_id = r.id) as unit_count,
         (select coalesce(sum(token_usage),0)::int from units x where x.run_id = r.id) as token_usage
       from runs r left join users u on u.id = r.created_by where r.workflow_id=$1 order by r.created_at desc limit 50`,
      [id],
    );
    return { items: r.rows };
  });

  app.post('/api/workflows/:id/runs', async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ start_date: date, end_date: date, sync_policy: z.enum(['skip', 'always', 'stale']).optional(), mode: z.enum(['manual', 'published']).default('manual') }).parse(req.body);
    const client = await db.connect();
    let runId: string;
    let requireApproval: boolean;
    try {
      await client.query('begin');
      const w = (await client.query('select * from workflows where id=$1 for update', [id])).rows[0];
      if (!w) return reply.code(404).send({ error: 'Workflow tidak ditemukan.' });
      if (w.status === 'archived') return reply.code(409).send({ error: 'Pulihkan workflow dari arsip sebelum menjalankan.' });
      if (b.mode === 'published' && w.status !== 'published') return reply.code(409).send({ error: 'Workflow harus dipublish sebelum dijalankan oleh integrasi.' });
      if (!w.company_id) return reply.code(400).send({ error: 'Pilih company dulu.' });
      const issues = validateGraph(w.graph);
      if (issues.length) return reply.code(400).send({ error: 'Workflow belum lengkap.', issues: issues.map((i) => i.message) });
      const concurrency = Math.min(deps.globalConcurrency, Number(w.settings?.concurrency) || deps.globalConcurrency);
      const r = await client.query(
        `insert into runs (workflow_id, company_id, graph, params, concurrency, created_by) values ($1,$2,$3,$4,$5,$6) returning id`,
        [id, w.company_id, JSON.stringify(w.graph), JSON.stringify({...b, analysis_date:wibClock().date}), concurrency, me(req).id],
      );
      runId = r.rows[0].id;
      requireApproval = w.settings?.requireApproval !== false;
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    finally { await client.query('rollback'); client.release(); }
    planRun(runId, { interactive: requireApproval }).then(async () => {
      if (!requireApproval) await approve(runId);
    });
    return { id: runId };
  });

  // Workflow-scoped webhook credential; edits and publication serialize with run creation.
  app.post('/integration/v1/workflows/:id/webhook', async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const client = await db.connect();
    let runId: string;
    let requireApproval: boolean;
    try {
      await client.query('begin');
      const w = (await client.query('select * from workflows where id=$1 for update',[id])).rows[0];
      const start = w?.graph.nodes.find((n: any)=>n.type==='trigger' && n.config.mode==='webhook');
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /,'');
      const token = start && w.status==='published' ? await readSecret(client as any,deps.masterKey,id,start.id,'webhookToken') : null;
      if (!token || Buffer.byteLength(token)!==Buffer.byteLength(bearer) || !timingSafeEqual(Buffer.from(token),Buffer.from(bearer))) return reply.code(401).send({error:'Webhook tidak aktif atau token tidak valid.'});
      const body = z.object({start_date:date.optional(),end_date:date.optional(),request_id:z.string().trim().min(1).max(200).optional(),items:z.any().optional(),data:z.any().optional()}).parse(req.body ?? {});
      if (!!body.start_date !== !!body.end_date || (body.start_date && (!validDate(body.start_date) || !validDate(body.end_date) || body.end_date! < body.start_date))) return reply.code(400).send({error:'Isi kedua tanggal yang valid, dengan tanggal selesai sama atau setelah tanggal mulai.'});
      if (!w.company_id) return reply.code(400).send({error:'Pilih company dulu.'});
      const issues = validateGraph(w.graph);
      if (issues.length) return reply.code(400).send({error:'Workflow belum lengkap.',issues:issues.map(i=>i.message)});
      const key = `webhook:${body.request_id ?? randomUUID()}`;
      const prior = (await client.query("select id from runs where workflow_id=$1 and params->>'schedule_key'=$2",[id,key])).rows[0];
      if (prior) return {id:prior.id,duplicate:true};
      const today = wibClock().date;
      const range = body.start_date ? {start_date:body.start_date,end_date:body.end_date!} : resolvePeriod(start.config.triggerPeriod ?? {mode:'yesterday'},today,{start_date:today,end_date:today});
      requireApproval = w.settings?.requireApproval !== false;
      const params = {...range,...(body.items!==undefined || body.data!==undefined ? {items:codeItems(body.items ?? body.data)} : {}),analysis_date:today,trigger_source:'webhook',schedule_key:key,require_approval:requireApproval};
      const r = await client.query('insert into runs(workflow_id,company_id,graph,params,concurrency,created_by,chunk_confirmed) values($1,$2,$3,$4,$5,$6,true) returning id',[id,w.company_id,w.graph,params,Math.min(deps.globalConcurrency,Number(w.settings?.concurrency)||deps.globalConcurrency),w.created_by]);
      runId = r.rows[0].id;
      await client.query('commit');
    } catch(error) {await client.query('rollback');throw error;}
    finally {await client.query('rollback');client.release();}
    // The scheduler owns dispatch and restart recovery, with an advisory lock per run.
    void scheduler.tick();
    return reply.code(202).send({id:runId});
  });

  // Narrow integration: the existing Autobot HTTP-node key can trigger only this enabled workflow.
  app.post('/integration/v1/workflows/:id/run', async (req, reply) => {
    const id=uuid.parse((req.params as any).id);
    const w=(await db.query('select * from workflows where id=$1',[id])).rows[0];
    const bearer=String(req.headers.authorization||'').replace(/^Bearer /,'');
    let authorized=false;
    if(w?.settings?.autobotTriggerEnabled&&w.status==='published')for(const node of w.graph.nodes){
      if(node.type!=='http'||node.config.destination!=='autobot')continue;
      const key=await readSecret(db,deps.masterKey,id,node.id,'autobotApiKey');
      if(key&&Buffer.byteLength(key)===Buffer.byteLength(bearer)&&timingSafeEqual(Buffer.from(key),Buffer.from(bearer))&&node.config.autobotWorkflowId===(req.body as any)?.workflow_id)authorized=true;
    }
    if(!authorized)return reply.code(401).send({error:'Credential workflow tidak valid.'});
    const b=z.object({run_id:z.string().uuid(),period:z.object({from:date,to:date})}).parse(req.body);
    if(b.period.from>b.period.to||[b.period.from,b.period.to].some(d=>!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d))return reply.code(400).send({error:'Periode tidak valid.'});
    const client=await db.connect();let runId:string;let requireApproval=false;
    try{
      await client.query('begin');const current=(await client.query('select * from workflows where id=$1 for update',[id])).rows[0];
      if(current.status!=='published'||!current.settings.autobotTriggerEnabled)return reply.code(409).send({error:'Workflow tidak aktif.'});
      const prior=(await client.query("select id from runs where workflow_id=$1 and params->>'autobot_dispatch_id'=$2",[id,b.run_id])).rows[0];
      if(prior)return {id:prior.id,duplicate:true};
      const issues=validateGraph(current.graph);if(issues.length)return reply.code(400).send({error:'Workflow belum lengkap.',issues});
      const r=await client.query('insert into runs(workflow_id,company_id,graph,params,concurrency,created_by) values($1,$2,$3,$4,$5,$6) returning id',[id,current.company_id,current.graph,{start_date:b.period.from,end_date:b.period.to,mode:'published',analysis_date:wibClock().date,autobot_dispatch_id:b.run_id},Math.min(deps.globalConcurrency,Number(current.settings.concurrency)||deps.globalConcurrency),current.created_by]);
      runId=r.rows[0].id;requireApproval=current.settings.requireApproval!==false;await client.query('commit');
    }catch(e){await client.query('rollback');throw e;}finally{await client.query('rollback');client.release();}
    planRun(runId,{interactive:requireApproval}).then(async()=>{if(!requireApproval)await approve(runId);}).catch(e=>console.error('[autobot trigger]',e.message));return {id:runId};
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const r = await db.query('select r.*, w.name as workflow_name, w.company_name from runs r join workflows w on w.id = r.workflow_id where r.id=$1', [id]);
    if (!r.rows[0]) return reply.code(404).send({ error: 'Run tidak ditemukan.' });
    const units = await db.query(`select ${UNIT_COLUMNS} from units where run_id=$1 order by node_id, seq`, [id]);
    const run = r.rows[0];
    // Rencana dikirim tanpa payload mentah; kanvas hanya butuh label dan estimasi.
    const plan = run.plan
      ? { ...run.plan, units: run.plan.units.map((u: any) => ({ nodeId: u.nodeId, seq: u.seq, label: u.label, source: u.source, estimate: u.estimate, skip: u.skip, filter: u.payload.filter, fetch: u.payload.fetch === true, history_id: u.payload.history_id ?? null })) }
      : null;
    const steps = await db.query(`select id, node_id, type, status, error, output->'summary' as summary, finished_at from steps where run_id=$1`, [id]);
    return { ...run, plan, units: units.rows, steps: steps.rows, global_concurrency: deps.globalConcurrency };
  });

  app.post('/api/runs/:id/replan', async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ overrides: overridesSchema }).parse(req.body);
    const r = await db.query(
      `with allowed as (select id from workflows where id=(select workflow_id from runs where id=$1) and status <> 'archived' for update)
       update runs set status='planning', overrides=$2, plan=null, error=null, finished_at=null, chunk_confirmed=true
       where id=$1 and exists(select 1 from allowed) and status in ('awaiting_chunk','awaiting_approval','plan_failed') returning id`,
      [id, JSON.stringify(b.overrides)],
    );
    if (!r.rows[0]) return reply.code(409).send({ error: 'Rencana hanya bisa dihitung ulang sebelum run disetujui.' });
    planRun(id, { interactive: true });
    return { ok: true };
  });

  // Kembali ke langkah ukuran chunk. Pratinjau data yang sudah dihitung dipakai lagi.
  app.post('/api/runs/:id/rechunk', async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const r = await db.query(
      `with allowed as (select id from workflows where id=(select workflow_id from runs where id=$1) and status <> 'archived' for update)
       update runs set status='awaiting_chunk', chunk_confirmed=false, plan=null, error=null
       where id=$1 and exists(select 1 from allowed) and status in ('awaiting_approval','plan_failed') and preview is not null returning id`,
      [id],
    );
    if (!r.rows[0]) return reply.code(409).send({ error: 'Ukuran chunk hanya bisa diubah sebelum run disetujui.' });
    return { ok: true };
  });

  app.post('/api/runs/:id/approve', async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const problem = await approve(id);
    if (problem) return reply.code(409).send({ error: problem });
    executor.tick();
    return { ok: true };
  });

  app.post('/api/runs/:id/cancel', async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    if (!(await executor.cancelRun(id))) return reply.code(409).send({ error: 'Run sudah selesai.' });
    return { ok: true };
  });

  // Lanjutkan dari yang gagal: hanya bila prompt (isinya) dan filter masih sama dengan saat run dimulai.
  app.post('/api/runs/:id/resume', async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const client = await db.connect();
    try {
      await client.query('begin');
      const w = (await client.query(`select status from workflows where id=(select workflow_id from runs where id=$1) for update`, [id])).rows[0];
      if (w?.status === 'archived') return reply.code(409).send({ error: 'Pulihkan workflow dari arsip sebelum melanjutkan run.' });
      const run = (await client.query('select * from runs where id=$1', [id])).rows[0];
      if (!run) return reply.code(404).send({ error: 'Run tidak ditemukan.' });
      if (run.status !== 'failed') return reply.code(409).send({ error: 'Hanya run yang gagal yang bisa dilanjutkan.' });

      const graph: Graph = run.graph;
      const pending = (await client.query(`select * from units where run_id=$1 and status in ('failed','queued')`, [id])).rows;
      const promptText = new Map<string, string>();
      const changed: string[] = [];
      for (const u of pending) {
        if (u.payload?.fetch) continue; // unit yang hanya mengambil history tidak punya prompt
        if (!promptText.has(u.node_id)) {
          const promptNode = graph.nodes.find((n) => n.id === incoming(graph, u.node_id, 'prompt')[0]?.source);
          if (!promptNode) return reply.code(409).send({ error: 'Node prompt tidak ditemukan di graf run ini.' });
          promptText.set(u.node_id, (await resolvePrompt(api, run.company_id, promptNode)).text);
        }
        const now = fingerprint({ ...u.fp_input, promptText: promptText.get(u.node_id)! });
        if (now !== u.fingerprint) changed.push(u.label);
      }
      if (changed.length) {
        return reply.code(409).send({
          error: `Tidak bisa dilanjutkan: isi prompt berubah sejak run dimulai (${changed.length} Audital Work terdampak, mis. ${changed[0]}). Buat run baru.`,
        });
      }

      await client.query(
        `update units set status='queued', error=null, history_id=null, correlation_id=null, unknown_count=0, started_at=null, finished_at=null,
           attempt = attempt + 1 where run_id=$1 and status='failed'`,
        [id],
      );
      // Sync yang gagal: hanya sales yang gagal yang diulang; yang sudah selesai tidak disinkron lagi.
      const syncs = await client.query(`select id, output from steps where run_id=$1 and type='sync' and status='failed'`, [id]);
      for (const s of syncs.rows) {
        const jobs = (s.output?.jobs ?? []).map((j: any) => (j.status === 'failed' ? { sales_id: j.sales_id, name: j.name, status: 'pending' } : j));
        await client.query(`update steps set status='waiting', error=null, finished_at=null, output=$2 where id=$1`, [s.id, JSON.stringify({ ...s.output, jobs, next_check: 0 })]);
      }
      // Merge yang gagal: bagian yang sudah selesai dipertahankan (sudah memakai token); hanya yang gagal diulang.
      const merges = await client.query(`select id, output from steps where run_id=$1 and type='merge' and status='failed'`, [id]);
      for (const s of merges.rows) {
        const groups = (s.output?.groups ?? []).map((g: any) => (g.status === 'failed' ? { sources: g.sources, status: 'pending' } : g));
        await client.query(`update steps set status='waiting', error=null, finished_at=null, output=$2 where id=$1`, [s.id, groups.length ? JSON.stringify({ ...s.output, groups, next_check: 0 }) : null]);
      }
      await client.query(`update steps set status='waiting', error=null, output=null, started_at=null, finished_at=null where run_id=$1 and status='failed'`, [id]);
      await client.query(`update runs set status='running', halted=false, error=null, finished_at=null where id=$1`, [id]);
      await client.query('commit');
      executor.tick();
      return { ok: true, retried: pending.filter((u) => u.status === 'failed').length };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { await client.query('rollback'); client.release(); }

  });

  app.get('/api/units/:id', async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const r = await db.query(`select ${UNIT_COLUMNS}, content from units where id=$1`, [id]);
    if (!r.rows[0]) return reply.code(404).send({ error: 'Unit tidak ditemukan.' });
    return r.rows[0];
  });

  // Pratinjau hasil langkah: baris tabel dibatasi supaya ringan di browser.
  app.get('/api/steps/:id', async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    const r = await db.query('select id, node_id, type, status, error, output from steps where id=$1', [id]);
    const s = r.rows[0];
    if (!s) return reply.code(404).send({ error: 'Langkah tidak ditemukan.' });
    const tables = (s.output?.tables ?? []).map((t: any) => ({ columns: t.columns, rows: t.rows.slice(0, 100), total: t.rows.length }));
    return { id: s.id, node_id: s.node_id, type: s.type, status: s.status, error: s.error, summary: s.output?.summary ?? null, tables, report: s.output?.report ?? null, items: s.output?.items?.slice(0,100) ?? [], totalItems: s.output?.items?.length ?? 0, logs:s.output?.logs ?? [] };
  });

  const sendStepFile = async (id: string, reply: FastifyReply) => {
    const r = await db.query(`select output->'file' as file from steps where id=$1 and status='done'`, [id]);
    const file = r.rows[0]?.file;
    if (!file?.path || !existsSync(file.path)) return reply.code(404).send({ error: 'File tidak ditemukan.' });
    reply.header('Content-Type', file.mime);
    // Nama asli (boleh berisi huruf non-ASCII) dikirim lewat filename*; filename biasa sebagai cadangan.
    const ascii = String(file.name).replace(/[^\w.\- ()]+/g, '_');
    reply.header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return reply.send(createReadStream(file.path));
  };

  app.get('/api/steps/:id/file', async (req, reply) => sendStepFile(uuid.parse((req.params as any).id), reply));

  return app;
}
