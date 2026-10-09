import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from './db.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const SESSION_DAYS = 7;
export const COOKIE = 'aawb_sid';

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export async function login(db: Db, email: string, password: string): Promise<{ token: string; user: SessionUser } | null> {
  const r = await db.query('select id, email, name, password_hash from users where email = $1', [email.trim().toLowerCase()]);
  const u = r.rows[0];
  // Hash tetap dihitung walau user tidak ada, supaya waktu respons tidak membocorkan email mana yang terdaftar.
  const ok = await verifyPassword(password, u?.password_hash ?? 'scrypt$00$00');
  if (!u || !ok) return null;
  const token = randomBytes(32).toString('hex');
  await db.query(`insert into sessions (token, user_id, expires_at) values ($1, $2, now() + interval '${SESSION_DAYS} days')`, [token, u.id]);
  return { token, user: { id: u.id, email: u.email, name: u.name } };
}

export async function userFromToken(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const r = await db.query(
    'select u.id, u.email, u.name from sessions s join users u on u.id = s.user_id where s.token = $1 and s.expires_at > now()',
    [token],
  );
  return r.rows[0] ?? null;
}

export async function logout(db: Db, token: string | undefined) {
  if (token) await db.query('delete from sessions where token = $1', [token]);
}

export async function updateAccount(db: Db, userId: string, token: string, email: string, currentPassword: string, newPassword?: string): Promise<SessionUser | null> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const user = (await client.query('select id, name, password_hash from users where id = $1 for update', [userId])).rows[0];
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
      await client.query('rollback');
      return null;
    }
    const hash = newPassword ? await hashPassword(newPassword) : user.password_hash;
    const updated = (await client.query('update users set email = $2, password_hash = $3 where id = $1 returning id, email, name', [userId, email, hash])).rows[0];
    await client.query('delete from sessions where user_id = $1 and token <> $2', [userId, token]);
    await client.query('commit');
    return updated;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

// .env hanya membuat admin pertama. Perubahan akun di aplikasi bertahan saat restart.
export async function seedAdmin(db: Db, email: string | undefined, password: string | undefined): Promise<string | null> {
  const count = await db.query('select count(*)::int as n from users');
  if (count.rows[0].n > 0) return null;
  if (!email || !password) {
    return 'Belum ada user. Isi ADMIN_EMAIL dan ADMIN_PASSWORD di .env lalu jalankan ulang server.';
  }
  const addr = email.trim().toLowerCase();
  await db.query('insert into users (email, name, password_hash) values ($1, $2, $3)', [addr, 'Admin', await hashPassword(password)]);
  return `User admin dibuat: ${addr}`;
}
