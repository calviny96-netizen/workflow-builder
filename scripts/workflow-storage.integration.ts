// Smoke test terhadap Docker lokal; membuat fixture, restart postgres/server, lalu membersihkan fixture.
// Tidak menjalankan audit atau mengirim pesan ke integrasi eksternal.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createPool } from '../apps/server/src/db.ts';
import { hashPassword } from '../apps/server/src/auth.ts';

const db = createPool(process.env.DATABASE_URL!);
const userId = randomUUID();
const password = randomUUID();
const email = `storage-${userId}@local.test`;
let cookie = '';
const created: string[] = [];
async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:8787${url}`, {
    method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (url === '/api/auth/login') cookie = res.headers.get('set-cookie')!.split(';')[0];
  const data = await res.json();
  assert.equal(res.status, 200, `${method} ${url}: ${JSON.stringify(data)}`);
  return data;
}
const baseline = (await db.query('select id, name, graph, settings, status from workflows order by id')).rows;
try {
  await db.query('insert into users(id,email,password_hash) values ($1,$2,$3)', [userId, email, await hashPassword(password)]);
  await call('POST', '/api/auth/login', { email, password });
  const graph = {
    nodes: [
      { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: {} },
      { id: 's', type: 'sales', position: { x: 200, y: 0 }, config: { sales: [{ id: 118, name: 'Fixture', channel: 'whatsapp' }] } },
      { id: 'p', type: 'prompt', position: { x: 200, y: 150 }, config: { mode: 'saved', savedPromptId: 7 } },
      { id: 'a', type: 'aw', position: { x: 400, y: 0 }, config: { model: 'qwen/qwen3.7-plus', chatType: 'individual', runBySuperadmin: true, timeoutMin: 5 } },
      { id: 'v', type: 'viewer', position: { x: 600, y: 0 }, config: {} },
    ],
    edges: [
      { id: 'e1', source: 't', sourceHandle: 'out', target: 's', targetHandle: 'in' },
      { id: 'e2', source: 's', sourceHandle: 'out', target: 'a', targetHandle: 'source' },
      { id: 'e3', source: 'p', sourceHandle: 'out', target: 'a', targetHandle: 'prompt' },
      { id: 'e4', source: 'a', sourceHandle: 'out', target: 'v', targetHandle: 'in' },
    ],
  };
  const fixtures: any[] = [];
  for (const status of ['published', 'archived']) {
    const w = await call('POST', '/api/workflows', { name: `Uji persistensi ${status}`, company_id: 227, company_name: 'Fixture', graph, settings: { concurrency: 3, requireApproval: true } });
    created.push(w.id);
    fixtures.push(await call('POST', `/api/workflows/${w.id}/lifecycle`, { action: status === 'published' ? 'publish' : 'archive' }));
  }
  await db.end();
  execFileSync('sg', ['docker', '-c', 'docker compose restart postgres server'], { stdio: 'pipe' });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if ((await fetch('http://127.0.0.1:8787/api/health')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Server sehat sesudah restart');
  for (const before of fixtures) {
    const after = await call('GET', `/api/workflows/${before.id}`);
    for (const field of ['name', 'graph', 'settings', 'status', 'published_at', 'archived_at']) assert.deepEqual(after[field], before[field], field);
  }
  const fresh = createPool(process.env.DATABASE_URL!);
  try {
    const after = (await fresh.query('select id, name, graph, settings, status from workflows where not (id = any($1::uuid[])) order by id', [created])).rows;
    assert.deepEqual(after, baseline, 'Workflow pengguna tetap utuh');
  } finally { await fresh.end(); }
  console.log('PASS: graf, setting, status publish/arsip dan sesi tetap tersimpan setelah restart PostgreSQL + server Docker; workflow pengguna tetap utuh.');
} finally {
  const cleanup = createPool(process.env.DATABASE_URL!);
  try {
    for (const id of created) {
      await fetch(`http://127.0.0.1:8787/api/workflows/${id}/lifecycle`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'archive' }) });
      await call('DELETE', `/api/workflows/${id}`, { confirmation: 'DELETE' });
    }
    await cleanup.query('delete from users where id=$1', [userId]);
  } finally { await cleanup.end(); await db.end().catch(() => {}); }
}
