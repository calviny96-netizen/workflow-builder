import pg from 'pg';

// history_id dan token dikembalikan pg sebagai string bila bigint; pakai integer biasa di skema.
export function createPool(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // Koneksi menganggur yang putus (mis. database dimatikan) tidak boleh menjatuhkan server;
  // permintaan berikutnya akan membuka koneksi baru begitu database hidup lagi.
  pool.on('error', (err) => console.error(`[database] koneksi terputus: ${err.message}`));
  return pool;
}

export type Db = pg.Pool;

const SCHEMA = `
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null default '',
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  token text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null
);

create table if not exists workflows (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company_id integer,
  company_name text not null default '',
  graph jsonb not null default '{"nodes":[],"edges":[]}',
  settings jsonb not null default '{}',
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  company_id integer not null,
  graph jsonb not null,
  params jsonb not null default '{}',
  overrides jsonb not null default '{}',
  plan jsonb,
  status text not null default 'planning',
  halted boolean not null default false,
  concurrency integer not null default 5,
  error text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists runs_workflow_idx on runs (workflow_id, created_at desc);
create index if not exists runs_status_idx on runs (status);

create table if not exists units (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  node_id text not null,
  seq integer not null,
  label text not null,
  source jsonb not null,
  payload jsonb not null,
  estimate jsonb not null default '{}',
  fp_input jsonb not null default '{}',
  fingerprint text not null,
  timeout_min integer not null default 80,
  status text not null default 'queued',
  correlation_id text,
  history_id integer,
  attempt integer not null default 1,
  unknown_count integer not null default 0,
  error text,
  content text,
  token_usage integer,
  model_used text,
  finish_reason text,
  next_poll_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists units_run_idx on units (run_id, node_id, seq);
create index if not exists units_status_idx on units (status);

create table if not exists node_secrets (
  workflow_id uuid not null references workflows(id) on delete cascade,
  node_id text not null,
  name text not null,
  value_enc text not null,
  hint text not null default '',
  updated_at timestamptz not null default now(),
  primary key (workflow_id, node_id, name)
);

create table if not exists steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  node_id text not null,
  type text not null,
  status text not null default 'waiting',
  output jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  unique (run_id, node_id)
);
`;

export async function migrate(db: Db) {
  await db.query(SCHEMA);
  await db.query(`alter table workflows add column if not exists status text not null default 'draft'
    check (status in ('draft','published','archived'))`);
  await db.query(`alter table workflows add column if not exists published_at timestamptz`);
  await db.query(`alter table workflows add column if not exists archived_at timestamptz`);
  await db.query(`create table if not exists file_cleanup (run_id uuid primary key, created_at timestamptz not null default now())`);
  await db.query(`create index if not exists workflows_status_idx on workflows(status, updated_at desc)`);
  await db.query(`alter table runs add column if not exists preview jsonb`);
  await db.query(`alter table units add column if not exists meta jsonb`);
  await db.query(`alter table runs add column if not exists chunk_confirmed boolean not null default false`);
  await db.query(`create unique index if not exists runs_schedule_occurrence_idx on runs(workflow_id, (params->>'schedule_key')) where params ? 'schedule_key'`);
}
