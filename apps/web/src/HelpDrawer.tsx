import { useEffect, useRef } from 'react';
import type React from 'react';
import { NODE_SPECS, PALETTE, sourcesOf, targetsOf } from '@nodes';
import type { NodeType, PortSpec } from '@nodes';
import { STATUS_LABEL } from './api.ts';
import { GROUPS, NODE_HELP, PORT_HELP, RECIPES } from './help.ts';
import { ShapeSvg } from './shapes.tsx';

export function NodeIcon({ type, size = 34 }: { type: NodeType; size?: number }) {
  const s = NODE_SPECS[type];
  const h = s.shape === 'pill' ? size * 0.6 : size * 0.88;
  return (
    <span className="node-icon" style={{ width: size, height: size }}>
      <ShapeSvg shape={s.shape} w={size} h={h} fill={`color-mix(in srgb, ${s.color} 12%, white)`} stroke={s.color} />
    </span>
  );
}

// Rangkaian node sebagai diagram kecil: bentuk + nama, dihubungkan panah.
export function Flow({ nodes, highlight, onPick }: { nodes: NodeType[]; highlight?: NodeType; onPick?: (t: NodeType) => void }) {
  return (
    <div className="flow">
      {nodes.map((t, i) => (
        <span className="flow-step" key={i}>
          {i > 0 && (
            <svg className="flow-arrow" width="22" height="12" viewBox="0 0 22 12" aria-hidden>
              <path d="M1 6h17M14 1.5 19 6l-5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          <button className={`flow-node ${highlight === t ? 'is-me' : ''}`} style={{ '--c': NODE_SPECS[t].color } as React.CSSProperties} onClick={() => onPick?.(t)} title={`Lihat panduan ${NODE_SPECS[t].label}`}>
            <NodeIcon type={t} size={20} />
            {NODE_SPECS[t].label}
          </button>
        </span>
      ))}
    </div>
  );
}

// Daftar node yang bisa disambung, sebagai chip yang bisa diklik.
export function NodeChips({ types, onPick, empty }: { types: NodeType[]; onPick?: (t: NodeType) => void; empty: string }) {
  if (!types.length) return <span className="muted small">{empty}</span>;
  return (
    <div className="chips">
      {types.map((t) => (
        <button key={t} className="node-chip" style={{ '--c': NODE_SPECS[t].color } as React.CSSProperties} onClick={() => onPick?.(t)}>
          <NodeIcon type={t} size={18} />
          {NODE_SPECS[t].label}
        </button>
      ))}
    </div>
  );
}

function Ports({ title, ports, input }: { title: string; ports: PortSpec[]; input?: boolean }) {
  return (
    <div className="help-ports">
      <span className="help-k">{title}</span>
      {ports.length === 0 ? (
        <span className="muted">tidak ada</span>
      ) : (
        ports.map((p) => (
          <span key={p.id} className="port-chip">
            {(p.accepts ?? [p.type]).map((t) => (
              <i key={t} style={{ background: PORT_HELP[t].color }} />
            ))}
            {p.label}
            {input && !p.required ? ' (opsional)' : ''}
          </span>
        ))
      )}
    </div>
  );
}

// Laci panduan: dibuka lewat tombol "?" atau tautan di panel node. Tidak memakan ruang kanvas saat tertutup.
export function HelpDrawer({ focus, onClose }: { focus: NodeType | 'top'; onClose: () => void }) {
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);

  useEffect(() => {
    const el = focus === 'top' ? null : body.current?.querySelector(`#help-${focus}`);
    if (el) el.scrollIntoView({ block: 'start' });
    else body.current?.scrollTo({ top: 0 });
  }, [focus]);

  const jump = (t: string) => body.current?.querySelector(`#help-${t}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });

  return (
    <div className="drawer-back" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label="Panduan" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <div className="drawer-title">Panduan</div>
            <div className="muted small">Fungsi tiap node dan cara merakitnya</div>
          </div>
          <button className="btn icon" onClick={onClose} aria-label="Tutup panduan">
            ✕
          </button>
        </header>

        <nav className="help-nav">
          {PALETTE.map((t) => (
            <button key={t} className="help-nav-item" onClick={() => jump(t)} title={NODE_SPECS[t].label}>
              <NodeIcon type={t} size={22} />
              {NODE_SPECS[t].label}
            </button>
          ))}
        </nav>

        <div className="drawer-body" ref={body}>
          <section className="help-section">
            <h3>Cara kerja singkat</h3>
            <ol className="help-steps">
              <li>
                <b>Company dipilih saat membuat workflow.</b> Daftar sales, prompt, memory, dan model mengikuti company itu, dan tidak bisa diganti sesudahnya.
              </li>
              <li>
                <b>Seret node</b> dari palet kiri ke kanvas, lalu klik node untuk mengaturnya di panel kanan.
              </li>
              <li>
                <b>Tarik garis</b> dari titik di tepi node ke titik node berikutnya. Hanya titik berwarna sama yang bisa disambung.
              </li>
              <li>
                <b>Tekan Run</b>, isi rentang tanggal. Rencana dan estimasi token muncul dulu; token baru terpakai setelah Anda menyetujui.
              </li>
            </ol>
          </section>

          <section className="help-section">
            <h3>Contoh susunan</h3>
            {RECIPES.map((r) => (
              <div className="recipe" key={r.title}>
                <b>{r.title}</b>
                <Flow nodes={r.flow} onPick={jump} />
                {r.side && (
                  <div className="flow-side">
                    <span className="muted small">ditambah</span>
                    <NodeChips types={r.side} onPick={jump} empty="" />
                    <span className="muted small">ke Proses AW</span>
                  </div>
                )}
                <span className="muted small">{r.note}</span>
              </div>
            ))}
          </section>

          {GROUPS.map((g) => (
            <section className="help-section" key={g.title}>
              <h3>
                {g.title} <span className="muted small">· {g.hint}</span>
              </h3>
              {g.types.map((t) => {
                const spec = NODE_SPECS[t];
                const h = NODE_HELP[t];
                return (
                  <article className={`help-node ${focus === t ? 'is-focus' : ''}`} id={`help-${t}`} key={t}>
                    <div className="help-node-head">
                      <NodeIcon type={t} size={40} />
                      <div>
                        <div className="help-node-title" style={{ color: spec.color }}>
                          {spec.label}
                        </div>
                        <div className="small">{h.tagline}</div>
                      </div>
                    </div>
                    <p className="small">{h.when}</p>
                    <div className="help-conn">
                      <div>
                        <div className="help-k">Menerima dari</div>
                        <NodeChips types={sourcesOf(t)} onPick={jump} empty="Tidak menerima sambungan; ini titik awal." />
                      </div>
                      <div>
                        <div className="help-k">Mengarah ke</div>
                        <NodeChips types={targetsOf(t)} onPick={jump} empty="Tidak mengarah ke mana pun; ini ujung alur." />
                      </div>
                    </div>
                    <Ports title="Titik masuk" ports={spec.inputs} input />
                    <Ports title="Titik keluar" ports={spec.outputs} />
                    <div className="help-k">Pengaturan</div>
                    <ul>
                      {h.settings.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                    <div className="help-k">Perlu diketahui</div>
                    <ul>
                      {h.tips.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                    <div className="help-k">Contoh</div>
                    {h.example.map((line, i) => (
                      <Flow key={i} nodes={line} highlight={t} onPick={jump} />
                    ))}
                  </article>
                );
              })}
            </section>
          ))}

          <section className="help-section">
            <h3>Warna titik sambungan</h3>
            <div className="legend">
              {Object.values(PORT_HELP).map((p) => (
                <div key={p.label}>
                  <i style={{ background: p.color }} />
                  <b>{p.label}</b>
                  <span className="muted">{p.text}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="help-section">
            <h3>Warna status saat run</h3>
            <div className="legend">
              {(['planned', 'queued', 'running', 'done', 'failed', 'skipped'] as const).map((s) => (
                <div key={s} className={`st-${s}`}>
                  <i style={{ background: 'var(--st-fill)', border: '2px solid var(--st-stroke)' }} />
                  <b>{STATUS_LABEL[s]}</b>
                  <span className="muted">
                    {
                      {
                        planned: 'Ada di rencana, belum disetujui.',
                        queued: 'Menunggu giliran karena batas jumlah bersamaan.',
                        running: 'Sedang dikerjakan AutoAudit.',
                        done: 'Laporan sudah tersimpan.',
                        failed: 'Gagal; bisa diulang lewat Lanjutkan.',
                        skipped: 'Tidak ada chat pada bagian ini.',
                      }[s]
                    }
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="help-section">
            <h3>Pintasan</h3>
            <div className="legend keys">
              <div>
                <kbd>?</kbd>
                <span>Buka atau tutup panduan ini</span>
              </div>
              <div>
                <kbd>× di garis</kbd>
                <span>Muncul saat kursor di atas garis; klik untuk memutus sambungan</span>
              </div>
              <div>
                <kbd>Backspace</kbd>
                <span>Hapus node atau garis yang dipilih</span>
              </div>
              <div>
                <kbd>Ctrl/⌘ Z</kbd>
                <span>Batalkan · tambah Shift untuk mengulang</span>
              </div>
              <div>
                <kbd>Klik dua kali</kbd>
                <span>pada node di palet: tambahkan ke tengah kanvas</span>
              </div>
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
