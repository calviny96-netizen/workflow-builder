import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { googleSettings } from './google-settings.ts';
import { sheetsFromCredentials } from './google.ts';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const json = JSON.stringify({ type: 'service_account', client_email: 'test@project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://untrusted.example/token' });
test('credentials are validated, encrypted, persisted and used by the existing Sheets reference', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'google-settings-'));
  try {
    const file = join(dir, 'google.enc');
    const master = randomBytes(32);
    const calls: {url: string; options: any}[] = [];
    const mock = async (url: any, options: any) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify(String(url).includes('/token') ? { access_token: 'mock-token', expires_in: 3600 } : {}));
    };
    const settings = googleSettings(file, master, join(dir, 'missing.json'), mock as typeof fetch);
    const sheets = settings.sheets;
    assert.equal(settings.status().configured, false);
    assert.throws(() => sheets.read('id', 'Tab'), /belum diatur/);
    await assert.rejects(settings.configure('{}'), /service account/);
    await settings.configure(json);
    assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
    assert.equal(settings.status().email, 'test@project.iam.gserviceaccount.com');
    assert.ok(!readFileSync(file, 'utf8').includes('PRIVATE KEY'));
    assert.ok(!readFileSync(file, 'utf8').includes('client_email'));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    await sheets.append('id', "O'Brien", [['id', 'name'], ['1', 'Updated']]);
    await sheets.update('id', "O'Brien", [{ row: 2, values: ['1', 'Updated'] }]);
    assert.ok(calls[1].url.includes(':append?'));
    assert.deepEqual(JSON.parse(calls[1].options.body).values[1], ['1', 'Updated']);
    assert.equal(JSON.parse(calls[2].options.body).data[0].range, "'O''Brien'!A2");
    assert.equal(calls.length, 3); // one token exchange reused for append and update
    const restored = googleSettings(file, master, join(dir, 'missing.json'), mock as typeof fetch);
    assert.equal(restored.status().configured, true);
    await assert.rejects(settings.configure('invalid'), /service account/);
    assert.equal(settings.status().configured, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('Google rejects credentials before any saved configuration is replaced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'google-settings-'));
  try {
    const settings = googleSettings(join(dir, 'google.enc'), randomBytes(32), join(dir, 'missing.json'), (async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch);
    await assert.rejects(settings.configure(json), /Login Google gagal/);
    assert.equal(settings.status().configured, false);
    assert.throws(() => sheetsFromCredentials(JSON.stringify({ type: 'authorized_user' })), /service account/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
