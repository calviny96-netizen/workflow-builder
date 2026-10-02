// Perhitungan murni untuk perencanaan run: tanpa jaringan, tanpa database.
// Rumus chunk diambil dari workflow n8n yang sudah teruji di produksi.

import { createHash } from 'node:crypto';

const DAY_MS = 86_400_000;

export interface DateSlice {
  part: number;
  start_date: string;
  end_date: string;
  days: number;
}

export interface ContactInput {
  phone_number?: string | null;
  chat_key?: string | null;
  message_count?: number | null;
}

export interface ContactSlice {
  part: number;
  chat_numbers: string[];
  contacts: number;
  messages: number;
}

export interface Planned<T> {
  slices: T[];
  warnings: string[];
}

const toMs = (d: string) => Date.parse(d + 'T00:00:00Z');
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function daysBetween(start: string, end: string): number {
  return Math.round((toMs(end) - toMs(start)) / DAY_MS) + 1;
}

// daysPerPart adalah PANJANG rentang tiap bagian, bukan jumlah bagian.
// 1-30 Juli dengan 5 → 6 bagian. Kelebihan dari maxParts digabung ke bagian terakhir.
export function splitByDays(start: string, end: string, daysPerPart: number, maxParts = 40): Planned<DateSlice> {
  const a = toMs(start);
  const b = toMs(end);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) throw new Error(`Rentang tanggal tidak valid: ${start} s/d ${end}`);
  const step = Math.max(1, Math.floor(daysPerPart));
  const cap = Math.max(1, Math.floor(maxParts));

  const slices: DateSlice[] = [];
  for (let t = a; t <= b; t += step * DAY_MS) {
    const last = Math.min(t + (step - 1) * DAY_MS, b);
    slices.push({ part: slices.length + 1, start_date: toIso(t), end_date: toIso(last), days: Math.round((last - t) / DAY_MS) + 1 });
  }

  const warnings: string[] = [];
  if (slices.length > cap) {
    const total = slices.length;
    const tail = slices.splice(cap - 1);
    const first = tail[0];
    slices.push({ part: cap, start_date: first.start_date, end_date: toIso(b), days: daysBetween(first.start_date, toIso(b)) });
    warnings.push(`${total} bagian melebihi batas ${cap}; ${tail.length} bagian terakhir digabung menjadi satu.`);
  }
  return { slices, warnings };
}

// Kontak dibagi bergiliran mulai dari yang terberat supaya beban tiap bagian mirip.
export function splitByContacts(contacts: ContactInput[], contactsPerPart: number, maxParts = 40): Planned<ContactSlice> {
  const seen = new Set<string>();
  const list: { id: string; messages: number }[] = [];
  for (const c of contacts) {
    const id = String(c.phone_number || c.chat_key || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push({ id, messages: Number(c.message_count || 0) });
  }
  if (!list.length) return { slices: [], warnings: [] };

  const per = Math.max(1, Math.floor(contactsPerPart));
  const cap = Math.max(1, Math.floor(maxParts));
  const wanted = Math.ceil(list.length / per);
  const parts = Math.min(wanted, cap);
  const warnings: string[] = [];
  if (wanted > cap) {
    warnings.push(`${wanted} bagian melebihi batas ${cap}; tiap bagian berisi sekitar ${Math.ceil(list.length / cap)} kontak, bukan ${per}.`);
  }

  list.sort((x, y) => y.messages - x.messages);
  const slices: ContactSlice[] = Array.from({ length: parts }, (_, i) => ({ part: i + 1, chat_numbers: [], contacts: 0, messages: 0 }));
  list.forEach((c, i) => {
    const s = slices[i % parts];
    s.chat_numbers.push(c.id);
    s.contacts += 1;
    s.messages += c.messages;
  });
  return { slices, warnings };
}

export interface PreflightNumbers {
  contacts: number;
  tokens: number; // token chat setelah filter
  fixedTokens: number; // prompt + memory + lampiran
  usableContext: number;
  days: number;
}

export interface RecommendOptions {
  outputLimit?: number; // baris keluaran per bagian; jawaban AI terpotong lebih dulu daripada konteks masuk penuh
  safePortion?: number; // porsi konteks yang boleh dipakai
}

export function recommendChunk(pf: PreflightNumbers, opts: RecommendOptions = {}): { daysPerPart: number; contactsPerPart: number } {
  const outputLimit = opts.outputLimit ?? 40;
  const safePortion = opts.safePortion ?? 0.6;
  const days = Math.max(1, pf.days);
  const budget = pf.usableContext > 0 ? pf.usableContext * safePortion - pf.fixedTokens : 0;

  let contactsPerPart = outputLimit;
  let daysPerPart = days;
  if (pf.contacts > 0 && pf.tokens > 0 && budget > 0) {
    const perContact = pf.tokens / pf.contacts;
    contactsPerPart = Math.max(1, Math.min(outputLimit, Math.floor(budget / Math.max(1, perContact)), pf.contacts));
    const fitTokens = Math.floor(budget / Math.max(1, pf.tokens / days));
    const fitOutput = Math.floor(outputLimit / Math.max(0.0001, pf.contacts / days));
    daysPerPart = Math.max(1, Math.min(days, fitTokens, fitOutput));
  }
  if (pf.contacts > 0) contactsPerPart = Math.min(contactsPerPart, pf.contacts);
  return { daysPerPart, contactsPerPart };
}

// Merge bertingkat: API menerima 2-10 sumber per merge. Mengembalikan ukuran kelompok
// tiap tingkat, dibagi rata supaya tidak ada kelompok berisi 1 (11 → [6,5], bukan [10,1]).
export function planMergeTiers(sources: number, maxPerMerge = 10): number[][] {
  if (maxPerMerge < 2) throw new Error('maxPerMerge minimal 2');
  const tiers: number[][] = [];
  let n = Math.floor(sources);
  while (n > 1) {
    const groups = Math.ceil(n / maxPerMerge);
    const base = Math.floor(n / groups);
    const extra = n % groups;
    tiers.push(Array.from({ length: groups }, (_, i) => base + (i < extra ? 1 : 0)));
    n = groups;
  }
  return tiers;
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, stable(x)]),
    );
  }
  return v;
}

// Sidik jari unit AW. "Lanjutkan dari yang gagal" hanya boleh bila nilainya tidak berubah.
// promptText adalah ISI prompt, bukan id saved prompt, karena isinya bisa diubah di AutoAudit.
export function fingerprint(unit: {
  promptText: string;
  model: string;
  memoryIds: number[];
  filter: unknown;
  runBySuperadmin: boolean;
  source: { channel: string; id: number };
}): string {
  const normalized = stable({ ...unit, memoryIds: [...unit.memoryIds].sort((a, b) => a - b) });
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

// Unik per unit walau dibuat dalam milidetik yang sama (bug correlation_id kembar di n8n).
export function correlationId(runId: string, nodeId: string, seq: number): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `aawb-${runId}-${nodeId}-${seq}-${rand}`;
}
