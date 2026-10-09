import { dataOutput } from './code.ts';
// Langkah yang berbicara ke luar: Sync Sales (AutoAudit), Kirim GOWA (GOWA), HTTP Request.

import { readFile } from 'node:fs/promises';
import { errorCode, unwrap } from '../../../packages/autoaudit/src/index.ts';
import type { AutoAuditClient } from '../../../packages/autoaudit/src/index.ts';
import { salesBehind, salesSourceKey, httpUrl, httpDestination } from '../../../packages/nodes/src/index.ts';
import type { Graph, GraphNode } from '../../../packages/nodes/src/index.ts';

export interface GowaConfig {
  baseUrl: string;
  user: string;
  password: string;
  deviceId: string;
  gapMs?: number; // jeda antar pesan, meniru batching di n8n
}

export function gowaFromEnv(env: NodeJS.ProcessEnv): GowaConfig | null {
  if (!env.GOWA_BASE_URL || !env.GOWA_USER || !env.GOWA_PASSWORD) return null;
  return {
    baseUrl: env.GOWA_BASE_URL.replace(/\/+$/, ''),
    user: env.GOWA_USER,
    password: env.GOWA_PASSWORD,
    deviceId: env.GOWA_DEVICE_ID ?? '',
  };
}

// ---------- Sync Sales
// Sync bisa berjalan puluhan menit, jadi tidak ditunggu di dalam satu putaran mesin. Keadaannya
// disimpan di steps.output dan dimajukan sedikit demi sedikit tiap putaran.

export interface SyncJob {
  sales_id: number;
  channel?: 'whatsapp' | 'whatsapp_official';
  name: string;
  status: 'pending' | 'queued' | 'done' | 'skipped' | 'failed';
  note?: string;
  after_id?: number;
  job_id?: number | null;
  started_at?: number;
}

const CHECK_EVERY_MS = 15_000;

export async function advanceSync(
  api: AutoAuditClient,
  run: { graph: Graph; company_id: number; params?: { sync_policy?: string } },
  node: GraphNode,
  previous: any,
  now = Date.now(),
  checkEveryMs = CHECK_EVERY_MS,
): Promise<{ output: any; status: 'running' | 'done' | 'failed'; error?: string }> {
  // Pilihan sync saat menekan Run mengalahkan pengaturan node.
  const c = { ...node.config, ...(run.params?.sync_policy ? { policy: run.params.sync_policy } : {}) };
  let jobs: SyncJob[] = previous?.jobs;
  if (!jobs) {
    const seen = new Set<string>();
    jobs = salesBehind(run.graph, node.id)
      .filter((s) => !seen.has(salesSourceKey(s)) && seen.add(salesSourceKey(s)))
      .map((s) => ({ sales_id: s.id, channel: s.channel, name: s.name, status: 'pending' as const }));
  }
  let nextCheck: number = previous?.next_check ?? 0;
  const wrap = (status: 'running' | 'done' | 'failed', error?: string) => ({
    status,
    error,
    output: { jobs, next_check: nextCheck, summary: { kind: 'sync', jobs: jobs.map((j) => ({ name: j.name, status: j.status, note: j.note ?? '' })) } },
  });

  // Mulai sync untuk yang belum dimulai.
  for (const job of jobs.filter((j) => j.status === 'pending')) {
    if (job.channel === 'whatsapp_official') {
      Object.assign(job, { status: 'skipped', note: 'WhatsApp Official memakai dataset akun langsung; tidak memerlukan Sync Sales.' });
      continue;
    }
    if (c.policy === 'skip') {
      Object.assign(job, { status: 'skipped', note: 'Sync dilewati sesuai pengaturan.' });
      continue;
    }
    const detail = unwrap<any>((await api.getSales(job.sales_id)).body) ?? {};
    const last = detail.last_sync_at ? Date.parse(detail.last_sync_at) : 0;
    const ageMin = last ? Math.floor((now - last) / 60_000) : null;
    if (c.policy === 'stale' && ageMin !== null && ageMin < Number(c.staleMinutes ?? 30)) {
      Object.assign(job, { status: 'skipped', note: `Data baru disinkron ${ageMin} menit lalu.` });
      continue;
    }
    // Garis batas: notifikasi sync sebelum titik ini bukan bukti sync yang kita mulai.
    const boundary = await api.listNotifications({ company_id: run.company_id, group: 'sync', page: 1, limit: 1 });
    const afterId = Number(boundary.body?.data?.[0]?.id ?? 0);
    let res;
    try {
      res = await api.syncSales(job.sales_id, c.mode);
    } catch {
      // Tidak tahu apakah permintaan sampai. Tunggu notifikasinya; POST tidak dikirim ulang.
      Object.assign(job, { status: 'queued', after_id: afterId, job_id: null, started_at: now, note: 'Balasan mulai-sync tidak diterima; menunggu notifikasi.' });
      continue;
    }
    const code = errorCode(res.body);
    if (res.ok) {
      Object.assign(job, { status: 'queued', after_id: afterId, job_id: Number(unwrap<any>(res.body)?.job_id) || null, started_at: now, note: '' });
    } else if (res.status === 409) {
      Object.assign(job, { status: 'queued', after_id: afterId, job_id: null, started_at: now, note: 'Sync untuk sales ini sudah berjalan; ikut menunggu.' });
    } else {
      Object.assign(job, { status: 'failed', note: `Sync ditolak (${res.status}${code ? ' ' + code : ''}): ${res.body?.error?.message ?? ''}`.trim() });
    }
  }

  // Periksa yang sedang berjalan, tidak lebih sering dari checkEveryMs.
  const queued = jobs.filter((j) => j.status === 'queued');
  if (queued.length && now >= nextCheck) {
    nextCheck = now + checkEveryMs;
    const n = await api.listNotifications({ company_id: run.company_id, group: 'sync', page: 1, limit: 100 });
    const events: any[] = n.body?.data ?? [];
    for (const job of queued) {
      const hit = events.find(
        (e) =>
          Number(e.id) > (job.after_id ?? 0) &&
          Number(e.data?.sales_id) === job.sales_id &&
          (job.job_id ? Number(e.data?.job_id) === job.job_id : true) &&
          /^(completed|failed|error|cancel)/.test(String(e.event_key)),
      );
      if (hit && String(hit.event_key) === 'completed') Object.assign(job, { status: 'done', note: '' });
      else if (hit) Object.assign(job, { status: 'failed', note: `Sync gagal: ${hit.data?.error_reason ?? hit.event_key}` });
      else if (now - (job.started_at ?? now) > Number(c.timeoutMin ?? 60) * 60_000) {
        if (c.onTimeout === 'continue') Object.assign(job, { status: 'done', note: `Belum selesai setelah ${c.timeoutMin} menit; dilanjutkan dengan data yang ada.` });
        else Object.assign(job, { status: 'failed', note: `Belum selesai setelah ${c.timeoutMin} menit.` });
      }
    }
  }

  if (jobs.some((j) => j.status === 'pending' || j.status === 'queued')) return wrap('running');
  const failed = jobs.filter((j) => j.status === 'failed');
  if (failed.length) return wrap('failed', failed.map((j) => `${j.name}: ${j.note}`).join('; '));
  return wrap('done');
}

// ---------- Kirim GOWA (GOWA)

export function fillTemplate(text: string, vars: Record<string, string | number>): string {
  return String(text ?? '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => (k in vars ? String(vars[k]) : m));
}

const MAX_WA = 3800; // batas aman panjang satu pesan WhatsApp

export const GOWA_HANDLER = 'Devina'; // handler di server GOWA Ordo; sengaja tidak bisa diubah dari node

// Kontrak GOWA Ordo, sama dengan node HTTP Request di n8n:
// - /send/message: JSON { phone, type, handler, message }
// - /send/file dengan berkas: multipart { phone, type, handler, caption, file }
// - /send/file dengan tautan: JSON { phone, type, handler, message, file_url }
async function gowa(cfg: GowaConfig, path: '/send/message' | '/send/file', fields: Record<string, string>, file: { data: Buffer; name: string; mime: string } | null, doFetch: typeof fetch) {
  const all = { ...fields, handler: GOWA_HANDLER };
  let body: string | FormData = JSON.stringify(all);
  if (file) {
    body = new FormData();
    for (const [k, v] of Object.entries(all)) body.set(k, v);
    body.set('file', new Blob([file.data], { type: file.mime }), file.name);
  }
  const res = await doFetch(cfg.baseUrl + path, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64'),
      ...(cfg.deviceId ? { 'X-Device-Id': cfg.deviceId } : {}),
      ...(file ? {} : { 'Content-Type': 'application/json' }),
    },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GOWA membalas ${res.status}${res.status === 401 ? ' (user/password salah)' : ''}: ${text.slice(0, 200)}`);
  }
}

// Nomor perorangan dirapikan ke format 62…; nama atau id grup dikirim apa adanya.
export function gowaTarget(target: unknown, type: unknown): { phone: string; type: 'Group' | 'Individual' } {
  const raw = String(target ?? '').trim();
  const kind = type === 'Group' || type === 'Individual' ? type : raw.includes('@g.us') || /[a-z]/i.test(raw) ? 'Group' : 'Individual';
  if (kind === 'Group') return { phone: raw, type: kind };
  const digits = raw.replace(/\D/g, '');
  return { phone: digits.startsWith('0') ? '62' + digits.slice(1) : digits, type: kind };
}

export async function sendMessage(
  cfg: GowaConfig | null,
  node: GraphNode,
  input: { vars: Record<string, string | number>; reports: { label: string; content: string }[]; files: { path: string; name: string; mime: string }[] },
  doFetch: typeof fetch = fetch,
) {
  if (!cfg) throw new Error('GOWA belum diatur. Isi GOWA_BASE_URL, GOWA_USER, GOWA_PASSWORD (dan GOWA_DEVICE_ID) di .env lalu jalankan ulang server.');
  const c = node.config;
  const to = gowaTarget(c.target, c.targetType);
  const text = fillTemplate(c.text, input.vars).trim().slice(0, MAX_WA);
  const manualUrl = fillTemplate(c.fileUrl, input.vars).trim();
  const mode = c.mode === 'file' || c.mode === 'text' ? c.mode : input.files.length || manualUrl ? 'file' : 'text';
  let sent = 0;
  const post = async (path: '/send/message' | '/send/file', fields: Record<string, string>, file: Parameters<typeof gowa>[3] = null) => {
    if (sent && (cfg.gapMs ?? 1500) > 0) await new Promise((r) => setTimeout(r, cfg.gapMs ?? 1500));
    await gowa(cfg, path, { phone: to.phone, type: to.type, ...fields }, file, doFetch);
    sent++;
  };

  let fileCount = 0;
  if (mode === 'file') {
    // Teks menjadi keterangan file pertama; boleh kosong.
    if (manualUrl) {
      await post('/send/file', { message: text, file_url: manualUrl });
      fileCount = 1;
    } else {
      if (!input.files.length) throw new Error('Kirim GOWA mode file: tidak ada file. Sambungkan node Export atau isi tautan file.');
      for (const [i, f] of input.files.entries()) {
        await post('/send/file', { caption: i === 0 ? text : '' }, { data: await readFile(f.path), name: f.name, mime: f.mime });
      }
      fileCount = input.files.length;
    }
  } else if (text) {
    await post('/send/message', { message: text });
  }

  if (c.includeReports) {
    for (const r of input.reports) {
      const body = `*${r.label}*\n\n${r.content.trim()}`;
      for (let i = 0; i < body.length; i += MAX_WA) await post('/send/message', { message: body.slice(i, i + MAX_WA) });
    }
  }
  if (!sent) throw new Error('Kirim GOWA: tidak ada yang dikirim. Isi teks pesan atau centang "Sertakan isi tiap laporan".');
  return { summary: { kind: 'message', target: to.phone, target_type: to.type, mode, sent, files: fileCount } };
}

// ---------- HTTP Request

export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text ?? '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export async function sendHttp(node: GraphNode, payload: unknown, doFetch: typeof fetch = fetch) {
  const url = httpUrl(node.config);
  if(!url) throw new Error('Tujuan HTTP belum lengkap. Isi Workflow ID Autobot atau URL khusus.');
  const autobot = httpDestination(node.config) === 'autobot';
  if(autobot && !node.config.autobotApiKey) throw new Error('Kunci integrasi Autobot belum diisi.');
  const method = autobot ? 'POST' : ['POST', 'PUT', 'PATCH'].includes(node.config.method) ? node.config.method : 'POST';
  let res;
  try {
    res = await doFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...parseHeaders(node.config.headers), ...(autobot?{Authorization:`Bearer ${node.config.autobotApiKey}`}:{}) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new Error(`Tidak bisa menghubungi ${new URL(url).host}: ${err instanceof Error ? err.message : err}`);
  }
  const body = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${new URL(url).host} membalas ${res.status}: ${body.slice(0, 200)}`);
  let data: unknown = {response:body.slice(0,2000000),truncated:body.length>2000000};
  if(body.length<=2000000){try{data=body ? JSON.parse(body) : [];}catch{data={response:body};}}
  return { ...dataOutput((Array.isArray(data) ? data : [data]).map(value=>({json:value && typeof value==='object' && !Array.isArray(value) ? value : {value}})), 'Respons HTTP'), summary: { kind: 'http', host: new URL(url).host, status: res.status, response: body.slice(0, 300) } };
}
