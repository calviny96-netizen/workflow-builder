import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useNodesInitialized, useNodesState, useReactFlow } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { incoming, NODE_SPECS, outgoing, REPORT_TYPES, salesBehind } from '@nodes';
import type { Graph } from '@nodes';
import { api, fmt, fmtTime, STATUS_LABEL } from './api.ts';
import { fromGraph } from './Editor.tsx';
import { HelpDrawer } from './HelpDrawer.tsx';
import { nodeTypes } from './shapes.tsx';

const STEP_NAME: Record<string, string> = { code:'Code', parse: 'Parse Tabel', sheets: 'Tulis Sheets', sync: 'Sync Sales', message: 'Kirim GOWA', http: 'HTTP Request', merge: 'Merge AutoAudit', aimerge: 'Merge AI' };
const TERMINAL = ['completed', 'cancelled', 'plan_failed'];
const GROUP_LIMIT = 12; // di atas ini ketupat ditumpuk jadi satu grup yang bisa dibuka
const ROWS = 8;

interface Item {
  key: string;
  id: string | null; // id unit bila sudah ada di database
  nodeId: string;
  seq: number;
  label: string;
  sourceId: number;
  status: string;
  estimate: any;
  filter: any;
  error?: string | null;
  attempt?: number;
  history_id?: number | null;
  token_usage?: number | null;
  fetch: boolean; // true = hanya mengambil laporan yang sudah ada, tidak menjalankan Audital Work
}

function itemsOf(run: any): Item[] {
  if (run.units?.length) {
    return run.units.map((u: any) => ({
      key: u.id, id: u.id, nodeId: u.node_id, seq: u.seq, label: u.label, sourceId: u.source.id, status: u.status, estimate: u.estimate,
      filter: u.filter, error: u.error, attempt: u.attempt, history_id: u.history_id, token_usage: u.token_usage, fetch: u.fetch === true,
    }));
  }
  return (run.plan?.units ?? []).map((u: any) => ({
    key: `${u.nodeId}:${u.seq}`, id: null, nodeId: u.nodeId, seq: u.seq, label: u.label, sourceId: u.source.id,
    status: u.skip ? 'skipped' : 'planned', estimate: u.estimate, filter: u.filter, fetch: u.fetch === true, history_id: u.history_id,
  }));
}

function groupStatus(tally: Record<string, number>): string {
  for (const s of ['failed', 'running', 'starting', 'queued', 'planned', 'cancelled', 'done', 'skipped']) if (tally[s]) return s;
  return 'planned';
}

// Ketupat AW "mekar": tiap unit jadi satu ketupat dengan garis sendiri dari Sales/Chunk asalnya.
function buildCanvas(graph: Graph, items: Item[], expanded: Set<string>, selectedKey: string | null, steps: any[]): { nodes: Node[]; edges: Edge[] } {
  const base = fromGraph(graph, true);
  const stepOf = new Map(steps.map((s) => [s.node_id, s]));
  base.nodes = base.nodes.map((n) => (stepOf.has(n.id) ? { ...n, selected: selectedKey === `step:${n.id}`, data: { ...n.data, status: stepOf.get(n.id).status } } : n));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  let nodes: Node[] = base.nodes;
  let edges: Edge[] = base.edges;

  // Posisi semua node, digeser bertahap supaya kolom unit dari node yang bertumpuk tidak saling menimpa.
  const pos = new Map(graph.nodes.map((n) => [n.id, { ...n.position }]));
  const reportNodes = graph.nodes.filter((n) => REPORT_TYPES.includes(n.type)).sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);

  for (const aw of reportNodes) {
    const at = pos.get(aw.id)!;
    const unitShape = NODE_SPECS[aw.type].shape === 'diamond' ? 'diamond' : 'square';
    const mine = items.filter((i) => i.nodeId === aw.id);
    if (!mine.length) continue;

    // Sumber tiap unit: node Chunk atau Sales yang memuat sales-nya.
    const originOf = (salesId: number) => {
      for (const e of incoming(graph, aw.id, 'source')) {
        const from = byId.get(e.source)!;
        if (salesBehind(graph, from.id).some((s) => s.id === salesId)) return from.id;
      }
      return incoming(graph, aw.id, 'source')[0]?.source ?? incoming(graph, aw.id, 'in')[0]?.source;
    };
    const side = [...incoming(graph, aw.id, 'prompt'), ...incoming(graph, aw.id, 'memory')];
    const outs = outgoing(graph, aw.id);
    const collapsed = mine.length > GROUP_LIMIT && !expanded.has(aw.id);

    nodes = nodes.filter((n) => n.id !== aw.id);
    edges = edges.filter((e) => e.source !== aw.id && e.target !== aw.id);

    if (collapsed) {
      const tally: Record<string, number> = {};
      for (const i of mine) tally[i.status] = (tally[i.status] ?? 0) + 1;
      const gid = `group:${aw.id}`;
      nodes.push({ id: gid, type: 'unit', position: { ...at }, data: { label: `${mine.length} laporan`, status: groupStatus(tally), count: mine.length, tally, shape: unitShape } });
      const origins = new Set(mine.map((i) => originOf(i.sourceId)));
      for (const o of origins) if (o) edges.push({ id: `${o}>${gid}`, source: o, sourceHandle: 'out', target: gid, targetHandle: 'source' });
      for (const s of side) edges.push({ id: `${s.id}>${gid}`, source: s.source, sourceHandle: 'out', target: gid, targetHandle: s.targetHandle, className: 'edge-faint' });
      for (const o of outs) edges.push({ id: `${gid}>${o.id}`, source: gid, sourceHandle: 'out', target: o.target, targetHandle: o.targetHandle });
      continue;
    }

    const cols = Math.ceil(mine.length / ROWS);
    const rows = Math.min(ROWS, mine.length);
    // Kolom unit tumbuh ke bawah dari posisi node. Node di bawahnya turun setinggi kolom; node sebaris
    // (hulu dan hilir) turun setengahnya supaya tetap di tengah kolom; node di kanan bergeser bila kolomnya lebih dari satu.
    const extraH = (rows - 1) * 112;
    const extraW = (cols - 1) * 118;
    for (const [id, p] of pos) {
      if (id === aw.id) continue;
      if (p.x > at.x + 100) p.x += extraW;
      // "Sebaris" = selisih tinggi kurang dari satu node; node jarang tepat sejajar saat diletakkan dengan tangan.
      if (p.y > at.y + 80) p.y += extraH;
      else if (Math.abs(p.y - at.y) <= 80) p.y += extraH / 2;
    }
    mine.forEach((it, i) => {
      const col = Math.floor(i / ROWS);
      const row = i % ROWS;
      const uid = `unit:${it.key}`;
      nodes.push({
        id: uid,
        type: 'unit',
        position: { x: at.x + 26 + col * 118, y: at.y + 26 + row * 112 },
        selected: selectedKey === it.key,
        data: { label: it.label, status: it.status, shape: unitShape, statusLabel: statusText(it) },
      });
      const origin = originOf(it.sourceId);
      if (origin) edges.push({ id: `${origin}>${uid}`, source: origin, sourceHandle: 'out', target: uid, targetHandle: 'source', animated: it.status === 'running' || it.status === 'starting' });
      for (const s of side) edges.push({ id: `${s.id}>${uid}`, source: s.source, sourceHandle: 'out', target: uid, targetHandle: s.targetHandle, className: 'edge-faint' });
      for (const o of outs) edges.push({ id: `${uid}>${o.id}`, source: uid, sourceHandle: 'out', target: o.target, targetHandle: o.targetHandle, className: 'edge-faint' });
    });
  }
  nodes = nodes.map((n) => (n.type === 'wf' && pos.has(n.id) ? { ...n, position: pos.get(n.id)! } : n));
  return { nodes, edges };
}

// Untuk unit yang hanya mengambil laporan, kata "berjalan/direncanakan" diganti supaya tidak terbaca seperti menjalankan AW.
const FETCH_LABEL: Record<string, string> = { planned: 'Akan diambil', queued: 'Antre diambil', starting: 'Mengambil', running: 'Mengambil', done: 'Terambil' };
const statusText = (i: { status: string; fetch?: boolean }) => (i.fetch && FETCH_LABEL[i.status]) || STATUS_LABEL[i.status] || i.status;

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Markdown → teks polos sederhana untuk unduhan .txt
const plain = (md: string) => md.replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');

function Report({ item }: { item: Item }) {
  const [unit, setUnit] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setUnit(null);
    if (item.id && item.status === 'done') api('GET', `/api/units/${item.id}`).then(setUnit).catch(() => {});
  }, [item.id, item.status]);

  const slug = item.label.replace(/[^\w-]+/g, '_').slice(0, 60);
  return (
    <div className="report">
      <div className="panel-title">{item.label}</div>
      <div className="kv small">
        <span>Status</span>
        <span className={`badge st-${item.status}`}>{statusText(item)}</span>
        {item.fetch ? (
          <>
            <span>Jenis</span>
            <span>Mengambil laporan yang sudah ada; tidak menjalankan Audital Work.</span>
          </>
        ) : (
          <>
            <span>Rentang</span>
            <span>
              {item.filter?.start_date} s/d {item.filter?.end_date}
              {item.filter?.chat_numbers?.length ? ` · ${item.filter.is_excluded ? 'kecuali' : 'hanya'} ${item.filter.chat_numbers.length} nomor` : ''}
            </span>
            <span>Estimasi</span>
            <span>
              {fmt(item.estimate?.contacts)} kontak · {fmt(item.estimate?.messages)} pesan · {fmt(item.estimate?.tokens)} token ({item.estimate?.percent ?? 0}% konteks)
            </span>
          </>
        )}
        {item.history_id && (
          <>
            <span>History</span>
            <span>#{item.history_id}{item.attempt && item.attempt > 1 ? ` · percobaan ke-${item.attempt}` : ''}</span>
          </>
        )}
        {unit?.token_usage && (
          <>
            <span>Terpakai</span>
            <span>
              {fmt(unit.token_usage)} token · {unit.model_used}
            </span>
          </>
        )}
      </div>
      {item.error && <div className="error">{item.error}</div>}
      {unit?.finish_reason && unit.finish_reason !== 'stop' && <div className="notice">Jawaban AI berakhir dengan "{unit.finish_reason}"; laporan mungkin terpotong.</div>}
      {unit?.content != null && (
        <>
          <div className="row">
            <button
              className="btn small"
              onClick={async () => {
                await navigator.clipboard.writeText(unit.content);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? 'Tersalin' : 'Salin teks'}
            </button>
            <button className="btn small" onClick={() => download(`${slug}.md`, unit.content)}>
              Unduh .md
            </button>
            <button className="btn small" onClick={() => download(`${slug}.txt`, plain(unit.content))}>
              Unduh .txt
            </button>
          </div>
          <div className="markdown">
            <Markdown remarkPlugins={[remarkGfm]}>{unit.content}</Markdown>
          </div>
        </>
      )}
      {item.status === 'done' && !unit && <p className="muted small">Memuat laporan…</p>}
    </div>
  );
}

function StepPanel({ step }: { step: any }) {
  const [detail, setDetail] = useState<any>(null);
  useEffect(() => {
    setDetail(null);
    if (step.status === 'done' && (step.type === 'parse' || step.type === 'merge' || step.type === 'aimerge' || step.type === 'code')) api('GET', `/api/steps/${step.id}`).then(setDetail).catch(() => {});
  }, [step.id, step.status]);
  const sum = step.summary;
  return (
    <div className="report">
      <div className="panel-title">{STEP_NAME[step.type] ?? 'Export'}</div>
      <div className="kv small">
        <span>Status</span>
        <span className={`badge st-${step.status}`}>{STATUS_LABEL[step.status] ?? step.status}</span>
      </div>
      {step.status === 'waiting' && step.type !== 'sync' && <p className="muted small">Menunggu langkah di hulunya selesai.</p>}
      {sum?.kind === 'code' && <>
        <p className="small">{sum.language === 'python' ? 'Python' : 'JavaScript'} · {sum.input} item masuk → {sum.items} item keluar · 0 token LLM</p>
        {detail && <><div className="row"><button className="btn small" onClick={()=>navigator.clipboard.writeText(JSON.stringify(detail.items,null,2))}>Salin JSON</button><button className="btn small" onClick={()=>download('hasil-code.json',JSON.stringify(detail.items,null,2))}>Unduh pratinjau JSON</button></div><pre className="code-output">{JSON.stringify(detail.items,null,2)}</pre>{detail.totalItems>detail.items.length && <p className="muted small">Menampilkan {detail.items.length} dari {detail.totalItems} item. Sambungkan Export untuk semua baris.</p>}{detail.logs?.length>0 && <><strong>Log</strong><pre className="code-output">{detail.logs.join('\n')}</pre></>}</>}
      </>}
      {sum?.kind === 'sync'  && (
        <div className="unit-list">
          {sum.jobs.map((j: any, k: number) => (
            <div className="unit-row" key={k} style={{ cursor: 'default' }}>
              <span className={`dot st-${j.status === 'pending' ? 'queued' : j.status === 'queued' ? 'running' : j.status}`} />
              <span className="unit-row-label">{j.name}</span>
              <span className="muted small">{j.note || { pending: 'menunggu', queued: 'sedang sync', done: 'selesai', skipped: 'dilewati', failed: 'gagal' }[j.status as string]}</span>
            </div>
          ))}
        </div>
      )}
      {step.type === 'aimerge' && step.status === 'running' && <p className="muted small">Model sedang menggabungkan laporan. Ini bisa memakan beberapa menit.</p>}
      {sum?.kind === 'aimerge' && (
        <>
          <p className="small">
            <b>{sum.title}</b> · {sum.sources} laporan sumber
          </p>
          <div className="kv small">
            <span>Model</span>
            <span>{sum.model}</span>
            <span>Pemakaian</span>
            <span>
              {fmt(sum.tokens)} token · {sum.calls} panggilan{sum.levels > 1 ? ` · ${sum.levels} tingkat` : ''}
            </span>
          </div>
          {sum.note && <div className="notice">{sum.note}</div>}
          {detail?.report?.content && (
            <>
              <div className="row">
                <button className="btn small" onClick={() => navigator.clipboard.writeText(detail.report.content)}>
                  Salin teks
                </button>
                <button className="btn small" onClick={() => download(`${String(sum.title).replace(/[^\w-]+/g, '_').slice(0, 60)}.md`, detail.report.content)}>
                  Unduh .md
                </button>
              </div>
              <div className="markdown">
                <Markdown remarkPlugins={[remarkGfm]}>{detail.report.content}</Markdown>
              </div>
            </>
          )}
        </>
      )}
      {sum?.kind === 'merge' && (
        <>
          <p className="small">
            <b>{sum.title}</b> · {sum.sources} laporan sumber
            {sum.levels > 1 ? ` · tingkat ${Math.min(sum.level, sum.levels)} dari ${sum.levels}` : ''}
          </p>
          {sum.note && <div className="notice">{sum.note}</div>}
          {sum.groups.length > 0 && (
            <div className="unit-list">
              {sum.groups.map((g: any, k: number) => (
                <div className="unit-row" key={k} style={{ cursor: 'default' }}>
                  <span className={`dot st-${g.status === 'pending' ? 'queued' : g.status}`} />
                  <span className="unit-row-label">
                    Merge {g.sources} laporan{g.history_id ? ` · history #${g.history_id}` : ''}
                  </span>
                  <span className="muted small">{g.error || { pending: 'menunggu', running: 'AI bekerja', done: 'selesai', failed: 'gagal' }[g.status as string]}</span>
                </div>
              ))}
            </div>
          )}
          {detail?.report?.content && (
            <>
              <div className="row">
                <button className="btn small" onClick={() => navigator.clipboard.writeText(detail.report.content)}>
                  Salin teks
                </button>
                <button className="btn small" onClick={() => download(`${String(sum.title).replace(/[^\w-]+/g, '_').slice(0, 60)}.md`, detail.report.content)}>
                  Unduh .md
                </button>
              </div>
              <div className="markdown">
                <Markdown remarkPlugins={[remarkGfm]}>{detail.report.content}</Markdown>
              </div>
            </>
          )}
        </>
      )}
      {sum?.kind === 'message' && (
        <p className="small">
          {sum.sent} pesan terkirim ke <b>{sum.target}</b>
          {sum.files ? `, termasuk ${sum.files} file` : ''}.
        </p>
      )}
      {sum?.kind === 'http' && (
        <>
          <p className="small">
            <b>{sum.host}</b> membalas {sum.status}.
          </p>
          {sum.response && <pre className="help-example">{sum.response}</pre>}
        </>
      )}
      {step.error && <div className="error">{step.error}</div>}
      {sum?.kind === 'file' && (
        <>
          <p className="small">
            <b>{sum.name}</b> · {fmt(Math.ceil(sum.size / 1024))} KB
            {sum.rows != null ? ` · ${fmt(sum.rows)} baris` : ''}
          </p>
          <a className="btn primary" href={`/api/steps/${step.id}/file`} download>
            {sum.zipped ? `Unduh ZIP (${sum.count} file ${String(sum.format).toUpperCase()})` : `Unduh ${String(sum.format).toUpperCase()}`}
          </a>
          {sum.files?.length > 1 && (
            <>
              <div className="help-k">Isi zip</div>
              <ul className="file-list">
                {sum.files.map((f: string) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {sum?.kind === 'sheet' && (
        <>
          <p className="small">
            <b>{sum.spreadsheet}</b> · tab {sum.tab}
          </p>
          <p className="small">
            {fmt(sum.appended)} baris ditambahkan, {fmt(sum.updated)} diperbarui, {fmt(sum.skipped)} dilewati karena sudah ada.
            {sum.wroteHeader ? ' Header ditulis karena tab masih kosong.' : ''}
          </p>
          {sum.note && <div className="notice">{sum.note}</div>}
          {sum.ignoredColumns?.length > 0 && <div className="notice">Kolom yang tidak ada di header sheet dan tidak ditulis: {sum.ignoredColumns.join(', ')}</div>}
          <a className="btn" href={sum.url} target="_blank" rel="noreferrer">
            Buka spreadsheet
          </a>
        </>
      )}
      {sum?.kind === 'rows' && (
        <>
          <p className="small">
            {fmt(sum.rows)} baris dari {sum.reports} laporan, {sum.tables.length} tabel.
          </p>
          {sum.withoutTable.length > 0 && <div className="notice">{sum.withoutTable.length} laporan tidak berisi tabel: {sum.withoutTable.slice(0, 3).join('; ')}{sum.withoutTable.length > 3 ? '…' : ''}</div>}
          {detail?.tables.map((t: any, k: number) => (
            <div className="markdown" key={k}>
              <table>
                <thead>
                  <tr>
                    {t.columns.map((c: string, i: number) => (
                      <th key={i}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((r: string[], i: number) => (
                    <tr key={i}>
                      {r.map((c, j) => (
                        <td key={j}>{c}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {t.total > t.rows.length && <p className="muted small">Menampilkan {t.rows.length} dari {fmt(t.total)} baris.</p>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// Langkah 2: data yang tersedia pada periode terpilih, dan angka chunk untuk tiap node Chunk.
function ChunkStep({ run, sizes, setSizes, busy, onNext }: { run: any; sizes: Record<string, number | null>; setSizes: (v: Record<string, number | null>) => void; busy: boolean; onNext: () => void }) {
  const pv = run.preview;
  const byNode = new Map<string, any[]>();
  for (const g of pv.groups) if (g.chunk) byNode.set(g.chunk.nodeId, [...(byNode.get(g.chunk.nodeId) ?? []), g]);
  const plain = pv.groups.filter((g: any) => !g.chunk && g.full);
  let totalAw = plain.length;

  const cards = [...byNode.entries()].map(([nodeId, groups]) => {
    const mode: string = groups[0].chunk.mode;
    const unit = mode === 'contacts' ? 'kontak' : 'hari';
    // Usulan paling ketat di antara semua sales pada node ini.
    const rec = Math.min(...groups.map((g) => (mode === 'contacts' ? g.chunk.recommended.contactsPerPart : g.chunk.recommended.daysPerPart)));
    const size = sizes[nodeId] ?? rec;
    const parts = (g: any) => (g.chunk.full.contacts === 0 ? 0 : mode === 'contacts' ? Math.ceil(g.chunk.full.contacts / size) : Math.ceil((g.period?.days ?? pv.days) / size));
    const aw = groups.reduce((n, g) => n + parts(g), 0);
    totalAw += aw;
    return (
      <div className="chunk-box" key={nodeId}>
        <div className="small">
          <b>Chunk · {mode === 'contacts' ? 'per jumlah kontak' : 'per rentang tanggal'}</b>
          <span className="muted"> (cara memecah diatur di node Chunk)</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Sales</th>
              <th>Kontak</th>
              <th>Pesan</th>
              <th>Token</th>
              <th>Konteks</th>
              <th>AW</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g, k) => (
              <tr key={k}>
                <td>{g.source.name}{g.period && <div className="muted small">{g.period.start_date} – {g.period.end_date}</div>}</td>
                <td>{fmt(g.chunk.full.contacts)}</td>
                <td>{fmt(g.chunk.full.messages)}</td>
                <td>{fmt(g.chunk.full.tokens)}</td>
                <td className={g.chunk.full.needsChunking ? 'over' : ''}>{g.chunk.full.percent}%</td>
                <td>
                  <b>{parts(g)}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <label>
          {mode === 'contacts' ? 'Kontak per Audital Work' : 'Hari per Audital Work'}
          <input
            type="number"
            min={1}
            autoFocus
            placeholder={`usulan sistem: ${rec}`}
            value={sizes[nodeId] ?? ''}
            onChange={(e) => setSizes({ ...sizes, [nodeId]: e.target.value === '' ? null : Math.max(1, Math.floor(Number(e.target.value))) })}
          />
        </label>
        <p className="muted small">
          Usulan sistem {rec} {unit} per Audital Work, supaya tiap bagian memakai kurang dari 60% konteks model dan jawabannya tidak terpotong. Dengan {size} {unit}: <b>{aw} Audital Work</b>.
        </p>
      </div>
    );
  });

  return (
    <>
      <div className="panel-title">Data yang tersedia</div>
      <div className="stats three">
        <div>
          <b>{fmt(pv.totals.contacts)}</b>
          <span>kontak</span>
        </div>
        <div>
          <b>{fmt(pv.totals.messages)}</b>
          <span>pesan</span>
        </div>
        <div>
          <b>{fmt(pv.totals.tokens)}</b>
          <span>token</span>
        </div>
      </div>
      <p className="muted small">
        Periode tiap AW ditampilkan bersama sumbernya. Angka dibaca dari AutoAudit tanpa memakai token AI.
      </p>
      {cards}
      {plain.length > 0 && (
        <p className="muted small">
          Tanpa chunk (1 Audital Work masing-masing): {plain.map((g: any) => `${g.source.name} (${fmt(g.full.contacts)} kontak, ${g.full.percent}% konteks)`).join('; ')}.
        </p>
      )}
      <button className="btn primary" disabled={busy} onClick={onNext}>
        Lanjut: lihat {totalAw} Audital Work →
      </button>
    </>
  );
}

// Kanvas run. Node disimpan di state React Flow supaya ukuran yang sudah terukur tidak hilang saat
// isinya diperbarui, dan kamera disesuaikan ulang setiap kali susunan node berubah (mis. ketupat AW mekar).
function RunCanvas({ canvas, onPick }: { canvas: { nodes: Node[]; edges: Edge[] }; onPick: (id: string | null) => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const flow = useReactFlow();
  const ready = useNodesInitialized();

  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return canvas.nodes.map((n) => (old.get(n.id)?.measured ? { ...n, measured: old.get(n.id)!.measured } : n));
    });
  }, [canvas.nodes, setNodes]);

  // Kunci susunan: daftar id node. Berubah saat rencana jadi, grup dibuka, atau run baru dimuat.
  const layoutKey = canvas.nodes.map((n) => n.id).join('|');
  useEffect(() => {
    if (!ready || !canvas.nodes.length) return;
    const t = setTimeout(() => flow.fitView({ maxZoom: 1, padding: 0.2, duration: 250 }), 60);
    return () => clearTimeout(t);
  }, [layoutKey, ready, flow]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={canvas.edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      onNodeClick={(_, n) => onPick(n.id)}
      onPaneClick={() => onPick(null)}
      fitView
      fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
}

export function RunView({ workflowId, runId }: { workflowId: string; runId: string }) {
  const [run, setRun] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [help, setHelp] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, number | null>>({});

  const load = () =>
    api('GET', `/api/runs/${runId}`)
      .then((r) => {
        setRun(r);
        return r;
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      const r = await load();
      if (!live) return;
      const idle = r && (TERMINAL.includes(r.status) || r.status === 'awaiting_approval' || r.status === 'awaiting_chunk' || r.status === 'failed');
      timer = setTimeout(loop, idle ? 6000 : 1500);
    };
    loop();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [runId]);

  // Angka chunk di langkah 2 diisi dari yang terakhir dipakai (atau kosong = usulan sistem).
  const previewStamp = run?.preview ? JSON.stringify(run.preview.groups.map((g: any) => g.chunk && [g.chunk.nodeId, g.chunk.size, g.chunk.sizeFrom])) : '';
  useEffect(() => {
    if (!run?.preview) return;
    const next: Record<string, number | null> = {};
    for (const g of run.preview.groups) {
      if (g.chunk) next[g.chunk.nodeId] = run.overrides?.[g.chunk.nodeId]?.size ?? (g.chunk.sizeFrom === 'manual' ? g.chunk.size : null);
    }
    setOverrides(next);
  }, [previewStamp]);

  const items = useMemo(() => (run ? itemsOf(run) : []), [run]);
  // Kanvas hanya dibangun ulang bila isinya benar-benar berubah, bukan tiap kali data run diambil ulang.
  // Tanpa ini node dibuat baru tiap beberapa detik dan bisa hilang dari layar karena ukurannya belum terukur.
  const canvasKey = run
    ? JSON.stringify([run.graph, items.map((i) => [i.key, i.status, i.label]), (run.steps ?? []).map((x: any) => [x.node_id, x.status]), [...expanded], selectedKey])
    : '';
  const canvas = useMemo(() => (run ? buildCanvas(run.graph, items, expanded, selectedKey, run.steps ?? []) : { nodes: [], edges: [] }), [canvasKey]);
  const selectedStep = selectedKey?.startsWith('step:') ? (run?.steps ?? []).find((s: any) => `step:${s.node_id}` === selectedKey) : null;
  const selected = items.find((i) => i.key === selectedKey) ?? null;

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setError('');
    try {
      await api('POST', `/api/runs/${runId}/${path}`, body);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!run) return <div className="center-page muted">{error || 'Memuat run…'}</div>;

  const tally: Record<string, number> = {};
  for (const i of items) tally[i.status] = (tally[i.status] ?? 0) + 1;
  const finished = items.filter((i) => i.status === 'done' || i.status === 'skipped').length;
  const used = items.reduce((n, i) => n + (i.token_usage ?? 0), 0);
  const chunkNodes: any[] = [...new Map((run.plan?.groups ?? []).filter((g: any) => g.chunk).map((g: any) => [g.chunk.nodeId, g])).values()];
  const hasChunkStep = !!run.preview;
  // Dipisah: yang benar-benar menjalankan Audital Work (memakai token) dan yang hanya mengambil laporan.
  const nRun = items.filter((i) => !i.fetch && i.status !== 'skipped').length;
  const nFetch = items.filter((i) => i.fetch).length;
  const stepNow = run.status === 'awaiting_chunk' ? 1 : run.status === 'awaiting_approval' ? 2 : ['running', 'failed'].includes(run.status) ? 3 : run.status === 'completed' ? 4 : run.status === 'planning' ? (run.chunk_confirmed || !hasChunkStep ? 2 : 1) : -1;

  return (
    <div className="page">
      <header className="topbar">
        <a className="btn ghost" href={`#/w/${workflowId}`} title="Kembali ke editor">
          ←
        </a>
        <strong>{run.workflow_name}</strong>
        <span className="muted">
          {run.company_name}
          {nRun > 0 || run.status === 'planning' || run.status === 'awaiting_chunk' ? run.graph.nodes.some((n: any) => n.type === 'aw' && n.config.analysisPeriod && n.config.analysisPeriod.mode !== 'run') ? ` · Periode sesuai node AW · acuan ${run.params.analysis_date ?? run.params.start_date}` : ` · ${run.params.start_date} s/d ${run.params.end_date}` : ''}
        </span>
        <span className={`badge st-${run.status}`}>{STATUS_LABEL[run.status] ?? run.status}</span>
        {items.length > 0 && run.status !== 'awaiting_approval' && (
          <span className="progress" title={`${finished} dari ${items.length} selesai`}>
            <i style={{ width: `${(finished / items.length) * 100}%` }} />
            <b>
              {finished}/{items.length}
            </b>
          </span>
        )}
        <span className="spacer" />
        <button className="btn help-btn" onClick={() => setHelp(true)} title="Panduan">
          <span>?</span> Panduan
        </button>
        {run.status === 'awaiting_approval' && (
          <button className="btn primary" disabled={busy} onClick={() => act('approve')}>
            {nRun > 0 ? `▶ Jalankan ${nRun} Audital Work${nFetch ? ` + ambil ${nFetch} laporan` : ''}` : `Ambil ${nFetch} laporan`}
          </button>
        )}
        {run.status === 'failed' && (
          <button className="btn primary" disabled={busy} onClick={() => act('resume')} title="Hanya mengulang yang gagal; yang sukses tidak dijalankan ulang">
            Lanjutkan dari yang gagal
          </button>
        )}
        {['planning', 'awaiting_chunk', 'awaiting_approval', 'running', 'failed'].includes(run.status) && (
          <button className="btn danger" disabled={busy} onClick={() => window.confirm('Batalkan run ini?') && act('cancel')}>
            Batalkan
          </button>
        )}
      </header>

      {help && <HelpDrawer focus="top" onClose={() => setHelp(false)} />}
      <div className="workspace">
        <div className="canvas">
          <ReactFlowProvider>
            <RunCanvas
              canvas={canvas}
              onPick={(id) => {
                if (id === null) setSelectedKey(null);
                else if (id.startsWith('group:')) setExpanded(new Set([...expanded, id.slice(6)]));
                else if (id.startsWith('unit:')) setSelectedKey(id.slice(5));
                else if ((run.steps ?? []).some((x: any) => x.node_id === id)) setSelectedKey(`step:${id}`);
                else setSelectedKey(null);
              }}
            />
          </ReactFlowProvider>
          {expanded.size > 0 && (
            <button className="btn small float" onClick={() => setExpanded(new Set())}>
              Tutup grup
            </button>
          )}
        </div>

        <aside className="panel wide">
          <div className="panel-body">
            {stepNow >= 0 && (
              <ol className="stepper">
                {['Tanggal', ...(hasChunkStep || run.status === 'awaiting_chunk' ? ['Data & chunk'] : []), 'Konfirmasi', 'Berjalan', 'Selesai'].map((label, i, all) => {
                  // Tanpa langkah chunk, indeks digeser supaya urutannya tetap cocok.
                  const idx = all.length === 5 ? i : i === 0 ? 0 : i + 1;
                  return (
                    <li key={label} className={idx < stepNow || run.status === 'completed' ? 'done' : idx === stepNow ? 'now' : ''}>
                      <i>{idx < stepNow || run.status === 'completed' ? '✓' : i + 1}</i>
                      {label}
                    </li>
                  );
                })}
              </ol>
            )}
            {error && <div className="error">{error}</div>}
            {run.error && <div className="error">{run.error}</div>}
            {run.status === 'planning' && (
              <p className="muted">{stepNow === 1 ? 'Membaca jumlah kontak, pesan, dan token yang tersedia…' : 'Menyusun daftar Audital Work dan estimasinya…'}</p>
            )}
            {run.status === 'awaiting_chunk' && <ChunkStep run={run} sizes={overrides} setSizes={setOverrides} busy={busy} onNext={() => act('replan', { overrides: Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, { size: v }])) })} />}
            {run.status === 'failed' && (
              <div className="notice">
                Run berhenti karena ada Audital Work yang gagal. Yang sedang berjalan sudah dibiarkan selesai; sisanya belum dijalankan. "Lanjutkan" hanya bisa bila isi prompt dan filter masih sama.
              </div>
            )}

            {selectedStep ? (
              <>
                <button className="btn small" onClick={() => setSelectedKey(null)}>
                  ← Ringkasan
                </button>
                <StepPanel step={selectedStep} />
              </>
            ) : selected ? (
              <>
                <button className="btn small" onClick={() => setSelectedKey(null)}>
                  ← Ringkasan
                </button>
                <Report item={selected} />
              </>
            ) : (
              <>
                {run.plan && (
                  <>
                    <div className="panel-title">Rencana &amp; estimasi</div>
                    <div className="stats">
                      <div>
                        <b>{nRun}</b>
                        <span>Audital Work dijalankan</span>
                      </div>
                      <div>
                        <b>{nFetch}</b>
                        <span>laporan diambil</span>
                      </div>
                      <div>
                        <b>{nRun ? fmt(run.plan.totals.tokens) : 0}</b>
                        <span>token masuk (estimasi)</span>
                      </div>
                      <div>
                        <b>{used ? fmt(used) : '-'}</b>
                        <span>token terpakai</span>
                      </div>
                    </div>
                    <p className="muted small">
                      {nRun > 0 ? `${fmt(run.plan.totals.contacts)} kontak. Maksimal ${Math.min(run.concurrency, run.global_concurrency)} Audital Work berjalan bersamaan.` : ''}
                      {run.plan.totals.skipped ? ` ${run.plan.totals.skipped} bagian tanpa chat dilewati.` : ''}
                    </p>

                    {chunkNodes.map((g: any) => (
                      <div className="chunk-box" key={g.chunk.nodeId}>
                        <div className="small">
                          <b>Chunk:</b> {g.chunk.size} {g.chunk.mode === 'contacts' ? 'kontak' : 'hari'} per Audital Work
                          <span className="muted"> · {g.chunk.sizeFrom === 'usulan' ? 'usulan sistem' : 'diisi manual'}</span>
                        </div>
                      </div>
                    ))}
                    {run.status === 'awaiting_approval' && hasChunkStep && (
                      <button className="btn small" disabled={busy} onClick={() => act('rechunk')}>
                        ← Ubah ukuran chunk
                      </button>
                    )}
                    {run.status === 'awaiting_approval' && (
                      <div className="ready">
                        {nRun === 0
                          ? `Hanya mengambil ${nFetch} laporan yang sudah ada. Tidak ada Audital Work yang dijalankan dan tidak ada token AI yang terpakai.`
                          : `Periksa daftar di bawah. Token AI baru terpakai setelah Anda menekan Jalankan${nFetch ? `; ${nFetch} laporan lainnya hanya diambil, tanpa token` : ''}.`}
                      </div>
                    )}

                    {[...new Map(run.plan.groups.filter((g: any) => g.contacts).map((g: any) => [g.nodeId, g.contacts])).values()].map((c: any, k: number) => (
                      <div className={`contact-result ${c.mode}`} key={k}>
                        {c.mode === 'only' ? (
                          <span>
                            Filter kontak: <b>hanya {c.count} nomor</b> yang dianalisis.
                          </span>
                        ) : (
                          <span>
                            Filter kontak: <b>{c.count} nomor dilewati</b>, sisanya dianalisis.
                          </span>
                        )}
                      </div>
                    ))}
                    {run.plan.warnings.length > 0 && (
                      <ul className="issues">
                        {run.plan.warnings.map((w: string, k: number) => (
                          <li key={k}>{w}</li>
                        ))}
                      </ul>
                    )}

                    <table className="table">
                      <thead>
                        <tr>
                          <th>Sumber</th>
                          <th>Jumlah</th>
                          <th>Keterangan</th>
                        </tr>
                      </thead>
                      <tbody>
                        {run.plan.groups.map((g: any, k: number) => (
                          <tr key={k}>
                            <td>{g.source.name}{g.period && <div className="muted small">{g.period.start_date} – {g.period.end_date}</div>}</td>
                            <td>{g.units}</td>
                            <td className="muted">
                              {g.chunk ? `${fmt(g.chunk.full.contacts)} kontak · ${fmt(g.chunk.full.tokens)} token · ${g.chunk.full.percent}%${g.chunk.full.needsChunking ? ' · wajib dipecah' : ''}` : ['history', 'continuous'].includes(g.source.channel) ? 'laporan yang sudah ada' : 'tanpa chunk'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}

                {(run.steps ?? []).length > 0 && (
                  <>
                    <div className="panel-title">Hasil</div>
                    <div className="unit-list">
                      {run.steps.map((s: any) => (
                        <button key={s.id} className="unit-row" onClick={() => setSelectedKey(`step:${s.node_id}`)}>
                          <span className={`dot st-${s.status}`} />
                          <span className="unit-row-label">{STEP_NAME[s.type] ?? `Export ${s.summary?.format?.toUpperCase() ?? ''}`}</span>
                          <span className="muted small">
                            {s.status !== 'done' ? (STATUS_LABEL[s.status] ?? s.status) : s.summary?.kind === 'file' ? s.summary.name : s.summary?.kind === 'sheet' ? `+${s.summary.appended} · ~${s.summary.updated}` : s.summary?.kind === 'message' ? `${s.summary.sent} pesan` : s.summary?.kind === 'http' ? `HTTP ${s.summary.status}` : s.summary?.kind === 'sync' ? 'selesai' : s.summary?.kind === 'merge' || s.summary?.kind === 'aimerge' ? `${s.summary.sources} laporan digabung` : `${fmt(s.summary?.rows)} baris`}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {items.length > 0 && (
                  <>
                <div className="panel-title">
                  {nRun === 0 ? 'Laporan yang diambil' : nFetch === 0 ? 'Audital Work' : 'Audital Work & laporan'}{' '}
                  <span className="muted small">
                    {Object.entries(tally)
                      .map(([s, n]) => `${n} ${((nRun === 0 && FETCH_LABEL[s]) || STATUS_LABEL[s] || s).toLowerCase()}`)
                      .join(' · ')}
                  </span>
                </div>
                <div className="unit-list">
                  {items.map((i) => (
                    <button key={i.key} className="unit-row" onClick={() => setSelectedKey(i.key)}>
                      <span className={`dot st-${i.status}`} />
                      <span className="unit-row-label">{i.label}</span>
                      <span className="muted small">
                        {i.status === 'failed' ? 'gagal' : i.fetch ? (i.status === 'done' ? 'terambil' : `history #${i.history_id ?? '-'}`) : i.status === 'done' && i.token_usage ? `${fmt(i.token_usage)} token` : `${fmt(i.estimate?.contacts)} kontak`}
                      </span>
                    </button>
                  ))}
                </div>
                  </>
                )}
                <p className="muted small">
                  Dibuat {fmtTime(run.created_at)}
                  {run.finished_at ? ` · selesai ${fmtTime(run.finished_at)}` : ''}
                </p>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
