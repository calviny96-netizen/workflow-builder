import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createSheetsClient, sheetsFromCredentials, GoogleError } from './google.ts';
import type { SheetsClient } from './google.ts';
import { encrypt, decrypt } from './secrets.ts';

export function googleSettings(file: string, master: Buffer, legacyFile: string, doFetch: typeof fetch = fetch) {
  let client: SheetsClient | null = null;
  let error = '';
  try {
    client = existsSync(file)
      ? sheetsFromCredentials(decrypt(master, readFileSync(file, 'utf8')), doFetch)
      : createSheetsClient(legacyFile, doFetch);
  } catch {
    error = 'Kredensial Google tersimpan tidak valid. Unggah kembali file JSON service account.';
  }
  const current = () => {
    if (!client) throw new GoogleError(error || 'Kredensial Google belum diatur. Unggah JSON service account pada node Tulis Sheets.');
    return client;
  };
  const sheets: SheetsClient = {
    get email() { return client?.email ?? ''; },
    tabs: (...args) => current().tabs(...args),
    read: (...args) => current().read(...args),
    append: (...args) => current().append(...args),
    update: (...args) => current().update(...args),
  };
  return {
    sheets,
    status: () => ({ configured: !!client, email: client?.email ?? null, error }),
    async configure(json: string) {
      const next = sheetsFromCredentials(json, doFetch);
      await next.authorize!();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, encrypt(master, json), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      client = next;
      error = '';
      return { configured: true, email: next.email };
    },
  };
}
