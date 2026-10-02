// Perencana: mengubah graf + parameter run menjadi daftar unit Audital Work beserta estimasinya.
// Hanya memanggil endpoint baca dan preflight, jadi tidak memakai token AI.

import { errorCode, unwrap } from '../../../packages/autoaudit/src/index.ts';
import type { AuditFilter, AutoAuditClient, RunPayload } from '../../../packages/autoaudit/src/index.ts';
import { daysBetween, fingerprint, recommendChunk, splitByContacts, splitByDays } from '../../../packages/engine/src/plan.ts';
import { incoming, parsePhones, salesBehind, validateGraph } from '../../../packages/nodes/src/index.ts';
import type { Graph, GraphNode } from '../../../packages/nodes/src/index.ts';

export interface RunParams {
  start_date: string;
  end_date: string;
  sync_policy?: 'skip' | 'always' | 'stale';
}

export interface ChunkOverride {
  mode?: 'days' | 'contacts';
  size?: number | null;
}

export interface Estimate {
  contacts: number;
  messages: number;
  tokens: number;
  percent: number;
  canStart: boolean;
  errorCode: string;
  needsChunking: boolean;
}

export interface PlanGroup {
  nodeId: string; // node AW
  source: { channel: string; id: number; name: string };
  chunk: null | {
    nodeId: string;
    mode: 'days' | 'contacts';
    size: number;
    sizeFrom: 'usulan' | 'manual';
    recommended: { daysPerPart: number; contactsPerPart: number };
    full: Estimate;
  };
  contacts?: { mode: 'only' | 'exclude'; count: number }; // filter nomor yang berlaku
  full?: Estimate; // estimasi periode penuh untuk sumber tanpa Chunk (hanya di tahap pratinjau)
  units: number;
  warnings: string[];
}

export interface PlannedUnit {
  nodeId: string;
  seq: number;
  label: string;
  source: PlanGroup['source'];
  payload: RunPayload;
  estimate: Estimate;
  fpInput: Record<string, unknown>;
  fingerprint: string;
  timeoutMin: number;
  skip: boolean;
}

export interface Plan {
  groups: PlanGroup[];
  units: PlannedUnit[];
  warnings: string[];
  totals: { units: number; skipped: number; contacts: number; messages: number; tokens: number };
  days: number;
  preview?: boolean; // true = baru estimasi periode penuh, belum dipecah menjadi unit
}

export class PlanError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(issues.join(' '));
    this.name = 'PlanError';
    this.issues = issues;
  }
}

const TIMEZONE = 'Asia/Jakarta';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function pool<T, R>(items: T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

function readEstimate(res: { status: number; body: any }): Estimate {
  const d = unwrap<any>(res.body) ?? {};
  const p = d.preview ?? {};
  const ds = p.dataset ?? {};
  const tb = p.token_breakdown ?? {};
  const ctx = p.context ?? {};
  const code = errorCode(d) || errorCode(res.body);
  return {
    contacts: Number(ds.filtered_contacts ?? 0),
    messages: Number(ds.filtered_messages ?? 0),
    tokens: Number(tb.total_context_tokens ?? ds.token_after_filter ?? 0),
    percent: Number(ctx.percent ?? 0),
    canStart: d.can_start === true,
    errorCode: code,
    needsChunking: ctx.needs_chunking === true || ctx.is_over_context === true,
  };
}

function preflightNumbers(res: { body: any }, days: number) {
  const p = unwrap<any>(res.body)?.preview ?? {};
  const ds = p.dataset ?? {};
  const tb = p.token_breakdown ?? {};
  return {
    contacts: Number(ds.filtered_contacts ?? 0),
    tokens: Number(ds.token_after_filter ?? tb.sales_context_tokens ?? 0),
    fixedTokens: Number(tb.fixed_context_tokens ?? tb.prompt_tokens ?? 0),
    usableContext: Number(p.context?.usable_context_length ?? 0),
    days,
  };
}

async function allContacts(api: AutoAuditClient, salesId: number, filter: AuditFilter) {
  const query = { limit: 100, start_date: filter.start_date, end_date: filter.end_date, chat_type: filter.chat_type };
  const first = await api.listContacts(salesId, { ...query, page: 1 });
  if (!first.ok) throw new PlanError([`Gagal mengambil kontak sales ${salesId} (${first.status} ${errorCode(first.body)}).`]);
  const pages = Number(first.body?.pagination?.total_pages ?? 1);
  const rest = await pool(
    Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2),
    4,
    async (page) => {
      const r = await api.listContacts(salesId, { ...query, page });
      if (!r.ok) throw new PlanError([`Gagal mengambil kontak sales ${salesId} halaman ${page} (${r.status}).`]);
      return r.body?.data ?? [];
    },
  );
  return [...(first.body?.data ?? []), ...rest.flat()];
}

interface PromptResolved {
  text: string; // isi prompt, dipakai untuk sidik jari
  payload: { prompt: string; saved_prompt_id?: number };
  title: string;
}

export async function resolvePrompt(api: AutoAuditClient, companyId: number, node: GraphNode): Promise<PromptResolved> {
  const c = node.config ?? {};
  if (c.mode === 'text') return { text: String(c.text), payload: { prompt: String(c.text) }, title: 'Teks bebas' };
  const res = await api.listSavedPrompts(companyId);
  const item = (unwrap<any>(res.body)?.items ?? []).find((p: any) => Number(p.id) === Number(c.savedPromptId));
  if (!item) throw new PlanError([`Saved prompt ${c.savedPromptId} tidak ditemukan di company ${companyId}.`]);
  // Pola yang sudah terbukti di workflow n8n: prompt kosong + saved_prompt_id.
  return { text: String(item.content ?? ''), payload: { prompt: '', saved_prompt_id: Number(item.id) }, title: String(item.title ?? '') };
}

export async function buildPlan(input: {
  api: AutoAuditClient;
  graph: Graph;
  params: RunParams;
  companyId: number;
  overrides?: Record<string, ChunkOverride>;
  maxUnits?: number;
  previewOnly?: boolean;
}): Promise<Plan> {
  const { api, graph, params, companyId } = input;
  const overrides = input.overrides ?? {};
  const maxUnits = input.maxUnits ?? 200;

  const issues = validateGraph(graph).map((i) => i.message);
  if (!DATE.test(params.start_date) || !DATE.test(params.end_date)) issues.push('Tanggal mulai dan selesai wajib diisi.');
  else if (params.end_date < params.start_date) issues.push('Tanggal selesai tidak boleh sebelum tanggal mulai.');
  if (issues.length) throw new PlanError(issues);

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const totalDays = daysBetween(params.start_date, params.end_date);
  const modelsRes = await api.listModels(companyId);
  const modelNames = new Set<string>((unwrap<any>(modelsRes.body)?.items ?? []).map((m: any) => String(m.model_name)));

  const plan: Plan = { groups: [], units: [], warnings: [], totals: { units: 0, skipped: 0, contacts: 0, messages: 0, tokens: 0 }, days: totalDays, preview: input.previewOnly === true };

  for (const aw of graph.nodes.filter((n) => n.type === 'aw')) {
    const c = aw.config ?? {};
    // Preflight tidak memvalidasi nama model, jadi dicek di sini.
    if (modelsRes.ok && !modelNames.has(String(c.model))) throw new PlanError([`Model "${c.model}" tidak ada di daftar model AutoAudit.`]);

    const promptNode = byId.get(incoming(graph, aw.id, 'prompt')[0].source)!;
    const prompt = await resolvePrompt(api, companyId, promptNode);
    const memoryIds = [
      ...new Set(
        incoming(graph, aw.id, 'memory').flatMap((e) => (byId.get(e.source)?.config?.memories ?? []).map((m: any) => Number(m.id))),
      ),
    ].sort((a, b) => a - b);
    const runBySuperadmin = c.runBySuperadmin === true;

    const baseFilter: AuditFilter = {
      start_date: params.start_date,
      end_date: params.end_date,
      chat_type: c.chatType || 'individual',
      time_filter_mode: c.timeFilterMode || 'all_day',
      ...(c.timeFilterMode === 'daily_window' ? { start_time: c.startTime, end_time: c.endTime } : {}),
      include_full_history_mode: c.includeFullHistoryMode || 'none',
      chat_numbers: [],
      timezone: TIMEZONE,
    };
    // Filter kontak: "hanya nomor ini" = chat_numbers; "kecualikan" = chat_numbers + is_excluded (terverifikasi di preflight).
    const contactMode: 'all' | 'only' | 'exclude' = c.contactMode === 'only' || c.contactMode === 'exclude' ? c.contactMode : 'all';
    const phones = contactMode === 'all' ? [] : parsePhones(c.contactNumbers).numbers;
    const phoneSet = new Set(phones);
    if (contactMode !== 'all') {
      baseFilter.chat_numbers = phones;
      baseFilter.is_excluded = contactMode === 'exclude';
    }

    const makePayload = (salesId: number, filter: AuditFilter): RunPayload => ({
      company_id: companyId,
      sales_id: salesId,
      model: String(c.model),
      ...prompt.payload,
      run_by_superadmin: runBySuperadmin,
      selected_memory_ids: memoryIds,
      filter,
    });

    // Kumpulkan sumber: langsung dari Sales, atau lewat Chunk.
    const inputs: { source: PlanGroup['source']; chunkNode: GraphNode | null }[] = [];
    for (const e of incoming(graph, aw.id, 'source')) {
      const from = byId.get(e.source)!;
      // Sales bisa datang langsung, lewat Sync Sales, lewat Chunk, atau keduanya.
      for (const s of salesBehind(graph, from.id)) {
        inputs.push({ source: { channel: 'whatsapp', id: s.id, name: s.name }, chunkNode: from.type === 'chunk' ? from : null });
      }
    }

    const drafts: { group: PlanGroup; label: string; filter: AuditFilter }[] = [];
    for (const inp of inputs) {
      const group: PlanGroup = { nodeId: aw.id, source: inp.source, chunk: null, units: 0, warnings: [], contacts: contactMode === 'all' ? undefined : { mode: contactMode, count: phones.length } };
      plan.groups.push(group);

      if (!inp.chunkNode) {
        if (input.previewOnly) group.full = readEstimate(await api.preflight(makePayload(inp.source.id, baseFilter)));
        else drafts.push({ group, label: inp.source.name, filter: baseFilter });
        continue;
      }

      const cc = { ...inp.chunkNode.config, ...(overrides[inp.chunkNode.id] ?? {}) };
      const mode: 'days' | 'contacts' = cc.mode === 'contacts' ? 'contacts' : 'days';
      const fullRes = await api.preflight(makePayload(inp.source.id, baseFilter));
      const full = readEstimate(fullRes);
      const recommended = recommendChunk(preflightNumbers(fullRes, totalDays));
      const manual = cc.size !== null && cc.size !== undefined && Number(cc.size) >= 1;
      const size = manual ? Math.floor(Number(cc.size)) : mode === 'days' ? recommended.daysPerPart : recommended.contactsPerPart;
      group.chunk = { nodeId: inp.chunkNode.id, mode, size, sizeFrom: manual ? 'manual' : 'usulan', recommended, full };
      if (contactMode === 'only' && full.contacts < phones.length) group.warnings.push(`${inp.source.name}: ${phones.length - full.contacts} dari ${phones.length} nomor tidak punya chat pada periode ini.`);
      if (input.previewOnly) continue; // tahap pratinjau berhenti di estimasi periode penuh

      if (full.contacts === 0) {
        // Tidak ada chat pada periode ini: satu unit yang nanti ditandai dilewati.
        drafts.push({ group, label: `${inp.source.name} · kosong`, filter: baseFilter });
        continue;
      }
      const maxParts = Math.max(1, Number(cc.maxParts) || 40);
      if (mode === 'days') {
        const { slices, warnings } = splitByDays(params.start_date, params.end_date, size, maxParts);
        group.warnings.push(...warnings);
        for (const s of slices) {
          const label = s.start_date === s.end_date ? s.start_date : `${s.start_date} s/d ${s.end_date}`;
          drafts.push({ group, label: `${inp.source.name} · ${label}`, filter: { ...baseFilter, start_date: s.start_date, end_date: s.end_date } });
        }
      } else {
        // Daftar kontak disaring dulu sesuai filter nomor, baru dibagi. Tiap bagian lalu membawa nomornya sendiri.
        const everyone = await allContacts(api, inp.source.id, baseFilter);
        const contacts =
          contactMode === 'all' ? everyone : everyone.filter((x: any) => phoneSet.has(String(x.phone_number)) === (contactMode === 'only'));
        const { slices, warnings } = splitByContacts(contacts, size, maxParts);
        group.warnings.push(...warnings);
        for (const s of slices) {
          drafts.push({
            group,
            label: `${inp.source.name} · bagian ${s.part} (${s.contacts} kontak)`,
            filter: { ...baseFilter, chat_numbers: s.chat_numbers, is_excluded: false },
          });
        }
      }
    }

    if (plan.units.length + drafts.length > maxUnits) {
      throw new PlanError([`Rencana menghasilkan ${plan.units.length + drafts.length} Audital Work, melebihi batas ${maxUnits}. Perbesar ukuran chunk.`]);
    }

    const estimates = await pool(drafts, 4, async (d) => readEstimate(await api.preflight(makePayload(d.group.source.id, d.filter))));
    drafts.forEach((d, i) => {
      const est = estimates[i];
      const payload = makePayload(d.group.source.id, d.filter);
      const fpInput = { model: payload.model, memoryIds, filter: d.filter, runBySuperadmin, source: { channel: d.group.source.channel, id: d.group.source.id } };
      const skip = est.errorCode === 'empty_filter_result' || (est.contacts === 0 && !est.canStart);
      if (!skip && !est.canStart) d.group.warnings.push(`${d.label}: preflight menolak (${est.errorCode || 'can_start=false'}).`);
      if (!skip && est.needsChunking) d.group.warnings.push(`${d.label}: melebihi konteks model, perkecil ukuran chunk.`);
      d.group.units += 1;
      plan.units.push({
        nodeId: aw.id,
        seq: plan.units.filter((u) => u.nodeId === aw.id).length + 1,
        label: d.label,
        source: d.group.source,
        payload,
        estimate: est,
        fpInput,
        fingerprint: fingerprint({ ...fpInput, promptText: prompt.text } as any),
        timeoutMin: Math.max(1, Number(c.timeoutMin) || 80),
        skip,
      });
    });
  }

  if (input.previewOnly) {
    for (const g of plan.groups) {
      const e = g.chunk?.full ?? g.full;
      if (e) {
        plan.totals.contacts += e.contacts;
        plan.totals.messages += e.messages;
        plan.totals.tokens += e.tokens;
      }
    }
    return plan;
  }

  // --- Sumber yang hanya mengambil laporan yang sudah ada (tidak memakai token AI).
  const fetchUnit = (nodeId: string, label: string, source: PlanGroup['source'], historyId: number, runBySuperadmin: boolean, title: string): PlannedUnit => ({
    nodeId,
    seq: plan.units.filter((u) => u.nodeId === nodeId).length + 1,
    label,
    source,
    payload: { fetch: true, history_id: historyId, run_by_superadmin: runBySuperadmin, company_id: companyId, title } as any,
    estimate: { contacts: 0, messages: 0, tokens: 0, percent: 0, canStart: true, errorCode: '', needsChunking: false },
    fpInput: { fetch: historyId },
    fingerprint: fingerprint({ promptText: '', model: 'fetch', memoryIds: [], filter: { history_id: historyId }, runBySuperadmin, source: { channel: 'history', id: historyId } }),
    timeoutMin: 10,
    skip: false,
  });

  for (const node of graph.nodes.filter((n) => n.type === 'history')) {
    const group: PlanGroup = { nodeId: node.id, source: { channel: 'history', id: 0, name: 'History AW' }, chunk: null, units: 0, warnings: [] };
    plan.groups.push(group);
    for (const it of node.config.items ?? []) {
      const title = String(it.title || `History ${it.id}`);
      // Nama sales dipakai untuk menamai file; history yang ditempel lewat id tidak membawanya.
      plan.units.push(fetchUnit(node.id, `#${it.id} · ${title}`.slice(0, 120), { channel: 'history', id: Number(it.id), name: String(it.sales || `History ${it.id}`) }, Number(it.id), it.runBySuperadmin === true, title));
      group.units += 1;
    }
  }

  for (const node of graph.nodes.filter((n) => n.type === 'continuous')) {
    const c = node.config;
    const group: PlanGroup = { nodeId: node.id, source: { channel: 'continuous', id: Number(c.scheduleId), name: `Continuous: ${c.scheduleLabel || '#' + c.scheduleId}` }, chunk: null, units: 0, warnings: [] };
    plan.groups.push(group);
    const range = c.pick === 'range';
    const res = await api.listScheduleRuns(Number(c.scheduleId), {
      company_id: companyId,
      page: 1,
      limit: range ? Math.min(100, Math.max(1, Number(c.maxRuns) || 31)) : 10,
      ...(range ? { date_from: params.start_date, date_to: params.end_date } : {}),
    });
    if (!res.ok) throw new PlanError([`Gagal membaca run Continuous Audit #${c.scheduleId} (${res.status} ${errorCode(res.body)}).`]);
    const finished = (res.body?.data ?? []).filter((r: any) => r.raw_status === 'completed' || r.status === 'success');
    const runs = range ? finished : finished.slice(0, 1);
    if (!runs.length) {
      group.warnings.push(range ? `${group.source.name}: tidak ada run yang selesai pada ${params.start_date} s/d ${params.end_date}.` : `${group.source.name}: belum ada run yang selesai.`);
      continue;
    }
    for (const r of runs) {
      const det = unwrap<any>((await api.getContinuousRun(Number(r.id), companyId)).body);
      const day = String(r.run_at ?? '').slice(0, 10);
      for (const s of det?.sales ?? []) {
        const hid = Number(s.history?.id || 0);
        const name = String(s.sales_name || s.target_label || 'Sales');
        if (!hid || !(s.raw_status === 'completed' || s.status === 'success')) {
          group.warnings.push(`${name} · ${day}: tidak ada laporan (status ${s.status ?? '-'}).`);
          continue;
        }
        // Laporan Continuous Audit disimpan di sisi company, bukan superadmin.
        plan.units.push(fetchUnit(node.id, `${name} · ${day}`, { channel: 'continuous', id: Number(s.sales_id) || hid, name }, hid, false, String(c.scheduleLabel || `Continuous ${c.scheduleId}`)));
        group.units += 1;
      }
    }
  }
  if (plan.units.length > maxUnits) throw new PlanError([`Rencana menghasilkan ${plan.units.length} unit, melebihi batas ${maxUnits}.`]);

  for (const u of plan.units) {
    plan.totals.units += 1;
    if (u.skip) plan.totals.skipped += 1;
    else {
      plan.totals.contacts += u.estimate.contacts;
      plan.totals.messages += u.estimate.messages;
      plan.totals.tokens += u.estimate.tokens;
    }
  }
  plan.warnings = plan.groups.flatMap((g) => g.warnings);
  return plan;
}
