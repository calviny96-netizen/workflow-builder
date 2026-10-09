import { parsePhones } from './phones.ts';
import type { ParsedPhones } from './phones.ts';

export interface ParsedChatIds extends ParsedPhones {
  groups: string[];
}

// AutoAudit menerima ID grup angka dan JID @g.us. Bentuk angka dipakai agar
// pilihan yang ditempel cocok dengan phone_number/chat_key pada daftar kontak.
export function normalizeChatId(value: unknown): string {
  return String(value ?? '').trim().replace(/@(g\.us|c\.us|s\.whatsapp\.net)$/i, '');
}

export function parseChatIds(text: string, chatType = 'both'): ParsedChatIds {
  const numbers: string[] = [];
  const groups: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  for (const raw of String(text ?? '').split(/[\n,;]+/)) {
    const piece = raw.trim();
    if (!piece) continue;
    const groupJid = /^(\d+(?:-\d+)?)@g\.us$/i.exec(piece);
    const legacyGroup = /^\d+-\d+$/.test(piece) && (chatType === 'group' || piece.replace('-', '').length > 15);
    const isGroup = !!groupJid || /^\d{16,}$/.test(piece) || legacyGroup
      || (chatType === 'group' && /^\d+$/.test(piece));
    const privateJid = /^(\d+)@(c\.us|s\.whatsapp\.net)$/i.exec(piece);
    const id = isGroup ? normalizeChatId(piece) : parsePhones(privateJid?.[1] ?? piece).numbers[0];
    if (!id) {
      invalid.push(piece.slice(0, 60));
      continue;
    }
    if (seen.has(id)) {
      duplicates++;
      continue;
    }
    seen.add(id);
    numbers.push(id);
    if (isGroup) groups.push(id);
  }
  return { numbers, groups, invalid, duplicates };
}
