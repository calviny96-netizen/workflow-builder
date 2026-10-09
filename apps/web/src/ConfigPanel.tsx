import { GoogleCredentials } from './GoogleCredentials.tsx';
import { CodeConfig } from './CodeConfig.tsx';
import { AnalysisCalendar } from './AnalysisCalendar.tsx';
import { useEffect, useState } from 'react';
import { DEFAULT_FILE_PATTERN, httpDestination, httpUrl, EXPORT_FORMATS, fileNameFrom, NODE_SPECS, parsePhones, salesSourceKey } from '@nodes';
import type { NodeType, SalesChannel, SalesSource } from '@nodes';
import { api } from './api.ts';
import { NODE_HELP } from './help.ts';
import { NodeIcon } from './HelpDrawer.tsx';
import { Select } from './Select.tsx';

interface OrModel {
  id: string;
  name: string;
  context_length: number;
}

// Daftar model OpenRouter diambil sekali lalu dipakai bersama semua panel.
let orModels: Promise<OrModel[]> | null = null;
function useOpenRouterModels() {
  const [models, setModels] = useState<OrModel[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    orModels ??= api('GET', '/api/openrouter/models').then((r) => r.items as OrModel[]);
    orModels.then(setModels).catch((e) => {
      orModels = null;
      setError(e.message);
    });
  }, []);
  return { models, error };
}

const ctx = (n: number) => (!n ? '' : n >= 1_000_000 ? `konteks ${(n / 1_000_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} jt token` : `konteks ${Math.round(n / 1000)} rb token`);


const OPTION_LABEL: Record<string, string> = {
  both: 'Private + grup',
  individual: 'Hanya chat private',
  group: 'Hanya chat grup',
  all_day: 'Sepanjang hari',
  daily_window: 'Jendela jam harian',
  none: 'Hanya rentang tanggal terpilih',
  before_start: 'Sertakan pesan sebelum tanggal mulai',
  after_end: 'Sertakan pesan setelah tanggal selesai',
};

export interface Catalog {
  prompts: { id: number; title: string }[];
  memories: { id: number; title: string; token_count: number | null; type: string }[];
  models: { name: string; context_length: number; superadmin_only: boolean }[];
  default_model: string | null;
  filter_options: Record<string, { value: string; label: string }[]>;
}

interface Props {
  workflowId: string;
  type: NodeType;
  config: Record<string, any>;
  companyId: number | null;
  catalog: Catalog | null;
  onChange: (patch: Record<string, any>) => void;
  onDelete: () => void;
  onHelp: () => void;
}

function SalesPicker({ companyId, selected, sourceType, onSourceType, onChange }: { companyId: number; selected: SalesSource[]; sourceType: SalesChannel; onSourceType: (type: SalesChannel) => void; onChange: (v: SalesSource[]) => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setItems([]);
    setTotal(0);
    setError('');
    setLoading(true);
    const t = setTimeout(() => {
      api('GET', `/api/aa/${sourceType === 'whatsapp_official' ? 'official-accounts' : 'sales'}?company_id=${companyId}&q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (!live) return;
          setItems(r.items.map((s: any) => ({ ...s, channel: sourceType })));
          setTotal(r.pagination?.total ?? r.items.length);
          setError('');
        })
        .catch((e) => live && setError(e.message))
        .finally(() => live && setLoading(false));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [companyId, q, sourceType]);

  const ids = new Set(selected.map(salesSourceKey));
  const toggle = (s: SalesSource) => onChange(ids.has(salesSourceKey(s)) ? selected.filter((x) => salesSourceKey(x) !== salesSourceKey(s)) : [...selected, { id: s.id, name: s.name, channel: s.channel }]);

  return (
    <>
      <label>Jenis sumber
        <Select value={sourceType} onChange={(e) => { setQ(''); onSourceType(e.target.value as SalesChannel); }}>
          <option value="whatsapp">Sales ID</option>
          <option value="whatsapp_official">WhatsApp Official</option>
        </Select>
      </label>
      <p className="muted small">Pilihan dari kedua jenis sumber dapat digabung dalam satu node. Setiap sumber memakai ID dan datasetnya sendiri.</p>
      {sourceType === 'whatsapp_official' && <div className="notice">Official membaca pesan teks private pada rentang tanggal terpilih. Pada Proses AW, gunakan Hanya chat private dan Hanya rentang tanggal terpilih.</div>}
      {selected.length > 0 && (
        <div className="chips">
          {selected.map((s) => (
            <button key={salesSourceKey(s)} className="chip" onClick={() => toggle(s)} title="Klik untuk melepas">
              {s.name} · {s.channel === 'whatsapp_official' ? 'Official' : 'Sales'} #{s.id} ×
            </button>
          ))}
        </div>
      )}
      <input placeholder={sourceType === 'whatsapp_official' ? 'Cari nama, ID, atau nomor akun Official…' : 'Cari nama atau nomor sales…'} value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <div className="error">{error}</div>}
      <div className="pick-list">
        {items.map((s) => (
          <label key={salesSourceKey(s)} className="pick-row">
            <input type="checkbox" checked={ids.has(salesSourceKey(s))} onChange={() => toggle(s)} />
            <span className="pick-main">
              {s.name}
              <span className="muted small">
                #{s.id} · {s.phone_number ? `${s.phone_number} · ` : ''}{s.division ? `${s.division} · ` : ''}
                {s.status}
              </span>
            </span>
          </label>
        ))}
        {loading && <div className="muted small">Memuat sumber…</div>}
        {items.length === 0 && !error && !loading && <div className="muted small">{sourceType === 'whatsapp_official' ? 'Tidak ada akun WhatsApp Official yang cocok pada company ini.' : 'Tidak ada sales yang cocok.'}</div>}
      </div>
      {total > items.length && <div className="muted small">Menampilkan {items.length} dari {total}. Persempit dengan pencarian.</div>}
      <div className="row">
        <button className="btn small" disabled={loading} onClick={() => onChange([...selected, ...items.filter((s) => !ids.has(salesSourceKey(s))).map((s) => ({ id: s.id, name: s.name, channel: s.channel }))])}>
          Pilih semua yang tampil
        </button>
        <button className="btn small" onClick={() => onChange([])}>
          Kosongkan
        </button>
      </div>
    </>
  );
}

const histId = (text: string) => [...text.matchAll(/historyId=(\d+)|(?:^|[\s,;])#?(\d{3,})(?=$|[\s,;])/gm)].map((m) => Number(m[1] ?? m[2]));

function HistoryPicker({ companyId, items, onChange }: { companyId: number; items: any[]; onChange: (v: any[]) => void }) {
  const [superadmin, setSuperadmin] = useState(false);
  const [q, setQ] = useState('');
  const [list, setList] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [paste, setPaste] = useState('');

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api('GET', `/api/aa/histories?company_id=${companyId}&superadmin=${superadmin}&q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (!live) return;
          setList(r.items);
          setTotal(r.pagination?.total ?? r.items.length);
          setError('');
        })
        .catch((e) => live && setError(e.message));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [companyId, superadmin, q]);

  const has = (id: number) => items.some((x) => x.id === id);
  const toggle = (h: any) => onChange(has(h.id) ? items.filter((x) => x.id !== h.id) : [...items, { id: h.id, title: h.title, sales: h.sales_name ?? '', runBySuperadmin: superadmin }]);
  const pasted = histId(paste).filter((id) => !has(id));

  return (
    <>
      {items.length > 0 && (
        <div className="chips">
          {items.map((h) => (
            <button key={h.id} className="chip" title={`${h.title}\nKlik untuk melepas`} onClick={() => onChange(items.filter((x) => x.id !== h.id))}>
              #{h.id} {h.runBySuperadmin ? '· SA' : ''} ×
            </button>
          ))}
        </div>
      )}
      <div className="segmented">
        <button className={!superadmin ? 'on' : ''} onClick={() => setSuperadmin(false)}>
          Sisi Company
        </button>
        <button className={superadmin ? 'on' : ''} onClick={() => setSuperadmin(true)}>
          Sisi Superadmin
        </button>
      </div>
      <input placeholder="Cari judul history…" value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <div className="error">{error}</div>}
      <div className="pick-list">
        {list.map((h) => (
          <label key={h.id} className="pick-row">
            <input type="checkbox" checked={has(h.id)} onChange={() => toggle(h)} />
            <span className="pick-main">
              {h.title || `History ${h.id}`}
              <span className="muted small">
                #{h.id}
                {h.sales_name ? ` · ${h.sales_name}` : ''} · {new Date(h.created_at).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' })}
              </span>
            </span>
          </label>
        ))}
        {list.length === 0 && !error && <div className="muted small">Tidak ada history yang cocok di sisi ini.</div>}
      </div>
      {total > list.length && <div className="muted small">Menampilkan {list.length} terbaru dari {total}. Persempit dengan pencarian.</div>}
      <label>
        Atau tempel id / tautan history
        <textarea rows={2} value={paste} placeholder={'24698, 24699\nhttps://…/dashboard/chatbot?historyId=24701'} onChange={(e) => setPaste(e.target.value)} />
      </label>
      {pasted.length > 0 && (
        <button
          className="btn small"
          onClick={() => {
            onChange([...items, ...pasted.map((id) => ({ id, title: `History ${id}`, runBySuperadmin: superadmin }))]);
            setPaste('');
          }}
        >
          Tambahkan {pasted.length} history ({superadmin ? 'sisi Superadmin' : 'sisi Company'})
        </button>
      )}
    </>
  );
}

function SchedulePicker({ companyId, config, onChange }: { companyId: number; config: Record<string, any>; onChange: (patch: Record<string, any>) => void }) {
  const [list, setList] = useState<any[] | null>(null);
  const [runs, setRuns] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api('GET', `/api/aa/schedules?company_id=${companyId}`)
      .then((r) => setList(r.items))
      .catch((e) => setError(e.message));
  }, [companyId]);
  useEffect(() => {
    setRuns(null);
    if (config.scheduleId) api('GET', `/api/aa/schedules/${config.scheduleId}/runs?company_id=${companyId}`).then((r) => setRuns(r.items)).catch(() => {});
  }, [config.scheduleId, companyId]);

  return (
    <>
      {error && <div className="error">{error}</div>}
      <label>
        Jadwal Continuous Audit
        <Select
          value={config.scheduleId ?? ''}
          onChange={(e) => {
            const id = Number(e.target.value) || null;
            onChange({ scheduleId: id, scheduleLabel: list?.find((s) => s.id === id)?.label ?? '' });
          }}
        >
          <option value="">{list ? '— pilih —' : 'Memuat…'}</option>
          {list?.map((s) => (
            <option key={s.id} value={s.id}>
              #{s.id} · {s.label} ({s.sales_count} sales{s.is_active ? '' : ', nonaktif'})
            </option>
          ))}
        </Select>
      </label>
      {list && list.length === 0 && <div className="notice">Company ini belum punya jadwal Continuous Audit.</div>}
      <label>
        Run yang diambil
        <Select value={config.pick} onChange={(e) => onChange({ pick: e.target.value })}>
          <option value="latest">Run terakhir yang selesai</option>
          <option value="range">Semua run pada rentang tanggal Run</option>
        </Select>
      </label>
      {runs && (
        <div className="unit-list">
          {runs.length === 0 && <div className="muted small" style={{ padding: 8 }}>Jadwal ini belum pernah berjalan.</div>}
          {runs.map((r) => (
            <div className="unit-row" key={r.id} style={{ cursor: 'default' }}>
              <span className={`dot st-${r.status === 'success' ? 'done' : r.status === 'failed' ? 'failed' : 'running'}`} />
              <span className="unit-row-label">{new Date(r.run_at).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              <span className="muted small">
                {r.sales?.success ?? 0}/{r.sales?.total ?? 0} sales
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="muted small">Hanya mengambil laporan yang sudah ada. Jadwalnya tidak dijalankan dan tidak ada token AI yang terpakai.</p>
    </>
  );
}

// Kontak mana yang dianalisis: semua, hanya nomor tertentu, atau semua kecuali nomor tertentu.
function ContactFilter({ config, onChange }: { config: Record<string, any>; onChange: (patch: Record<string, any>) => void }) {
  const mode: string = config.contactMode ?? 'all';
  const parsed = parsePhones(config.contactNumbers ?? '');
  const n = parsed.numbers.length;
  return (
    <div className="contact-filter">
      <div className="choice-title">Kontak yang dianalisis</div>
      <div className="segmented">
        {(
          [
            ['all', 'Semua kontak'],
            ['only', 'Hanya nomor ini'],
            ['exclude', 'Kecualikan nomor ini'],
          ] as const
        ).map(([value, label]) => (
          <button key={value} className={mode === value ? 'on' : ''} onClick={() => onChange({ contactMode: value })}>
            {label}
          </button>
        ))}
      </div>
      {mode === 'all' ? (
        <p className="muted small">Semua kontak pada rentang tanggal ikut dianalisis.</p>
      ) : (
        <>
          <textarea
            rows={5}
            value={config.contactNumbers ?? ''}
            placeholder={'Tempel nomor, satu per baris:\n081234567890\n081298765432'}
            onChange={(e) => onChange({ contactNumbers: e.target.value })}
          />
          <div className={`contact-result ${mode}`}>
            {n === 0 ? (
              <span>Belum ada nomor yang dikenali.</span>
            ) : mode === 'only' ? (
              <span>
                <b>Hanya {n} nomor ini</b> yang dianalisis. Kontak lain diabaikan.
              </span>
            ) : (
              <span>
                <b>{n} nomor ini dilewati.</b> Semua kontak lain dianalisis.
              </span>
            )}
          </div>
          {n > 0 && (
            <div className="chips">
              {parsed.numbers.slice(0, 8).map((p) => (
                <span key={p} className="num-chip">
                  {p}
                </span>
              ))}
              {n > 8 && <span className="muted small">+{n - 8} lainnya</span>}
            </div>
          )}
          {parsed.invalid.length > 0 && (
            <div className="notice">
              {parsed.invalid.length} baris bukan nomor dan diabaikan: {parsed.invalid.slice(0, 3).join(', ')}
              {parsed.invalid.length > 3 ? '…' : ''}
            </div>
          )}
          <p className="muted small">
            Boleh format 08…, +62…, atau 62…, dengan spasi atau tanda hubung; semuanya diubah ke 62…{parsed.duplicates ? ` ${parsed.duplicates} nomor kembar dihitung sekali.` : ''}
          </p>
        </>
      )}
    </div>
  );
}

// Merge AI lewat OpenRouter. Key diketik di kolom lokal dan baru dikirim saat "Simpan key" ditekan,
// supaya simpan-otomatis tidak mengirim key yang baru setengah diketik.
function AiMergeConfig({ config, onChange }: { config: Record<string, any>; onChange: (patch: Record<string, any>) => void }) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(!config.apiKeyHint);
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { models, error } = useOpenRouterModels();
  useEffect(() => {
    if (config.apiKeyHint) setEditing(false);
  }, [config.apiKeyHint]);

  async function test() {
    setBusy(true);
    setCheck(null);
    try {
      setCheck(await api('POST', '/api/openrouter/check', { key: draft.trim() }));
    } catch (e: any) {
      setCheck({ ok: false, message: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="contact-filter">
        <div className="choice-title">API key OpenRouter</div>
        {!editing ? (
          <div className="picked">
            <span>
              Tersimpan <code>••••{config.apiKeyHint}</code>
            </span>
            <button className="link-btn" onClick={() => setEditing(true)}>
              Ganti
            </button>
          </div>
        ) : (
          <>
            <input type="password" autoComplete="off" value={draft} placeholder="sk-or-…" onChange={(e) => { setDraft(e.target.value); setCheck(null); }} />
            <div className="row">
              <button className="btn small" disabled={busy || draft.trim().length < 8} onClick={test}>
                {busy ? 'Memeriksa…' : 'Tes key'}
              </button>
              <button
                className="btn small primary"
                disabled={draft.trim().length < 8}
                onClick={() => {
                  onChange({ apiKey: draft.trim() });
                  setDraft('');
                  setCheck(null);
                }}
              >
                Simpan key
              </button>
              {config.apiKeyHint && (
                <button className="btn small" onClick={() => { setEditing(false); setDraft(''); }}>
                  Batal
                </button>
              )}
            </div>
            {check && <div className={check.ok ? 'ready' : 'error'}>{check.message}</div>}
            {config.apiKey && <div className="muted small">Menyimpan key…</div>}
          </>
        )}
        <p className="muted small">Key disimpan terenkripsi di server dan tidak pernah ditampilkan lagi. Biaya merge ditagih ke akun OpenRouter pemilik key ini.</p>
      </div>

      <label>
        Model
        <Select value={config.model ?? ''} placeholder={models ? 'Pilih model OpenRouter…' : 'Memuat daftar model…'} onChange={(e) => onChange({ model: e.target.value })}>
          {config.model && models && !models.some((m) => m.id === config.model) && <option value={config.model}>{config.model}</option>}
          {models?.map((m) => (
            <option key={m.id} value={m.id} data-hint={[m.id, ctx(m.context_length)].filter(Boolean).join(' · ')}>
              {m.name}
            </option>
          ))}
        </Select>
      </label>
      {error && <div className="error">{error}</div>}

      <label>
        Judul laporan gabungan
        <input value={config.title ?? ''} placeholder="kosong = Merge + nama workflow + tanggal" onChange={(e) => onChange({ title: e.target.value })} />
      </label>
      <label>
        Instruksi merge
        <textarea rows={6} value={config.prompt ?? ''} onChange={(e) => onChange({ prompt: e.target.value })} />
      </label>
      <p className="muted small">Bila laporan terlalu banyak untuk sekali kirim, penggabungan dilakukan bertingkat otomatis mengikuti kapasitas model.</p>
    </>
  );
}

// Model untuk Merge AutoAudit: daftar OpenRouter, dengan model yang aktif di company ditaruh paling atas.
function MergeModelSelect({ value, catalog, onChange }: { value: string; catalog: Props['catalog']; onChange: (v: string) => void }) {
  const { models, error } = useOpenRouterModels();
  const active = new Set((catalog?.models ?? []).map((m) => m.name));
  const byId = new Map((models ?? []).map((m) => [m.id, m]));
  const rest = (models ?? []).filter((m) => !active.has(m.id));
  return (
    <>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="" data-hint={catalog?.default_model ?? undefined}>
          Model bawaan company
        </option>
        {value && !active.has(value) && !byId.has(value) && <option value={value}>{value}</option>}
        {[...active].map((id) => (
          <option key={id} value={id} data-hint={['aktif di company', id, ctx(byId.get(id)?.context_length ?? 0)].filter(Boolean).join(' · ')}>
            {byId.get(id)?.name ?? id}
          </option>
        ))}
        {rest.map((m) => (
          <option key={m.id} value={m.id} data-hint={[m.id, ctx(m.context_length)].filter(Boolean).join(' · ')}>
            {m.name}
          </option>
        ))}
      </Select>
      {error && <span className="muted small">Daftar OpenRouter tidak termuat ({error}); hanya model company yang tampil.</span>}
      {value && models && !active.has(value) && <span className="notice">Model ini belum aktif di company ini, jadi AutoAudit bisa menolaknya saat run. Aktifkan dulu di AutoAudit atau pilih yang bertanda "aktif di company".</span>}
    </>
  );
}

// Kirim GOWA lewat GOWA: dua bentuk kiriman (teks saja, atau file dengan keterangan opsional).
function MessageConfig({ config, onChange }: { config: Record<string, any>; onChange: (patch: Record<string, any>) => void }) {
  const mode = config.mode === 'file' ? 'file' : 'text';
  const type = config.targetType === 'Individual' ? 'Individual' : 'Group';
  return (
    <>
      <label>
        Bentuk kiriman
        <div className="segmented">
          <button className={mode === 'text' ? 'on' : ''} onClick={() => onChange({ mode: 'text' })}>
            Teks saja
          </button>
          <button className={mode === 'file' ? 'on' : ''} onClick={() => onChange({ mode: 'file' })}>
            File + keterangan
          </button>
        </div>
      </label>
      <label>
        Dikirim ke
        <div className="segmented">
          <button className={type === 'Group' ? 'on' : ''} onClick={() => onChange({ targetType: 'Group' })}>
            Grup
          </button>
          <button className={type === 'Individual' ? 'on' : ''} onClick={() => onChange({ targetType: 'Individual' })}>
            Nomor perorangan
          </button>
        </div>
      </label>
      <label>
        {type === 'Group' ? 'Nama atau ID grup' : 'Nomor WhatsApp'}
        <input
          value={config.target ?? ''}
          placeholder={type === 'Group' ? 'mis. Tim Operasional, atau 1203…@g.us' : '08xxxxxxxxxx atau 628xxxxxxxxxx'}
          onChange={(e) => onChange({ target: e.target.value })}
        />
      </label>
      {type === 'Group' && <p className="muted small">Nama grup harus persis sama dengan nama grup di WhatsApp.</p>}
      <label>
        {mode === 'file' ? 'Keterangan file (opsional)' : 'Teks pesan'}
        <textarea rows={5} value={config.text ?? ''} onChange={(e) => onChange({ text: e.target.value })} />
      </label>
      <p className="muted small">
        Bisa memakai {'{{workflow}}'}, {'{{company}}'}, {'{{periode}}'}, {'{{jumlah_aw}}'}, {'{{jumlah_baris}}'}.
      </p>
      {mode === 'file' && (
        <>
          <label>
            Tautan file (opsional)
            <input value={config.fileUrl ?? ''} placeholder="kosong = kirim file dari node Export yang disambungkan" onChange={(e) => onChange({ fileUrl: e.target.value })} />
          </label>
        </>
      )}
      <label className="inline">
        <input type="checkbox" checked={!!config.includeReports} onChange={(e) => onChange({ includeReports: e.target.checked })} />
        Sertakan isi tiap laporan sebagai pesan
      </label>
      <p className="muted small">Handler GOWA: Devina (tetap).</p>
      <IntegrationNote kind="gowa" />
    </>
  );
}

function IntegrationNote({ kind }: { kind: 'gowa' | 'merge' }) {
  const [info, setInfo] = useState<any>(null);
  useEffect(() => {
    api('GET', '/api/integrations').then(setInfo).catch(() => {});
  }, []);
  if (!info) return null;
  if (kind === 'merge') {
    return info.merge ? (
      <div className="ready">✓ Endpoint merge AI aktif di server AutoAudit.</div>
    ) : (
      <div className="notice">
        Endpoint merge AI (<code>/merge-reports/ai-runs</code>) belum aktif di server AutoAudit ini. Node bisa dirakit, tetapi run akan berhenti di langkah ini sampai endpoint dipasang.
      </div>
    );
  }
  return info[kind] ? (
    <div className="ready">✓ GOWA sudah diatur di server.</div>
  ) : (
    <div className="notice">GOWA belum diatur. Isi GOWA_BASE_URL, GOWA_USER, GOWA_PASSWORD, dan GOWA_DEVICE_ID di .env lalu jalankan ulang server.</div>
  );
}

function SheetsConfig({ config, onChange }: { config: Record<string, any>; onChange: (patch: Record<string, any>) => void }) {
  const [meta, setMeta] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(url: string, keepGid: boolean, selectedGid = config.gid) {
    if (!/\/spreadsheets\/d\//.test(url)) return;
    setBusy(true);
    setError('');
    try {
      const lookup = keepGid && selectedGid != null ? `${url.split('#')[0].split('?')[0]}#gid=${selectedGid}` : url;
      const m = await api('GET', `/api/google/tabs?url=${encodeURIComponent(lookup)}`);
      setMeta(m);
      const gid = keepGid && m.tabs.some((t: any) => t.gid === selectedGid) ? selectedGid : (m.gid ?? m.tabs[0]?.gid ?? null);
      onChange({ gid, tabTitle: m.tabs.find((t: any) => t.gid === gid)?.title ?? '' });
    } catch (e: any) {
      setMeta(null);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (config.url) load(config.url, true);
  }, []);

  const header: string[] | null = meta?.tabs.find((t: any) => t.gid === config.gid)?.header ?? null;
  return (
    <>
      <GoogleCredentials onConfigured={() => { if (config.url) void load(config.url, true); }} />
      <label>
        Tautan spreadsheet
        <input value={config.url ?? ''} placeholder="https://docs.google.com/spreadsheets/d/…" onChange={(e) => onChange({ url: e.target.value })} onBlur={(e) => load(e.target.value, false)} />
      </label>
      <button className="btn small" disabled={busy || !config.url} onClick={() => load(config.url, true)}>
        {busy ? 'Memuat…' : 'Muat daftar tab'}
      </button>
      {error && <div className="error">{error}</div>}
      {meta && (
        <>
          <label>
            Tab di "{meta.title}"
            <Select
              value={config.gid ?? ''}
              onChange={(e) => {
                const gid = Number(e.target.value);
                onChange({ gid, tabTitle: meta.tabs.find((t: any) => t.gid === gid)?.title ?? '' });
                load(`${config.url.split('#')[0].split('?')[0]}#gid=${gid}`, true, gid);
              }}
            >
              {meta.tabs.map((t: any) => (
                <option key={t.gid} value={t.gid}>
                  {t.title}
                </option>
              ))}
            </Select>
          </label>
          {header && <p className="muted small">{header.length ? `Header tab: ${header.join(', ')}` : 'Tab masih kosong; judul kolom dari tabel akan ditulis sebagai header.'}</p>}
        </>
      )}
      {!meta && config.tabTitle && <p className="muted small">Tab terpilih: {config.tabTitle}</p>}
      <label>
        Cara menulis
        <Select value={config.mode} onChange={(e) => onChange({ mode: e.target.value })}>
          <option value="append">Tambah semua baris di bawah</option>
          <option value="dedup">Tambah hanya yang belum ada (berdasarkan kunci)</option>
          <option value="upsert">Perbarui yang sudah ada, tambah yang baru (berdasarkan kunci)</option>
        </Select>
      </label>
      {config.mode !== 'append' && (
        <label>
          Kolom kunci
          <input value={config.keyColumns ?? ''} placeholder="mis. Nomor WA, Sales" onChange={(e) => onChange({ keyColumns: e.target.value })} />
        </label>
      )}
      <label>
        Tabel ke- (bila laporan berisi beberapa tabel)
        <input type="number" min={1} value={config.table ?? 1} onChange={(e) => onChange({ table: Math.max(1, Number(e.target.value) || 1) })} />
      </label>
      <p className="muted small">
        Kolom dicocokkan lewat nama header (huruf besar dan spasi diabaikan). Kolom tabel yang tidak ada di header sheet tidak ditulis. Sheet harus dibagikan sebagai Editor ke{' '}
        {meta?.email ?? 'email service account'}.
      </p>
    </>
  );
}

export function ConfigPanel({ workflowId, type, config, companyId, catalog, onChange, onDelete, onHelp }: Props) {
  const [newWebhookToken, setNewWebhookToken] = useState('');
  const [tokenCopied, setTokenCopied] = useState(false);
  const spec = NODE_SPECS[type];
  const byId = new Map((useOpenRouterModels().models ?? []).map((m) => [m.id, m]));
  const needCompany = ['sales', 'prompt', 'memory', 'aw', 'history', 'continuous', 'merge'].includes(type) && !companyId;
  // Pilihan datang dari AutoAudit (berbahasa Inggris); labelnya diterjemahkan bila dikenal.
  const opts = (key: string, fallback: [string, string][]) =>
    (catalog?.filter_options?.[key] ?? fallback.map(([value, label]) => ({ value, label }))).map((o) => (
      <option key={o.value} value={o.value}>
        {OPTION_LABEL[o.value] ?? o.label}
      </option>
    ));

  return (
    <div className="panel-body">
      <div className="panel-head">
        <NodeIcon type={type} size={38} />
        <div className="panel-head-text">
          <div className="panel-head-title" style={{ color: spec.color }}>
            {spec.label}
          </div>
          <div className="muted small">{NODE_HELP[type].tagline}</div>
        </div>
      </div>
      <button className="link-btn" onClick={onHelp}>
        Lihat panduan node ini →
      </button>

      {needCompany && <div className="notice">Pilih company di bilah atas dulu.</div>}

      {type === 'code' && <CodeConfig config={config} onChange={onChange}/> }

      {type === 'sales' && companyId && <SalesPicker companyId={companyId} selected={config.sales ?? []} sourceType={config.sourceType ?? 'whatsapp'} onSourceType={(sourceType) => onChange({ sourceType })} onChange={(sales) => onChange({ sales })} />}

      {type === 'prompt' && (
        <>
          <div className="segmented">
            <button className={config.mode !== 'text' ? 'on' : ''} onClick={() => onChange({ mode: 'saved' })}>
              Saved prompt
            </button>
            <button className={config.mode === 'text' ? 'on' : ''} onClick={() => onChange({ mode: 'text' })}>
              Teks bebas
            </button>
          </div>
          {config.mode !== 'text' ? (
            <label>
              Saved prompt
              <Select
                value={config.savedPromptId ?? ''}
                onChange={(e) => {
                  const id = Number(e.target.value) || null;
                  onChange({ savedPromptId: id, title: catalog?.prompts.find((p) => p.id === id)?.title ?? '' });
                }}
              >
                <option value="">— pilih —</option>
                {catalog?.prompts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </Select>
            </label>
          ) : (
            <label>
              Isi prompt
              <textarea rows={12} value={config.text ?? ''} onChange={(e) => onChange({ text: e.target.value })} placeholder="Tulis instruksi audit di sini…" />
            </label>
          )}
        </>
      )}

      {type === 'memory' && catalog && (
        <div className="pick-list tall">
          {catalog.memories.map((m) => {
            const on = (config.memories ?? []).some((x: any) => x.id === m.id);
            return (
              <label key={m.id} className="pick-row">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    onChange({ memories: on ? config.memories.filter((x: any) => x.id !== m.id) : [...(config.memories ?? []), { id: m.id, title: m.title }] })
                  }
                />
                <span className="pick-main">
                  {m.title}
                  <span className="muted small">
                    {m.type}
                    {m.token_count ? ` · ${m.token_count.toLocaleString('id-ID')} token` : ''}
                  </span>
                </span>
              </label>
            );
          })}
          {catalog.memories.length === 0 && <div className="muted small">Company ini belum punya memory.</div>}
        </div>
      )}

      {type === 'chunk' && (
        <>
          <label>
            Cara memecah
            <Select value={config.mode} onChange={(e) => onChange({ mode: e.target.value })}>
              <option value="days">Per rentang tanggal</option>
              <option value="contacts">Per jumlah kontak</option>
            </Select>
          </label>
          <label>
            {config.mode === 'contacts' ? 'Kontak per Audital Work' : 'Hari per Audital Work'}
            <input
              type="number"
              min={1}
              placeholder="kosong = pakai usulan sistem"
              value={config.size ?? ''}
              onChange={(e) => onChange({ size: e.target.value === '' ? null : Math.max(1, Math.floor(Number(e.target.value))) })}
            />
          </label>
          <p className="muted small">
            {config.mode === 'contacts'
              ? 'Daftar kontak pada rentang tanggal dibagi rata mulai dari yang paling banyak pesannya. Rentang tanggal tetap berlaku di setiap bagian.'
              : 'Angka ini panjang rentang tiap bagian, bukan jumlah bagian. 1–30 Juli dengan 5 hari menjadi 6 Audital Work.'}{' '}
            Angka masih bisa diubah di layar rencana sebelum run dimulai.
          </p>
          <label>
            Batas bagian per sales
            <input type="number" min={1} max={200} value={config.maxParts ?? 40} onChange={(e) => onChange({ maxParts: Math.max(1, Number(e.target.value) || 40) })} />
          </label>
        </>
      )}

      {type === 'aw' && (
        <>
          <AnalysisCalendar config={config} onChange={onChange} />
          <label>
            Dijalankan sebagai
            <div className="segmented">
              <button className={!config.runBySuperadmin ? 'on' : ''} onClick={() => onChange({ runBySuperadmin: false })}>
                Jalankan di Company
              </button>
              <button className={config.runBySuperadmin ? 'on' : ''} onClick={() => onChange({ runBySuperadmin: true })}>
                Jalankan di Superadmin
              </button>
            </div>
          </label>
          <p className="muted small">
            {config.runBySuperadmin
              ? 'Riwayat tersimpan di sisi superadmin dan saldo kredit company tidak dipotong.'
              : 'Riwayat tersimpan di company dan memotong saldo kredit company.'}
          </p>
          <label>
            Model
            <Select value={config.model ?? ''} onChange={(e) => onChange({ model: e.target.value })}>
              <option value="">— pilih —</option>
              {catalog?.models
                .filter((m) => config.runBySuperadmin || !m.superadmin_only)
                .map((m) => (
                  <option key={m.name} value={m.name} data-hint={[byId.get(m.name)?.name, ctx(m.context_length ?? byId.get(m.name)?.context_length ?? 0)].filter(Boolean).join(' · ')}>
                    {m.name}
                    {m.name === catalog.default_model ? ' (default)' : ''}
                  </option>
                ))}
            </Select>
          </label>
          <label>
            Jenis chat
            <Select value={config.chatType} onChange={(e) => onChange({ chatType: e.target.value })}>
              {opts('chat_types', [
                ['individual', 'Hanya chat private'],
                ['group', 'Hanya grup'],
                ['both', 'Private + grup'],
              ])}
            </Select>
          </label>
          <label>
            Jam
            <Select value={config.timeFilterMode} onChange={(e) => onChange({ timeFilterMode: e.target.value })}>
              {opts('time_filter_modes', [
                ['all_day', 'Sepanjang hari'],
                ['daily_window', 'Jendela jam harian'],
              ])}
            </Select>
          </label>
          {config.timeFilterMode === 'daily_window' && (
            <div className="row">
              <label>
                Dari
                <input type="time" value={config.startTime} onChange={(e) => onChange({ startTime: e.target.value })} />
              </label>
              <label>
                Sampai
                <input type="time" value={config.endTime} onChange={(e) => onChange({ endTime: e.target.value })} />
              </label>
            </div>
          )}
          <ContactFilter config={config} onChange={onChange} />
          <label>
            Riwayat di luar rentang
            <Select value={config.includeFullHistoryMode} onChange={(e) => onChange({ includeFullHistoryMode: e.target.value })}>
              {opts('include_full_history_modes', [['none', 'Hanya rentang tanggal terpilih']])}
            </Select>
          </label>
          <label>
            Batas waktu per Audital Work (menit)
            <input type="number" min={1} max={600} value={config.timeoutMin ?? 80} onChange={(e) => onChange({ timeoutMin: Math.max(1, Number(e.target.value) || 80) })} />
          </label>
        </>
      )}

      {type === 'parse' && (
        <>
          <label>
            Tabel yang diambil
            <Select value={config.tables ?? 'all'} onChange={(e) => onChange({ tables: e.target.value })}>
              <option value="all">Semua tabel di tiap laporan</option>
              <option value="first">Hanya tabel pertama</option>
            </Select>
          </label>
          <label className="inline">
            <input type="checkbox" checked={config.addSource !== false} onChange={(e) => onChange({ addSource: e.target.checked })} />
            Tambah kolom Sumber dan Bagian
          </label>
          <p className="muted small">Tabel dengan judul kolom yang sama dari banyak Audital Work digabung jadi satu. Tabel dengan judul kolom berbeda tetap terpisah.</p>
        </>
      )}

      {type === 'export' && (
        <>
          <label>
            Format
            <Select value={config.format} onChange={(e) => onChange({ format: e.target.value })}>
              {Object.entries(EXPORT_FORMATS).map(([value, f]) => (
                <option key={value} value={value}>
                  {f.label}
                </option>
              ))}
            </Select>
          </label>
          <p className="muted small">
            {EXPORT_FORMATS[config.format]?.needs === 'rows'
              ? 'Excel dibuat dari tabel di laporan. Bisa disambung langsung dari Proses AW (tabel dibaca otomatis) atau dari Parse Tabel. Tiap tabel menjadi satu sheet.'
              : config.format === 'pdf'
                ? 'PDF dirender oleh AutoAudit: sambungkan langsung dari sumber laporan (Proses AW, History AW, atau Hasil Continuous).'
                : 'File teks dari isi laporan: sambungkan langsung dari sumber laporan.'}
          </p>
          <label>
            Hasil
            <div className="segmented">
              <button className={config.split !== 'combined' ? 'on' : ''} onClick={() => onChange({ split: 'separate' })}>
                Satu file per laporan
              </button>
              <button className={config.split === 'combined' ? 'on' : ''} onClick={() => onChange({ split: 'combined' })}>
                Gabung jadi satu file
              </button>
            </div>
          </label>
          {config.split !== 'combined' ? (
            <>
              <p className="muted small">Tiap laporan menjadi file sendiri. Bila lebih dari satu, semuanya dibungkus dalam satu file .zip. Sambungan dari Parse Tabel selalu menghasilkan satu file gabungan.</p>
              <label>
                Pola nama file
                <input value={config.pattern ?? ''} placeholder={DEFAULT_FILE_PATTERN} onChange={(e) => onChange({ pattern: e.target.value })} />
              </label>
              <div className="chips">
                {['sales', 'periode', 'judul', 'workflow', 'bagian'].map((v) => (
                  <button key={v} className="chip" title="Klik untuk menambahkan ke pola" onClick={() => onChange({ pattern: `${config.pattern || DEFAULT_FILE_PATTERN}-{{${v}}}` })}>
                    {`{{${v}}}`}
                  </button>
                ))}
              </div>
              <div className="name-preview">
                <span className="muted small">Contoh nama file</span>
                <code>
                  {fileNameFrom(config.pattern, { sales: 'Tion', periode: '2026-08-25 sd 2026-08-31', judul: '2 Weekly Report', workflow: 'Nama workflow', bagian: '' })}.{config.format}
                </code>
              </div>
              <p className="muted small">
                <b>sales</b> = nama sales · <b>periode</b> = rentang tanggal yang diaudit · <b>judul</b> = judul jadwal Continuous atau history (nama workflow untuk Proses AW) · <b>bagian</b> = potongan chunk.
              </p>
              <label>
                Nama file .zip (opsional)
                <input value={config.filename ?? ''} placeholder="kosong = nama workflow + tanggal" onChange={(e) => onChange({ filename: e.target.value })} />
              </label>
            </>
          ) : (
            <label>
              Nama file (tanpa akhiran)
              <input value={config.filename ?? ''} placeholder="kosong = nama workflow + tanggal" onChange={(e) => onChange({ filename: e.target.value })} />
            </label>
          )}
        </>
      )}

      {type === 'history' && companyId && <HistoryPicker companyId={companyId} items={config.items ?? []} onChange={(items) => onChange({ items })} />}
      {type === 'continuous' && companyId && <SchedulePicker companyId={companyId} config={config} onChange={onChange} />}

      {type === 'aimerge' && <AiMergeConfig config={config} onChange={onChange} />}

      {type === 'merge' && (
        <>
          <IntegrationNote kind="merge" />
          <label>
            Judul laporan gabungan
            <input value={config.title ?? ''} placeholder="kosong = Merge + nama workflow + tanggal" onChange={(e) => onChange({ title: e.target.value })} />
          </label>
          <label>
            Instruksi merge
            <textarea rows={6} value={config.prompt ?? ''} onChange={(e) => onChange({ prompt: e.target.value })} />
          </label>
          <label>
            Model
<MergeModelSelect value={config.model ?? ''} catalog={catalog} onChange={(model) => onChange({ model })} />
          </label>
          <p className="muted small">
            Sekali merge maksimal 10 laporan; lebih dari itu digabung bertingkat otomatis. Memakai token AI dan kredit company, dan hasilnya tersimpan di Merge Reports AutoAudit.
          </p>
        </>
      )}

      {type === 'sync' && (
        <>
          <label>
            Kapan sync dijalankan
            <Select value={config.policy} onChange={(e) => onChange({ policy: e.target.value })}>
              <option value="stale">Hanya bila data lebih tua dari…</option>
              <option value="always">Selalu</option>
              <option value="skip">Jangan sync (lewati)</option>
            </Select>
          </label>
          {config.policy === 'stale' && (
            <label>
              Umur data maksimal (menit)
              <input type="number" min={1} value={config.staleMinutes ?? 30} onChange={(e) => onChange({ staleMinutes: Math.max(1, Number(e.target.value) || 30) })} />
            </label>
          )}
          {config.policy !== 'skip' && (
            <>
              <label>
                Mode sync
                <Select value={config.mode} onChange={(e) => onChange({ mode: e.target.value })}>
                  <option value="sync-max-priority">Prioritas maksimum (didahulukan)</option>
                  <option value="sync">Biasa (ikut antrean)</option>
                  <option value="sync-no-skip">No-skip</option>
                </Select>
              </label>
              <div className="row">
                <label>
                  Batas waktu (menit)
                  <input type="number" min={1} value={config.timeoutMin ?? 60} onChange={(e) => onChange({ timeoutMin: Math.max(1, Number(e.target.value) || 60) })} />
                </label>
                <label>
                  Bila terlewati
                  <Select value={config.onTimeout} onChange={(e) => onChange({ onTimeout: e.target.value })}>
                    <option value="fail">Hentikan run</option>
                    <option value="continue">Lanjut dengan data yang ada</option>
                  </Select>
                </label>
              </div>
            </>
          )}
          <p className="muted small">Semua Proses AW menunggu sampai sync selesai. Sync yang gagal menghentikan run sebelum token terpakai.</p>
        </>
      )}

      {type === 'message' && <MessageConfig config={config} onChange={onChange} />}

      {type === 'http' && (
        <>
          <label>Tujuan hasil analisis
            <Select value={httpDestination(config)} onChange={e=>onChange({destination:e.target.value})}>
              <option value="autobot">Autobot (bawaan)</option><option value="custom">Endpoint khusus</option>
            </Select>
          </label>
          {httpDestination(config)==='autobot' ? <>
            <div className="http-autobot-note"><strong>Kirim hasil ke Autobot</strong><p>Tabel dan laporan diterima sebagai memory customer dan tugas follow-up.</p></div>
            <label>Workflow ID Autobot<input value={config.autobotWorkflowId||''} placeholder="Salin ID dari workflow Autobot" onChange={e=>onChange({autobotWorkflowId:e.target.value.trim()})}/></label>
            <label>Kunci integrasi Autobot<input type="password" autoComplete="new-password" value={config.autobotApiKey||''} placeholder={config.autobotApiKeyHint?`Tersimpan · berakhir ${config.autobotApiKeyHint}`:'Tempel kunci integrasi workflow'} onChange={e=>onChange({autobotApiKey:e.target.value})}/></label>
            <p className="muted small">{config.autobotApiKeyHint?'Kosongkan untuk mempertahankan kunci tersimpan.':'Kunci disimpan terenkripsi setelah workflow disimpan.'}</p>
            <label>Endpoint otomatis<input readOnly value={httpUrl(config)||'https://autobot.dbautoaudit.stream/integration/v1/workflows/…/builder-results'}/></label>
            <p className="muted small">Metode POST · Autobot menentukan company dan sales berdasarkan konfigurasi workflow.</p>
          </> : <>
            <div className="row"><label style={{flex:'0 0 92px'}}>Metode<Select value={config.method||'POST'} onChange={e=>onChange({method:e.target.value})}><option>POST</option><option>PUT</option><option>PATCH</option></Select></label>
            <label>URL endpoint khusus<input value={config.url||''} placeholder="https://…" onChange={e=>onChange({url:e.target.value})}/></label></div>
            <label>Header tambahan (satu per baris)<textarea rows={3} value={config.headers||''} placeholder={'X-Secret: nilai\nAuthorization: Bearer …'} onChange={e=>onChange({headers:e.target.value})}/></label>
          </>}
          <div className="http-autobot-note"><strong>Contoh tabel yang dikirim</strong><table><thead><tr><th>Customer</th><th>Tindakan</th></tr></thead><tbody><tr><td>Budi Santoso</td><td>Hubungi besok</td></tr></tbody></table><p className="muted small">Sambungkan node Parse Tabel atau laporan ke input HTTP Request.</p></div>
        </>
      )}

      {type === 'sheets' && <SheetsConfig config={config} onChange={onChange} />}

      {type === 'trigger' && <>
        <label>Mulai workflow melalui<Select value={config.mode ?? 'manual'} onChange={e=>onChange({mode:e.target.value,triggerPeriod:config.triggerPeriod ?? {mode:'yesterday'},triggerSchedule:{frequency:'daily',time:'08:00',start:new Date(Date.now()+7*3600000).toISOString().slice(0,10),...config.triggerSchedule,enabled:e.target.value==='schedule'}})}><option value="manual">Manual (default)</option><option value="schedule">Jadwal otomatis</option><option value="webhook">Webhook</option></Select></label>
        {(config.mode === 'schedule' || config.mode === 'webhook') && <AnalysisCalendar startMode={config.mode} config={{analysisPeriod:config.triggerPeriod ?? {mode:'yesterday'},analysisSchedule:{...config.triggerSchedule,enabled:config.mode==='schedule'}}} onChange={patch=>onChange({...('analysisPeriod' in patch?{triggerPeriod:patch.analysisPeriod}:{}),...('analysisSchedule' in patch?{triggerSchedule:patch.analysisSchedule}:{})})} />}
        {config.mode === 'manual' || !config.mode ? <p className="small">Tanggal dipilih saat menekan Run. Jadwal lama pada Proses AW tetap dapat dipakai.</p> : <p className="muted small">Publish untuk mengaktifkan trigger. AW dengan “Ikuti tanggal saat Run” memakai periode Start. Nonaktifkan jadwal otomatis di Proses AW. Pengaturan konfirmasi sebelum jalan tetap berlaku.</p>}
        {config.mode === 'webhook' && <>
          <label>URL webhook<input readOnly value={`${window.location.origin}/integration/v1/workflows/${workflowId}/webhook`}/></label>
          <label>Token webhook<input type="password" autoComplete="new-password" value={config.webhookToken ?? ''} placeholder={config.webhookTokenHint?`Tersimpan · berakhir ${config.webhookTokenHint}`:'Minimal 32 karakter'} onChange={e=>{setNewWebhookToken(e.target.value);setTokenCopied(false);onChange({webhookToken:e.target.value});}}/></label>
          <button className="btn small" type="button" onClick={()=>{const bytes=crypto.getRandomValues(new Uint8Array(32));const token=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');setNewWebhookToken(token);setTokenCopied(false);onChange({webhookToken:token});}}>Buat token baru</button>
          {(config.webhookToken || newWebhookToken) && <button className="btn small" type="button" onClick={async()=>{try{await navigator.clipboard.writeText(config.webhookToken || newWebhookToken);setTokenCopied(true);}catch{setTokenCopied(false);}}}>{tokenCopied?'Token disalin ✓':'Salin token baru'}</button>}
          {newWebhookToken && <p className="muted small">Token baru dapat disalin selama panel ini terbuka, termasuk setelah tersimpan otomatis.</p>}
          <p className="muted small">Salin token baru sebelum menutup panel. Token yang sudah tersimpan hanya ditampilkan sebagai petunjuk saat panel dibuka kembali. Kirim POST dengan header Authorization: Bearer TOKEN dan body JSON. Body kosong memakai periode Start.</p>
          <pre className="small">{JSON.stringify({start_date:'2026-10-05',end_date:'2026-10-05',request_id:'id-unik-dari-sistem-anda'},null,2)}</pre>
          <p className="muted small">Tanggal dan request_id opsional. Gunakan request_id yang sama saat mengulang permintaan agar tidak membuat run ganda.</p>
        </>}
      </>}
      {type === 'viewer' && <p className="small">Laporan tiap Audital Work bisa dibuka dari tampilan run, disalin, atau diunduh sebagai .md / .txt.</p>}

      {type !== 'trigger' && (
        <button className="btn danger small push-down" onClick={onDelete}>
          Hapus node
        </button>
      )}
    </div>
  );
}
