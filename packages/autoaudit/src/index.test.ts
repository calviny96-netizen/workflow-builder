import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient, errorCode, evaluateRunStatus, unwrap } from './index.ts';

function fakeFetch(replies: Array<{ status: number; body: unknown } | Error>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = replies.shift();
    if (!next) throw new Error('tidak ada balasan tersisa');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

test('status run ditafsirkan seperti workflow n8n', () => {
  assert.equal(evaluateRunStatus({ status: 'completed' }).state, 'done');
  assert.equal(evaluateRunStatus({ status: 'running', runtime: { finished_at: '2026-10-01' } }).state, 'done');
  assert.equal(evaluateRunStatus({ runtime: { run_status: 'failed' } }).state, 'failed');
  assert.equal(evaluateRunStatus({ status: 'running', runtime: { stream_error: 'x' } }).state, 'failed');
  assert.equal(evaluateRunStatus({ status: 'idle' }).state, 'unknown');
  assert.equal(evaluateRunStatus({}).state, 'unknown');
  assert.equal(evaluateRunStatus({ status: 'processing' }).state, 'running');
});

test('unwrap dan errorCode', () => {
  assert.deepEqual(unwrap({ data: { a: 1 } }), { a: 1 });
  assert.deepEqual(unwrap({ a: 1 }), { a: 1 });
  assert.equal(errorCode({ error: { code: 'empty_filter_result' } }), 'empty_filter_result');
  assert.equal(errorCode({ code: 'x' }), 'x');
  assert.equal(errorCode(null), '');
});

test('GET di-retry saat 5xx, query dan bearer terpasang', async () => {
  const f = fakeFetch([{ status: 502, body: {} }, { status: 200, body: { data: [] } }]);
  const api = createClient({ baseUrl: 'https://x.test/', token: 'rahasia', fetch: f.fn });
  const res = await api.listSales({ company_id: 7, q: undefined });
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, 'https://x.test/api/v1/integrations/sales?company_id=7');
  assert.equal((f.calls[0].init.headers as Record<string, string>).Authorization, 'Bearer rahasia');
});

test('POST tidak pernah di-retry', async () => {
  const f = fakeFetch([{ status: 502, body: {} }, { status: 202, body: {} }]);
  const api = createClient({ baseUrl: 'https://x.test', token: 't', fetch: f.fn });
  const res = await api.startRun({ company_id: 1, sales_id: 2, model: 'm', run_by_superadmin: false });
  assert.equal(res.status, 502);
  assert.equal(f.calls.length, 1);

  const g = fakeFetch([new Error('putus')]);
  const api2 = createClient({ baseUrl: 'https://x.test', token: 't', fetch: g.fn });
  await assert.rejects(() => api2.syncSales(2), /network_error|putus/);
  assert.equal(g.calls.length, 1);
});

test('Official memakai endpoint dan account ID sendiri; Sales ID tetap memakai endpoint lama', async () => {
  const f = fakeFetch(Array.from({ length: 5 }, () => ({ status: 200, body: { data: {} } })));
  const api = createClient({ baseUrl: 'https://x.test', token: 't', fetch: f.fn });
  await api.listOfficialAccounts(167);
  const official = { company_id: 167, whatsapp_official_account_id: 28, model: 'm', run_by_superadmin: true };
  await api.preflight(official);
  await api.startRun(official);
  await api.startRun({ company_id: 167, sales_id: 28, model: 'm', run_by_superadmin: true });
  await api.listOfficialMessages(28, { company_id: 167, limit: 100, cursor: null });
  assert.equal(f.calls[0].url, 'https://x.test/api/v1/integrations/audital-work/whatsapp-official/accounts?company_id=167');
  assert.ok(f.calls[1].url.endsWith('/whatsapp-official/runs/preflight'));
  assert.ok(f.calls[2].url.endsWith('/whatsapp-official/runs'));
  assert.deepEqual(JSON.parse(f.calls[2].init.body as string), official);
  assert.ok(f.calls[3].url.endsWith('/audital-work/runs'));
  assert.equal(JSON.parse(f.calls[3].init.body as string).sales_id, 28);
  assert.ok(f.calls[4].url.endsWith('/whatsapp-official/accounts/28/text-messages'));
});
