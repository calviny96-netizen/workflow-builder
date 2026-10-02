import { Children, isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Opt {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

interface Props {
  value: string | number | null | undefined;
  onChange: (e: { target: { value: string } }) => void;
  children: ReactNode; // elemen <option value="…" data-hint="…">Label</option>, sama seperti <select> biasa
  disabled?: boolean;
  placeholder?: string;
}

const SEARCH_FROM = 6; // kotak cari muncul bila pilihan lebih dari lima
const MAX_SHOWN = 80;

// Membaca <option> dari children supaya pemakaiannya sama dengan <select> bawaan.
function readOptions(children: ReactNode): Opt[] {
  const out: Opt[] = [];
  Children.forEach(children, (c) => {
    if (Array.isArray(c)) return void out.push(...readOptions(c));
    if (!isValidElement(c)) return;
    const p = c.props as any;
    if (c.type === 'option') {
      const label = Children.toArray(p.children).join('');
      out.push({ value: String(p.value ?? label), label, hint: p['data-hint'], disabled: p.disabled });
    } else if (p?.children) out.push(...readOptions(p.children));
  });
  return out;
}

// Dropdown bergaya: tombol + daftar melayang, dengan pencarian bila pilihannya banyak dan navigasi keyboard.
export function Select({ value, onChange, children, disabled, placeholder }: Props) {
  const options = useMemo(() => readOptions(children), [children]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ left: number; top: number; width: number; up: boolean; maxH: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.value === String(value ?? ''));
  const searchable = options.length >= SEARCH_FROM;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = words.length ? options.filter((o) => words.every((w) => `${o.label} ${o.hint ?? ''} ${o.value}`.toLowerCase().includes(w))) : options;
  const shown = matches.slice(0, MAX_SHOWN);

  // Daftar melayang ditempel ke <body> dengan posisi tetap, supaya tidak terpotong panel yang bisa digulung.
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const place = () => {
      const r = trigger.current!.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 12;
      const up = below < 220 && r.top > below;
      setBox({ left: r.left, top: up ? r.top - 6 : r.bottom + 6, width: Math.max(r.width, 220), up, maxH: Math.min(340, (up ? r.top : below) - 8) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setActive(Math.max(0, options.findIndex((o) => o.value === String(value ?? ''))));
    const away = (e: MouseEvent) => {
      if (!pop.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  useEffect(() => {
    list.current?.querySelector('.sel-opt.active')?.scrollIntoView({ block: 'nearest' });
  }, [active, open, box]);

  const pick = (o: Opt | undefined) => {
    if (!o || o.disabled) return;
    onChange({ target: { value: o.value } });
    setOpen(false);
    trigger.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return setOpen(true);
      setActive((i) => Math.min(shown.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
  };

  return (
    <>
      <button
        type="button"
        ref={trigger}
        className={`sel ${open ? 'open' : ''} ${current && current.value !== '' ? '' : 'empty'}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
      >
        <span className="sel-value">{current?.label || placeholder || 'Pilih…'}</span>
        <svg className="sel-caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open &&
        box &&
        createPortal(
          <div
            ref={pop}
            className={`sel-pop ${box.up ? 'up' : ''}`}
            style={{ left: box.left, top: box.top, width: box.width, maxHeight: box.maxH }}
            role="listbox"
            onKeyDown={onKey}
          >
            {searchable && (
              <div className="sel-search">
                <input
                  autoFocus
                  value={q}
                  placeholder={`Cari dari ${options.length} pilihan…`}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setActive(0);
                  }}
                />
              </div>
            )}
            <div className="sel-list" ref={list}>
              {shown.map((o, i) => (
                <button
                  type="button"
                  key={o.value + i}
                  role="option"
                  aria-selected={o.value === current?.value}
                  disabled={o.disabled}
                  className={`sel-opt ${i === active ? 'active' : ''} ${o.value === current?.value ? 'chosen' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(o)}
                >
                  <span className="sel-opt-text">
                    <span>{o.label}</span>
                    {o.hint && <span className="sel-opt-hint">{o.hint}</span>}
                  </span>
                  {o.value === current?.value && <span className="sel-check">✓</span>}
                </button>
              ))}
              {shown.length === 0 && <div className="sel-empty">Tidak ada yang cocok dengan "{q}".</div>}
              {matches.length > shown.length && <div className="sel-empty">Menampilkan {shown.length} dari {matches.length}. Ketik untuk mempersempit.</div>}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
