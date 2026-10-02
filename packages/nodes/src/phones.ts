// Membaca nomor WhatsApp yang ditempel user. AutoAudit hanya mengenali format 62… tanpa tanda apa pun
// (terverifikasi: "08…" dan "+62…" menghasilkan nol kontak), jadi semua bentuk diubah ke situ.

export interface ParsedPhones {
  numbers: string[];
  invalid: string[]; // potongan teks yang bukan nomor telepon
  duplicates: number;
}

export function parsePhones(text: string): ParsedPhones {
  const numbers: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  // Dipisah per baris, koma, atau titik koma. Spasi dan tanda hubung di dalam satu nomor dibiarkan ("0812-3456 7890").
  for (const raw of String(text ?? '').split(/[\n,;]+/)) {
    const piece = raw.trim();
    if (!piece) continue;
    let d = piece.replace(/\D/g, '');
    if (d.startsWith('0')) d = '62' + d.slice(1);
    else if (d.startsWith('8')) d = '62' + d;
    if (!/^\d{10,15}$/.test(d) || /[a-z]{3,}/i.test(piece)) {
      invalid.push(piece.slice(0, 30));
      continue;
    }
    if (seen.has(d)) duplicates++;
    else {
      seen.add(d);
      numbers.push(d);
    }
  }
  return { numbers, invalid, duplicates };
}
