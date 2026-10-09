// Uji integrasi terhadap aplikasi yang hidup; akun uji dihapus setelah selesai.
// node --env-file=.env --test scripts/account-settings.integration.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { hashPassword, seedAdmin, verifyPassword } from '../apps/server/src/auth.ts';
import { createPool } from '../apps/server/src/db.ts';

test('pengaturan akun: validasi, perubahan, sesi, konflik, dan seed startup', async () => {
  const db = createPool(process.env.DATABASE_URL!);
  const base = process.env.ACCOUNT_TEST_BASE_URL || 'http://127.0.0.1:5173';
  const id = randomUUID();
  const otherId = randomUUID();
  const originalEmail = `account-test-${id}@example.com`;
  const newEmail = `changed-${id}@example.com`;
  const otherEmail = `other-${id}@example.com`;
  const password = 'test-password-original';
  const newPassword = 'test-password-updated';
  const request = (path: string, method = 'GET', body?: unknown, cookie?: string) => fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const login = async (email: string, pw: string) => {
    const response = await request('/api/auth/login', 'POST', { email, password: pw });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  try {
    await db.query('insert into users (id, email, password_hash) values ($1,$2,$3),($4,$5,$3)', [id, originalEmail, await hashPassword(password), otherId, otherEmail]);
    const cookie = await login(originalEmail, password);
    const otherSession = await login(originalEmail, password);
    const update = (body: unknown) => request('/api/auth/account', 'PATCH', body, cookie);
    assert.equal((await request('/api/auth/account', 'PATCH', { email: newEmail, currentPassword: password })).status, 401);
    assert.equal((await update({ email: newEmail, currentPassword: 'wrong' })).status, 403);
    assert.equal((await update({ email: newEmail, currentPassword: password, newPassword: 'short' })).status, 400);
    assert.equal((await update({ email: 'invalid', currentPassword: password })).status, 400);
    assert.equal((await update({ email: otherEmail, currentPassword: password, newPassword })).status, 409);
    assert.equal((await request('/api/auth/me', 'GET', undefined, otherSession)).status, 200);
    const unchanged = (await db.query('select email, password_hash from users where id=$1', [id])).rows[0];
    assert.equal(unchanged.email, originalEmail);
    assert.ok(await verifyPassword(password, unchanged.password_hash));
    const updated = await update({ email: `  ${newEmail.toUpperCase()}  `, currentPassword: password, newPassword });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).user.email, newEmail);
    assert.equal((await request('/api/auth/me', 'GET', undefined, cookie)).status, 200);
    assert.equal((await request('/api/auth/me', 'GET', undefined, otherSession)).status, 401);
    assert.equal((await request('/api/auth/login', 'POST', { email: originalEmail, password })).status, 401);
    assert.equal((await request('/api/auth/login', 'POST', { email: newEmail, password })).status, 401);
    await login(newEmail, newPassword);
    assert.equal((await update({ email: newEmail, currentPassword: newPassword, newPassword: password })).status, 200);
    assert.equal((await update({ email: originalEmail, currentPassword: password })).status, 200);
    await login(originalEmail, password);
    // .env lama tidak boleh mengembalikan password atau membuat akun tambahan.
    await seedAdmin(db, originalEmail, newPassword);
    await login(originalEmail, password);
    await seedAdmin(db, newEmail, newPassword);
    assert.equal((await db.query('select count(*)::int as n from users where email=$1', [newEmail])).rows[0].n, 0);
  } finally {
    await db.query('delete from users where id = any($1::uuid[])', [[id, otherId]]);
    await db.end();
  }
});
