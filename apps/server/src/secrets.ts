// Rahasia yang diisi user di dalam node (mis. API key OpenRouter).
// Disimpan terenkripsi (AES-256-GCM) di tabel node_secrets, terpisah dari graf: graf yang dikirim ke browser
// dan salinan graf di tiap run hanya memuat petunjuk 4 karakter terakhir, bukan kuncinya.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Graph } from '../../../packages/nodes/src/index.ts';
import type { Db } from './db.ts';

// Kunci enkripsi server dibuat sekali dan disimpan di .data/secret.key (tidak ikut ke git).
export function loadMasterKey(file: string): Buffer {
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600 });
  return key;
}

function encrypt(master: Buffer, text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', master, iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

function decrypt(master: Buffer, packed: string): string {
  const [iv, tag, body] = packed.split('.').map((x) => Buffer.from(x, 'base64'));
  const d = createDecipheriv('aes-256-gcm', master, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

// Field rahasia per jenis node.
const SECRET_FIELDS: Record<string, string[]> = { aimerge: ['apiKey'] };

// Memindahkan nilai rahasia dari graf ke tabel terenkripsi. Mengembalikan graf yang aman dikirim ke browser.
export async function stashSecrets(db: Db, master: Buffer, workflowId: string, graph: Graph): Promise<Graph> {
  const keep: string[] = [];
  const nodes = [];
  for (const n of graph.nodes) {
    const fields = SECRET_FIELDS[n.type];
    if (!fields) {
      nodes.push(n);
      continue;
    }
    const config = { ...n.config };
    for (const f of fields) {
      const value = String(config[f] ?? '').trim();
      if (value) {
        await db.query(
          `insert into node_secrets (workflow_id, node_id, name, value_enc, hint) values ($1,$2,$3,$4,$5)
           on conflict (workflow_id, node_id, name) do update set value_enc = excluded.value_enc, hint = excluded.hint, updated_at = now()`,
          [workflowId, n.id, f, encrypt(master, value), value.slice(-4)],
        );
      }
      const row = (await db.query('select hint from node_secrets where workflow_id=$1 and node_id=$2 and name=$3', [workflowId, n.id, f])).rows[0];
      config[f] = ''; // nilai asli tidak pernah tinggal di graf
      config[`${f}Hint`] = row ? row.hint : '';
      keep.push(`${n.id}:${f}`);
    }
    nodes.push({ ...n, config });
  }
  // Rahasia milik node yang sudah dihapus ikut dibuang.
  const all = await db.query('select node_id, name from node_secrets where workflow_id=$1', [workflowId]);
  for (const r of all.rows) {
    if (!keep.includes(`${r.node_id}:${r.name}`)) await db.query('delete from node_secrets where workflow_id=$1 and node_id=$2 and name=$3', [workflowId, r.node_id, r.name]);
  }
  return { ...graph, nodes };
}

export async function readSecret(db: Db, master: Buffer, workflowId: string, nodeId: string, name: string): Promise<string | null> {
  const r = await db.query('select value_enc from node_secrets where workflow_id=$1 and node_id=$2 and name=$3', [workflowId, nodeId, name]);
  return r.rows[0] ? decrypt(master, r.rows[0].value_enc) : null;
}
