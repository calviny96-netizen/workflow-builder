// Merge Report: menggabungkan laporan dengan AI lewat POST /merge-reports/ai-runs.
// Tiap merge berjalan beberapa menit, jadi keadaannya disimpan di steps.output dan dimajukan tiap putaran mesin
// (sama seperti Sync Sales). Lebih dari 10 sumber digabung bertingkat.
//
// Catatan kontrak (openapi 2 Okt 2026): tiap POST membuat run baru dan memakai kredit company; server AutoAudit
// tidak mengulang otomatis. Karena itu POST di sini juga tidak pernah diulang diam-diam.

import { errorCode, unwrap } from '../../../packages/autoaudit/src/index.ts';
import type { AutoAuditClient } from '../../../packages/autoaudit/src/index.ts';
import { planMergeTiers } from '../../../packages/engine/src/plan.ts';
import type { GraphNode } from '../../../packages/nodes/src/index.ts';

export interface MergeSource {
  history_id: number;
  label: string;
}

interface MergeGroup {
  sources: number[];
  status: 'pending' | 'running' | 'done' | 'failed';
  history_id?: number;
  report_id?: number;
  error?: string;
}

export interface MergeState {
  level: number;
  levels: number;
  groups: MergeGroup[];
  next_check: number;
  report?: { label: string; content: string; history_id: number | null; report_id: number | null };
  summary?: unknown;
}

const MAX_SOURCES = 10;
const isJson = (body: unknown) => body !== null && typeof body === 'object';

function split(ids: number[]): MergeGroup[] {
  const sizes = planMergeTiers(ids.length, MAX_SOURCES)[0] ?? [];
  let i = 0;
  return sizes.map((n) => ({ sources: ids.slice(i, (i += n)), status: 'pending' as const }));
}

export async function advanceMerge(
  api: AutoAuditClient,
  run: { company_id: number; workflow_name: string; params: { start_date: string; end_date: string } },
  node: GraphNode,
  previous: MergeState | null,
  sources: MergeSource[],
  now = Date.now(),
  checkEveryMs = 15_000,
): Promise<{ output: MergeState; status: 'running' | 'done' | 'failed'; error?: string }> {
  const c = node.config;
  const title = String(c.title || '').trim() || `Merge ${run.workflow_name} ${run.params.start_date} sd ${run.params.end_date}`;

  let st: MergeState = previous?.groups ? previous : { level: 1, levels: Math.max(1, planMergeTiers(sources.length, MAX_SOURCES).length), groups: split(sources.map((s) => s.history_id)), next_check: 0 };
  const finish = (status: 'running' | 'done' | 'failed', error?: string) => {
    st.summary = {
      kind: 'merge',
      title,
      sources: sources.length,
      level: st.level,
      levels: st.levels,
      groups: st.groups.map((g) => ({ sources: g.sources.length, status: g.status, history_id: g.history_id ?? null, error: g.error ?? null })),
      report_id: st.report?.report_id ?? null,
      note: sources.length === 1 ? 'Hanya satu laporan yang masuk, jadi diteruskan apa adanya tanpa merge.' : null,
    };
    return { output: st, status, error };
  };

  if (sources.length === 0) return finish('failed', 'Tidak ada laporan yang selesai untuk digabung.');
  if (sources.length === 1) {
    // Merge butuh minimal 2 sumber. Satu laporan diteruskan apa adanya.
    const h = await api.getHistory(sources[0].history_id, run.company_id, false).then((r) => (r.ok ? r : api.getHistory(sources[0].history_id, run.company_id, true)));
    st = { ...st, groups: [], report: { label: title, content: String(h.body?.data?.result?.content ?? ''), history_id: sources[0].history_id, report_id: null } };
    return finish('done');
  }

  // Model selalu dikirim. Terverifikasi 2 Okt 2026: tanpa field model, server membalas 500 "Failed to start
  // report merge" walau dokumentasinya menyebut model opsional. Bila node tidak memilih, dipakai model bawaan company.
  let model = String(c.model || '').trim();
  if (!model && st.groups.some((g) => g.status === 'pending')) {
    model = String(unwrap<any>((await api.listModels(run.company_id)).body)?.summary?.default_model ?? '');
  }

  // Mulai merge yang belum dimulai di tingkat ini.
  for (const [i, g] of st.groups.entries()) {
    if (g.status !== 'pending') continue;
    const last = st.level === st.levels && st.groups.length === 1;
    const body = {
      company_id: run.company_id,
      title: last ? title : `${title} (tingkat ${st.level}, bagian ${i + 1} dari ${st.groups.length})`,
      prompt: String(c.prompt),
      ...(model ? { model } : {}),
      source_history_ids: g.sources,
      base_history_id: g.sources[0],
    };
    let res;
    try {
      res = await api.startMergeRun(body);
    } catch (err) {
      Object.assign(g, { status: 'failed', error: `Tidak ada balasan saat memulai merge (${err instanceof Error ? err.message : err}). Periksa AutoAudit sebelum melanjutkan, karena merge mungkin sudah berjalan.` });
      continue;
    }
    const hid = Number(res.body?.data?.history_id || 0);
    if (res.ok && hid) Object.assign(g, { status: 'running', history_id: hid, error: undefined });
    else if (!isJson(res.body)) Object.assign(g, { status: 'failed', error: 'Endpoint merge AI (/merge-reports/ai-runs) belum tersedia di server AutoAudit ini.' });
    else if (res.status === 402) Object.assign(g, { status: 'failed', error: 'Saldo kredit company di AutoAudit habis. Isi ulang saldo, lalu Lanjutkan.' });
    else Object.assign(g, { status: 'failed', error: `Merge ditolak (${res.status}${errorCode(res.body) ? ' ' + errorCode(res.body) : ''}): ${res.body?.error?.message ?? ''}`.trim() });
  }

  // Periksa yang sedang berjalan.
  if (st.groups.some((g) => g.status === 'running') && now >= st.next_check) {
    st.next_check = now + checkEveryMs;
    for (const g of st.groups.filter((x) => x.status === 'running')) {
      let res;
      try {
        res = await api.getMergeRun(g.history_id!, run.company_id);
      } catch {
        continue; // coba lagi di putaran berikutnya
      }
      const d = res.body?.data ?? {};
      if (d.status === 'completed') Object.assign(g, { status: 'done', report_id: Number(d.report_id) || undefined });
      else if (d.status === 'failed') Object.assign(g, { status: 'failed', error: `Merge gagal: ${typeof d.error === 'string' ? d.error : (d.error?.message ?? 'tanpa keterangan')}` });
    }
  }

  const failed = st.groups.filter((g) => g.status === 'failed');
  if (failed.length && !st.groups.some((g) => g.status === 'running')) return finish('failed', failed.map((g) => g.error).join('; '));
  if (st.groups.some((g) => g.status !== 'done')) return finish('running');

  // Tingkat ini selesai. Lebih dari satu hasil → gabungkan lagi di tingkat berikutnya.
  if (st.groups.length > 1) {
    st = { ...st, level: st.level + 1, groups: split(st.groups.map((g) => g.history_id!)), next_check: 0 };
    return finish('running');
  }

  // Hasil akhir tersimpan sebagai custom report; ambil isinya supaya bisa diteruskan ke node berikutnya.
  const final = st.groups[0];
  const rep = final.report_id ? await api.getCustomReport(final.report_id, run.company_id) : null;
  const content = String(rep?.body?.data?.content_markdown ?? rep?.body?.data?.text ?? '');
  if (!content.trim()) return finish('failed', 'Merge selesai, tetapi laporan gabungannya kosong atau tidak bisa dibaca.');
  st.report = { label: title, content, history_id: final.history_id ?? null, report_id: final.report_id ?? null };
  return finish('done');
}
