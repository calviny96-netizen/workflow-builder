// Postgres lokal tertanam untuk pengembangan: `npm run db`.
// Data disimpan di .data/postgres. Biarkan proses ini hidup selama bekerja; Ctrl+C untuk berhenti.
// Di server, lewati skrip ini dan isi DATABASE_URL dengan Postgres sungguhan.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const port = Number(process.env.LOCAL_PG_PORT || 54329);
const user = 'aawb';
const password = process.env.LOCAL_PG_PASSWORD || 'aawb-local';
const database = 'aawb';
const dir = fileURLToPath(new URL('../.data/postgres', import.meta.url));

const pg = new EmbeddedPostgres({ databaseDir: dir, user, password, port, persistent: true });

// Berkas postmaster.pid tertinggal bila proses mati mendadak. Dianggap hidup hanya bila prosesnya benar-benar ada.
const pidFile = dir + '/postmaster.pid';
if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, 'utf8').split('\n')[0]);
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    // proses sudah tidak ada
  }
  if (alive) {
    console.log(`Postgres lokal sudah hidup (PID ${pid}). Tidak perlu dijalankan lagi.`);
    process.exit(0);
  }
  rmSync(pidFile);
  console.log('Sisa berkas dari Postgres yang mati mendadak dibersihkan.');
}

const fresh = !existsSync(dir + '/PG_VERSION');
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase(database);

console.log(`Postgres lokal hidup di port ${port}, database "${database}".`);
console.log('DATABASE_URL untuk .env ada di .env.example.');

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
