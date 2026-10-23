import crypto from 'node:crypto';
import * as context from './context';
import * as table from './table';
import * as store from './store';
import { httpError, type RequestLike, type StoreDoc } from './types';

function normalizeEmail(email: unknown): string {
  return String(email || '').trim().toLowerCase();
}

function validEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 80;
}

function hashPassword(password: string, salt: Buffer = crypto.randomBytes(16)): Promise<{ salt: string; hash: string }> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, (error, hash) => {
      if (error) reject(error);
      else resolve({ salt: salt.toString('hex'), hash: hash.toString('hex') });
    });
  });
}

function checkPassword(password: string, saltHex: string, hashHex: string): Promise<boolean> {
  return hashPassword(password, Buffer.from(saltHex, 'hex')).then((result) => (
    crypto.timingSafeEqual(Buffer.from(result.hash, 'hex'), Buffer.from(hashHex, 'hex'))
  ));
}

export async function run<T>(userId: string, fn: () => T | Promise<T>): Promise<T> {
  const profile = await table.get(`USER#${userId}`, 'PROFILE');
  const doc = await store.load(userId);
  return context.run({
    userId,
    name: profile ? String(profile.name || '') : '',
    email: profile ? String(profile.email || '') : '',
    ringToken: (doc.settings && doc.settings.ringToken) || '',
    refreshToken: (doc.settings && doc.settings.ringRefresh) || '',
    doc,
    chain: Promise.resolve()
  }, fn);
}

export async function eachUser(fn: () => unknown): Promise<string[]> {
  const ids = await table.listUserIds();
  for (const id of ids) {
    await run(id, fn);
  }
  return ids;
}

export async function register({ name, email, password }: { name?: unknown; email?: unknown; password?: unknown }) {
  const displayName = String(name || '').trim().slice(0, 40);
  const normalized = normalizeEmail(email);
  if (!displayName) throw httpError('Enter your name.', 400);
  if (!validEmail(normalized)) throw httpError('Enter a valid email.', 400);
  if (String(password || '').length < 8) throw httpError('Use at least 8 characters for the password.', 400);
  const existing = await table.get(`EMAIL#${normalized}`, 'LOOKUP');
  if (existing) throw httpError('An account with that email already exists. Sign in instead.', 409);
  const ids = await table.listUserIds();
  const userId = crypto.randomBytes(9).toString('hex');
  const secret = await hashPassword(String(password || ''));
  await table.put({
    pk: `USER#${userId}`,
    sk: 'PROFILE',
    name: displayName,
    email: normalized,
    salt: secret.salt,
    hash: secret.hash,
    createdAt: new Date().toISOString()
  });
  await table.put({ pk: `EMAIL#${normalized}`, sk: 'LOOKUP', userId });
  const legacy = ids.length === 0 ? store.claimLegacy() : null;
  if (legacy) {
    await run(userId, async () => {
      await store.update((data: StoreDoc) => {
        data.seeded = legacy.seeded;
        data.seedVersion = legacy.seedVersion;
        data.processed = legacy.processed;
        data.events = legacy.events;
        data.alerts = legacy.alerts;
        data.summaries = legacy.summaries;
        data.people = legacy.people || [];
        data.settings = legacy.settings;
      });
      const current = context.current();
      if (current) current.ringToken = legacy.settings.ringToken || '';
    });
  }
  return createSession(userId);
}

export async function login({ email, password }: { email?: unknown; password?: unknown }) {
  const normalized = normalizeEmail(email);
  const lookup = await table.get(`EMAIL#${normalized}`, 'LOOKUP');
  const profile = lookup ? await table.get(`USER#${lookup.userId}`, 'PROFILE') : null;
  const matches = profile ? await checkPassword(String(password || ''), profile.salt, profile.hash) : false;
  if (!matches || !lookup) throw httpError('That email or password is not right.', 401);
  return createSession(String(lookup.userId));
}

async function createSession(userId: string) {
  const token = crypto.randomBytes(24).toString('hex');
  const expires = Date.now() + (30 * 24 * 60 * 60 * 1000);
  await table.put({ pk: `SESSION#${token}`, sk: 'SESSION', userId, expires });
  return { token, userId, expires };
}

export function requestToken(source: RequestLike | string | null | undefined): string {
  if (source && typeof source === 'object') {
    const header = String((source.headers && source.headers.authorization) || '');
    const match = /^Bearer\s+([A-Za-z0-9]+)$/.exec(header.trim());
    if (match) return match[1];
    const cookie = source.headers && source.headers.cookie;
    return readCookie(Array.isArray(cookie) ? cookie.join(';') : cookie, 'carebell');
  }
  return readCookie(source, 'carebell');
}

export async function sessionUser(source: RequestLike | string | null | undefined) {
  const token = requestToken(source);
  if (!token) return null;
  const session = await table.get(`SESSION#${token}`, 'SESSION');
  if (!session || session.expires < Date.now()) {
    if (session) await table.delete(`SESSION#${token}`, 'SESSION');
    return null;
  }
  const profile = await table.get(`USER#${session.userId}`, 'PROFILE');
  if (!profile) return null;
  const settings = await table.get(`USER#${session.userId}`, 'SETTINGS');
  return {
    id: session.userId,
    name: String(profile.name || ''),
    email: String(profile.email || ''),
    ringToken: String((settings && settings.ringToken) || ''),
    sessionToken: token
  };
}

export async function logout(source: RequestLike | string | null | undefined): Promise<void> {
  const token = requestToken(source);
  if (token) await table.delete(`SESSION#${token}`, 'SESSION');
}

function readCookie(header: unknown, name: string): string {
  const source = String(header || '');
  for (const part of source.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

export function cookie(token: string): string {
  return `carebell=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`;
}

export function clearCookie(): string {
  return 'carebell=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}
