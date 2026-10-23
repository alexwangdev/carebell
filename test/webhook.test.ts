import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.CAREBELL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carebell-'));
process.env.CAREBELL_NO_SEED = '1';
process.env.RING_HMAC_KEY = 'test-signing-key';
process.env.DEMO_MODE = 'true';
delete process.env.RING_ACCESS_TOKEN;
delete process.env.BEDROCK_MODEL_ID;

import { start } from '../server';
import { signBody, createWebhookBody } from '../lib/domain';
import { sceneJpeg, videoFromJpegs } from '../lib/vision';

let base = '';
let server: Server;
let cookie = '';

test.before(async () => {
  server = await start(0);
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alex', email: 'alex@example.com', password: 'test-password' })
  });
  assert.equal(response.status, 201);
  cookie = (response.headers.get('set-cookie') || '').split(';')[0];
});

function authed(url: string, options: RequestInit = {}) {
  const headers = { ...(options.headers || {}), Cookie: cookie };
  return fetch(url, { ...options, headers });
}

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function postRaw(pathname: string, raw: Buffer, signature?: string) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signature ? { 'X-Signature': signature } : {})
    },
    body: raw
  });
  return { status: response.status, body: await response.json() as { status?: string } };
}

test('signed doorbell webhook is logged once and shown as a large alert', async () => {
  const payload = createWebhookBody({ kind: 'doorbell', requestId: 'press-1' });
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = signBody(raw, 'test-signing-key');
  const first = await postRaw('/webhooks/ring', raw, signature);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'processed');

  const state = await authed(`${base}/api/state`).then((response) => response.json()) as any;
  assert.equal(state.banner.title, 'Someone pressed the doorbell');
  assert.equal(state.banner.kind, 'doorbell');
  assert.ok(state.banner.snapshotUrl.endsWith('.svg'));
  assert.equal(state.log.filter((event: { kind: string }) => event.kind === 'doorbell').length, 1);
  assert.equal(state.mode, 'demo');

  const replay = await postRaw('/webhooks/ring', raw, signature);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.status, 'duplicate');
  const again = await authed(`${base}/api/state`).then((response) => response.json()) as any;
  assert.equal(again.log.filter((event: { kind: string }) => event.kind === 'doorbell').length, 1);
});

test('rejects a webhook when the signature does not match', async () => {
  const payload = createWebhookBody({ kind: 'person', requestId: 'person-unsigned' });
  const raw = Buffer.from(JSON.stringify(payload));
  const rejected = await postRaw('/webhooks/ring', raw, 'sha256=deadbeef');
  assert.equal(rejected.status, 401);
});

test('caregiver filters keep a vehicle in the log without an alert', async () => {
  const current = await authed(`${base}/api/state`).then((response) => response.json()) as any;
  await authed(`${base}/api/alerts/${current.banner.id}/ack`, { method: 'POST' });
  const payload = createWebhookBody({ kind: 'vehicle', requestId: 'car-1' });
  const raw = Buffer.from(JSON.stringify(payload));
  const result = await postRaw('/webhooks/ring', raw, signBody(raw, 'test-signing-key'));
  assert.equal(result.body.status, 'processed');
  const state = await authed(`${base}/api/state`).then((response) => response.json()) as any;
  const car = state.log.find((event: { kind: string }) => event.kind === 'vehicle');
  assert.equal(car.title, 'A car passed the door');
  assert.equal(car.notified, false);
  assert.notEqual(state.banner && state.banner.kind, 'vehicle');
});

test('a no-activity drill alerts the emergency contact', async () => {
  const saved = await authed(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emergencyName: 'Daughter', checkInBy: '10:00', anomalyEnabled: true })
  }).then((response) => response.json()) as any;
  assert.equal(saved.settings.emergencyName, 'Daughter');

  const drilled = await authed(`${base}/api/demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'anomaly' })
  }).then((response) => response.json()) as any;
  assert.equal(drilled.banner.kind, 'anomaly');
  assert.match(drilled.banner.detail, /Daughter/);
  assert.match(drilled.banner.detail, /practice/);
});

test('the OpenCV tester page is available at its own address', async () => {
  const response = await fetch(`${base}/opencv`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Test a door file/);
  assert.match(html, /Playground access token/);
  assert.match(html, /\/opencv\.js/);
});

test('a loaded MP4 recording can raise a fall alert', async () => {
  const mp4 = await videoFromJpegs([
    sceneJpeg('standing'),
    sceneJpeg('standing'),
    sceneJpeg('fall'),
    sceneJpeg('fall')
  ], { fps: 2 });
  assert.ok(mp4);
  const body = new FormData();
  body.append('file', new Blob([new Uint8Array(mp4)], { type: 'video/mp4' }), 'fall.mp4');
  const response = await authed(`${base}/api/demo/video`, { method: 'POST', body });
  assert.equal(response.status, 200);
  const state = await response.json() as any;
  assert.equal(state.banner.kind, 'fall');
  assert.equal(state.banner.snapshotNote, '');
});
