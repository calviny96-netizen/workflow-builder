// Mesin eksekusi. Seluruh keadaan ada di Postgres, jadi server boleh mati-hidup di tengah run.
// Aturan yang dijaga:
// - POST /runs tidak pernah diulang otomatis; unit yang nasibnya tidak pasti dicari dulu lewat correlation_id.
// - Satu unit gagal → run "halted": tidak ada unit baru, yang sedang jalan dibiarkan selesai.
// - Jumlah AW yang berjalan bersamaan dibatasi global dan per run.

import { errorCode, evaluateRunStatus, unwrap } from '../../../packages/autoaudit/src/index.ts';
import type { AutoAuditClient } from '../../../packages/autoaudit/src/index.ts';
import { correlationId } from '../../../packages/engine/src/plan.ts';
import type { Db } from './db.ts';
import type { SheetsClient } from './google.ts';
import { runReadySteps } from './steps.ts';
import type { GowaConfig } from './steps-io.ts';

export interface ExecutorOptions {
  db: Db;
  api: AutoAuditClient;
  globalConcurrency: number;
  filesDir: string;
  sheets?: SheetsClient | null;
  gowa?: GowaConfig | null;
  fetch?: typeof fetch;
  syncCheckMs?: number;
  masterKey?: Buffer;
  tickMs?: number;
  pollMs?: number;
  unknownLimit?: number;
  recoverAfterMs?: number;
  log?: (msg: string) => void;
}

const ACTIVE = `('starting','running')`;

export function createExecutor(opts: ExecutorOptions) {
  const { db, api } = opts;
  const tickMs = opts.tickMs ?? 2000;
  const pollMs = opts.pollMs ?? 15_000;
  const unknownLimit = opts.unknownLimit ?? 15;
  const recoverAfterMs = opts.recoverAfterMs ?? 30_000;
  const emptyResultLimit = 4; // kali cek setelah status selesai sebelum jawaban kosong dianggap gagal
  const log = opts.log ?? (() => {});
  const inflight = new Set<string>(); // unit yang POST-nya sedang berjalan di proses ini
  let timer: NodeJS.Timeout | null = null;
  let busy = false;

  async function failUnit(id: string, message: string) {
    await db.query(`update units set status='failed', error=$2, finished_at=now() where id=$1 and status in ${ACTIVE}`, [id, message.slice(0, 1000)]);
  }

  async function claimNext(): Promise<any | null> {
    // Ambil satu unit antre dari run yang belum penuh, selama batas global belum tercapai.
    const r = await db.query(
      `update units set status='starting', started_at=now(), error=null
       where id = (
         select u.id from units u
         join runs r on r.id = u.run_id
         where u.status = 'queued' and r.status = 'running' and not r.halted
           and not exists (select 1 from steps s where s.run_id = u.run_id and s.type = 'sync' and s.status <> 'done')
           and (select count(*) from units a where a.status in ${ACTIVE}) < $1
           and (select count(*) from units a where a.run_id = u.run_id and a.status in ${ACTIVE}) < r.concurrency
         order by r.started_at, u.node_id, u.seq
         limit 1
         for update of u skip locked
       )
       returning *`,
      [opts.globalConcurrency],
    );
    return r.rows[0] ?? null;
  }

  async function startUnit(unit: any) {
    if (unit.payload.fetch) {
      // Hanya mengambil laporan yang sudah ada: tidak ada POST, langsung masuk tahap baca.
      await db.query(`update units set status='running', history_id=$2, unknown_count=0, next_poll_at=now() where id=$1`, [unit.id, unit.payload.history_id]);
      return;
    }
    inflight.add(unit.id);
    try {
      const corr = correlationId(String(unit.run_id).slice(0, 8), unit.node_id, unit.seq);
      // correlation_id disimpan SEBELUM POST supaya run bisa ditemukan lagi bila server mati di tengah jalan.
      await db.query('update units set correlation_id=$2 where id=$1', [unit.id, corr]);
      const res = await api.startRun({ ...unit.payload, correlation_id: corr });
      const code = errorCode(res.body);
      const data = unwrap<any>(res.body) ?? {};
      const historyId = Number(data.history_id || 0);
      if (code === 'empty_filter_result') {
        await db.query(`update units set status='skipped', error='Tidak ada pesan pada rentang ini', finished_at=now() where id=$1`, [unit.id]);
      } else if (!res.ok || !historyId) {
        await failUnit(unit.id, `Gagal memulai Audital Work (${res.status}${code ? ' ' + code : ''})`);
      } else {
        await db.query(
          `update units set status='running', history_id=$2, unknown_count=0, next_poll_at=now() + ($3 || ' milliseconds')::interval where id=$1`,
          [unit.id, historyId, String(Math.min(5000, pollMs))],
        );
      }
    } catch (err) {
      // Galat jaringan: tidak tahu apakah AutoAudit menerima permintaannya. Biarkan 'starting';
      // recoverStarting() akan mencarinya lewat correlation_id, bukan mengirim ulang.
      log(`unit ${unit.id}: galat saat memulai: ${err instanceof Error ? err.message : err}`);
    } finally {
      inflight.delete(unit.id);
    }
  }

  async function recoverStarting() {
    const r = await db.query(
      `select u.*, r.company_id from units u join runs r on r.id = u.run_id
       where u.status = 'starting' and u.started_at < now() - ($1 || ' milliseconds')::interval`,
      [String(recoverAfterMs)],
    );
    for (const unit of r.rows) {
      if (inflight.has(unit.id)) continue;
      let found = 0;
      if (unit.correlation_id) {
        try {
          const n = await api.listNotifications({ company_id: unit.company_id, group: 'audital_work', page: 1, limit: 100 });
          const hit = (n.body?.data ?? []).find((x: any) => x?.data?.correlation_id === unit.correlation_id);
          found = Number(hit?.data?.history_id || 0);
        } catch {
          continue; // coba lagi di tick berikutnya
        }
      }
      if (found) {
        await db.query(`update units set status='running', history_id=$2, next_poll_at=now() where id=$1 and status='starting'`, [unit.id, found]);
        log(`unit ${unit.id}: tersambung kembali ke history ${found}`);
      } else {
        await failUnit(unit.id, 'Status tidak pasti setelah gangguan saat memulai. Periksa AutoAudit sebelum melanjutkan.');
      }
    }
  }

  async function pollUnit(unit: any) {
    const rbs = unit.payload.run_by_superadmin === true;
    const next = () => db.query(`update units set next_poll_at = now() + ($2 || ' milliseconds')::interval where id=$1`, [unit.id, String(pollMs)]);

    const ageMin = (Date.now() - new Date(unit.started_at).getTime()) / 60_000;
    if (ageMin > unit.timeout_min) return failUnit(unit.id, `Kehabisan waktu setelah ${unit.timeout_min} menit`);

    let res;
    try {
      res = unit.payload.fetch ? await api.getHistory(unit.history_id, unit.company_id, rbs) : await api.getRunStatus(unit.history_id, unit.company_id, rbs);
    } catch {
      return next();
    }
    if (unit.payload.fetch) {
      // Unit "ambil": history lama dari chatbot sering berstatus idle walau laporannya ada, jadi yang
      // dilihat adalah isi laporannya, bukan statusnya.
      if (res.status === 404) {
        return failUnit(unit.id, `History ${unit.history_id} tidak ditemukan di sisi ${rbs ? 'Superadmin' : 'Company'}. Periksa pilihan Company/Superadmin di node.`);
      }
      const h = res.ok ? unwrap<any>(res.body) : null;
      const result = h?.result;
      if (result && String(result.content ?? '').trim()) {
        // Rentang tanggal yang diaudit dan judul history dipakai untuk menamai file export.
        const meta = { start_date: h.filter?.startDate ?? null, end_date: h.filter?.endDate ?? null, title: h.title ?? null, chat_type: h.filter?.chatType ?? null };
        await db.query(
          `update units set status='done', content=$2, token_usage=$3, model_used=$4, finish_reason=$5, meta=$6, finished_at=now() where id=$1 and status='running'`,
          [unit.id, String(result.content), Number(result.token_usage) || null, result.model_used ?? null, result.finish_reason ?? null, JSON.stringify(meta)],
        );
        return;
      }
      const count = unit.unknown_count + 1;
      if (res.ok && count >= emptyResultLimit) return failUnit(unit.id, `History ${unit.history_id} belum punya laporan (status ${h?.status ?? '-'}).`);
      await db.query('update units set unknown_count=$2 where id=$1', [unit.id, count]);
      return next();
    }
    const ev = evaluateRunStatus(res.ok ? unwrap(res.body) : {});

    if (ev.state === 'failed') return failUnit(unit.id, `Audital Work berstatus ${ev.status || 'error'}${ev.error && ev.error !== ev.status ? ': ' + ev.error : ''}`);
    if (ev.state === 'unknown') {
      const count = unit.unknown_count + 1;
      if (count >= unknownLimit) return failUnit(unit.id, `Status tidak terbaca ${count} kali berturut-turut untuk history ${unit.history_id}`);
      await db.query('update units set unknown_count=$2 where id=$1', [unit.id, count]);
      return next();
    }
    if (ev.state === 'running') {
      if (unit.unknown_count) await db.query('update units set unknown_count=0 where id=$1', [unit.id]);
      return next();
    }

    // Selesai: ambil laporan.
    let hist;
    try {
      hist = await api.getHistory(unit.history_id, unit.company_id, rbs);
    } catch {
      return next();
    }
    const result = unwrap<any>(hist.body)?.result;
    if (!hist.ok || !result || !String(result.content ?? '').trim()) {
      // Hasil kadang muncul sesaat setelah status selesai, jadi ditunggu beberapa kali. Tetapi AutoAudit juga
      // bisa menandai run selesai padahal jawaban AI kosong (terjadi di production, history 24701); itu gagal.
      const count = unit.unknown_count + 1;
      if (hist.ok && count >= emptyResultLimit) {
        return failUnit(unit.id, `AutoAudit menandai history ${unit.history_id} selesai, tetapi jawaban AI kosong. Lanjutkan run untuk mengulang bagian ini.`);
      }
      await db.query('update units set unknown_count=$2 where id=$1', [unit.id, count]);
      return next();
    }
    await db.query(
      `update units set status='done', content=$2, token_usage=$3, model_used=$4, finish_reason=$5, finished_at=now() where id=$1 and status='running'`,
      [unit.id, String(result.content ?? ''), Number(result.token_usage) || null, result.model_used ?? null, result.finish_reason ?? null],
    );
  }

  async function settleRuns() {
    // Ada yang gagal → hentikan pengambilan unit baru.
    await db.query(
      `update runs r set halted = true
       where r.status = 'running' and not r.halted and (
         exists (select 1 from units u where u.run_id = r.id and u.status = 'failed')
         or exists (select 1 from steps s where s.run_id = r.id and s.status = 'failed'))`,
    );
    // Sync yang masih berjalan di run yang dihentikan diparkir; keadaannya tersimpan dan dilanjutkan saat resume.
    await db.query(`update steps s set status='waiting' from runs r where r.id = s.run_id and r.status='running' and r.halted and s.type in ('sync','merge') and s.status='running'`);
    // Run yang dihentikan dan sudah tidak punya unit aktif → gagal.
    await db.query(
      `update runs r set status = 'failed', finished_at = now(),
         error = case when exists (select 1 from units u where u.run_id = r.id and u.status = 'failed')
           then (select count(*) || ' Audital Work gagal' from units u where u.run_id = r.id and u.status = 'failed')
           else (select 'Langkah gagal: ' || string_agg(s.error, '; ') from steps s where s.run_id = r.id and s.status = 'failed') end
       where r.status = 'running' and r.halted
         and not exists (select 1 from units u where u.run_id = r.id and u.status in ${ACTIVE})
         and not exists (select 1 from steps s where s.run_id = r.id and s.status = 'running')`,
    );
    // Semua unit selesai atau dilewati → selesai.
    await db.query(
      `update runs r set status = 'completed', finished_at = now(), error = null
       where r.status = 'running' and not r.halted
         and not exists (select 1 from units u where u.run_id = r.id and u.status not in ('done','skipped'))
         and not exists (select 1 from steps s where s.run_id = r.id and s.status <> 'done')`,
    );
  }

  let recoveredSteps = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (!recoveredSteps) {
        // Langkah lokal yang tertinggal 'running' berarti server mati di tengahnya; aman diulang.
        await db.query(`update steps set status='waiting' where status='running'`);
        recoveredSteps = true;
      }
      await recoverStarting();

      const starts: Promise<void>[] = [];
      for (;;) {
        const unit = await claimNext();
        if (!unit) break;
        starts.push(startUnit(unit));
      }

      const due = await db.query(
        `select u.*, r.company_id from units u join runs r on r.id = u.run_id
         where u.status = 'running' and (u.next_poll_at is null or u.next_poll_at <= now())
         order by u.next_poll_at nulls first limit 50`,
      );
      await Promise.all([...starts, ...due.rows.map((u) => pollUnit(u).catch((e) => log(`poll ${u.id}: ${e?.message ?? e}`)))]);
      await runReadySteps({ db, api, filesDir: opts.filesDir, sheets: opts.sheets ?? null, gowa: opts.gowa ?? null, fetch: opts.fetch, syncCheckMs: opts.syncCheckMs, masterKey: opts.masterKey }, log);
      await settleRuns();
    } catch (err) {
      log(`tick: ${err instanceof Error ? err.message : err}`);
    } finally {
      busy = false;
    }
  }

  async function cancelRun(runId: string) {
    const r = await db.query(`update runs set status='cancelled', finished_at=now() where id=$1 and status in ('planning','awaiting_chunk','awaiting_approval','running','failed') returning company_id`, [runId]);
    if (!r.rows[0]) return false;
    await db.query(`update units set status='cancelled', finished_at=now() where run_id=$1 and status='queued'`, [runId]);
    await db.query(`update steps set status='cancelled', finished_at=now() where run_id=$1 and status='waiting'`, [runId]);
    const active = await db.query(`select * from units where run_id=$1 and status in ${ACTIVE}`, [runId]);
    for (const u of active.rows) {
      if (u.history_id) {
        try {
          await api.cancelRun(u.history_id, r.rows[0].company_id, u.payload.run_by_superadmin === true);
        } catch {
          // pembatalan di AutoAudit bersifat usaha terbaik
        }
      }
      await db.query(`update units set status='cancelled', finished_at=now() where id=$1`, [u.id]);
    }
    return true;
  }

  return {
    tick,
    cancelRun,
    start() {
      if (!timer) timer = setInterval(tick, tickMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type Executor = ReturnType<typeof createExecutor>;
