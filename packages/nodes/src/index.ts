export * from './calendar.ts';
export * from './code.ts';
import { CODE_SAMPLE, CODE_TEMPLATES } from './code.ts';
import { calendarIssues } from './calendar.ts';
import {httpDestination,httpUrl} from './http.ts';
export {AUTOBOT_BASE_URL,httpDestination,httpUrl} from './http.ts';
export { parsePhones } from './phones.ts';
export { DEFAULT_FILE_PATTERN, fileNameFrom, periodText, uniqueNames } from './filename.ts';
import { parsePhones } from './phones.ts';

// Katalog node: satu sumber kebenaran untuk kanvas (bentuk, port) dan mesin (validasi graf).
// Tanpa dependensi supaya bisa diimpor browser maupun server.

export type PortType = 'flow' | 'source' | 'prompt' | 'memory' | 'report' | 'rows' | 'file' | 'data';
export type Shape = 'pill' | 'square' | 'diamond' | 'trapezoid' | 'document' | 'cylinder' | 'parallelogram' | 'table' | 'circle' | 'hexagon';
export type NodeType = 'trigger' | 'sales' | 'chunk' | 'prompt' | 'memory' | 'aw' | 'viewer' | 'parse' | 'export' | 'sheets' | 'sync' | 'message' | 'http' | 'history' | 'continuous' | 'merge' | 'aimerge' | 'code';

// Node yang menghasilkan laporan: Proses AW menjalankan audit; dua lainnya hanya mengambil hasil yang sudah ada.
export const REPORT_TYPES: NodeType[] = ['aw', 'history', 'continuous'];

// Node yang dikerjakan server setelah Audital Work di hulunya selesai.
export const STEP_TYPES: NodeType[] = ['code', 'parse', 'export', 'sheets', 'sync', 'message', 'http', 'merge', 'aimerge'];

export interface PortSpec {
  id: string;
  label: string;
  type: PortType;
  accepts?: PortType[]; // bila port menerima lebih dari satu tipe
  multiple?: boolean;
  required?: boolean;
}

export interface NodeSpec {
  type: NodeType;
  label: string;
  description: string;
  family: 'resource' | 'process' | 'control';
  shape: Shape;
  color: string;
  dashed?: boolean; // garis putus-putus: node yang hanya mengambil, tidak menjalankan
  inputs: PortSpec[];
  outputs: PortSpec[];
  defaults: Record<string, unknown>;
}

export interface GraphNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  config: Record<string, any>;
}

export interface GraphEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphIssue {
  nodeId?: string;
  message: string;
}

export const NODE_SPECS: Record<NodeType, NodeSpec> = {
  trigger: {
    type: 'trigger',
    label: 'Start / Trigger',
    description: 'Memulai workflow secara manual, melalui jadwal WIB, atau webhook.',
    family: 'control',
    shape: 'pill',
    color: '#64748b',
    inputs: [],
    outputs: [{ id: 'out', label: 'mulai', type: 'flow', multiple: true }],
    defaults: { mode: 'manual' },
  },
  code: {
    type: 'code', label: 'Code', description: 'Transformasi JSON dengan Python atau JavaScript tanpa LLM.',
    family: 'process', shape: 'hexagon', color: '#b45309',
    inputs: [{id:'in',label:'data / laporan / baris',type:'data',accepts:['flow','data','report','rows'],multiple:true,required:true}],
    outputs: [{id:'out',label:'data JSON',type:'data',multiple:true}],
    defaults: {language:'javascript',runMode:'all',code:CODE_TEMPLATES.passthrough.javascript,title:'',inputJson:CODE_SAMPLE,timeoutSeconds:10},
  },
  sales: {
    type: 'sales',
    label: 'Sales',
    description: 'Pilih Sales ID atau akun WhatsApp Official sebagai sumber chat.',
    family: 'resource',
    shape: 'square',
    color: '#2563eb',
    inputs: [{ id: 'in', label: 'mulai', type: 'flow' }],
    outputs: [{ id: 'out', label: 'sumber', type: 'source', multiple: true }],
    defaults: { sales: [], sourceType: 'whatsapp' },
  },
  chunk: {
    type: 'chunk',
    label: 'Chunk',
    description: 'Memecah tiap sumber menjadi banyak Audital Work, per rentang tanggal atau per kontak.',
    family: 'process',
    shape: 'trapezoid',
    color: '#d97706',
    inputs: [{ id: 'in', label: 'sumber', type: 'source', multiple: true, required: true }],
    outputs: [{ id: 'out', label: 'potongan', type: 'source', multiple: true }],
    defaults: { mode: 'days', size: null, maxParts: 40 },
  },
  prompt: {
    type: 'prompt',
    label: 'Prompt',
    description: 'Saved prompt AutoAudit atau teks bebas.',
    family: 'resource',
    shape: 'document',
    color: '#7c3aed',
    inputs: [],
    outputs: [{ id: 'out', label: 'prompt', type: 'prompt', multiple: true }],
    defaults: { mode: 'saved', savedPromptId: null, title: '', text: '' },
  },
  memory: {
    type: 'memory',
    label: 'Memory',
    description: 'Company memory yang disertakan ke Audital Work.',
    family: 'resource',
    shape: 'cylinder',
    color: '#0d6794',
    inputs: [],
    outputs: [{ id: 'out', label: 'memory', type: 'memory', multiple: true }],
    defaults: { memories: [] },
  },
  aw: {
    type: 'aw',
    label: 'Proses AW',
    description: 'Menjalankan Audital Work, satu run per sumber atau potongan yang masuk.',
    family: 'process',
    shape: 'diamond',
    color: '#dc2626',
    inputs: [
      { id: 'source', label: 'sumber', type: 'source', multiple: true, required: true },
      { id: 'prompt', label: 'prompt', type: 'prompt', required: true },
      { id: 'memory', label: 'memory', type: 'memory', multiple: true },
    ],
    outputs: [{ id: 'out', label: 'laporan', type: 'report', multiple: true }],
    defaults: {
      analysisPeriod: { mode: 'run' },
      analysisSchedule: { enabled: false, frequency: 'daily', time: '08:00', start: '' },
      model: '',
      chatType: 'individual',
      timeFilterMode: 'all_day',
      startTime: '08:00',
      endTime: '17:00',
      includeFullHistoryMode: 'none',
      runBySuperadmin: false,
      timeoutMin: 80,
      contactMode: 'all', // all | only | exclude
      contactNumbers: '',
    },
  },
  viewer: {
    type: 'viewer',
    label: 'Penampil',
    description: 'Menampilkan laporan; bisa disalin atau diunduh sebagai teks.',
    family: 'control',
    shape: 'parallelogram',
    color: '#475569',
    inputs: [{ id: 'in', label: 'laporan', type: 'report', accepts: ['report','data'], multiple: true, required: true }],
    outputs: [],
    defaults: {},
  },
  parse: {
    type: 'parse',
    label: 'Parse Tabel',
    description: 'Mengubah tabel Markdown di laporan menjadi baris data. Tabel dari banyak laporan digabung.',
    family: 'process',
    shape: 'table',
    color: '#0369a1',
    inputs: [{ id: 'in', label: 'laporan', type: 'report', accepts: ['report','data'], multiple: true, required: true }],
    outputs: [{ id: 'out', label: 'baris', type: 'rows', multiple: true }],
    defaults: { tables: 'all', addSource: true },
  },
  export: {
    type: 'export',
    label: 'Export',
    description: 'Membuat file hasil: Excel dari baris tabel, atau PDF / teks dari laporan.',
    family: 'control',
    shape: 'parallelogram',
    color: '#155d80',
    inputs: [{ id: 'in', label: 'laporan / baris', type: 'report', accepts: ['report', 'rows', 'data'], multiple: true, required: true }],
    outputs: [{ id: 'out', label: 'file', type: 'file', multiple: true }],
    defaults: { format: 'xlsx', filename: '', split: 'separate', pattern: '' },
  },
  sheets: {
    type: 'sheets',
    label: 'Tulis Sheets',
    description: 'Menulis baris tabel ke sebuah tab Google Sheets: tambah, perbarui berdasarkan kunci, atau tambah yang baru saja.',
    family: 'control',
    shape: 'parallelogram',
    color: '#0f6e9d',
    inputs: [{ id: 'in', label: 'laporan / baris', type: 'report', accepts: ['report', 'rows', 'data'], multiple: true, required: true }],
    outputs: [],
    defaults: { url: '', gid: null, tabTitle: '', mode: 'append', keyColumns: '', table: 1 },
  },
  history: {
    type: 'history',
    label: 'History AW',
    description: 'Mengambil laporan dari Audital Work yang sudah pernah dijalankan, tanpa menjalankan ulang.',
    family: 'resource',
    shape: 'square',
    color: '#be185d',
    dashed: true,
    inputs: [{ id: 'in', label: 'mulai', type: 'flow' }],
    outputs: [{ id: 'out', label: 'laporan', type: 'report', multiple: true }],
    defaults: { items: [] },
  },
  continuous: {
    type: 'continuous',
    label: 'Hasil Continuous',
    description: 'Mengambil laporan yang dihasilkan sebuah jadwal Continuous Audit, tanpa memicu audit.',
    family: 'resource',
    shape: 'square',
    color: '#c2410c',
    dashed: true,
    inputs: [{ id: 'in', label: 'mulai', type: 'flow' }],
    outputs: [{ id: 'out', label: 'laporan', type: 'report', multiple: true }],
    defaults: { scheduleId: null, scheduleLabel: '', pick: 'latest', maxRuns: 31 },
  },
  merge: {
    type: 'merge',
    label: 'Merge AutoAudit',
    description: 'Menggabungkan banyak laporan menjadi satu lewat fitur Merge Reports AutoAudit. Hasilnya tersimpan di AutoAudit.',
    family: 'process',
    shape: 'hexagon',
    color: '#b45309',
    inputs: [{ id: 'in', label: 'laporan', type: 'report', multiple: true, required: true }],
    outputs: [{ id: 'out', label: 'laporan gabungan', type: 'report', multiple: true }],
    defaults: {
      title: '',
      prompt: 'Gabungkan laporan-laporan berikut menjadi satu laporan. Satukan temuan yang sama, hilangkan duplikasi, dan pertahankan semua baris tabel.',
      model: '',
    },
  },
  aimerge: {
    type: 'aimerge',
    label: 'Merge AI',
    description: 'Menggabungkan banyak laporan menjadi satu dengan model AI pilihan lewat OpenRouter. API key diisi di node ini.',
    family: 'process',
    shape: 'hexagon',
    color: '#7e22ce',
    inputs: [{ id: 'in', label: 'laporan', type: 'report', multiple: true, required: true }],
    outputs: [{ id: 'out', label: 'laporan gabungan', type: 'report', multiple: true }],
    defaults: {
      apiKey: '',
      apiKeyHint: '',
      model: '',
      title: '',
      prompt: 'Gabungkan laporan-laporan berikut menjadi satu laporan utuh berbahasa Indonesia. Satukan temuan yang sama, hilangkan duplikasi, dan pertahankan semua baris tabel dengan judul kolom yang sama.',
    },
  },
  sync: {
    type: 'sync',
    label: 'Sync Sales',
    description: 'Menyegarkan data chat sales sebelum diaudit, dan menunggu sampai selesai.',
    family: 'process',
    shape: 'circle',
    color: '#0891b2',
    inputs: [{ id: 'in', label: 'sumber', type: 'source', multiple: true, required: true }],
    outputs: [{ id: 'out', label: 'sumber', type: 'source', multiple: true }],
    defaults: { mode: 'sync-max-priority', policy: 'stale', staleMinutes: 30, timeoutMin: 60, onTimeout: 'fail' },
  },
  message: {
    type: 'message',
    label: 'Kirim GOWA',
    description: 'Mengirim ringkasan, isi laporan, atau file hasil ke WhatsApp lewat GOWA.',
    family: 'control',
    shape: 'parallelogram',
    color: '#1674a3',
    inputs: [{ id: 'in', label: 'laporan / file', type: 'report', accepts: ['report', 'rows', 'file', 'data'], multiple: true, required: true }],
    outputs: [],
    defaults: { mode: 'text', targetType: 'Group', target: '', text: 'Workflow {{workflow}} selesai untuk periode {{periode}}: {{jumlah_aw}} Audital Work.', fileUrl: '', includeReports: false },
  },
  http: {
    type: 'http',
    label: 'HTTP Request',
    description: 'Mengirim hasil sebagai JSON ke sistem lain (webhook, n8n, API klien).',
    family: 'control',
    shape: 'parallelogram',
    color: '#9333ea',
    inputs: [{ id: 'in', label: 'laporan / baris', type: 'report', accepts: ['report', 'rows', 'file', 'data'], multiple: true, required: true }],
    outputs: [{id:'out',label:'respons JSON',type:'data',multiple:true}],
    defaults: { destination: 'autobot', autobotWorkflowId: '', autobotApiKey: '', method: 'POST', url: '', headers: '' },
  },
};

export const PALETTE: NodeType[] = ['trigger', 'code', 'sales', 'prompt', 'memory', 'history', 'continuous', 'sync', 'chunk', 'aw', 'aimerge', 'merge', 'parse', 'viewer', 'export', 'sheets', 'message', 'http'];

// Daftar sales di belakang sebuah node sumber, menembus Sync Sales.
export type SalesChannel = 'whatsapp' | 'whatsapp_official';
export interface SalesSource { id: number; name: string; channel?: SalesChannel }
export function salesSourceKey(source: SalesSource): string {
  return `${source.channel ?? 'whatsapp'}:${source.id}`;
}

export function salesBehind(graph: Graph, nodeId: string, seen = new Set<string>()): (SalesSource & { channel: SalesChannel })[] {
  if (seen.has(nodeId)) return [];
  seen.add(nodeId);
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  if (node.type === 'sales') return (node.config.sales ?? []).map((s: any) => ({ id: Number(s.id), name: String(s.name), channel: s.channel ?? 'whatsapp' }));
  if (node.type === 'sync' || node.type === 'chunk') return incoming(graph, node.id, 'in').flatMap((e) => salesBehind(graph, e.source, seen));
  return [];
}

// Format export dan jenis masukan yang dibutuhkannya.
export const EXPORT_FORMATS: Record<string, { label: string; needs: PortType }> = {
  xlsx: { label: 'Excel (.xlsx)', needs: 'rows' },
  pdf: { label: 'PDF', needs: 'report' },
  md: { label: 'Teks Markdown (.md)', needs: 'report' },
  txt: { label: 'Teks polos (.txt)', needs: 'report' },
};

export function portOf(type: NodeType, handle: string, side: 'in' | 'out'): PortSpec | undefined {
  const spec = NODE_SPECS[type];
  return (side === 'in' ? spec?.inputs : spec?.outputs)?.find((p) => p.id === handle);
}

export function incoming(graph: Graph, nodeId: string, handle?: string): GraphEdge[] {
  return graph.edges.filter((e) => e.target === nodeId && (handle === undefined || e.targetHandle === handle));
}

export function outgoing(graph: Graph, nodeId: string): GraphEdge[] {
  return graph.edges.filter((e) => e.source === nodeId);
}

// Dipakai kanvas saat garis ditarik, dan validateGraph saat disimpan/dijalankan.
export function canConnect(graph: Graph, edge: Omit<GraphEdge, 'id'>): string | null {
  const from = graph.nodes.find((n) => n.id === edge.source);
  const to = graph.nodes.find((n) => n.id === edge.target);
  if (!from || !to) return 'Node tidak ditemukan.';
  if (from.id === to.id) return 'Node tidak bisa disambung ke dirinya sendiri.';
  const out = portOf(from.type, edge.sourceHandle, 'out');
  const inp = portOf(to.type, edge.targetHandle, 'in');
  if (!out || !inp) return 'Port tidak dikenal.';
  if (!(inp.accepts ?? [inp.type]).includes(out.type)) return `Tipe tidak cocok: ${out.label} tidak bisa masuk ke ${inp.label}.`;
  if (from.type === 'chunk' && to.type === 'chunk') return 'Chunk tidak bisa disambung ke Chunk lain.';
  if (from.type === 'chunk' && to.type === 'sync') return 'Sync Sales harus diletakkan sebelum Chunk, bukan sesudahnya.';
  if (from.type === 'aimerge' && to.type === 'merge') return 'Merge AutoAudit hanya menerima laporan yang punya history di AutoAudit; hasil Merge AI tidak punya.';
  const existing = incoming(graph, to.id, inp.id);
  if (existing.some((e) => e.source === edge.source && e.sourceHandle === edge.sourceHandle)) return 'Sambungan ini sudah ada.';
  if (!inp.multiple && existing.length > 0) return `${NODE_SPECS[to.type].label} hanya menerima satu ${inp.label}.`;
  return null;
}

// Aturan antar jenis node yang tidak tertangkap oleh tipe port.
const BLOCKED: [NodeType, NodeType, string][] = [
  ['chunk', 'chunk', 'Chunk tidak bisa disambung ke Chunk lain.'],
  ['chunk', 'sync', 'Sync Sales harus diletakkan sebelum Chunk, bukan sesudahnya.'],
  ['aimerge', 'merge', 'Merge AutoAudit hanya menerima laporan yang punya history di AutoAudit; hasil Merge AI tidak punya.'],
];

// Apakah keluaran `from` bisa masuk ke `to` (tanpa melihat graf tertentu). Dipakai panduan dan pesan salah sambung.
export function compatible(from: NodeType, to: NodeType): boolean {
  if (from === to && from !== 'sync' && from !== 'code') return false;
  if (BLOCKED.some(([a, b]) => a === from && b === to)) return false;
  return NODE_SPECS[from].outputs.some((o) => NODE_SPECS[to].inputs.some((i) => (i.accepts ?? [i.type]).includes(o.type)));
}
export const targetsOf = (type: NodeType): NodeType[] => PALETTE.filter((t) => compatible(type, t));
export const sourcesOf = (type: NodeType): NodeType[] => PALETTE.filter((t) => compatible(t, type));

function hasCycle(graph: Graph): boolean {
  const state = new Map<string, number>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const e of outgoing(graph, id)) if (visit(e.target)) return true;
    state.set(id, 2);
    return false;
  };
  return graph.nodes.some((n) => visit(n.id));
}

export function validateGraph(graph: Graph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  for (const n of graph.nodes) {
    if (!NODE_SPECS[n.type]) issues.push({ nodeId: n.id, message: `Jenis node "${n.type}" tidak dikenal.` });
  }
  if (issues.length) return issues;

  if (graph.nodes.filter((n) => n.type === 'trigger').length !== 1) issues.push({ message: 'Workflow butuh tepat satu Trigger.' });
  if (graph.nodes.filter(n => n.type === 'aw' && n.config.analysisSchedule?.enabled).length > 1) issues.push({ message: 'Aktifkan satu jadwal otomatis per workflow. Jadwal ini menjalankan seluruh workflow; tiap AW memakai periodenya sendiri.' });
  if (graph.nodes.some(n => n.type === 'trigger' && ['schedule','webhook'].includes(n.config.mode)) && graph.nodes.some(n => n.type === 'aw' && n.config.analysisSchedule?.enabled)) issues.push({ message: 'Nonaktifkan jadwal pada Proses AW saat memakai trigger Start otomatis. Periode AW tetap boleh diatur.' });
  if (!graph.nodes.some((n) => REPORT_TYPES.includes(n.type) || n.type === 'code')) issues.push({ message: 'Workflow butuh minimal satu node Code atau sumber laporan: Proses AW, History AW, atau Hasil Continuous.' });

  const checked: GraphEdge[] = [];
  for (const e of graph.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) {
      issues.push({ message: 'Ada garis yang ujungnya hilang.' });
      continue;
    }
    const problem = canConnect({ nodes: graph.nodes, edges: checked }, e);
    if (problem) issues.push({ nodeId: e.target, message: problem });
    else checked.push(e);
  }
  if (hasCycle(graph)) issues.push({ message: 'Workflow tidak boleh berputar (siklus).' });

  for (const n of graph.nodes) {
    const spec = NODE_SPECS[n.type];
    for (const p of spec.inputs) {
      if (p.required && incoming(graph, n.id, p.id).length === 0) {
        issues.push({ nodeId: n.id, message: `${spec.label}: port "${p.label}" belum disambung.` });
      }
    }
    const c = n.config || {};
    if (n.type === 'sales' && !(Array.isArray(c.sales) && c.sales.length)) {
      issues.push({ nodeId: n.id, message: 'Sales: belum ada Sales ID atau akun WhatsApp Official yang dipilih.' });
    }
    if (n.type === 'sales' && Array.isArray(c.sales) && c.sales.some((s: any) => !Number.isInteger(Number(s.id)) || Number(s.id) <= 0 || (s.channel !== undefined && !['whatsapp', 'whatsapp_official'].includes(s.channel)))) {
      issues.push({ nodeId: n.id, message: 'Sales: ID atau jenis sumber tidak valid.' });
    }
    if (n.type === 'prompt') {
      if (c.mode === 'saved' && !c.savedPromptId) issues.push({ nodeId: n.id, message: 'Prompt: saved prompt belum dipilih.' });
      if (c.mode === 'text' && !String(c.text || '').trim()) issues.push({ nodeId: n.id, message: 'Prompt: teks masih kosong.' });
    }
    if (n.type === 'code') {
      if (!['javascript','python'].includes(c.language ?? 'javascript')) issues.push({nodeId:n.id,message:'Code: pilih Python atau JavaScript.'});
      if (!['all','each'].includes(c.runMode ?? 'all')) issues.push({nodeId:n.id,message:'Code: pilih mode semua item atau per item.'});
      if (!String(c.code ?? '').trim() || String(c.code).length > 100000) issues.push({nodeId:n.id,message:'Code: isi kode maksimal 100.000 karakter.'});
      if (c.timeoutSeconds !== undefined && (!Number.isInteger(c.timeoutSeconds) || c.timeoutSeconds < 1 || c.timeoutSeconds > 30)) issues.push({nodeId:n.id,message:'Code: batas waktu 1–30 detik.'});
      if (String(c.inputJson ?? '').trim()) {try{JSON.parse(c.inputJson);}catch{issues.push({nodeId:n.id,message:'Code: input JSON tidak valid.'});}}
    }
    if (n.type === 'trigger') {
      if (!['manual','schedule','webhook'].includes(c.mode ?? 'manual')) issues.push({nodeId:n.id,message:'Start: pilih jenis trigger yang valid.'});
      if (c.mode === 'schedule' || c.mode === 'webhook') {
        for (const message of calendarIssues(c.triggerPeriod ?? {mode:'yesterday'}, c.mode === 'schedule' ? {...c.triggerSchedule,enabled:true} : undefined)) issues.push({nodeId:n.id,message:`Start: ${message}`});
        if (c.mode === 'webhook' && ((!c.webhookTokenHint && !String(c.webhookToken ?? '').trim()) || (String(c.webhookToken ?? '').trim() && String(c.webhookToken).trim().length < 32))) issues.push({nodeId:n.id,message:'Start: buat token webhook minimal 32 karakter.'});
      }
    }
    if (n.type === 'aw') for (const message of calendarIssues(c.analysisPeriod, c.analysisSchedule)) issues.push({ nodeId: n.id, message: `Proses AW: ${message}` });
    if (n.type === 'aw' && !String(c.model || '').trim()) issues.push({ nodeId: n.id, message: 'Proses AW: model belum dipilih.' });
    if (n.type === 'aw' && (c.contactMode === 'only' || c.contactMode === 'exclude') && parsePhones(c.contactNumbers).numbers.length === 0) {
      issues.push({ nodeId: n.id, message: `Proses AW: daftar nomor untuk "${c.contactMode === 'only' ? 'hanya nomor ini' : 'kecualikan nomor ini'}" masih kosong.` });
    }
    if (n.type === 'chunk') {
      if (c.mode !== 'days' && c.mode !== 'contacts') issues.push({ nodeId: n.id, message: 'Chunk: mode harus per tanggal atau per kontak.' });
      if (c.size !== null && c.size !== undefined && !(Number(c.size) >= 1)) issues.push({ nodeId: n.id, message: 'Chunk: angka pecahan minimal 1.' });
    }
    if (n.type === 'sheets') {
      if (!/\/spreadsheets\/d\/[\w-]{20,}/.test(String(c.url || ''))) issues.push({ nodeId: n.id, message: 'Tulis Sheets: tautan spreadsheet belum diisi.' });
      else if (c.gid === null || c.gid === undefined) issues.push({ nodeId: n.id, message: 'Tulis Sheets: tab belum dipilih.' });
      if (c.mode !== 'append' && !String(c.keyColumns || '').trim()) issues.push({ nodeId: n.id, message: 'Tulis Sheets: kolom kunci wajib diisi untuk mode perbarui atau tambah-yang-baru.' });
    }
    if (n.type === 'history' && !(Array.isArray(c.items) && c.items.length)) issues.push({ nodeId: n.id, message: 'History AW: belum ada history yang dipilih.' });
    if (n.type === 'continuous' && !c.scheduleId) issues.push({ nodeId: n.id, message: 'Hasil Continuous: jadwal Continuous Audit belum dipilih.' });
    if (n.type === 'aimerge') {
      if (!String(c.apiKey || '').trim() && !String(c.apiKeyHint || '').trim()) issues.push({ nodeId: n.id, message: 'Merge AI: API key OpenRouter belum diisi.' });
      if (!String(c.model || '').trim()) issues.push({ nodeId: n.id, message: 'Merge AI: model belum dipilih.' });
      if (!String(c.prompt || '').trim()) issues.push({ nodeId: n.id, message: 'Merge AI: instruksi merge masih kosong.' });
    }
    if (n.type === 'merge' && !String(c.prompt || '').trim()) issues.push({ nodeId: n.id, message: 'Merge Report: instruksi merge masih kosong.' });
    if (n.type === 'message') {
      if (!String(c.target || '').trim()) issues.push({ nodeId: n.id, message: 'Kirim GOWA: nomor atau grup tujuan belum diisi.' });
      const hasFile = graph.edges.some((e) => e.target === n.id && graph.nodes.find((x) => x.id === e.source)?.type === 'export');
      if (c.mode === 'file' && !hasFile && !String(c.fileUrl || '').trim()) issues.push({ nodeId: n.id, message: 'Kirim GOWA: mode file butuh node Export yang disambungkan, atau tautan file.' });
      if (c.mode === 'text' && !String(c.text || '').trim() && !c.includeReports) issues.push({ nodeId: n.id, message: 'Kirim GOWA: teks pesan masih kosong.' });
    }
    if (n.type === 'http' && !/^https?:\/\/\S+$/.test(httpUrl(c))) issues.push({ nodeId: n.id, message: httpDestination(c)==='autobot'?'HTTP Request: isi Workflow ID Autobot yang valid.':'HTTP Request: URL khusus harus diawali http:// atau https://.' });
    if(n.type==='http' && httpDestination(c)==='autobot' && !String(c.autobotApiKey||c.autobotApiKeyHint||'').trim()) issues.push({nodeId:n.id,message:'HTTP Request: masukkan kunci integrasi Autobot.'});
    if (n.type === 'export') {
      const fmt = EXPORT_FORMATS[c.format];
      if (!fmt) issues.push({ nodeId: n.id, message: 'Export: format belum dipilih.' });
      else {
        // Excel menerima laporan (tabelnya dibaca otomatis) maupun baris dari Parse Tabel.
        // PDF dan teks dibuat dari laporan utuh, jadi tidak bisa dari baris.
        const wrong = fmt.needs === 'report' && incoming(graph, n.id, 'in').some((e) => portOf(byId.get(e.source)!.type, e.sourceHandle, 'out')?.type !== 'report' && !['code','http'].includes(byId.get(e.source)!.type));
        if (wrong) issues.push({ nodeId: n.id, message: `Export ${fmt.label} butuh masukan laporan langsung dari Proses AW, bukan dari Parse Tabel.` });
      }
    }
    if (n.type === 'memory' && outgoing(graph, n.id).length && !(Array.isArray(c.memories) && c.memories.length)) {
      issues.push({ nodeId: n.id, message: 'Memory: belum ada memory yang dipilih.' });
    }
  }
  return issues;
}
