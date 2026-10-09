import { useEffect, useRef, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Handle, Position, useReactFlow } from '@xyflow/react';
import type { EdgeProps, NodeProps } from '@xyflow/react';
import { EXPORT_FORMATS, NODE_SPECS, parseChatIds, httpUrl, PERIOD_LABELS } from '@nodes';
import type { NodeType, Shape } from '@nodes';
import { STATUS_LABEL } from './api.ts';

const SIZE: Record<Shape, [number, number]> = {
  pill: [150, 56],
  square: [118, 118],
  diamond: [136, 136],
  trapezoid: [150, 84],
  document: [150, 92],
  cylinder: [128, 104],
  parallelogram: [156, 76],
  table: [150, 84],
  circle: [104, 104],
  hexagon: [150, 96],
};

export function ShapeSvg({ shape, w, h, fill, stroke, dashed }: { shape: Shape; w: number; h: number; fill: string; stroke: string; dashed?: boolean }) {
  // fill/stroke lewat style supaya nilai CSS seperti var() dan color-mix() berlaku.
  const common = { style: { fill, stroke }, strokeWidth: 2, strokeDasharray: dashed ? '5 4' : undefined, strokeLinejoin: 'round' as const };
  const p = 1.5; // ruang untuk garis tepi
  const k = Math.min(22, w * 0.16); // kemiringan sisi trapesium / jajar genjang
  let el;
  if (shape === 'pill') el = <rect x={p} y={p} width={w - 2 * p} height={h - 2 * p} rx={(h - 2 * p) / 2} {...common} />;
  else if (shape === 'square') el = <rect x={p} y={p} width={w - 2 * p} height={h - 2 * p} rx={3} {...common} />;
  else if (shape === 'diamond') el = <polygon points={`${w / 2},${p} ${w - p},${h / 2} ${w / 2},${h - p} ${p},${h / 2}`} {...common} />;
  else if (shape === 'trapezoid') el = <polygon points={`${k},${p} ${w - k},${p} ${w - p},${h - p} ${p},${h - p}`} {...common} />;
  else if (shape === 'parallelogram') el = <polygon points={`${k},${p} ${w - p},${p} ${w - k},${h - p} ${p},${h - p}`} {...common} />;
  else if (shape === 'hexagon') el = <polygon points={`${w * 0.2},${p} ${w * 0.8},${p} ${w - p},${h / 2} ${w * 0.8},${h - p} ${w * 0.2},${h - p} ${p},${h / 2}`} {...common} />;
  else if (shape === 'circle') el = <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - p} ry={h / 2 - p} {...common} />;
  else if (shape === 'table') {
    // Persegi panjang bergaris: baris-baris tabel.
    el = (
      <>
        <rect x={p} y={p} width={w - 2 * p} height={h - 2 * p} rx={3} {...common} />
        <line x1={p} y1={h * 0.26} x2={w - p} y2={h * 0.26} stroke={stroke} strokeWidth={1.5} />
        <line x1={p} y1={h * 0.78} x2={w - p} y2={h * 0.78} stroke={stroke} strokeWidth={1} opacity={0.5} />
      </>
    );
  } else if (shape === 'document') {
    const b = h - Math.min(14, h * 0.2);
    el = <path d={`M${p},${p} H${w - p} V${b} C${w * 0.75},${b - 14} ${w * 0.6},${h + 4} ${w / 2},${b} C${w * 0.35},${b - 12} ${w * 0.2},${h + 2} ${p},${b} Z`} {...common} />;
  } else {
    const ry = Math.min(13, h * 0.2);
    el = (
      <>
        <path d={`M${p},${ry} V${h - ry} A${w / 2 - p},${ry - p} 0 0 0 ${w - p},${h - ry} V${ry}`} {...common} />
        <ellipse cx={w / 2} cy={ry} rx={w / 2 - p} ry={ry - p} {...common} />
      </>
    );
  }
  return (
    <svg width={w} height={h} className="shape-svg" aria-hidden>
      {el}
    </svg>
  );
}

function summary(type: NodeType, c: Record<string, any>): string {
  if (type === 'sales') {
    const n = c.sales?.length ?? 0;
    const official = (c.sales ?? []).filter((s: any) => s.channel === 'whatsapp_official').length;
    return n === 0 ? 'belum dipilih' : n === 1 ? `${c.sales[0].name}${official ? ' · Official' : ''}` : `${n - official} sales · ${official} Official`;
  }
  if (type === 'prompt') return c.mode === 'text' ? 'teks bebas' : c.title || 'belum dipilih';
  if (type === 'memory') return `${c.memories?.length ?? 0} memory`;
  if (type === 'chunk') {
    const unit = c.mode === 'contacts' ? 'kontak' : 'hari';
    return c.size ? `per ${c.size} ${unit}` : `per ${unit} · usulan`;
  }
  if (type === 'aw') return c.analysisPeriod && c.analysisPeriod.mode !== 'run' ? `${c.analysisSchedule?.enabled ? '◷ ' : ''}${PERIOD_LABELS[c.analysisPeriod.mode as keyof typeof PERIOD_LABELS] ?? 'periode?'} · ${String(c.model || 'model?').split('/').pop()}` : `${String(c.model || 'model?').split('/').pop()} · ${c.runBySuperadmin ? 'Superadmin' : 'Company'}`;
  if (type === 'code') return `${c.language === 'python' ? 'Python' : 'JavaScript'} · ${c.runMode === 'each' ? 'per item' : 'semua item'}`;
  if (type === 'trigger') return c.mode === 'webhook' ? 'webhook' : c.mode === 'schedule' ? `jadwal ${c.triggerSchedule?.frequency ?? 'daily'} · ${c.triggerSchedule?.time ?? '08:00'} WIB` : 'manual · rentang tanggal';
  if (type === 'parse') return c.tables === 'first' ? 'tabel pertama' : 'semua tabel';
  if (type === 'export') return `${EXPORT_FORMATS[c.format]?.label ?? 'format?'} · ${c.split === 'combined' ? 'digabung' : 'per laporan'}`;
  if (type === 'merge') return c.title || 'lewat AutoAudit';
  if (type === 'aimerge') return c.model ? String(c.model).split('/').pop()! : 'model?';
  if (type === 'history') return `${c.items?.length ?? 0} history`;
  if (type === 'continuous') return c.scheduleLabel ? `${c.scheduleLabel} · ${c.pick === 'range' ? 'rentang tanggal' : 'run terakhir'}` : 'jadwal?';
  if (type === 'sync') return c.policy === 'skip' ? 'dilewati' : c.policy === 'always' ? 'selalu sync' : `bila > ${c.staleMinutes ?? 30} menit`;
  if (type === 'message') return c.target ? `ke ${c.target}` : 'tujuan?';
  if (type === 'http') {
    try {
      return new URL(httpUrl(c)).host;
    } catch {
      return 'URL?';
    }
  }
  if (type === 'sheets') return c.tabTitle ? `${c.tabTitle} · ${{ append: 'tambah', upsert: 'perbarui', dedup: 'yang baru' }[c.mode as string] ?? ''}` : 'belum diatur';
  return 'laporan';
}

// Posisi port. Ketupat AW: sumber di kiri, prompt di atas, memory di bawah, laporan di kanan.
function handlePosition(type: NodeType, handle: string, side: 'in' | 'out'): Position {
  if (type === 'aw' && handle === 'prompt') return Position.Top;
  if (type === 'aw' && handle === 'memory') return Position.Bottom;
  // Prompt biasanya diletakkan di atas AW dan Memory di bawahnya, jadi keluarannya menghadap ke sana.
  if (type === 'prompt' && side === 'out') return Position.Bottom;
  if (type === 'memory' && side === 'out') return Position.Top;
  return side === 'in' ? Position.Left : Position.Right;
}

export interface WfNodeData extends Record<string, unknown> {
  type: NodeType;
  config: Record<string, any>;
  hasIssue?: boolean;
  status?: string; // status langkah di tampilan run
  glow?: 'to' | 'from' | 'both' | 'origin' | 'dim'; // petunjuk saat menarik garis atau menyeret node baru
  glowHandles?: string[];
  readOnly?: boolean;
}

export function WorkflowNode({ data, selected }: NodeProps) {
  const d = data as WfNodeData;
  const spec = NODE_SPECS[d.type];
  const [w, h] = SIZE[spec.shape];
  return (
    <div className={`wf-node ${selected ? 'is-selected' : ''} ${d.status ? 'st-' + d.status : ''} ${d.glow ? 'glow-' + d.glow : ''}`} style={{ width: w, height: h }} title={spec.description}>
      <ShapeSvg shape={spec.shape} w={w} h={h} fill={d.status ? 'var(--st-fill)' : `color-mix(in srgb, ${spec.color} 7%, white)`} stroke={d.hasIssue ? 'var(--bad)' : spec.color} dashed={spec.dashed} />
      {d.type === 'aw' && (d.config.contactMode === 'only' || d.config.contactMode === 'exclude') && (
        <span className={`node-tag ${d.config.contactMode}`} title="Filter kontak aktif di node ini">
          {d.config.contactMode === 'only' ? 'hanya' : 'kecuali'} {parseChatIds(d.config.contactNumbers, d.config.chatType || 'individual').numbers.length} chat
        </span>
      )}
      {d.hasIssue && <span className="node-flag" title="Node ini belum lengkap">!</span>}
      <div className="wf-node-body">
        <div className="wf-node-title" style={{ color: spec.color }}>
          {d.type === 'code' && d.config.title ? d.config.title : spec.label}
        </div>
        <div className="wf-node-sub">{d.status ? (STATUS_LABEL[d.status] ?? d.status) : summary(d.type, d.config)}</div>
      </div>
      {spec.inputs.map((p) => (
        <Handle key={p.id} id={p.id} type="target" position={handlePosition(d.type, p.id, 'in')} className={`port port-${p.type} ${d.glow && d.glow !== 'dim' && d.glowHandles?.includes(p.id) ? 'port-glow' : ''}`} title={`masuk: ${p.label}`} isConnectable={!d.readOnly} />
      ))}
      {spec.outputs.map((p) => (
        <Handle key={p.id} id={p.id} type="source" position={handlePosition(d.type, p.id, 'out')} className={`port port-${p.type} ${d.glow && d.glow !== 'dim' && d.glowHandles?.includes(p.id) ? 'port-glow' : ''}`} title={`keluar: ${p.label}`} isConnectable={!d.readOnly} />
      ))}
    </div>
  );
}

export interface UnitNodeData extends Record<string, unknown> {
  label: string;
  status: string;
  count?: number; // >1 berarti grup yang ditutup
  statusLabel?: string;
  shape?: Shape; // ketupat untuk Audital Work, persegi untuk laporan yang hanya diambil
  tally?: Record<string, number>;
}

// Satu ketupat kecil per Audital Work hasil chunk, diwarnai menurut statusnya.
export function UnitNode({ data, selected }: NodeProps) {
  const d = data as UnitNodeData;
  const size = d.count ? 112 : 84;
  // Label ringkas di bawah ketupat: "2026-09-24 s/d 2026-09-25" → "24/09 – 25/09".
  const tail = d.label.includes(' · ') ? d.label.split(' · ').slice(1).join(' · ') : d.label;
  const short = tail.replace(/(\d{4})-(\d{2})-(\d{2})/g, '$3/$2').replace(' s/d ', ' – ');
  return (
    <div className={`unit-node st-${d.status} ${selected ? 'is-selected' : ''}`} style={{ width: size, height: size }} title={`${d.label}\n${STATUS_LABEL[d.status] ?? d.status}`}>
      <ShapeSvg shape={d.shape ?? 'diamond'} w={size} h={size} fill="var(--st-fill)" stroke="var(--st-stroke)" dashed={d.status === 'skipped' || d.status === 'planned'} />
      <div className="wf-node-body">
        {d.count ? (
          <>
            <div className="unit-count">×{d.count}</div>
            <div className="unit-caption">klik untuk buka</div>
          </>
        ) : (
          <div className="unit-status">{d.statusLabel ?? STATUS_LABEL[d.status] ?? d.status}</div>
        )}
      </div>
      {!d.count && <div className="unit-label">{short}</div>}
      <Handle id="source" type="target" position={Position.Left} className="port port-source" isConnectable={false} />
      <Handle id="prompt" type="target" position={Position.Top} className="port port-prompt" isConnectable={false} />
      <Handle id="memory" type="target" position={Position.Bottom} className="port port-memory" isConnectable={false} />
      <Handle id="out" type="source" position={Position.Right} className="port port-report" isConnectable={false} />
    </div>
  );
}

// Garis di editor: tombol × untuk memutus sambungan muncul saat kursor di atas garis (atau garis dipilih).
export function CutEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected }: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const { deleteElements } = useReactFlow();
  const [hover, setHover] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Jeda singkat saat kursor pergi, supaya sempat berpindah dari garis ke tombol tanpa tombolnya hilang.
  const enter = () => {
    if (timer.current) clearTimeout(timer.current);
    setHover(true);
  };
  const leave = () => {
    timer.current = setTimeout(() => setHover(false), 180);
  };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      {/* Jalur lebar tak terlihat supaya garis tipis mudah disentuh kursor. */}
      <path d={path} fill="none" stroke="transparent" strokeWidth={22} onMouseEnter={enter} onMouseLeave={leave} />
      {(hover || selected) && (
        <EdgeLabelRenderer>
          <button
            className={`edge-cut nodrag nopan ${selected ? 'on' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onMouseEnter={enter}
            onMouseLeave={leave}
            onClick={(e) => {
              e.stopPropagation();
              deleteElements({ edges: [{ id }] });
            }}
            title="Putuskan sambungan ini"
            aria-label="Putuskan sambungan"
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const nodeTypes = { wf: WorkflowNode, unit: UnitNode };
export const edgeTypes = { cut: CutEdge };
