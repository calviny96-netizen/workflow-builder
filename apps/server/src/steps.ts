// Langkah hilir: node yang dikerjakan server setelah Audital Work di hulunya selesai.
// Saat ini Parse Tabel dan Export. Semuanya cepat dan lokal, kecuali PDF yang dirender AutoAudit.

import { executeCode, codeItems } from './code.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { marked } from 'marked';
import type { AutoAuditClient } from '../../../packages/autoaudit/src/index.ts';
import { mergeTables, parseMarkdownTables, plainText } from '../../../packages/engine/src/table.ts';
import type { MdTable } from '../../../packages/engine/src/table.ts';
import { parseSheetUrl, planSheetWrite } from '../../../packages/engine/src/sheetplan.ts';
import type { SheetsClient } from './google.ts';
import { fileNameFrom, incoming, periodText, REPORT_TYPES, STEP_TYPES, uniqueNames } from '../../../packages/nodes/src/index.ts';
import type { Graph, GraphNode } from '../../../packages/nodes/src/index.ts';
import type { Db } from './db.ts';
import { advanceSync, sendHttp, sendMessage } from './steps-io.ts';
import { advanceMerge } from './steps-merge.ts';
import { aiMerge, listModels } from './steps-aimerge.ts';
import type { OpenRouterModel } from './steps-aimerge.ts';
import { readSecret } from './secrets.ts';
import type { MergeSource } from './steps-merge.ts';
import type { GowaConfig } from './steps-io.ts';

export interface StepContext {
  db: Db;
  api: AutoAuditClient;
  filesDir: string;
  sheets: SheetsClient | null;
  gowa?: GowaConfig | null;
  fetch?: typeof fetch;
  syncCheckMs?: number;
  masterKey?: Buffer; // untuk membuka rahasia yang diisi di node (API key OpenRouter)
}

interface ReportInput {
  label: string;
  sourceName: string;
  content: string;
  period: string; // rentang tanggal yang diaudit
  title: string; // judul jadwal Continuous / history, atau nama workflow
  part: string; // potongan chunk, bila ada
  model?: string | null;
  tokens?: number | null;
  chatType?: string | null;
}

export const stepNodes = (graph: Graph): GraphNode[] => graph.nodes.filter((n) => STEP_TYPES.includes(n.type));

const MIME: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  zip: 'application/zip',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

const safeName = (s: string) => s.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'hasil';

// Laporan gabungan dari node Merge Report di hulu.
async function mergedInto(ctx: StepContext, run: any, nodeId: string): Promise<ReportInput[]> {
  const graph: Graph = run.graph;
  const ids = incoming(graph, nodeId, 'in')
    .map((e) => graph.nodes.find((n) => n.id === e.source))
    .filter((n) => n?.type === 'merge' || n?.type === 'aimerge' || n?.type === 'code' || n?.type === 'http')
    .map((n) => n!.id);
  if (!ids.length) return [];
  const r = await ctx.db.query(`select output->'report' as report from steps where run_id=$1 and node_id = any($2) and status='done'`, [run.id, ids]);
  return r.rows
    .filter((x) => x.report)
    .map((x) => ({ label: x.report.label, sourceName: 'Gabungan', content: x.report.content ?? '', period: periodText(run.params.start_date, run.params.end_date), title: x.report.label, part: '', model: x.report.model ?? null, tokens: x.report.tokens ?? null }));
}

// History yang menjadi sumber sebuah node Merge Report: unit AW/ambil yang selesai, dan hasil merge lain di hulu.
async function mergeSources(ctx: StepContext, run: any, nodeId: string): Promise<MergeSource[]> {
  const graph: Graph = run.graph;
  const from = incoming(graph, nodeId, 'in').map((e) => graph.nodes.find((n) => n.id === e.source)!);
  const unitIds = from.filter((n) => REPORT_TYPES.includes(n.type)).map((n) => n.id);
  const mergeIds = from.filter((n) => n.type === 'merge').map((n) => n.id);
  const u = unitIds.length
    ? await ctx.db.query(`select history_id, label from units where run_id=$1 and node_id = any($2) and status='done' and history_id is not null order by node_id, seq`, [run.id, unitIds])
    : { rows: [] };
  const m = mergeIds.length
    ? await ctx.db.query(`select (output->'report'->>'history_id')::int as history_id, output->'report'->>'label' as label from steps where run_id=$1 and node_id = any($2) and status='done'`, [run.id, mergeIds])
    : { rows: [] };
  return [...u.rows, ...m.rows].filter((x) => x.history_id);
}

async function reportsInto(ctx: StepContext, run: any, nodeId: string): Promise<ReportInput[]> {
  const graph: Graph = run.graph;
  const awIds = incoming(graph, nodeId, 'in')
    .map((e) => graph.nodes.find((n) => n.id === e.source))
    .filter((n) => n && REPORT_TYPES.includes(n.type))
    .map((n) => n!.id);
  const merged = await mergedInto(ctx, run, nodeId);
  if (!awIds.length) return merged;
  const r = await ctx.db.query(
    `select label, source->>'name' as source_name, content, payload, meta, model_used, token_usage from units where run_id=$1 and node_id = any($2) and status='done' order by node_id, seq`,
    [run.id, awIds],
  );
  return [...merged, ...r.rows.map((u) => ({
    label: u.label,
    sourceName: u.source_name,
    content: u.content ?? '',
    period: u.payload?.fetch ? periodText(u.meta?.start_date, u.meta?.end_date) : periodText(u.payload?.filter?.start_date, u.payload?.filter?.end_date),
    title: String(u.payload?.title || (u.payload?.fetch ? u.meta?.title : '') || run.workflow_name || ''),
    part: u.label.includes(' · ') && !u.payload?.fetch ? u.label.split(' · ').slice(1).join(' · ') : '',
    model: u.model_used,
    tokens: u.token_usage,
    chatType: u.payload?.fetch ? u.meta?.chat_type : u.payload?.filter?.chat_type,
  }))];
}

async function tablesInto(ctx: StepContext, run: any, nodeId: string): Promise<MdTable[]> {
  const graph: Graph = run.graph;
  const parseIds = incoming(graph, nodeId, 'in')
    .map((e) => graph.nodes.find((n) => n.id === e.source))
    .filter((n) => n?.type === 'parse' || n?.type === 'code' || n?.type === 'http')
    .map((n) => n!.id);
  if (!parseIds.length) return [];
  const r = await ctx.db.query(`select output from steps where run_id=$1 and node_id = any($2) and status='done' order by node_id`, [run.id, parseIds]);
  return r.rows.flatMap((s) => s.output?.tables ?? []);
}

export async function runCode(ctx: StepContext, run: any, node: GraphNode) {
  const graph: Graph = run.graph;
  const from = incoming(graph,node.id,'in').map(e=>graph.nodes.find(n=>n.id===e.source)!);
  const codeIds = from.filter(n=>n.type==='code' || n.type==='http').map(n=>n.id);
  const prior = codeIds.length ? (await ctx.db.query("select output from steps where run_id=$1 and node_id=any($2) and status='done' order by node_id",[run.id,codeIds])).rows.flatMap(r=>r.output?.items ?? []) : [];
  // Code outputs are already structured; do not feed their text/table adapters back as duplicate input.
  const nonCodeGraph = {...graph,edges:graph.edges.filter(e=>!codeIds.includes(e.source))};
  const adaptedReports = await reportsInto(ctx,{...run,graph:nonCodeGraph},node.id);
  const adaptedTables = await tablesInto(ctx,{...run,graph:nonCodeGraph},node.id);
  const rows = adaptedTables.flatMap(t=>t.rows.map(row=>({json:Object.fromEntries(t.columns.map((key,i)=>[key,row[i] ?? '']))})));
  const reports = adaptedReports.map(r=>({json:{label:r.label,source:r.sourceName,content:r.content,period:r.period}}));
  const hasDataSource = from.some(n=>n.type!=='trigger');
  const items = hasDataSource ? [...prior,...rows,...reports] : run.params.items !== undefined ? codeItems(run.params.items) : codeItems(JSON.parse(node.config.inputJson || '[]'));
  return executeCode(node.config,items,{start_date:run.params.start_date,end_date:run.params.end_date,analysis_date:run.params.analysis_date,company_id:run.company_id,workflow:run.workflow_name});
}

async function runParse(ctx: StepContext, run: any, node: GraphNode) {
  const reports = await reportsInto(ctx, run, node.id);
  const without: string[] = [];
  const inputs = reports.map((rep) => {
    let tables = parseMarkdownTables(rep.content);
    if (!tables.length) without.push(rep.label);
    if (node.config.tables === 'first') tables = tables.slice(0, 1);
    const part = rep.label.includes(' · ') ? rep.label.split(' · ').slice(1).join(' · ') : '';
    return { tables, extra: node.config.addSource === false ? {} : { Sumber: rep.sourceName, Bagian: part } };
  });
  const tables = mergeTables(inputs);
  const rows = tables.reduce((n, t) => n + t.rows.length, 0);
  return {
    summary: { kind: 'rows', reports: reports.length, tables: tables.map((t) => ({ columns: t.columns.length, rows: t.rows.length })), rows, withoutTable: without },
    tables,
  };
}

const CHAT_TYPE: Record<string, string> = { individual: 'chat private', private: 'chat private', group: 'grup', both: 'private + grup' };

function htmlDocument(title: string, reports: ReportInput[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Kotak "Tanggal" dan "Type" pada template AutoAudit tidak bisa diisi lewat API, jadi keduanya ditulis di isi laporan.
  const info = (r: ReportInput) => {
    const bits = [r.period ? `Periode analisis: ${r.period.replace(" sd ", " s/d ")}` : '', r.chatType ? `Jenis chat: ${CHAT_TYPE[r.chatType] ?? r.chatType}` : ''].filter(Boolean);
    return bits.length ? `<p class="info">${esc(bits.join('  ·  '))}</p>` : '';
  };
  const body = reports.map((r) => `<section><h1>${esc(r.label)}</h1>${info(r)}${marked.parse(r.content, { async: false })}</section>`).join('<hr/>');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.5;color:#111}
h1{font-size:15px;margin:0 0 8px}h2{font-size:13px}h3{font-size:12px}.info{color:#555;margin:0 0 10px}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #999;padding:3px 5px;text-align:left;vertical-align:top}
th{background:#eee}section{page-break-inside:auto}hr{border:0;border-top:1px solid #ccc;margin:16px 0}
</style></head><body>${body}</body></html>`;
}

function workbook(tables: MdTable[]) {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  if (!tables.length) wb.addWorksheet('Kosong').addRow(['Tidak ada tabel pada laporan.']);
  tables.forEach((t, i) => {
    const ws = wb.addWorksheet(tables.length === 1 ? 'Data' : `Tabel ${i + 1}`);
    ws.addRow(t.columns);
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of t.rows) ws.addRow(r);
    ws.columns.forEach((col, k) => {
      const longest = Math.max(t.columns[k]?.length ?? 8, ...t.rows.slice(0, 200).map((r) => String(r[k] ?? '').length));
      col.width = Math.min(60, Math.max(8, longest + 2));
      col.alignment = { vertical: 'top', wrapText: true };
    });
  });
  return wb;
}

async function renderReports(ctx: StepContext, run: any, format: string, title: string, reports: ReportInput[]): Promise<Buffer> {
  if (format === 'xlsx') {
    const tables = mergeTables(reports.map((rep) => ({ tables: parseMarkdownTables(rep.content), extra: reports.length > 1 ? { Sumber: rep.sourceName, Bagian: rep.part } : {} })));
    return Buffer.from(await workbook(tables).xlsx.writeBuffer());
  }
  if (format === 'pdf') {
    // Template PDF AutoAudit mengisi kotak "Model Used" dan "Tokens" dari metaInfo.model dan metaInfo.token.
    const models = [...new Set(reports.map((r) => r.model).filter(Boolean))];
    const tokens = reports.reduce((n, r) => n + (Number(r.tokens) || 0), 0);
    const metaInfo = { ...(models.length ? { model: models.join(', ') } : {}), ...(tokens ? { token: tokens } : {}) };
    const res = await ctx.api.exportPdf({ company_id: run.company_id, htmlContent: htmlDocument(title, reports), reportTitle: title, filename: `${title}.pdf`, metaInfo });
    if (!res.ok || !res.pdf) throw new Error(`Export PDF gagal (${title}). ${res.error}`);
    return res.pdf;
  }
  const joined = reports.length === 1 ? reports[0].content.trim() + '\n' : reports.map((r) => `# ${r.label}\n\n${r.content.trim()}\n`).join('\n---\n\n');
  return Buffer.from(format === 'txt' ? plainText(joined) : joined, 'utf8');
}

async function runExport(ctx: StepContext, run: any, node: GraphNode, stepId: string) {
  const format = String(node.config.format);
  const reports = await reportsInto(ctx, run, node.id);
  const fromParse = await tablesInto(ctx, run, node.id);
  const zipBase = fileNameFrom(node.config.filename || `${run.workflow_name} ${periodText(run.params.start_date, run.params.end_date)}`, {} as any);
  // Satu file per laporan, kecuali diminta digabung. Baris dari Parse Tabel sudah berupa gabungan, jadi selalu satu file.
  const separate = node.config.split !== 'combined' && reports.length > 0 && fromParse.length === 0;

  const rowsIn = (rs: ReportInput[]) => rs.reduce((n, r) => n + parseMarkdownTables(r.content).reduce((m, t) => m + t.rows.length, 0), 0);
  let rows: number | undefined;
  let files: { name: string; data: Buffer }[];
  if (separate) {
    if (format === 'xlsx') rows = rowsIn(reports);
    const names = uniqueNames(
      reports.map((r) => `${fileNameFrom(node.config.pattern, { sales: r.sourceName, periode: r.period, judul: r.title, workflow: run.workflow_name, bagian: r.part })}.${format}`),
    );
    files = [];
    for (const [i, r] of reports.entries()) files.push({ name: names[i], data: await renderReports(ctx, run, format, names[i].replace(/\.[a-z]+$/, ''), [r]) });
  } else if (format === 'xlsx') {
    const tables = await allTablesInto(ctx, run, node.id);
    rows = tables.reduce((n, t) => n + t.rows.length, 0);
    files = [{ name: `${zipBase}.xlsx`, data: Buffer.from(await workbook(tables).xlsx.writeBuffer()) }];
  } else {
    if (!reports.length) throw new Error('Tidak ada laporan yang selesai untuk diekspor.');
    files = [{ name: `${zipBase}.${format}`, data: await renderReports(ctx, run, format, zipBase, reports) }];
  }
  if (!files.length) throw new Error('Tidak ada laporan yang selesai untuk diekspor.');

  // Lebih dari satu file dibungkus zip supaya tetap satu unduhan.
  let out: { name: string; data: Buffer; ext: string };
  if (files.length === 1) out = { ...files[0], ext: format };
  else {
    const zip = new JSZip();
    for (const f of files) zip.file(f.name, f.data);
    out = { name: `${zipBase}.zip`, data: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), ext: 'zip' };
  }

  const dir = join(ctx.filesDir, run.id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${stepId}.${out.ext}`);
  await writeFile(path, out.data);
  return {
    summary: { kind: 'file', name: out.name, size: out.data.length, format, zipped: files.length > 1, count: files.length, files: files.map((f) => f.name), reports: reports.length, ...(rows === undefined ? {} : { rows }) },
    file: { path, name: out.name, mime: MIME[out.ext] ?? 'application/octet-stream' },
  };
}

// Semua tabel yang masuk ke sebuah node: dari Parse Tabel, atau dibaca langsung dari laporan AW.
async function allTablesInto(ctx: StepContext, run: any, nodeId: string): Promise<MdTable[]> {
  const direct = (await reportsInto(ctx, run, nodeId)).map((rep) => ({
    tables: parseMarkdownTables(rep.content),
    extra: { Sumber: rep.sourceName, Bagian: rep.part },
  }));
  return [...(await tablesInto(ctx, run, nodeId)), ...mergeTables(direct)];
}

async function runSheets(ctx: StepContext, run: any, node: GraphNode) {
  if (!ctx.sheets) throw new Error('Kunci service account Google belum dipasang di .secrets/google.json.');
  const c = node.config;
  const target = parseSheetUrl(c.url);
  if (!target) throw new Error('Tautan spreadsheet tidak valid.');
  const meta = await ctx.sheets.tabs(target.id);
  // Tab dicari lewat gid, bukan nama, supaya tidak rusak saat tab diganti nama.
  const tab = meta.tabs.find((t) => t.gid === Number(c.gid));
  if (!tab) throw new Error(`Tab dengan gid ${c.gid} tidak ada lagi di spreadsheet "${meta.title}".`);

  const tables = await allTablesInto(ctx, run, node.id);
  const pick = Math.max(1, Number(c.table) || 1);
  const table = tables[pick - 1];
  const base = { kind: 'sheet', spreadsheet: meta.title, tab: tab.title, url: `https://docs.google.com/spreadsheets/d/${target.id}/edit#gid=${tab.gid}` };
  if (!table || !table.rows.length) return { summary: { ...base, appended: 0, updated: 0, skipped: 0, ignoredColumns: [], note: tables.length ? `Tabel ke-${pick} tidak ada (laporan berisi ${tables.length} tabel).` : 'Tidak ada tabel pada laporan.' } };

  const keyColumns = String(c.keyColumns || '').split(',').map((s) => s.trim()).filter(Boolean);
  const existing = await ctx.sheets.read(target.id, tab.title);
  const plan = planSheetWrite({ existing, columns: table.columns, rows: table.rows, mode: c.mode, keyColumns });
  if (plan.missingKeys.length) throw new Error(`Kolom kunci tidak ada di tab "${tab.title}": ${plan.missingKeys.join(', ')}. Header yang ada: ${(existing[0] ?? []).join(', ') || '(kosong)'}.`);
  if (plan.ignoredColumns.length === table.columns.length) throw new Error(`Tidak satu pun kolom tabel cocok dengan header tab "${tab.title}". Header sheet: ${(existing[0] ?? []).join(', ')}. Kolom tabel: ${table.columns.join(', ')}.`);

  // Perbarui dulu, baru tambah: nomor baris yang diperbarui dihitung dari isi sheet sebelum ada tambahan.
  await ctx.sheets.update(target.id, tab.title, plan.updates);
  await ctx.sheets.append(target.id, tab.title, [...(plan.header ? [plan.header] : []), ...plan.appends]);
  return { summary: { ...base, appended: plan.appends.length, updated: plan.updates.length, skipped: plan.skipped, ignoredColumns: plan.ignoredColumns, wroteHeader: !!plan.header } };
}

// File hasil node Export yang masuk ke sebuah node.
async function filesInto(ctx: StepContext, run: any, nodeId: string): Promise<{ path: string; name: string; mime: string }[]> {
  const graph: Graph = run.graph;
  const ids = incoming(graph, nodeId, 'in')
    .map((e) => graph.nodes.find((n) => n.id === e.source))
    .filter((n) => n?.type === 'export')
    .map((n) => n!.id);
  if (!ids.length) return [];
  const r = await ctx.db.query(`select output->'file' as file from steps where run_id=$1 and node_id = any($2) and status='done'`, [run.id, ids]);
  return r.rows.map((x) => x.file).filter(Boolean);
}

async function runMessage(ctx: StepContext, run: any, node: GraphNode) {
  const [reports, tables, files, done] = await Promise.all([
    reportsInto(ctx, run, node.id),
    tablesInto(ctx, run, node.id),
    filesInto(ctx, run, node.id),
    ctx.db.query(`select count(*)::int as n from units where run_id=$1 and status='done'`, [run.id]),
  ]);
  const vars = {
    workflow: run.workflow_name,
    company: run.company_name ?? '',
    periode: `${run.params.start_date} s/d ${run.params.end_date}`,
    jumlah_aw: done.rows[0].n,
    jumlah_baris: tables.reduce((n, t) => n + t.rows.length, 0),
  };
  return sendMessage(ctx.gowa ?? null, node, { vars, reports, files }, ctx.fetch);
}

async function runHttp(ctx: StepContext, run: any, node: GraphNode) {
  const savedKey = ctx.masterKey ? await readSecret(ctx.db, ctx.masterKey, run.workflow_id, node.id, 'autobotApiKey') : null;
  node = {...node, config:{...node.config, autobotApiKey:savedKey || node.config.autobotApiKey}};
  const [reports, tables, files] = await Promise.all([reportsInto(ctx, run, node.id), tablesInto(ctx, run, node.id), filesInto(ctx, run, node.id)]);
  const codeIds = incoming(run.graph,node.id,'in').map(e=>run.graph.nodes.find((n:GraphNode)=>n.id===e.source)).filter(n=>n?.type==='code' || n?.type==='http').map(n=>n!.id);
  const items = codeIds.length ? (await ctx.db.query("select output->'items' as items from steps where run_id=$1 and node_id=any($2) and status='done' order by node_id",[run.id,codeIds])).rows.flatMap(r=>r.items ?? []) : undefined;
  return sendHttp(
    node,
    {
      ...(items ? {items} : {}),
      workflow: run.workflow_name,
      run_id: run.id,
      company_id: run.company_id,
      params: run.params,
      reports: reports.map((r) => ({ label: r.label, source: r.sourceName, content: r.content })),
      tables,
      files: files.map((f) => ({ name: f.name })),
    },
    ctx.fetch,
  );
}

// Daftar model OpenRouter (untuk mengetahui kapasitas konteks) disimpan sejam.
let modelCache: { at: number; list: OpenRouterModel[] } | null = null;
export async function openRouterModels(doFetch?: typeof fetch): Promise<OpenRouterModel[]> {
  if (modelCache && Date.now() - modelCache.at < 3_600_000) return modelCache.list;
  modelCache = { at: Date.now(), list: await listModels(doFetch) };
  return modelCache.list;
}

async function runAiMerge(ctx: StepContext, run: any, node: GraphNode) {
  const c = node.config;
  // Key dibaca dari penyimpanan terenkripsi saat dijalankan, jadi mengganti key berlaku juga untuk run yang dilanjutkan.
  const key = ctx.masterKey ? await readSecret(ctx.db, ctx.masterKey, run.workflow_id, node.id, 'apiKey') : null;
  if (!key) throw new Error('API key OpenRouter belum diisi di node Merge AI.');
  const reports = await reportsInto(ctx, run, node.id);
  if (!reports.length) throw new Error('Tidak ada laporan yang selesai untuk digabung.');
  const title = String(c.title || '').trim() || `Merge ${run.workflow_name} ${periodText(run.params.start_date, run.params.end_date)}`;
  if (reports.length === 1) {
    return { summary: { kind: 'aimerge', title, sources: 1, calls: 0, tokens: 0, model: c.model, levels: 0, note: 'Hanya satu laporan yang masuk, jadi diteruskan apa adanya tanpa merge.' }, report: { label: title, content: reports[0].content, history_id: null } };
  }
  const models = await openRouterModels(ctx.fetch).catch(() => [] as OpenRouterModel[]);
  const contextLength = models.find((m) => m.id === c.model)?.context_length || 120_000;
  const out = await aiMerge({ key, model: String(c.model), contextLength, prompt: String(c.prompt), title, reports: reports.map((r) => ({ label: r.label, content: r.content })), fetch: ctx.fetch });
  return { summary: { kind: 'aimerge', title, sources: reports.length, calls: out.calls, tokens: out.tokens, model: c.model, levels: out.levels, note: null }, report: { label: title, content: out.content, history_id: null, model: c.model, tokens: out.tokens } };
}

// Merge AI bisa berjalan beberapa menit; dijalankan di latar supaya putaran mesin tidak tertahan.
// Bila server mati di tengahnya, langkah kembali ke 'waiting' saat hidup lagi dan diulang.
function startAiMerge(ctx: StepContext, run: any, node: GraphNode, stepId: string, log: (m: string) => void) {
  runAiMerge(ctx, run, node)
    .then((output) => ctx.db.query(`update steps set status='done', output=$2, finished_at=now() where id=$1 and status='running'`, [stepId, JSON.stringify(output)]))
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log(`merge AI ${stepId} gagal: ${message}`);
      return ctx.db.query(`update steps set status='failed', error=$2, finished_at=now() where id=$1 and status='running'`, [stepId, message.slice(0, 1000)]);
    })
    .catch((err) => log(`merge AI ${stepId}: gagal menyimpan hasil: ${err?.message ?? err}`));
}

// Langkah siap bila semua AW hulunya sudah selesai/dilewati dan semua langkah hulunya selesai.
function ready(graph: Graph, nodeId: string, unitsOpen: Map<string, number>, stepStatus: Map<string, string>): boolean {
  return incoming(graph, nodeId, 'in').every((e) => {
    const from = graph.nodes.find((n) => n.id === e.source);
    if (!from) return false;
    if (REPORT_TYPES.includes(from.type)) return (unitsOpen.get(from.id) ?? 0) === 0;
    if (STEP_TYPES.includes(from.type)) return stepStatus.get(from.id) === 'done';
    return true;
  });
}

export async function runReadySteps(ctx: StepContext, log: (m: string) => void) {
  const runs = await ctx.db.query(
    `select r.*, w.name as workflow_name, w.company_name from runs r join workflows w on w.id = r.workflow_id
     where r.status='running' and not r.halted
       and exists (select 1 from steps s where s.run_id = r.id and (s.status='waiting' or (s.type in ('sync','merge') and s.status='running')))`,
  );
  for (const run of runs.rows) {
    const graph: Graph = run.graph;
    for (let progressed = true; progressed; ) {
      progressed = false;
      const open = await ctx.db.query(`select node_id, count(*)::int as n from units where run_id=$1 and status not in ('done','skipped') group by node_id`, [run.id]);
      const unitsOpen = new Map<string, number>(open.rows.map((x) => [x.node_id, x.n]));
      const steps = (await ctx.db.query('select id, node_id, type, status, output from steps where run_id=$1', [run.id])).rows;
      const stepStatus = new Map<string, string>(steps.map((s) => [s.node_id, s.status]));

      // Sync Sales dimajukan sedikit demi sedikit tiap putaran; tidak ditunggu di sini.
      // Sync Sales dan Merge Report berjalan lama, jadi dimajukan bertahap. Merge baru mulai setelah hulunya selesai.
      const longRunning = steps.filter(
        (s) => (s.type === 'sync' && (s.status === 'waiting' || s.status === 'running')) || (s.type === 'merge' && (s.status === 'running' || (s.status === 'waiting' && ready(graph, s.node_id, unitsOpen, stepStatus)))),
      );
      for (const step of longRunning) {
        const node = graph.nodes.find((n) => n.id === step.node_id)!;
        // Baris langkah dikunci selama dimajukan, supaya dua putaran yang bertabrakan tidak memulai sync yang sama dua kali.
        const client = await ctx.db.connect();
        try {
          await client.query('begin');
          const locked = await client.query(`select output from steps where id=$1 and status in ('waiting','running') for update skip locked`, [step.id]);
          if (locked.rows[0]) {
            const r =
              step.type === 'merge'
                ? await advanceMerge(ctx.api, run, node, locked.rows[0].output, await mergeSources(ctx, run, node.id), Date.now(), ctx.syncCheckMs)
                : await advanceSync(ctx.api, run, node, locked.rows[0].output, Date.now(), ctx.syncCheckMs);
            await client.query(
              `update steps set status=$2, output=$3, error=$4, started_at=coalesce(started_at, now()), finished_at=case when $2 = 'running' then null else now() end where id=$1`,
              [step.id, r.status, JSON.stringify(r.output), r.error ?? null],
            );
            if (r.status === 'done') progressed = true;
          }
          await client.query('commit');
        } catch (err) {
          await client.query('rollback').catch(() => {});
          log(`${step.type} ${step.id}: ${err instanceof Error ? err.message : err}`); // galat sementara; dicoba lagi di putaran berikutnya
        } finally {
          client.release();
        }
      }

      for (const step of steps.filter((s) => s.status === 'waiting' && s.type !== 'sync' && s.type !== 'merge')) {
        if (!ready(graph, step.node_id, unitsOpen, stepStatus)) continue;
        const node = graph.nodes.find((n) => n.id === step.node_id)!;
        const claimed = await ctx.db.query(`update steps set status='running', started_at=now(), error=null where id=$1 and status='waiting' returning id`, [step.id]);
        if (!claimed.rows[0]) continue;
        if (node.type === 'aimerge') {
          startAiMerge(ctx, run, node, step.id, log);
          continue;
        }
        try {
          const output =
            node.type === 'code'
              ? await runCode(ctx, run, node)
              : node.type === 'parse'
              ? await runParse(ctx, run, node)
              : node.type === 'sheets'
                ? await runSheets(ctx, run, node)
                : node.type === 'message'
                  ? await runMessage(ctx, run, node)
                  : node.type === 'http'
                    ? await runHttp(ctx, run, node)
                    : await runExport(ctx, run, node, step.id);
          await ctx.db.query(`update steps set status='done', output=$2, finished_at=now() where id=$1`, [step.id, JSON.stringify(output)]);
          progressed = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`langkah ${node.type} ${step.id} gagal: ${message}`);
          await ctx.db.query(`update steps set status='failed', error=$2, finished_at=now() where id=$1`, [step.id, message.slice(0, 1000)]);
        }
      }
    }
  }
}
