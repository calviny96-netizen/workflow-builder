// Klien AutoAudit Integration API.
// Aturan dari workflow n8n yang sudah teruji:
// - GET di-retry, POST tidak pernah di-retry (POST /runs dan /sync bisa membuat job ganda).
// - Token hanya hidup di server; tidak pernah ikut tercetak di error atau log.

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface ClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  getRetries?: number;
  fetch?: typeof fetch;
}

export interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
}

export class AutoAuditError extends Error {
  status: number;
  code: string;
  body: unknown;
  constructor(message: string, status: number, code: string, body: unknown) {
    super(message);
    this.name = 'AutoAuditError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface AuditFilter {
  start_date?: string;
  end_date?: string;
  years?: number[];
  time_filter_mode?: string;
  start_time?: string;
  end_time?: string;
  chat_type?: string;
  chat_numbers?: string[];
  include_participants?: boolean;
  include_full_history?: boolean;
  include_full_history_mode?: string;
  contact_exclusion_mode?: string;
  is_excluded?: boolean;
  timezone?: string;
}

export interface RunPayload {
  company_id: number;
  sales_id: number;
  model: string;
  prompt?: string;
  saved_prompt_id?: number;
  run_by_superadmin: boolean;
  selected_memory_ids?: number[];
  correlation_id?: string;
  filter?: AuditFilter;
}

export type RunState = 'running' | 'done' | 'failed' | 'unknown';

const DONE = ['completed', 'complete', 'done', 'success', 'finished'];
const FAILED = ['failed', 'error', 'cancelled', 'canceled'];

// Menafsirkan balasan GET /audital-work/runs/status. 'unknown' berarti status
// kosong/idle: pemanggil yang menghitung berapa kali berturut-turut sebelum menyerah.
export function evaluateRunStatus(data: any): { state: RunState; status: string; error?: string } {
  const rt = data && typeof data.runtime === 'object' && data.runtime ? data.runtime : {};
  const status = String((data && data.status) || rt.run_status || '').toLowerCase();
  if (DONE.includes(status) || rt.finished_at) return { state: 'done', status };
  if (FAILED.includes(status) || rt.stream_error) {
    return { state: 'failed', status, error: rt.stream_error ? String(rt.stream_error) : status || 'error' };
  }
  if (status === '' || status === 'idle') return { state: 'unknown', status };
  return { state: 'running', status };
}

// Membuka amplop { data: ... } dan mengambil kode error bila ada.
export function unwrap<T = any>(body: any): T {
  return body && typeof body === 'object' && 'data' in body ? body.data : body;
}

export function errorCode(body: any): string {
  if (!body || typeof body !== 'object') return '';
  const e = body.error;
  if (e && typeof e === 'object' && e.code) return String(e.code);
  if (typeof e === 'string') return e;
  return String(body.code || '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createClient(opts: ClientOptions) {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const getRetries = opts.getRetries ?? 3;
  const P = '/api/v1/integrations';

  async function once(method: string, path: string, query?: Query, body?: unknown): Promise<ApiResponse<any>> {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await doFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // balasan bukan JSON dibiarkan sebagai teks
    }
    return { status: res.status, ok: res.ok, body: parsed };
  }

  // Tidak melempar pada status non-2xx: pemanggil perlu membaca kode seperti
  // empty_filter_result (bukan kegagalan) atau 501 dari export-to-drive.
  async function request(method: string, path: string, query?: Query, body?: unknown): Promise<ApiResponse<any>> {
    const attempts = method === 'GET' ? getRetries : 1;
    let lastError: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await once(method, path, query, body);
        if (res.status >= 500 && i < attempts) {
          await sleep(1000 * i);
          continue;
        }
        return res;
      } catch (err) {
        lastError = err;
        if (i < attempts) await sleep(1000 * i);
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new AutoAuditError(`${method} ${path} gagal: ${reason}`, 0, 'network_error', null);
  }

  const get = (path: string, query?: Query) => request('GET', P + path, query);
  const post = (path: string, body?: unknown, query?: Query) => request('POST', P + path, query, body);

  // Export PDF membalas berkas biner, jadi tidak lewat request() yang membaca teks/JSON.
  async function exportPdf(body: { company_id: number; htmlContent: string; reportTitle?: string; filename?: string; metaInfo?: Record<string, unknown> }): Promise<{ status: number; ok: boolean; pdf: Buffer | null; error: string }> {
    const res = await doFetch(new URL(baseUrl + P + '/audital-work/export/pdf'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json', Accept: 'application/pdf' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
    if (res.ok && isPdf) return { status: res.status, ok: true, pdf: buf, error: '' };
    let error = `AutoAudit membalas ${res.status}`;
    try {
      const j = JSON.parse(buf.toString('utf8'));
      error += `: ${j?.error?.message ?? j?.error?.code ?? j?.message ?? 'bukan berkas PDF'}`;
    } catch {
      error += res.ok ? ': balasan bukan berkas PDF' : '';
    }
    return { status: res.status, ok: false, pdf: null, error };
  }

  return {
    request,
    exportPdf,

    // Data master
    listCompanies: (q?: Query) => get('/data-master/companies', q),
    listDivisions: (q: Query) => get('/data-master/divisions', q),

    // Sales
    listSales: (q: Query) => get('/sales', q),
    getSales: (id: number) => get(`/sales/${id}`),
    listContacts: (id: number, q?: Query) => get(`/sales/${id}/contacts`, q),
    syncSales: (id: number, mode: 'sync' | 'sync-max-priority' | 'sync-no-skip' = 'sync') =>
      post(`/sales/${id}/${mode}`, {}),

    // Notifikasi
    listNotifications: (q?: Query) => get('/notifications', q),
    pollNotifications: (q?: Query) => get('/notifications/poll', q),

    // Audital Work: bacaan
    listModels: (companyId: number) => get('/audital-work/models', { company_id: companyId }),
    listSavedPrompts: (companyId: number) => get('/audital-work/saved-prompts', { company_id: companyId }),
    getSavedPrompt: (id: number, companyId: number) =>
      get(`/audital-work/saved-prompts/${id}`, { company_id: companyId }),
    listMemories: (companyId: number) => get('/audital-work/memories', { company_id: companyId }),
    getFilterOptions: (companyId: number) => get('/audital-work/filter-options', { company_id: companyId }),
    // Terverifikasi 1 Okt 2026: mengirim company_id di sini membalas 404 "Sales not found",
    // berlawanan dengan contoh Postman. Company diambil server dari sales-nya.
    getSalesSetup: (id: number) => get(`/audital-work/sales/${id}/setup`),
    filterPreview: (id: number, filter: AuditFilter) => post(`/audital-work/sales/${id}/filter-preview`, filter),

    // Audital Work: run
    preflight: (payload: RunPayload) => post('/audital-work/runs/preflight', payload),
    startRun: (payload: RunPayload) => post('/audital-work/runs', payload),
    getRunStatus: (historyId: number, companyId: number, runBySuperadmin: boolean) =>
      get('/audital-work/runs/status', {
        history_id: historyId,
        company_id: companyId,
        run_by_superadmin: runBySuperadmin,
      }),
    cancelRun: (historyId: number, companyId: number, runBySuperadmin: boolean) =>
      post(`/audital-work/runs/${historyId}/cancel`, { company_id: companyId, run_by_superadmin: runBySuperadmin }),
    getHistory: (historyId: number, companyId: number, runBySuperadmin: boolean) =>
      get(`/audital-work/histories/${historyId}`, { company_id: companyId, run_by_superadmin: runBySuperadmin }),
    listHistories: (q: Query) => get('/audital-work/histories', q),

    // Continuous Audit (hanya-baca)
    listSchedules: (q: Query) => get('/continuous-audit/schedules', q),
    listScheduleRuns: (scheduleId: number, q: Query) => get(`/continuous-audit/schedules/${scheduleId}/runs`, q),
    getContinuousRun: (runId: number, companyId: number) => get(`/continuous-audit/runs/${runId}`, { company_id: companyId }),

    // Merge Reports
    listGeneratedReports: (q: Query) => get('/merge-reports/generated', q),
    getGeneratedByHistory: (historyId: number, companyId: number) =>
      get(`/merge-reports/generated/by-history/${historyId}`, { company_id: companyId }),
    mergePreview: (body: unknown) => post('/merge-reports/preview', body),
    createAiDraft: (body: unknown) => post('/merge-reports/ai-drafts', body),
    // Menjalankan AI merge dan menyimpan hasilnya sebagai custom report. Memakai kredit company; jangan diulang buta.
    startMergeRun: (body: unknown) => post('/merge-reports/ai-runs', body),
    getMergeRun: (historyId: number, companyId: number) => get(`/merge-reports/ai-runs/${historyId}`, { company_id: companyId }),
    getCustomReport: (id: number, companyId: number) => get(`/merge-reports/custom/${id}`, { company_id: companyId }),
  };
}

export type AutoAuditClient = ReturnType<typeof createClient>;
