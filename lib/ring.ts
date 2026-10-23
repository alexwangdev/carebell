import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as context from './context';
import type { StoreDoc } from './types';

type RequestRedirect = 'follow' | 'error' | 'manual';

export interface HouseholdDoor {
  id: string;
  name: string;
}

export interface Household {
  live: boolean;
  doorbellId?: string;
  doorbellName?: string;
  doors: HouseholdDoor[];
  chimeId?: string;
  audioRef?: string;
  audioName?: string;
  volume?: number | null;
  online?: boolean | null;
  snoozed?: boolean | null;
  doorOnline?: boolean | null;
  motionEnabled?: 'on' | 'off' | null;
  chimeChecked?: boolean;
  unauthorized?: boolean;
  error?: string;
}

interface HouseholdCache {
  at: number;
  healthAt: number;
  key: string;
  value: Household;
}

let cache: HouseholdCache | null = null;

const RING_BASE = () => process.env.RING_API_BASE || 'https://api.amazonvision.com';

function tokenFile(): string {
  const root = process.env.CAREBELL_DATA_DIR || path.join(__dirname, '..', 'data');
  return path.join(root, 'playground-token');
}

function accessToken(): string {
  if (process.env.RING_ACCESS_TOKEN) return process.env.RING_ACCESS_TOKEN.trim();
  const ctx = context.current();
  if (ctx) return String(ctx.ringToken || '').trim();
  try {
    return fs.readFileSync(tokenFile(), 'utf8').trim();
  } catch {
    return '';
  }
}

export function tokenSource(): 'env' | 'ring' | 'playground' | 'none' {
  if (process.env.RING_ACCESS_TOKEN) return 'env';
  const ctx = context.current();
  if (ctx && ctx.refreshToken) return 'ring';
  return accessToken() ? 'playground' : 'none';
}

export function saveToken(token: string): void {
  const root = path.dirname(tokenFile());
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(tokenFile(), token);
  clearCache();
}

export function clearToken(): boolean {
  if (process.env.RING_ACCESS_TOKEN) return false;
  try { fs.unlinkSync(tokenFile()); } catch { /* already gone */ }
  clearCache();
  return true;
}

export function live(): boolean {
  return Boolean(accessToken());
}

async function refreshStoredToken() {
  const ctx = context.current();
  const refresh = ctx && ctx.refreshToken;
  const clientId = process.env.RING_CLIENT_ID;
  const clientSecret = process.env.RING_CLIENT_SECRET;
  if (!refresh || !clientId || !clientSecret) return false;
  const response = await fetch('https://oauth.ring.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
      client_secret: clientSecret
    }),
    signal: AbortSignal.timeout(15000)
  }).catch(() => null);
  if (!response || !response.ok) return false;
  const body: any = await response.json().catch(() => ({}));
  if (!body.access_token) return false;
  ctx.ringToken = body.access_token;
  if (body.refresh_token) ctx.refreshToken = body.refresh_token;
  const store = require('./store') as typeof import('./store');
  await store.update((data: StoreDoc) => {
    data.settings.ringToken = body.access_token;
    if (body.refresh_token) data.settings.ringRefresh = body.refresh_token;
  });
  clearCache();
  return true;
}

async function ringFetch(pathname: string, {
  method = 'GET',
  body,
  raw,
  redirect = 'follow',
  timeout = 8000,
  refreshed = false
}: {
  method?: string;
  body?: unknown;
  raw?: string;
  redirect?: RequestRedirect | 'follow' | 'error' | 'manual';
  timeout?: number;
  refreshed?: boolean;
} = {}): Promise<Response | null> {
  const token = accessToken();
  if (!token) return null;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let payload: string | undefined;
  if (raw != null) {
    headers['Content-Type'] = 'application/sdp';
    headers.Accept = 'application/sdp, application/json';
    payload = raw;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${RING_BASE()}${pathname}`, {
    method,
    redirect,
    headers,
    body: payload,
    signal: AbortSignal.timeout(timeout)
  });
  if (response.status === 401 && !refreshed && await refreshStoredToken()) {
    return ringFetch(pathname, { method, body, raw, redirect, timeout, refreshed: true });
  }
  return response;
}

export function addH265ToSdp(sdp: string): string {
  const normalized = String(sdp || '').replace(/\r?\n/g, '\r\n');
  if (normalized.includes('a=rtpmap:127 H265/90000')) return normalized;
  const lines = normalized.split('\r\n');
  const result: string[] = [];
  let videoIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('m=video') && videoIndex < 0) {
      videoIndex = result.length;
      result.push(`${lines[i]} 127`);
    } else {
      result.push(lines[i]);
    }
  }
  if (videoIndex < 0) return normalized;
  let insertAt = result.length;
  for (let i = videoIndex + 1; i < result.length; i += 1) {
    if (result[i].startsWith('m=') || result[i] === '') {
      insertAt = i;
      break;
    }
  }
  result.splice(insertAt, 0, 'a=rtpmap:127 H265/90000', 'a=fmtp:127 profile-id=1', 'a=rtcp-fb:127 nack', 'a=rtcp-fb:127 nack pli');
  return result.join('\r\n');
}

function ringError(response: Response | null, fallback: string): string {
  if (!response) return 'The doorbell is not connected.';
  if (response.status === 401) return 'The Playground token expired. Generate a new one.';
  if (response.status === 403) return 'This Playground token cannot use the camera. Generate a new token that includes cameras.';
  if (response.status === 503) return 'The doorbell is offline right now.';
  return fallback;
}


function tokenKey(): string {
  return crypto.createHash('sha256').update(accessToken()).digest('hex').slice(0, 12);
}

export function clearCache(): void {
  cache = null;
}

export function doorKey(id: unknown): string {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 16);
}

function preferredDoorId(): string {
  if (process.env.RING_DEVICE_ID) return process.env.RING_DEVICE_ID;
  if (!context.current()) return '';
  try {
    return (require('./store') as typeof import('./store')).get().settings.watchedDoorId || '';
  } catch {
    return '';
  }
}

function motionState(enabled: unknown): 'on' | 'off' | null {
  if (enabled === 'off' || enabled === false) return 'off';
  if (enabled === 'on' || enabled === true) return 'on';
  return null;
}

export function describeHousehold(value: Household | null | undefined) {
  const empty = { line: '', motion: '', chime: '', doors: [] };
  if (!value || !value.live || value.error) return empty;
  const name = value.doorbellName || 'The doorbell';
  let line = '';
  if (value.doorOnline === true) line = `${name} is online`;
  else if (value.doorOnline === false) line = 'The doorbell is offline, so new events will not arrive.';
  else if (value.doorbellId) line = 'CareBell could not read the doorbell status just now.';
  const motion = value.motionEnabled === 'off'
    ? 'Motion alerts are off. Turn them on in the Ring app.'
    : '';
  let chime = '';
  if (value.chimeChecked) {
    if (!value.chimeId) chime = 'No Chime was found on this Ring account.';
    else if (value.snoozed) chime = 'Chime is snoozed';
    else if (value.online === false) chime = 'The Chime is offline, so it cannot play a tone.';
    else if (value.online === true) chime = 'Chime is ready';
  }
  const doors = (value.doors || []).map((door) => ({
    key: doorKey(door.id),
    name: door.name || 'Door',
    watching: door.id === value.doorbellId
  }));
  return { line, motion, chime, doors };
}

export function peek() {
  const described = describeHousehold(cache && cache.value);
  return {
    source: tokenSource(),
    connected: live(),
    deviceName: cache && cache.value ? cache.value.doorbellName : '',
    error: cache && cache.value ? cache.value.error || '' : '',
    door: { line: described.line, motion: described.motion, choices: described.doors },
    chimeLine: described.chime
  };
}

async function refreshHealth(value: Household): Promise<void> {
  value.chimeChecked = true;
  const jobs: Promise<void>[] = [];
  if (value.doorbellId) {
    jobs.push((async () => {
      const [statusRes, configRes] = await Promise.all([
        ringFetch(`/v1/devices/${encodeURIComponent(value.doorbellId || '')}/status`),
        ringFetch(`/v1/devices/${encodeURIComponent(value.doorbellId || '')}/configurations`)
      ]);
      if (statusRes && statusRes.ok) {
        const status = ((await statusRes.json()) as any).data?.attributes || {};
        value.doorOnline = Boolean(status.online);
      }
      if (configRes && configRes.ok) {
        const enabled = ((await configRes.json()) as any).data?.attributes?.motion_detection?.enabled;
        value.motionEnabled = motionState(enabled);
      }
    })());
  }
  if (value.chimeId) {
    jobs.push((async () => {
      const statusRes = await ringFetch(`/v1/devices/${encodeURIComponent(value.chimeId || '')}/status`);
      if (statusRes && statusRes.ok) {
        const status = ((await statusRes.json()) as any).data?.attributes || {};
        value.online = Boolean(status.online);
        value.snoozed = Boolean(status.audio?.snooze?.active);
      }
    })());
  }
  await Promise.all(jobs);
}

export async function household(): Promise<Household> {
  if (!live()) return { live: false, doors: [] };
  const key = `${tokenKey()}:${preferredDoorId()}`;
  if (cache && cache.key === key && Date.now() - cache.at < 5 * 60 * 1000) {
    if (Date.now() - cache.healthAt >= 45 * 1000) {
      try {
        await refreshHealth(cache.value);
      } catch {
        /* Keep the last door health reading. */
      }
      cache.healthAt = Date.now();
    }
    return cache.value;
  }
  const value: Household = {
    live: true,
    doorbellId: '',
    doorbellName: '',
    doors: [],
    chimeId: process.env.RING_CHIME_ID || '',
    audioRef: process.env.RING_CHIME_AUDIO_REF || '',
    audioName: '',
    volume: null,
    online: null,
    snoozed: null,
    doorOnline: null,
    motionEnabled: null,
    chimeChecked: false
  };
  try {
    const listed = await ringFetch('/v1/devices');
    if (listed && listed.status === 401) {
      value.unauthorized = true;
      value.error = tokenSource() === 'ring'
        ? 'The Ring connection expired. Open CareBell from the Ring app to link it again.'
        : 'The Playground token expired. Generate a new one.';
      cache = { at: Date.now(), healthAt: Date.now(), key, value };
      return value;
    }
    if (!listed || !listed.ok) {
      value.error = 'CareBell could not reach the doorbell just now.';
      cache = { at: Date.now(), healthAt: Date.now(), key, value };
      return value;
    }
    const devices = ((await listed.json()) as any).data || [];
    for (const device of devices) {
      const capabilities = await ringFetch(`/v1/devices/${encodeURIComponent(device.id)}/capabilities`);
      if (!capabilities || !capabilities.ok) continue;
      const attributes = ((await capabilities.json()) as any).data?.attributes || {};
      const actions = attributes.audio?.supported_actions || [];
      const name = device.attributes?.name || 'Door';
      if (actions.includes('chime.play') && !value.chimeId) value.chimeId = device.id;
      const motion = attributes.motion_detection;
      if (motion && motion.configurations !== null) value.doors.push({ id: device.id, name });
    }
    const wanted = preferredDoorId();
    let chosen = value.doors.find((door) => door.id === wanted);
    if (!chosen && process.env.RING_DEVICE_ID) {
      const named = devices.find((device) => device.id === process.env.RING_DEVICE_ID);
      if (named) chosen = { id: named.id, name: named.attributes?.name || 'Door' };
    }
    if (!chosen) chosen = value.doors[0];
    if (!chosen) {
      const fallback = devices.find((device) => device.id !== value.chimeId);
      if (fallback) chosen = { id: fallback.id, name: fallback.attributes?.name || 'Door' };
    }
    if (chosen) {
      value.doorbellId = chosen.id;
      value.doorbellName = chosen.name;
    }
    if (value.chimeId) {
      const configRes = await ringFetch(`/v1/devices/${encodeURIComponent(value.chimeId)}/configurations`);
      if (configRes && configRes.ok) {
        const audio = ((await configRes.json()) as any).data?.attributes?.audio || {};
        value.volume = audio.volume ?? null;
        const slots = Array.isArray(audio.customizable_slots) ? [...audio.customizable_slots] : [];
        slots.sort((a, b) => String(a.event).localeCompare(String(b.event)));
        const slot = slots.find((item) => item.disabled === false && item.audio_ref) || slots[0];
        if (slot && !process.env.RING_CHIME_AUDIO_REF) {
          value.audioRef = slot.audio_ref || '';
          value.audioName = slot.audio_name || '';
        }
      }
    }
    await refreshHealth(value);
  } catch {
    value.error = 'CareBell could not reach the doorbell just now.';
  }
  cache = { at: Date.now(), healthAt: Date.now(), key, value };
  return value;
}

export async function listEvents(deviceId: string, eventTypes: string) {
  const response = await ringFetch(`/v1/history/devices/${encodeURIComponent(deviceId)}/events?event_types=${encodeURIComponent(eventTypes)}`);
  if (!response) return { ok: false, events: [] };
  if (response.status === 401) return { ok: false, unauthorized: true, events: [] };
  if (!response.ok) return { ok: false, events: [] };
  const body = await response.json() as { data?: any[] };
  return { ok: true, events: Array.isArray(body.data) ? body.data : [] };
}

function imageOptions(format: string) {
  return {
    format: format === 'png' ? 'png' : 'jpeg',
    resolution: { width: 1280, height: 720 }
  };
}

async function downloadImage(payload: Record<string, unknown>) {
  const home = await household();
  if (!home.doorbellId) return { ok: false, note: 'No doorbell was found on this Playground token.' };
  const response = await ringFetch(`/v1/devices/${encodeURIComponent(home.doorbellId)}/media/image/download`, {
    method: 'POST',
    body: payload,
    redirect: 'manual'
  });
  if (!response) return { ok: false, note: 'The doorbell is not connected.' };
  if (response.status !== 303) {
    if (response.status === 416) return { ok: false, status: 416, note: 'No picture was saved for this moment. The text alert still stands.' };
    if (response.status === 401) return { ok: false, status: 401, note: 'The Playground token expired, so the picture is unavailable. The text alert still stands.' };
    return { ok: false, status: response.status, note: 'No picture is available for this moment. The text alert still stands.' };
  }
  const location = response.headers.get('location');
  if (!location) return { ok: false, note: 'No picture is available for this moment. The text alert still stands.' };
  const image = await fetch(location, { signal: AbortSignal.timeout(8000) });
  if (image.status === 416) return { ok: false, status: 416, note: 'No picture was saved for this moment. The text alert still stands.' };
  if (!image.ok) return { ok: false, status: image.status, note: 'No picture is available for this moment. The text alert still stands.' };
  const bytes = Buffer.from(await image.arrayBuffer());
  const origin = image.headers.get('x-media-origin');
  const contentType = image.headers.get('content-type') || 'image/jpeg';
  let note = 'This is the picture from that moment at the door.';
  if (origin === 'snapshot') note = 'This is a snapshot the doorbell already saved.';
  if (origin === 'recording') note = 'This frame comes from the door recording.';
  return { ok: true, bytes, contentType, note, doorbellName: home.doorbellName };
}

export async function downloadAt(timestampMs: number) {
  return downloadImage({
    type: 'at_timestamp',
    timestamp: timestampMs,
    image_options: imageOptions('jpeg')
  });
}

export async function downloadSampled(timestampMs: number) {
  const offsets = [0, -8000, 8000, -3000, 3000];
  const frames: { at: number; jpeg: Buffer; note?: string; contentType?: string }[] = [];
  const seen = new Set<string>();
  let note = 'No picture is available for this moment. The text alert still stands.';
  let contentType = 'image/jpeg';
  let doorbellName: string | undefined;
  for (const offset of offsets) {
    const at = timestampMs + offset;
    if (at <= 0) continue;
    const image = await downloadAt(at);
    if (offset === 0 && (!image.ok || !image.bytes)) {
      return { ok: false, frames, note: image.note, status: image.status, contentType: image.contentType };
    }
    if (!image.ok || !image.bytes) continue;
    const key = `${image.bytes.length}:${image.bytes[64] || 0}:${image.bytes[128] || 0}:${image.bytes[image.bytes.length >> 1] || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    frames.push({ at, jpeg: image.bytes, note: image.note, contentType: image.contentType });
    note = image.note || note;
    contentType = image.contentType || contentType;
    doorbellName = image.doorbellName || doorbellName;
  }
  frames.sort((a, b) => a.at - b.at);
  const closest = frames.slice().sort((a, b) => Math.abs(a.at - timestampMs) - Math.abs(b.at - timestampMs))[0];
  return {
    ok: frames.length > 0,
    frames,
    bytes: closest ? closest.jpeg : undefined,
    note: (closest && closest.note) || note,
    contentType: (closest && closest.contentType) || contentType,
    doorbellName
  };
}

export async function downloadLatest(startMs: number, endMs: number) {
  const start = Math.max(startMs, endMs - 24 * 60 * 60 * 1000 + 1000);
  return downloadImage({
    type: 'latest_in_range',
    start_timestamp: start,
    end_timestamp: endMs,
    image_options: imageOptions('jpeg')
  });
}

export async function downloadClip(timestampMs: number, durationMs?: number) {
  const home = await household();
  if (!home.doorbellId) return { ok: false, note: 'No doorbell was found on this Playground token.' };
  const duration = Math.min(12000, Math.max(3000, Number(durationMs) || 8000));
  const response = await ringFetch(`/v1/devices/${encodeURIComponent(home.doorbellId)}/media/video/download`, {
    method: 'POST',
    redirect: 'manual',
    timeout: 15000,
    body: {
      timestamp: timestampMs,
      duration,
      video_options: {
        codec: 'avc',
        frame_rate: 5,
        resolution: { width: 1080, height: 720 }
      },
      audio_options: { audio_enabled: true }
    }
  });
  if (!response) return { ok: false, note: 'The doorbell is not connected.' };
  if (response.status === 416) return { ok: false, status: 416, note: 'No recording was saved for this moment. The picture and the words still stand.' };
  if (response.status !== 303) return { ok: false, status: response.status, note: ringError(response, 'No recording is available for this moment.') };
  const location = response.headers.get('location');
  if (!location) return { ok: false, note: 'No recording is available for this moment.' };
  const video = await fetch(location, { signal: AbortSignal.timeout(20000) });
  if (video.status === 416) return { ok: false, status: 416, note: 'No recording was saved for this moment. The picture and the words still stand.' };
  if (video.status !== 200 && video.status !== 206) return { ok: false, status: video.status, note: 'No recording is available for this moment.' };
  const bytes = Buffer.from(await video.arrayBuffer());
  if (bytes.length < 64 || bytes.length > 12_000_000) return { ok: false, note: 'The recording could not be saved. The picture and the words still stand.' };
  const partial = video.status === 206;
  return {
    ok: true,
    bytes,
    note: partial ? 'This is the part of the door recording that was saved.' : 'This is the recording from that moment at the door.'
  };
}

export function streamingDeviceId(deviceId?: string): string {
  const chosen = String(deviceId || '').trim();
  if (/^ava1\.ring\.device\.[A-Z0-9]+$/.test(chosen)) return chosen;
  return '';
}

export async function openLive(sdp: string, deviceId?: string) {
  const home = await household();
  const doorbellId = streamingDeviceId(deviceId) || home.doorbellId;
  if (!doorbellId) return { ok: false, error: 'No doorbell was found on this Playground token.' };
  const offer = addH265ToSdp(sdp);
  if (!/^v=/.test(offer) || !offer.includes('m=video') || !offer.includes('a=recvonly')) {
    return { ok: false, error: 'The live view could not start. Please try again.' };
  }
  const response = await ringFetch(`/v1/devices/${encodeURIComponent(doorbellId)}/media/streaming/whep/sessions`, {
    method: 'POST',
    raw: offer,
    timeout: 15000
  });
  if (!response || response.status !== 201) {
    return { ok: false, status: response && response.status, error: ringError(response, 'The live view could not start. Please try again.') };
  }
  const answer = await response.text();
  const location = response.headers.get('location') || '';
  let allowed = false;
  try {
    const target = new URL(location, RING_BASE());
    allowed = target.origin === new URL(RING_BASE()).origin && target.pathname.includes('/media/streaming/whep/sessions/');
  } catch {
    allowed = false;
  }
  if (!answer.includes('m=video') || !allowed) return { ok: false, error: 'The live view could not start. Please try again.' };
  return { ok: true, sdp: answer, location };
}

export async function closeLive(location: string | undefined): Promise<void> {
  if (!location) return;
  const token = accessToken();
  if (!token) return;
  await fetch(location, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000)
  }).catch(() => {});
}

export async function playChime() {
  if (!live()) {
    return { played: false, demo: true, message: 'This device will play a sound. With a Playground token, a linked Chime plays the tone already chosen for it.' };
  }
  const home = await household();
  if (!home.chimeId) return { played: false, message: 'No Chime is available, so this stays a text alert.' };
  if (home.online === false) return { played: false, message: 'The Chime is offline, so this stays a text alert.' };
  if (home.snoozed) return { played: false, message: 'The Chime is snoozed, so this stays a text alert.' };
  if (!home.audioRef) return { played: false, message: 'No Chime tone is available, so this stays a text alert.' };
  const capabilities = await ringFetch(`/v1/devices/${encodeURIComponent(home.chimeId)}/capabilities`);
  const actions = capabilities && capabilities.ok ? (((await capabilities.json()) as any).data?.attributes?.audio?.supported_actions || []) : [];
  if (!actions.includes('chime.play')) return { played: false, message: 'This Chime cannot play a tone, so this stays a text alert.' };
  const status = await ringFetch(`/v1/devices/${encodeURIComponent(home.chimeId)}/status`);
  if (status && status.ok) {
    const attributes = ((await status.json()) as any).data?.attributes || {};
    if (!attributes.online) return { played: false, message: 'The Chime is offline, so this stays a text alert.' };
    if (attributes.audio?.snooze?.active) return { played: false, message: 'The Chime is snoozed, so this stays a text alert.' };
  }
  const played = await ringFetch(`/v1/devices/${encodeURIComponent(home.chimeId)}/media/audio/playback`, {
    method: 'POST',
    body: { data: { type: 'audio', attributes: { audio_ref: home.audioRef } } }
  });
  if (played && played.ok) {
    const body = await played.json().catch(() => ({})) as any;
    if (body.data?.attributes?.status === 'completed') {
      return { played: true, message: 'The door Chime has played.' };
    }
  }
  return { played: false, message: 'The tone did not play. Read the text alert.' };
}
