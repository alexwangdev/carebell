import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { httpError } from './types';

function filePath(): string {
  const root = process.env.CAREBELL_DATA_DIR || path.join(__dirname, '..', 'data');
  return path.join(root, 'ring-unclaimed.json');
}

interface Unclaimed {
  accountId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  createdAt: number;
}

function readAll(): Unclaimed[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(rows: Unclaimed[]): void {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows));
  fs.renameSync(tmp, file);
}

function prune(rows: Unclaimed[]): Unclaimed[] {
  const cutoff = Date.now() - (15 * 60 * 1000);
  return rows.filter((row) => row.createdAt > cutoff);
}

export function maskEmail(email: unknown): string {
  const [local, domain] = String(email || '').split('@');
  if (!local || !domain) return 'user';
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

export function nonceFor(time: unknown, accountId: string, key = process.env.RING_HMAC_KEY || ''): string {
  return crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(`${time}:${accountId}`).digest('base64url');
}

export function freshTime(time: unknown): boolean {
  const stamp = Number(time);
  if (!Number.isFinite(stamp)) return false;
  const delta = (Date.now() - stamp) / 1000;
  return delta <= 600 && delta >= -30;
}

export async function exchangeCode(code: unknown): Promise<void> {
  const clientId = process.env.RING_CLIENT_ID;
  const clientSecret = process.env.RING_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw httpError('Ring app credentials are not configured.', 503);
  }
  const response = await fetch('https://oauth.ring.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code || ''),
      client_id: clientId,
      client_secret: clientSecret
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    throw httpError('Ring did not accept the authorization code.', 502);
  }
  const tokens = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  const profile = await fetch(`${process.env.RING_API_BASE || 'https://api.amazonvision.com'}/v1/users/me`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(8000)
  });
  if (!profile.ok) {
    throw httpError('Ring did not return the account for that code.', 502);
  }
  const body = await profile.json() as { data?: { id?: string } };
  const accountId = body && body.data && body.data.id;
  if (!accountId || !tokens.access_token) {
    throw httpError('Ring did not return the account for that code.', 502);
  }
  const rows = prune(readAll()).filter((row) => row.accountId !== accountId);
  rows.push({
    accountId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || '',
    expiresIn: Number(tokens.expires_in) || 14400,
    createdAt: Date.now()
  });
  writeAll(rows);
}

async function ringJson(pathname: string, token: string, method: string, body: unknown) {
  const response = await fetch(`${process.env.RING_API_BASE || 'https://api.amazonvision.com'}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    throw httpError('Ring did not finish linking the account.', 502);
  }
  return response.json().catch(() => ({}));
}

export async function claim(email: unknown, nonce: unknown, time: unknown) {
  if (!freshTime(time) || !nonce) {
    throw httpError('That Ring link expired. Start it again from the Ring app.', 400);
  }
  const rows = prune(readAll());
  let match: Unclaimed | null = null;
  for (const row of rows) {
    const expected = nonceFor(time, row.accountId);
    const left = Buffer.from(expected);
    const right = Buffer.from(String(nonce));
    if (left.length === right.length && crypto.timingSafeEqual(left, right)) match = row;
  }
  writeAll(rows.filter((row) => !match || row.accountId !== match.accountId));
  if (!match) {
    throw httpError('CareBell could not match this Ring account. Open the app from Ring again.', 400);
  }
  const identifier = maskEmail(email);
  await ringJson('/v1/accounts/me/app-integrations', match.accessToken, 'POST', {
    account_identifier: identifier,
    nonce: String(nonce)
  });
  await ringJson('/v1/accounts/me/app-integrations', match.accessToken, 'PATCH', {
    account_identifier: identifier,
    status: 'completed'
  });
  return {
    accessToken: match.accessToken,
    refreshToken: match.refreshToken,
    expiresIn: match.expiresIn
  };
}
