// Klien Google Sheets minimal lewat service account. Tanpa pustaka: JWT ditandatangani dengan node:crypto.

import { createPrivateKey, createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export interface SheetsClient {
  email: string;
  authorize?(): Promise<void>;
  tabs(spreadsheetId: string): Promise<{ title: string; spreadsheet: string; tabs: { gid: number; title: string }[] }>;
  read(spreadsheetId: string, tab: string): Promise<string[][]>;
  append(spreadsheetId: string, tab: string, rows: string[][]): Promise<void>;
  update(spreadsheetId: string, tab: string, updates: { row: number; values: string[] }[]): Promise<void>;
}

export class GoogleError extends Error {}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
// Nama tab dikutip supaya spasi dan tanda baca aman di notasi A1.
const range = (tab: string, a1 = '') => `'${tab.replace(/'/g, "''")}'${a1 ? '!' + a1 : ''}`;

export function createSheetsClient(keyFile: string, doFetch: typeof fetch = fetch): SheetsClient | null {
  if (!existsSync(keyFile)) return null;
  return sheetsFromCredentials(readFileSync(keyFile, 'utf8'), doFetch);
}

export function sheetsFromCredentials(json: string, doFetch: typeof fetch = fetch): SheetsClient {
  let key: any;
  try {
    key = JSON.parse(json);
    if (key.type !== 'service_account' || typeof key.client_email !== 'string' || !key.client_email.endsWith('.iam.gserviceaccount.com') || typeof key.private_key !== 'string') throw new Error();
    if (createPrivateKey(key.private_key).asymmetricKeyType !== 'rsa') throw new Error();
  } catch {
    throw new GoogleError('File harus berupa JSON service account Google dengan client_email dan private_key RSA yang valid.');
  }
  // Endpoint tetap: token_uri dari file unggahan tidak boleh mengarahkan JWT ke host lain.
  const tokenUrl = 'https://oauth2.googleapis.com/token';
  let token = { value: '', exp: 0 };

  async function accessToken(): Promise<string> {
    if (token.value && Date.now() < token.exp - 60_000) return token.value;
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: tokenUrl, iat: now, exp: now + 3600 })}`;
    const sig = createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
    const res = await doFetch(tokenUrl, {
      signal: AbortSignal.timeout(30_000),
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    });
    const j: any = await res.json();
    if (!res.ok || !j.access_token) throw new GoogleError(`Login Google gagal: ${j.error_description ?? j.error ?? res.status}`);
    token = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  async function call(method: string, path: string, body?: unknown): Promise<any> {
    // Kuota Sheets: 60 permintaan per menit; 429 dicoba ulang dengan jeda.
    for (let attempt = 1; ; attempt++) {
      const res = await doFetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
        method,
        headers: { authorization: `Bearer ${await accessToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
      const j: any = await res.json().catch(() => ({}));
      if (res.ok) return j;
      if (res.status === 429 && attempt < 5) {
        await new Promise((r) => setTimeout(r, 5000 * attempt));
        continue;
      }
      if (res.status === 403) throw new GoogleError(`Tidak punya akses ke spreadsheet ini. Bagikan sheet ke ${key.client_email} sebagai Editor.`);
      if (res.status === 404) throw new GoogleError('Spreadsheet tidak ditemukan. Periksa tautannya.');
      throw new GoogleError(`Google Sheets membalas ${res.status}: ${j?.error?.message ?? ''}`);
    }
  }

  return {
    email: key.client_email,
    async authorize() { await accessToken(); },
    async tabs(id) {
      const j = await call('GET', `${id}?fields=properties.title,sheets.properties(sheetId,title)`);
      return { title: j.properties?.title ?? '', spreadsheet: id, tabs: (j.sheets ?? []).map((s: any) => ({ gid: s.properties.sheetId, title: s.properties.title })) };
    },
    async read(id, tab) {
      const j = await call('GET', `${id}/values/${encodeURIComponent(range(tab))}?valueRenderOption=FORMATTED_VALUE`);
      return (j.values ?? []).map((r: unknown[]) => r.map((c) => String(c ?? '')));
    },
    async append(id, tab, rows) {
      if (!rows.length) return;
      await call('POST', `${id}/values/${encodeURIComponent(range(tab, 'A1'))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: rows });
    },
    async update(id, tab, updates) {
      if (!updates.length) return;
      await call('POST', `${id}/values:batchUpdate`, {
        valueInputOption: 'RAW',
        data: updates.map((u) => ({ range: range(tab, `A${u.row}`), values: [u.values] })),
      });
    },
  };
}
