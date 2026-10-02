// Merge AI lewat OpenRouter: menggabungkan laporan dengan model pilihan user, memakai API key yang diisi di node.
// Tidak bergantung pada endpoint merge AutoAudit.

export interface AiReport {
  label: string;
  content: string;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
}

const BASE = 'https://openrouter.ai/api/v1';
const tokens = (s: string) => Math.ceil(s.length / 3.2); // perkiraan kasar; teks Indonesia + tabel cenderung boros token

export async function listModels(doFetch: typeof fetch = fetch): Promise<OpenRouterModel[]> {
  const res = await doFetch(`${BASE}/models`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`OpenRouter membalas ${res.status} saat mengambil daftar model.`);
  const j: any = await res.json();
  return (j.data ?? [])
    .filter((m: any) => (m.architecture?.output_modalities ?? ['text']).includes('text'))
    .map((m: any) => ({ id: String(m.id), name: String(m.name ?? m.id), context_length: Number(m.context_length) || 0 }));
}

// Memeriksa key tanpa memakai kredit: OpenRouter membalas info limit dan pemakaian.
export async function checkKey(key: string, doFetch: typeof fetch = fetch): Promise<{ ok: boolean; message: string }> {
  const res = await doFetch(`${BASE}/key`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401) return { ok: false, message: 'Key ditolak OpenRouter. Periksa kembali isinya.' };
  if (!res.ok) return { ok: false, message: `OpenRouter membalas ${res.status}.` };
  const d: any = ((await res.json()) as any).data ?? {};
  const left = d.limit_remaining ?? (d.limit != null && d.usage != null ? d.limit - d.usage : null);
  return { ok: true, message: `Key valid${d.label ? ` (${d.label})` : ''}${left != null ? `, sisa limit $${Number(left).toFixed(2)}` : d.limit == null ? ', tanpa batas limit' : ''}.` };
}

function explain(status: number, body: any): string {
  const detail = String(body?.error?.message ?? '').slice(0, 200);
  if (status === 401) return 'API key OpenRouter ditolak. Isi ulang key di node Merge AI.';
  if (status === 402) return 'Saldo atau limit OpenRouter tidak cukup untuk permintaan ini.';
  if (status === 404) return `Model tidak ditemukan di OpenRouter. ${detail}`;
  if (status === 429) return 'OpenRouter sedang membatasi laju permintaan. Coba Lanjutkan beberapa saat lagi.';
  return `OpenRouter membalas ${status}. ${detail}`.trim();
}

async function complete(key: string, model: string, system: string, user: string, doFetch: typeof fetch) {
  const res = await doFetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'AutoAudit Workflow Builder' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  const body: any = await res.json().catch(() => null);
  // OpenRouter kadang membalas 200 dengan objek error di dalamnya (galat dari penyedia model).
  if (!res.ok || body?.error) throw new Error(explain(res.ok ? Number(body.error.code) || 502 : res.status, body));
  const choice = body?.choices?.[0];
  const content = String(choice?.message?.content ?? '');
  if (!content.trim()) throw new Error('Model membalas jawaban kosong.');
  if (choice.finish_reason === 'length') throw new Error('Jawaban model terpotong karena batas panjang keluaran. Pilih model dengan keluaran lebih besar, atau kurangi jumlah laporan per merge.');
  return { content, tokens: Number(body?.usage?.total_tokens) || 0 };
}

// Laporan dikelompokkan supaya tiap panggilan muat di konteks model (separuh konteks untuk masukan,
// sisanya untuk jawaban). Satu laporan yang sendirian sudah terlalu besar tetap dikirim sendiri.
export function groupByBudget(reports: AiReport[], budgetTokens: number): AiReport[][] {
  const groups: AiReport[][] = [];
  let cur: AiReport[] = [];
  let used = 0;
  for (const r of reports) {
    const t = tokens(r.content) + 50;
    if (cur.length && used + t > budgetTokens) {
      groups.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(r);
    used += t;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

export async function aiMerge(input: {
  key: string;
  model: string;
  contextLength: number;
  prompt: string;
  title: string;
  reports: AiReport[];
  fetch?: typeof fetch;
}): Promise<{ content: string; calls: number; tokens: number; levels: number }> {
  const doFetch = input.fetch ?? fetch;
  const budget = Math.max(500, Math.floor((input.contextLength || 120_000) * 0.5) - tokens(input.prompt));
  let current = input.reports;
  let calls = 0;
  let used = 0;
  let levels = 0;

  for (;;) {
    const groups = groupByBudget(current, budget);
    if (levels > 0 && groups.length >= current.length) {
      throw new Error('Laporan terlalu besar untuk digabung dengan model ini. Pilih model dengan konteks lebih besar.');
    }
    levels++;
    const last = groups.length === 1;
    const next: AiReport[] = [];
    // Kelompok dalam satu tingkat dikerjakan berurutan supaya tidak memicu batas laju OpenRouter.
    for (const [i, g] of groups.entries()) {
      const body = g.map((r, k) => `## Laporan ${k + 1}: ${r.label}\n\n${r.content.trim()}`).join('\n\n---\n\n');
      const note = last ? '' : `\n\nIni bagian ${i + 1} dari ${groups.length}. Hasil bagian-bagian akan digabung lagi, jadi pertahankan semua data dan baris tabel; jangan diringkas berlebihan.`;
      const out = await complete(input.key, input.model, input.prompt + note, `Gabungkan ${g.length} laporan berikut menjadi satu laporan.\n\n${body}`, doFetch);
      calls++;
      used += out.tokens;
      next.push({ label: last ? input.title : `${input.title} (bagian ${i + 1})`, content: out.content });
    }
    if (last) return { content: next[0].content, calls, tokens: used, levels };
    current = next;
  }
}
