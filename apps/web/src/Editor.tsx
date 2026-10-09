import { addEdge, MarkerType, Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow } from '@xyflow/react';
import type { Connection, Edge, Node } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canConnect, compatible, NODE_SPECS, sourcesOf, targetsOf, validateGraph } from '@nodes';
import type { Graph, NodeType } from '@nodes';
import { api, fmtTime, STATUS_LABEL } from './api.ts';
import { ConfigPanel } from './ConfigPanel.tsx';
import type { Catalog } from './ConfigPanel.tsx';
import { GROUPS, NODE_HELP } from './help.ts';
import { HelpDrawer, NodeChips, NodeIcon } from './HelpDrawer.tsx';
import { edgeTypes, nodeTypes } from './shapes.tsx';
import type { WfNodeData } from './shapes.tsx';

type WfNode = Node<WfNodeData>;

export function fromGraph(graph: Graph, readOnly = false): { nodes: WfNode[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((n) => ({ id: n.id, type: 'wf', position: n.position, data: { type: n.type, config: n.config ?? {}, readOnly } })),
    edges: graph.edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle, ...EDGE_OPTIONS, ...(readOnly ? {} : { type: 'cut' }) })),
  };
}

function toGraph(nodes: WfNode[], edges: Edge[]): Graph {
  return {
    nodes: nodes.map((n) => ({ id: n.id, type: n.data.type, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, config: n.data.config })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? 'out', target: e.target, targetHandle: e.targetHandle ?? 'in' })),
  };
}

// Garis berpanah supaya arah alur jelas.
export const EDGE_OPTIONS = { markerEnd: { type: MarkerType.ArrowClosed, color: '#475569', width: 16, height: 16 } };

const newId = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
const isoDay = (offset: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date(Date.now() + offset * 86_400_000));

function CompanyPicker({ value, onPick }: { value: { id: number | null; name: string }; onPick: (c: { id: number; name: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      api('GET', `/api/aa/companies?q=${encodeURIComponent(q)}`)
        .then((r) => setItems(r.items))
        .catch(() => setItems([]));
    }, 200);
    return () => clearTimeout(t);
  }, [open, q]);
  return (
    <div className="company-picker">
      <button className={`btn company ${value.id ? '' : 'warn'}`} onClick={() => setOpen(!open)}>
        {value.id ? `Company: ${value.name}` : 'Pilih company'}
      </button>
      {open && (
        <div className="popover">
          <input autoFocus placeholder="Cari company…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="pick-list">
            {items.map((c) => (
              <button
                key={c.id}
                className="pick-item"
                onClick={() => {
                  onPick(c);
                  setOpen(false);
                }}
              >
                {c.name} <span className="muted small">#{c.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EditorInner({ workflowId }: { workflowId: string }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<WfNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [workflowStatus, setWorkflowStatus] = useState('draft');
  const [publishing, setPublishing] = useState(false);
  const archived = workflowStatus === 'archived';
  const [name, setName] = useState('');
  const [company, setCompany] = useState<{ id: number | null; name: string }>({ id: null, name: '' });
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const [message, setMessage] = useState('');
  const [runs, setRuns] = useState<any[]>([]);
  const [runOpen, setRunOpen] = useState(false);
  const [runDates, setRunDates] = useState({ start_date: isoDay(-7), end_date: isoDay(-1) });
  const [runError, setRunError] = useState<string[]>([]);
  const [help, setHelp] = useState<NodeType | 'top' | null>(null);
  const [tip, setTip] = useState<{ type: NodeType; top: number } | null>(null);
  const [hintOff, setHintOff] = useState(false);
  // Petunjuk sambungan saat menarik garis atau menyeret node dari palet:
  // out = menarik dari titik keluar (mencari tujuan), in = menarik dari titik masuk (mencari sumber).
  const [linkHint, setLinkHint] = useState<{ mode: 'out' | 'in'; nodeId: string; handleId: string } | { mode: 'palette'; type: NodeType } | null>(null);
  const [badLink, setBadLink] = useState<{ from: NodeType; to: NodeType; reason: string } | null>(null);
  const [syncPolicy, setSyncPolicy] = useState<'skip' | 'always' | 'stale' | null>(null);
  const flow = useReactFlow();

  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const graphJson = useMemo(() => JSON.stringify(graph), [graph]);
  const issues = useMemo(() => validateGraph(graph), [graphJson]);
  const issueIds = useMemo(() => new Set(issues.map((i) => i.nodeId).filter(Boolean)), [issues]);
  const selected = nodes.find((n) => n.selected);

  // --- muat
  useEffect(() => {
    api('GET', `/api/workflows/${workflowId}`)
      .then((w) => {
        const g = fromGraph(w.graph);
        setNodes(g.nodes);
        setEdges(g.edges);
        setName(w.name);
        setWorkflowStatus(w.status);
        setCompany({ id: w.company_id, name: w.company_name });
        setSettings(w.settings ?? {});
        last.current = JSON.stringify(w.graph);
        setLoaded(true);
      })
      .catch((e) => setMessage(e.message));
    api('GET', `/api/workflows/${workflowId}/runs`)
      .then((r) => setRuns(r.items))
      .catch(() => {});
  }, [workflowId]);

  useEffect(() => {
    setCatalog(null);
    if (!company.id) return;
    api('GET', `/api/aa/catalog?company_id=${company.id}`)
      .then(setCatalog)
      .catch((e) => setMessage(e.message));
  }, [company.id]);

  // --- undo / redo: potret graf diambil setelah perubahan mereda
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const last = useRef('');
  const restoring = useRef(false);
  useEffect(() => {
    if (!loaded || graphJson === last.current) return;
    if (restoring.current) {
      restoring.current = false;
      last.current = graphJson;
      return;
    }
    const t = setTimeout(() => {
      past.current.push(last.current);
      if (past.current.length > 100) past.current.shift();
      future.current = [];
      last.current = graphJson;
    }, 350);
    return () => clearTimeout(t);
  }, [graphJson, loaded]);

  const restore = useCallback(
    (from: string[], to: string[]) => {
      const snap = from.pop();
      if (!snap) return;
      to.push(last.current);
      restoring.current = true;
      const g = fromGraph(JSON.parse(snap));
      setNodes(g.nodes);
      setEdges(g.edges);
    },
    [setNodes, setEdges],
  );

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === '?') {
        e.preventDefault();
        setHelp((h) => (h ? null : 'top'));
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) restore(future.current, past.current);
        else restore(past.current, future.current);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [restore]);

  // --- simpan otomatis
  const payload = useMemo(
    () => JSON.stringify({ name: name.trim() || 'Tanpa nama', company_id: company.id, company_name: company.name, graph, settings }),
    [name, company, graphJson, settings],
  );
  const savedPayload = useRef('');
  const save = useCallback(async () => {
    if (archived) return false;
    if (payload === savedPayload.current) return true;
    setSaveState('saving');
    try {
      const submitted = JSON.parse(payload);
      const res = await api('PUT', `/api/workflows/${workflowId}`, submitted);
      savedPayload.current = payload;
      setWorkflowStatus(res.status);
      // API key yang baru diisi sudah disimpan terenkripsi di server; buang dari browser dan tampilkan petunjuknya saja.
      const submittedNodes = new Map<string, any>(submitted.graph.nodes.map((n: any) => [n.id, n.config]));
      const safeNodes = new Map<string, any>(res.graph.nodes.map((n: any) => [n.id, n.config]));
      setNodes(ns => ns.map(n => {
        const field = ({aimerge:'apiKey',http:'autobotApiKey',trigger:'webhookToken'} as Record<string,string>)[n.data.type];
        const hint = safeNodes.get(n.id)?.[`${field}Hint`] ?? '';
        if (field && n.data.config[field] !== submittedNodes.get(n.id)?.[field]) return n;
        return field && (n.data.config[field] || n.data.config[`${field}Hint`] !== hint)
          ? {...n,data:{...n.data,config:{...n.data.config,[field]:'',[`${field}Hint`]:hint}}} : n;
      }));
      setSaveState('saved');
      return true;
    } catch (e: any) {
      setSaveState('error');
      setMessage(`Gagal menyimpan: ${e.message}`);
      return false;
    }
  }, [payload, workflowId, setNodes, archived]);

  useEffect(() => {
    if (!loaded || archived) return;
    if (!savedPayload.current) {
      savedPayload.current = payload; // keadaan awal dari server
      return;
    }
    if (payload === savedPayload.current) return;
    setSaveState('dirty');
    const t = setTimeout(save, 1200);
    return () => clearTimeout(t);
  }, [payload, loaded, save, archived]);

  // --- interaksi kanvas
  const isValidConnection = useCallback(
    (c: Connection | Edge) =>
      canConnect(graph, { source: c.source!, sourceHandle: c.sourceHandle ?? 'out', target: c.target!, targetHandle: c.targetHandle ?? 'in' }) === null,
    [graph],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const problem = canConnect(graph, { source: c.source!, sourceHandle: c.sourceHandle ?? 'out', target: c.target!, targetHandle: c.targetHandle ?? 'in' });
      if (problem) return setMessage(problem);
      setEdges((eds) => addEdge({ ...c, id: newId('e'), ...EDGE_OPTIONS, type: 'cut' }, eds));
    },
    [graph, setEdges],
  );

  // Garis dilepas di node yang tidak bisa menerimanya: jelaskan kenapa dan ke mana seharusnya.
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: any) => {
      setLinkHint(null);
      if (state.isValid || !state.fromNode || !state.fromHandle) return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      const hitId = state.toNode?.id ?? (document.elementFromPoint(point.clientX, point.clientY)?.closest('.react-flow__node') as HTMLElement | null)?.dataset.id;
      const other = nodes.find((n) => n.id === hitId);
      if (!other || other.id === state.fromNode.id) return;
      // Garis boleh ditarik dari titik keluar maupun titik masuk; arah sebenarnya ditentukan jenis titik asalnya.
      const startedAtOutput = state.fromHandle.type === 'source';
      const me = nodes.find((n) => n.id === state.fromNode.id)!;
      const [src, dst] = startedAtOutput ? [me, other] : [other, me];
      // Sudah tersambung: cukup diberi tahu, bukan dianggap salah sambung.
      if (edges.some((e) => e.source === src.id && e.target === dst.id)) {
        return setMessage(`${NODE_SPECS[src.data.type].label} sudah tersambung ke ${NODE_SPECS[dst.data.type].label}.`);
      }
      let reason: string;
      if (!compatible(src.data.type, dst.data.type)) {
        reason = compatible(dst.data.type, src.data.type)
          ? `Arahnya terbalik: yang benar dari ${NODE_SPECS[dst.data.type].label} ke ${NODE_SPECS[src.data.type].label}.`
          : `Keluaran ${NODE_SPECS[src.data.type].label} bukan jenis masukan yang diterima ${NODE_SPECS[dst.data.type].label}.`;
      } else if (state.toHandle) {
        reason =
          canConnect(graph, {
            source: src.id,
            sourceHandle: startedAtOutput ? state.fromHandle.id : state.toHandle.id,
            target: dst.id,
            targetHandle: startedAtOutput ? state.toHandle.id : state.fromHandle.id,
          }) ?? 'Sambungan ini tidak diizinkan.';
      } else {
        const spec = NODE_SPECS[dst.data.type];
        const outTypes = NODE_SPECS[src.data.type].outputs.map((o) => o.type);
        const port = spec.inputs.find((i) => (i.accepts ?? [i.type]).some((t) => outTypes.includes(t)));
        return setMessage(`Lepaskan garis tepat di titik "${port?.label ?? 'masuk'}" pada ${spec.label}, bukan di badan node.`);
      }
      setBadLink({ from: src.data.type, to: dst.data.type, reason });
    },
    [nodes, graph, edges],
  );

  const addNode = useCallback(
    (type: NodeType, position: { x: number; y: number }) => {
      if (type === 'trigger' && nodes.some((n) => n.data.type === 'trigger')) return setMessage('Workflow hanya boleh punya satu Trigger.');
      const config: Record<string, any> = structuredClone(NODE_SPECS[type].defaults);
      if (type === 'http') { const id=new URLSearchParams(window.location.search).get('autobot_workflow_id'); if(id && /^[0-9a-f-]{36}$/i.test(id)) config.autobotWorkflowId=id; }
      if (type === 'aw' && catalog?.default_model) config.model = catalog.default_model;
      // Titik jatuh menjadi tengah node, bukan pojok kiri atasnya.
      const at = { x: Math.round(position.x - 65), y: Math.round(position.y - 50) };
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id: newId(type), type: 'wf', position: at, selected: true, data: { type, config } }]);
    },
    [nodes, catalog, setNodes],
  );

  const patchSelected = (patch: Record<string, any>) => {
    if (!selected) return;
    setNodes((ns) => ns.map((n) => (n.id === selected.id ? { ...n, data: { ...n.data, config: { ...n.data.config, ...patch } } } : n)));
  };

  // Node mana yang menyala, dan titik mana di node itu. "to" = bisa jadi tujuan (hijau), "from" = bisa jadi sumber (biru).
  const glow = useMemo(() => {
    const map = new Map<string, { to: boolean; from: boolean; handles: string[] }>();
    if (!linkHint) return map;
    for (const n of nodes) {
      const spec = NODE_SPECS[n.data.type];
      const g = { to: false, from: false, handles: [] as string[] };
      if (linkHint.mode === 'palette') {
        // Node baru belum ada di graf, jadi cukup dilihat dari jenisnya.
        g.to = compatible(linkHint.type, n.data.type);
        g.from = compatible(n.data.type, linkHint.type);
      } else if (n.id !== linkHint.nodeId) {
        if (linkHint.mode === 'out') {
          g.handles = spec.inputs.filter((p) => canConnect(graph, { source: linkHint.nodeId, sourceHandle: linkHint.handleId, target: n.id, targetHandle: p.id }) === null).map((p) => p.id);
          g.to = g.handles.length > 0;
        } else {
          g.handles = spec.outputs.filter((p) => canConnect(graph, { source: n.id, sourceHandle: p.id, target: linkHint.nodeId, targetHandle: linkHint.handleId }) === null).map((p) => p.id);
          g.from = g.handles.length > 0;
        }
      }
      map.set(n.id, g);
    }
    return map;
  }, [linkHint, nodes, graph]);

  const shown = useMemo(
    (): WfNode[] =>
      nodes.map((n) => {
        const hasIssue = issueIds.has(n.id);
        if (!linkHint) return hasIssue === !!n.data.hasIssue && !n.data.glow ? n : { ...n, data: { ...n.data, hasIssue, glow: undefined, glowHandles: undefined } };
        const g = glow.get(n.id)!;
        const isOrigin = linkHint.mode !== 'palette' && linkHint.nodeId === n.id;
        const mark: WfNodeData['glow'] = isOrigin ? 'origin' : g.to && g.from ? 'both' : g.to ? 'to' : g.from ? 'from' : 'dim';
        return { ...n, data: { ...n.data, hasIssue, glow: mark, glowHandles: g.handles } };
      }),
    [nodes, issueIds, linkHint, glow],
  );

  const hintText = useMemo(() => {
    if (!linkHint) return null;
    const count = [...glow.values()].filter((g) => g.to || g.from).length;
    if (linkHint.mode === 'palette') {
      const label = NODE_SPECS[linkHint.type].label;
      return { label, text: count ? 'bisa disambung dengan node yang menyala' : 'belum punya pasangan di kanvas', legend: true };
    }
    const label = NODE_SPECS[nodes.find((n) => n.id === linkHint.nodeId)!.data.type].label;
    if (linkHint.mode === 'out') return { label, text: count ? 'bisa mengarah ke node yang menyala hijau' : 'belum punya node tujuan yang cocok di kanvas', legend: false };
    return { label, text: count ? 'bisa menerima dari node yang menyala biru' : 'belum punya node sumber yang cocok di kanvas', legend: false };
  }, [linkHint, glow, nodes]);

  function pickCompany(c: { id: number; name: string }) {
    const bound = nodes.some((n) => (n.data.config.sales?.length || n.data.config.memories?.length || n.data.config.savedPromptId) && true);
    if (company.id && company.id !== c.id && bound && !window.confirm('Ganti company akan mengosongkan pilihan sales, prompt, memory, dan model. Lanjutkan?')) return;
    if (company.id !== c.id) {
      setNodes((ns) =>
        ns.map((n) => {
          const t = n.data.type;
          const reset = t === 'sales' ? { sales: [] } : t === 'memory' ? { memories: [] } : t === 'prompt' ? { savedPromptId: null, title: '' } : t === 'aw' ? { model: '' } : null;
          return reset && company.id ? { ...n, data: { ...n.data, config: { ...n.data.config, ...reset } } } : n;
        }),
      );
    }
    setCompany(c);
  }

  async function startRun() {
    setRunError([]);
    if (!(await save())) return;
    try {
      const r = await api('POST', `/api/workflows/${workflowId}/runs`, { ...runDates, ...(hasSync ? { sync_policy: syncChoice } : {}) });
      window.location.hash = `#/w/${workflowId}/run/${r.id}`;
    } catch (e: any) {
      setRunError(e.issues?.length ? e.issues : [e.message]);
    }
  }

  const blocked = issues.length > 0 || !company.id;
  const syncNode = nodes.find((n) => n.data.type === 'sync');
  const hasSync = !!syncNode;
  const hasChunk = nodes.some((n) => n.data.type === 'chunk');
  const hasAw = nodes.some((n) => n.data.type === 'aw');
  // Tanggal hanya dipakai Proses AW dan Hasil Continuous bermode rentang tanggal.
  const needsDates = nodes.some(n => n.data.type === 'aw' && (!n.data.config.analysisPeriod || n.data.config.analysisPeriod.mode === 'run')) || nodes.some((n) => n.data.type === 'continuous' && n.data.config.pick === 'range');
  const staleMin = Number(syncNode?.data.config.staleMinutes ?? 30);
  const syncChoice = syncPolicy ?? (syncNode?.data.config.policy as 'skip' | 'always' | 'stale' | undefined) ?? 'stale';

  if (archived) return <div className="page">
    <header className="topbar"><a className="btn" href="#/">← Workflow</a><b>{name}</b><span className="badge lifecycle-archived">Arsip</span></header>
    <main className="list-main"><h2>Workflow diarsipkan</h2><p className="muted">Konfigurasi dan hasil tetap tersimpan. Pulihkan dari menu Arsip pada daftar workflow untuk mengedit atau menjalankan kembali.</p>
      <div className="card archived-summary"><b>{company.name} · {nodes.length} node</b>
        <p>AW bersamaan: {settings.concurrency ?? 5} · Konfirmasi sebelum jalan: {settings.requireApproval !== false ? 'Ya' : 'Tidak'}</p>
        {nodes.map(n => <div key={n.id}>{NODE_SPECS[n.data.type].label} · {n.id}</div>)}
      </div><h3>Riwayat run</h3>{runs.map(r => <p key={r.id}><a href={`#/w/${workflowId}/run/${r.id}`}>{r.status} · {fmtTime(r.created_at)}</a></p>)}
    </main></div>;

  return (
    <div className="page">
      <header className="topbar">
        <a className="btn ghost" href="#/" title="Kembali ke daftar workflow">
          ←
        </a>
        <input className="name-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Nama workflow" />
        {company.id ? (
          <span className="company-tag" title="Company ditetapkan saat workflow dibuat dan tidak bisa diganti">
            {company.name}
          </span>
        ) : (
          <CompanyPicker value={company} onPick={pickCompany} />
        )}
        <label className="inline">
          AW bersamaan
          <input
            type="number"
            min={1}
            max={50}
            placeholder="5"
            value={settings.concurrency ?? ''}
            onChange={(e) => setSettings({ ...settings, concurrency: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) })}
          />
        </label>
        <label className="inline" title="Bila dimatikan, run langsung berjalan tanpa layar rencana">
          <input type="checkbox" checked={settings.requireApproval !== false} onChange={(e) => setSettings({ ...settings, requireApproval: e.target.checked })} />
          Konfirmasi sebelum jalan
        </label>
        <span className="spacer" />
        <span className={`badge lifecycle-${workflowStatus}`}>{workflowStatus === 'published' ? 'Published' : 'Draft'}</span>
        <button className="btn" disabled={publishing || !loaded} title="Perubahan pada workflow published akan menjadi Draft. Run manual tersedia pada Draft." onClick={async () => {
          setPublishing(true);
          try {
            if (!await save()) return;
            const w = await api('POST', `/api/workflows/${workflowId}/lifecycle`, { action: workflowStatus === 'published' && payload === savedPayload.current ? 'unpublish' : 'publish' });
            setWorkflowStatus(w.status);
            setMessage(w.status === 'published' ? 'Workflow berhasil dipublish. Perubahan berikutnya perlu dipublish ulang.' : 'Workflow menjadi Draft.');
          } catch (e: any) { setMessage([e.message, ...(e.issues ?? [])].join(' ')); }
          finally { setPublishing(false); }
        }}>{publishing ? 'Menyimpan…' : workflowStatus === 'published' ? 'Unpublish' : 'Publish'}</button>
        <button className="btn help-btn" onClick={() => setHelp('top')} title="Panduan (tombol ?)">
          <span>?</span> Panduan
        </button>
        <span className={`save-state ${saveState}`}>{{ saved: 'Tersimpan', dirty: 'Belum tersimpan', saving: 'Menyimpan…', error: 'Gagal menyimpan' }[saveState]}</span>
        <button
          className={`btn primary ${blocked ? 'is-blocked' : ''}`}
          title={blocked ? 'Workflow belum lengkap; klik untuk melihat apa yang kurang' : ''}
          onClick={() => {
            if (!blocked) return setRunOpen(true);
            // Lepas pilihan node supaya daftar pemeriksaan tampil di panel kanan, dan sebutkan alasannya.
            setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)));
            setMessage(`Belum bisa dijalankan: ${[...(company.id ? [] : ['Company belum dipilih.']), ...issues.map((i) => i.message)].join(' ')}`);
          }}
        >
          {hasAw ? '▶ Run' : '▶ Ambil laporan'}{blocked ? ` (${issues.length + (company.id ? 0 : 1)} belum lengkap)` : ''}
        </button>
      </header>

      <div className="workspace">
        <aside className="palette">
          {GROUPS.map((g) => (
            <div className="palette-group" key={g.title}>
              <div className="side-title">
                {g.title} <span>{g.hint}</span>
              </div>
              {g.types.map((t) => {
            const s = NODE_SPECS[t];
            return (
              <div
                key={t}
                className="palette-item"
                draggable
                onMouseEnter={(e) => setTip({ type: t, top: e.currentTarget.getBoundingClientRect().top })}
                onMouseLeave={() => setTip(null)}
                onDragEnd={() => setLinkHint(null)}
                onDragStart={(e) => {
                  setTip(null);
                  setLinkHint({ mode: 'palette', type: t });
                  e.dataTransfer.setData('application/aawb-node', t);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDoubleClick={() => addNode(t, flow.screenToFlowPosition({ x: window.innerWidth / 2 + (nodes.length % 5) * 36, y: window.innerHeight / 2 + (nodes.length % 5) * 36 }))}
              >
                <NodeIcon type={t} size={30} />
                <span>{s.label}</span>
              </div>
            );
              })}
            </div>
          ))}
          <button className="link-btn palette-help" onClick={() => setHelp('top')}>
            Bingung? Buka panduan
          </button>
        </aside>
        {tip && (
          <div className="tip-card" style={{ top: Math.min(tip.top, window.innerHeight - 190) }}>
            <b style={{ color: NODE_SPECS[tip.type].color }}>{NODE_SPECS[tip.type].label}</b>
            <span>{NODE_HELP[tip.type].tagline}</span>
            <span className="muted small">Seret ke kanvas, atau klik dua kali. Tekan ? untuk panduan lengkap.</span>
          </div>
        )}

        <div
          className="canvas"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(e) => {
            e.preventDefault();
            setLinkHint(null);
            const t = e.dataTransfer.getData('application/aawb-node') as NodeType;
            if (t && NODE_SPECS[t]) addNode(t, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
          }}
        >
          <ReactFlow
            nodes={shown}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={(_, p) => p.nodeId && p.handleId && setLinkHint({ mode: p.handleType === 'source' ? 'out' : 'in', nodeId: p.nodeId, handleId: p.handleId })}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            deleteKeyCode={['Backspace', 'Delete']}
            defaultEdgeOptions={{ ...EDGE_OPTIONS, type: 'cut' }}
            connectionLineStyle={{ stroke: '#2563eb', strokeWidth: 2.5 }}
            fitView
            fitViewOptions={{ maxZoom: 1, padding: 0.3 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
          {!hintOff && loaded && nodes.length <= 1 && (
            <div className="start-card">
              <button className="btn icon" onClick={() => setHintOff(true)} aria-label="Tutup petunjuk">
                ✕
              </button>
              <b>Mulai merakit</b>
              <ol>
                <li>Seret Sales, Prompt, dan Proses AW ke kanvas</li>
                <li>Tarik garis antar titik yang warnanya sama</li>
                <li>Tekan Run</li>
              </ol>
              <button className="link-btn" onClick={() => setHelp('top')}>
                Lihat panduan dan contoh susunan →
              </button>
            </div>
          )}
          {hintText && (
            <div className="link-banner">
              <b>{hintText.label}</b> {hintText.text}
              {hintText.legend && (
                <span className="link-legend">
                  <i className="to" /> bisa jadi tujuannya
                  <i className="from" /> bisa jadi sumbernya
                </span>
              )}
            </div>
          )}
          {message && (
            <div className="toast" onClick={() => setMessage('')}>
              {message} <span className="muted">(klik untuk tutup)</span>
            </div>
          )}
        </div>

        <aside className="panel">
          {selected ? (
            <ConfigPanel
              workflowId={workflowId}
              key={selected.id}
              type={selected.data.type}
              config={selected.data.config}
              companyId={company.id}
              catalog={catalog}
              onChange={patchSelected}
              onHelp={() => setHelp(selected.data.type)}
              onDelete={() => {
                setEdges((es) => es.filter((e) => e.source !== selected.id && e.target !== selected.id));
                setNodes((ns) => ns.filter((n) => n.id !== selected.id));
              }}
            />
          ) : (
            <div className="panel-body">
              <div className="panel-title">Pemeriksaan</div>
              {!company.id && <div className="notice">Company belum dipilih.</div>}
              {issues.length === 0 && company.id ? (
                <div className="ready">✓ Workflow lengkap dan siap dijalankan.</div>
              ) : issues.length === 0 ? null : (
                <ul className="issues">
                  {issues.map((i, k) => (
                    <li key={k}>{i.message}</li>
                  ))}
                </ul>
              )}
              <div className="panel-title">Riwayat run</div>
              {runs.length === 0 && <p className="muted small">Belum ada run.</p>}
              {runs.map((r) => (
                <a key={r.id} className="run-row" href={`#/w/${workflowId}/run/${r.id}`}>
                  <span className={`badge st-${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                  <span className="small">
                    {r.params.start_date} s/d {r.params.end_date}
                  </span>
                  <span className="muted small">
                    {fmtTime(r.created_at)} · {r.unit_count} AW
                  </span>
                </a>
              ))}
              <p className="muted small">Klik sebuah node untuk mengaturnya. Untuk memutus sambungan, arahkan kursor ke garis lalu klik tanda × yang muncul.</p>
            </div>
          )}
        </aside>
      </div>

      {help && <HelpDrawer focus={help} onClose={() => setHelp(null)} />}

      {badLink && (
        <div className="modal-back" onClick={() => setBadLink(null)}>
          <div className="card modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              {NODE_SPECS[badLink.from].label} tidak bisa disambung ke {NODE_SPECS[badLink.to].label}
            </h3>
            <p className="small">{badLink.reason}</p>
            <div className="link-help">
              <div>
                <div className="help-k">{NODE_SPECS[badLink.from].label} bisa mengarah ke</div>
                <NodeChips types={targetsOf(badLink.from)} empty="Tidak mengarah ke mana pun; ini ujung alur." />
              </div>
              <div>
                <div className="help-k">{NODE_SPECS[badLink.to].label} menerima dari</div>
                <NodeChips types={sourcesOf(badLink.to)} empty="Tidak menerima sambungan; ini titik awal." />
              </div>
            </div>
            <div className="row end">
              <button
                className="btn"
                onClick={() => {
                  setHelp(badLink.from);
                  setBadLink(null);
                }}
              >
                Buka panduan
              </button>
              <button className="btn primary" autoFocus onClick={() => setBadLink(null)}>
                Mengerti
              </button>
            </div>
          </div>
        </div>
      )}

      {runOpen && (
        <div className="modal-back" onClick={() => setRunOpen(false)}>
          <div className="card modal" onClick={(e) => e.stopPropagation()}>
            <h3>{hasAw ? 'Jalankan workflow' : 'Ambil laporan'}</h3>
            <p className="muted small">
              Company <strong>{company.name}</strong>.{' '}
              {!hasAw
                ? 'Workflow ini hanya mengambil laporan yang sudah ada; tidak ada Audital Work yang dijalankan dan tidak ada token AI yang terpakai.'
                : `Rencana dan estimasi token dihitung dulu${settings.requireApproval === false ? ', lalu run langsung berjalan.' : '; belum ada token AI yang terpakai sampai Anda menyetujuinya.'}`}
            </p>
            {needsDates ? (
              <div className="row">
                <label>
                  Tanggal mulai
                  <input type="date" value={runDates.start_date} onChange={(e) => setRunDates({ ...runDates, start_date: e.target.value })} />
                </label>
                <label>
                  Tanggal selesai
                  <input type="date" value={runDates.end_date} onChange={(e) => setRunDates({ ...runDates, end_date: e.target.value })} />
                </label>
              </div>
            ) : (
              <p className="small">{hasAw ? 'Periode analisis mengikuti pengaturan setiap node Proses AW, dengan hari ini sebagai tanggal acuan.' : 'Tidak perlu tanggal: yang diambil adalah run terakhir tiap jadwal dan history yang sudah dipilih.'}</p>
            )}
            {hasSync && (
              <div className="choice-group">
                <div className="choice-title">Sinkronisasi data sebelum audit</div>
                {(
                  [
                    ['skip', 'Langsung jalan', 'Tanpa sync; memakai data yang sudah ada.'],
                    ['stale', `Sync bila perlu`, `Sales yang sudah disinkron dalam ${staleMin} menit terakhir dilewati; sisanya sync dulu.`],
                    ['always', 'Sync dulu', 'Semua sales disinkron sebelum audit dimulai.'],
                  ] as const
                ).map(([value, title, text]) => (
                  <label key={value} className={`choice ${syncChoice === value ? 'on' : ''}`}>
                    <input type="radio" name="sync" checked={syncChoice === value} onChange={() => setSyncPolicy(value)} />
                    <span>
                      <b>{title}</b>
                      <span className="muted small">{text}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            {hasChunk && (
              <p className="muted small">
                Berikutnya: lihat jumlah kontak, pesan, dan token yang tersedia, tentukan ukuran chunk, lalu periksa daftar Audital Work sebelum menjalankan.
              </p>
            )}
            {runError.length > 0 && (
              <ul className="issues">
                {runError.map((m, k) => (
                  <li key={k}>{m}</li>
                ))}
              </ul>
            )}
            <div className="row end">
              <button className="btn" onClick={() => setRunOpen(false)}>
                Batal
              </button>
              <button className="btn primary" onClick={startRun} disabled={!runDates.start_date || !runDates.end_date || runDates.end_date < runDates.start_date}>
                Lanjut →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function Editor({ workflowId }: { workflowId: string }) {
  return (
    <ReactFlowProvider>
      <EditorInner workflowId={workflowId} />
    </ReactFlowProvider>
  );
}
