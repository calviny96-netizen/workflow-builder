// Fase 0: uji kontrak API AutoAudit terhadap server nyata.
//
//   npm run contract          hanya endpoint baca + preview/preflight (tanpa token AI)
//   npm run contract:run      + satu run Audital Work mini (memakai token AI)
//   npm run contract:merge    + merge AI dari 2 laporan terbaru (memakai token AI)
//
// Yang disimpan ke docs/contract/ hanyalah BENTUK respons (nama field + tipe),
// bukan isinya, supaya data klien tidak ikut tertulis ke repo.

import { mkdir, writeFile } from 'node:fs/promises';
import { createClient, errorCode, evaluateRunStatus, unwrap } from '../packages/autoaudit/src/index.ts';
import type { ApiResponse, RunPayload } from '../packages/autoaudit/src/index.ts';

const args = new Set(process.argv.slice(2));
const DO_RUN = args.has('--run');
const DO_MERGE = args.has('--merge');
const OUT_DIR = new URL('../docs/contract/', import.meta.url);

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    console.error(`Variabel ${name} belum diisi di .env (lihat .env.example).`);
    process.exit(1);
  }
  return v;
}

const companyId = Number(env('AA_TEST_COMPANY_ID'));
const salesId = Number(env('AA_TEST_SALES_ID'));
const runBySuperadmin = env('AA_TEST_RUN_BY_SUPERADMIN', 'false') === 'true';
const timezone = env('AA_TEST_TIMEZONE', 'Asia/Jakarta');
const testDate =
  process.env.AA_TEST_DATE ||
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(Date.now() - 86_400_000));

const api = createClient({
  baseUrl: env('AUTOAUDIT_BASE_URL', 'https://app-autoaudit.ordoagentic.ai'),
  token: env('AUTOAUDIT_API_KEY'),
});

// Field yang nilainya aman dan berguna untuk dicatat apa adanya (enum, bukan data klien).
const KEEP_VALUES = /^(status|run_status|queue_status|sync_status|chat_type|code|can_start|needs_chunking|is_over_context)$/;

function shape(v: unknown, key = '', depth = 0): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [shape(v[0], key, depth + 1), `…(${v.length})`] : [];
  if (typeof v === 'object') {
    if (depth > 6) return '{…}';
    return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, shape(x, k, depth + 1)]));
  }
  if (KEEP_VALUES.test(key)) return `${typeof v}: ${String(v)}`;
  return typeof v;
}

const results: { name: string; status: number | string; note: string }[] = [];

async function record(name: string, call: () => Promise<ApiResponse<any>>, keepRaw = false): Promise<any> {
  try {
    const res = await call();
    const code = errorCode(res.body);
    const out = { http_status: res.status, error_code: code || undefined, body: keepRaw ? res.body : shape(res.body) };
    await writeFile(new URL(`${name}.json`, OUT_DIR), JSON.stringify(out, null, 2) + '\n');
    results.push({ name, status: res.status, note: code });
    console.log(`${res.ok ? 'OK  ' : 'GAGAL'} ${res.status} ${name}${code ? ' [' + code + ']' : ''}`);
    return res.ok ? unwrap(res.body) : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, status: 'error', note: msg });
    console.log(`GAGAL --- ${name}: ${msg}`);
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const list = (d: any): any[] => (Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : []);

await mkdir(OUT_DIR, { recursive: true });
console.log(`Company ${companyId}, sales ${salesId}, tanggal uji ${testDate}, run_by_superadmin=${runBySuperadmin}\n`);

// --- 1. Bacaan murni
await record('companies', () => api.listCompanies({ page: 1, limit: 2 }));
await record('divisions', () => api.listDivisions({ company_id: companyId, page: 1, limit: 2 }));
await record('sales-list', () => api.listSales({ company_id: companyId, page: 1, limit: 2 }));
await record('sales-detail', () => api.getSales(salesId));
await record('sales-contacts', () => api.listContacts(salesId, { page: 1, limit: 2 }));
await record('notifications', () => api.listNotifications({ company_id: companyId, page: 1, limit: 2 }));
const models = await record('aw-models', () => api.listModels(companyId));
await record('aw-saved-prompts', () => api.listSavedPrompts(companyId));
await record('aw-memories', () => api.listMemories(companyId));
// filter-options berisi enum, bukan data klien: disimpan utuh.
await record('aw-filter-options', () => api.getFilterOptions(companyId), true);
await record('aw-sales-setup', () => api.getSalesSetup(salesId));
await record('aw-histories', () =>
  api.listHistories({ company_id: companyId, run_by_superadmin: runBySuperadmin, page: 1, limit: 2 }),
);
const generated = await record('merge-generated', () =>
  api.listGeneratedReports({ company_id: companyId, page: 1, limit: 2 }),
);

// --- 2. POST yang hanya menghitung (tidak memakai token AI)
const filter = { start_date: testDate, end_date: testDate, chat_type: 'individual', timezone };
await record('aw-filter-preview', () => api.filterPreview(salesId, filter));

// Nama model yang dikirim ke run adalah model_name (mis. "qwen/qwen3.7-plus"), bukan id numerik.
const model = process.env.AA_TEST_MODEL || models?.summary?.default_model || models?.anchor_model?.model_name;

const payload: RunPayload = {
  company_id: companyId,
  sales_id: salesId,
  model: String(model || ''),
  prompt: 'Uji kontrak API. Balas dengan satu kalimat ringkasan saja.',
  run_by_superadmin: runBySuperadmin,
  correlation_id: `contract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  filter,
};

if (!payload.model) {
  console.log('\nModel tidak terbaca dari /models. Isi AA_TEST_MODEL di .env lalu jalankan ulang.');
} else {
  const pf = await record('aw-preflight', () => api.preflight(payload));

  // --- 3. Satu run mini (memakai token AI): hanya dengan --run
  if (DO_RUN) {
    if (pf && pf.can_start === false) {
      console.log('Preflight menolak (can_start=false); run dilewati. Coba tanggal lain lewat AA_TEST_DATE.');
    } else {
      const started = await record('aw-run-start', () => api.startRun(payload));
      const historyId = Number(started?.history_id || 0);
      if (historyId) {
        let state = 'running';
        let unknown = 0;
        for (let i = 1; i <= 80 && (state === 'running' || state === 'unknown'); i++) {
          await sleep(15_000);
          const res = await api.getRunStatus(historyId, companyId, runBySuperadmin);
          const ev = evaluateRunStatus(unwrap(res.body));
          state = ev.state;
          unknown = ev.state === 'unknown' ? unknown + 1 : 0;
          console.log(`  polling ${i}: ${ev.status || '(kosong)'} -> ${ev.state}`);
          if (unknown >= 15) state = 'failed';
          if (state === 'done' || state === 'failed') {
            await writeFile(
              new URL('aw-run-status-terminal.json', OUT_DIR),
              JSON.stringify({ http_status: res.status, body: shape(res.body) }, null, 2) + '\n',
            );
          }
        }
        results.push({ name: 'aw-run-polling', status: state, note: `history ${historyId}` });
        await record('aw-history-detail', () => api.getHistory(historyId, companyId, runBySuperadmin));
        await record('merge-generated-by-history', () => api.getGeneratedByHistory(historyId, companyId));
      }
    }
  }
}

// --- 4. Merge AI (memakai token AI dan membuat draft history): hanya dengan --merge
if (DO_MERGE) {
  const ids = list(generated)
    .map((g) => g.assistant_message_id)
    .filter(Boolean)
    .slice(0, 2);
  if (ids.length < 2) {
    console.log('Butuh minimal 2 laporan di /merge-reports/generated untuk uji merge.');
  } else {
    // Terverifikasi: base_assistant_message_id wajib dan harus termasuk dalam sumber;
    // ai-drafts juga mewajibkan prompt.
    const body = { company_id: companyId, base_assistant_message_id: ids[0], source_assistant_message_ids: ids };
    await record('merge-preview', () => api.mergePreview(body));
    const draft = await record('merge-ai-draft', () =>
      api.createAiDraft({
        ...body,
        prompt: 'Uji kontrak API. Gabungkan kedua laporan menjadi satu ringkasan singkat.',
        ...(payload.model ? { model: payload.model } : {}),
        run_by_superadmin: runBySuperadmin,
      }),
    );
    const draftHistory = Number(draft?.history_id || 0);
    if (draftHistory) {
      // Pertanyaan terbuka PRD §10: apakah draft langsung diisi AI, dan bagaimana tahu sudah selesai.
      console.log(`  draft history ${draftHistory}`);
      let found = '';
      for (let i = 1; i <= 20 && !found; i++) {
        for (const superadmin of [runBySuperadmin, !runBySuperadmin]) {
          const st = await api.getRunStatus(draftHistory, companyId, superadmin);
          const h = await api.getHistory(draftHistory, companyId, superadmin);
          const hd = unwrap<any>(h.body);
          const ev = evaluateRunStatus(unwrap(st.body));
          console.log(
            `  cek ${i} superadmin=${superadmin}: status ${st.status}/${ev.status || '-'} -> ${ev.state}; ` +
              `history ${h.status}, result ${hd?.result ? 'ADA (' + String(hd.result.content || '').length + ' karakter)' : 'kosong'}`,
          );
          if (h.ok && hd?.result?.content) found = String(superadmin);
        }
        if (!found) await sleep(15_000);
      }
      results.push({ name: 'merge-draft-result', status: found ? 'ada' : 'kosong', note: found ? `superadmin=${found}` : 'tidak terisi dalam 5 menit' });
      await record('merge-draft-history', () =>
        api.getHistory(draftHistory, companyId, found ? found === 'true' : runBySuperadmin),
      );
      await record('merge-draft-generated', () => api.getGeneratedByHistory(draftHistory, companyId));
    }
  }
}

console.log('\nRingkasan');
console.table(results);
console.log('Bentuk respons tersimpan di docs/contract/.');
