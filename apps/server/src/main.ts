import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { createClient } from '../../../packages/autoaudit/src/index.ts';
import { buildApp } from './app.ts';
import { seedAdmin } from './auth.ts';
import { createPool, migrate } from './db.ts';
import { createExecutor } from './executor.ts';
import { createSheetsClient } from './google.ts';
import { gowaFromEnv } from './steps-io.ts';
import { loadMasterKey } from './secrets.ts';

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Variabel ${name} belum diisi di .env (lihat .env.example).`);
    process.exit(1);
  }
  return v;
}

const port = Number(process.env.PORT || 8787);
const globalConcurrency = Math.max(1, Number(process.env.AW_CONCURRENCY || 5));

const db = createPool(need('DATABASE_URL'));
try {
  await migrate(db);
} catch (err) {
  console.error(`Tidak bisa terhubung ke database. Sudah menjalankan "npm run db"? (${err instanceof Error ? err.message : err})`);
  process.exit(1);
}
const seeded = await seedAdmin(db, process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
if (seeded) console.log(seeded);

const api = createClient({ baseUrl: need('AUTOAUDIT_BASE_URL'), token: need('AUTOAUDIT_API_KEY') });
const sheets = createSheetsClient(fileURLToPath(new URL('../../../.secrets/google.json', import.meta.url)));
console.log(sheets ? `Google Sheets siap sebagai ${sheets.email}` : 'Google Sheets belum dipasang (.secrets/google.json tidak ada).');

const gowa = gowaFromEnv(process.env);
console.log(gowa ? `GOWA siap di ${gowa.baseUrl}` : 'GOWA belum diatur (GOWA_BASE_URL, GOWA_USER, GOWA_PASSWORD di .env).');

// Kunci untuk mengenkripsi rahasia yang diisi user di node (mis. API key OpenRouter).
const masterKey = loadMasterKey(fileURLToPath(new URL('../../../.data/secret.key', import.meta.url)));

const executor = createExecutor({
  db,
  api,
  sheets,
  gowa,
  masterKey,
  globalConcurrency,
  filesDir: fileURLToPath(new URL('../../../.data/files', import.meta.url)),
  pollMs: Number(process.env.AW_POLL_MS || 15_000),
  tickMs: Number(process.env.ENGINE_TICK_MS || 2000),
  log: (m) => console.log(`[mesin] ${m}`),
});

const app = buildApp({ db, api, executor, sheets, masterKey, gowaReady: !!gowa, globalConcurrency, secureCookie: process.env.NODE_ENV === 'production' });

// Build web (apps/web/dist) disajikan bila ada; saat pengembangan Vite yang menyajikannya.
const dist = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(dist)) {
  app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Tidak ditemukan.' });
    return reply.sendFile('index.html');
  });
}

try {
  await app.listen({ port, host: process.env.HOST || '127.0.0.1' });
} catch (err: any) {
  if (err?.code === 'EADDRINUSE') console.error(`Port ${port} sudah dipakai. Server kemungkinan sudah hidup di tab lain; tutup yang itu dulu, atau set PORT lain di .env.`);
  else console.error(err);
  await db.end();
  process.exit(1);
}
executor.start();
console.log(`Server hidup di http://127.0.0.1:${port} (maks. ${globalConcurrency} Audital Work bersamaan)`);

const shutdown = async () => {
  executor.stop();
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
