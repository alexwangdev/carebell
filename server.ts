import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from './lib/env';
import * as store from './lib/store';
import * as ring from './lib/ring';
import * as bedrock from './lib/bedrock';
import * as accounts from './lib/accounts';
import * as context from './lib/context';
import * as table from './lib/table';
import * as ringlink from './lib/ringlink';
import * as rules from './lib/rules';
import * as gemini from './lib/gemini';
import { matchPeople, describeMatch, cleanName, cleanRelation, dhash } from './lib/people';
import { canRewriteKind, DoorWatchAgent, framesFromVideo, observeHousehold, readVideoFrames, sceneCopy, sceneFromEvents, sceneJpeg } from './lib/vision';
import { videoFromRequest } from './lib/upload';
import {
  newId,
  zonedParts,
  shiftDate,
  zonedTimeToUtc,
  speakTime,
  signBody,
  verifySignature,
  createWebhookBody,
  translateWebhook,
  isActivity,
  summarizeDay,
  routineStatus,
  buildSampleDay,
  demoSnapshotSvg,
  dateLabel,
  hashEvents,
  sanitizeSettings
} from './lib/domain';
import type { Alert, DoorEvent, HttpError, StoreDoc } from './lib/types';

loadEnv();

type ServerResponse = http.ServerResponse & { corsHeaders?: Record<string, string> };
type IncomingMessage = http.IncomingMessage;

const PUBLIC = path.resolve(__dirname, 'public');
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; media-src 'self'; base-uri 'none'; form-action 'self'"
};
const clients = new Set<{ res: ServerResponse; userId?: string }>();
const bedrockPending = new Set<string>();
let booted = false;

function linkCookie(nonce: unknown, time: unknown): string {
  const value = Buffer.from(JSON.stringify({ nonce, time })).toString('base64url');
  return `carebell-link=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`;
}

function clearLinkCookie(): string {
  return 'carebell-link=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
}

function pendingLink(cookieHeader: unknown) {
  const source = String(cookieHeader || '');
  for (const part of source.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== 'carebell-link') continue;
    try {
      return JSON.parse(Buffer.from(decodeURIComponent(rest.join('=')), 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

async function finishRingLink(email: unknown, nonce: unknown, time: unknown): Promise<void> {
  const linked = await ringlink.claim(email, nonce, time);
  const current = context.current();
  if (!current) return;
  current.ringToken = linked.accessToken;
  current.refreshToken = linked.refreshToken || '';
  await store.update((data: StoreDoc) => {
    data.settings.ringToken = linked.accessToken;
    data.settings.ringRefresh = linked.refreshToken || '';
    data.settings.playgroundConnectedAt = Date.now();
  });
  ring.clearCache();
}

async function finishPendingLink(cookieHeader: unknown): Promise<void> {
  const pending = pendingLink(cookieHeader);
  const current = context.current();
  if (!pending || !current || !current.email) return;
  try {
    await finishRingLink(current.email, pending.nonce, pending.time);
  } catch {
    // Sign-in still succeeds. The Ring link can be started again from the Ring app.
  }
}

async function beginRingLink(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const nonce = url.searchParams.get('nonce') || '';
  const time = url.searchParams.get('time') || '';
  if (!nonce || !ringlink.freshTime(time)) {
    send(res, 400, { error: 'That Ring link expired. Start it again from the Ring app.' });
    return;
  }
  const session = await accounts.sessionUser(req.headers.cookie);
  if (!session) {
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': linkCookie(nonce, time),
      ...SECURITY
    });
    res.end();
    return;
  }
  try {
    await accounts.run(session.id, () => finishRingLink(session.email, nonce, time));
    res.writeHead(302, { Location: '/', 'Set-Cookie': clearLinkCookie(), ...SECURITY });
    res.end();
  } catch (error: any) {
    const httpError = error as HttpError;
    send(res, httpError.status || 500, { error: httpError.status ? httpError.message : 'Ring linking did not finish.' });
  }
}

function signingKey(): string | null {
  if (process.env.RING_HMAC_KEY) return process.env.RING_HMAC_KEY;
  if (process.env.RING_ACCESS_TOKEN) return null;
  return 'carebell-demo-signing-key';
}

export function allowedOrigin(origin: unknown): string {
  const value = String(origin || '');
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(value)) return value;
  const extra = String(process.env.CAREBELL_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
  return extra.includes(value) ? value : '';
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = allowedOrigin(req && req.headers && req.headers.origin);
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Carebell-Session',
    Vary: 'Origin'
  };
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, unknown> = {}): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    ...SECURITY,
    ...(res.corsHeaders || {}),
    ...(extra as http.OutgoingHttpHeaders),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': payload.length
  });
  res.end(payload);
}

function presentEvent(event: DoorEvent) {
  return {
    id: event.id,
    at: event.at,
    localDate: event.localDate,
    localTime: speakTime(event.localTime),
    kind: event.kind,
    title: event.title,
    detail: event.detail,
    deviceName: event.deviceName,
    snapshotUrl: event.snapshotUrl || '',
    familiarName: event.familiarName || '',
    clipUrl: event.clipUrl || '',
    clipNote: event.clipNote || '',
    notified: Boolean(event.notified),
    sample: Boolean(event.sample),
    drill: Boolean(event.drill)
  };
}

function presentAlert(alert: Alert) {
  return {
    id: alert.id,
    at: alert.at,
    localDate: alert.localDate,
    localTime: speakTime(alert.localTime),
    level: alert.level,
    kind: alert.kind,
    title: alert.title,
    detail: alert.detail,
    snapshotUrl: alert.snapshotUrl || '',
    snapshotNote: alert.snapshotNote || '',
    clipUrl: alert.clipUrl || '',
    clipNote: alert.clipNote || '',
    chimeMessage: alert.chimeMessage || '',
    playSound: Boolean(alert.playSound) && !alert.acked,
    contactName: alert.contactName || '',
    drill: Boolean(alert.drill)
  };
}

function viewModel() {
  const data = store.get();
  const events = ring.live() ? data.events.filter((event) => !event.sample) : data.events;
  const todayParts = zonedParts(new Date(), data.settings.timeZone);
  const today = todayParts.localDate;
  const yesterday = shiftDate(today, -1);
  const activityToday = events.filter((event) => event.localDate === today && isActivity(event));
  const activityYesterday = events.filter((event) => event.localDate === yesterday && isActivity(event));
  const fired = data.settings.anomalyFiredOn === today;
  const summaryKey = `${hashEvents(activityToday)}:${fired ? 1 : 0}:${data.settings.emergencyName}`;
  const cached = data.summaries.find((item) => item.date === today && item.hash === summaryKey);
  const todayText = cached
    ? cached.text
    : summarizeDay(activityToday, {
      dayWord: 'Today',
      leaveBy: data.settings.leaveBy,
      homeBy: data.settings.homeBy,
      anomaly: activityToday.length === 0 && fired,
      contactName: data.settings.emergencyName
    });
  if (!cached && activityToday.length) scheduleBedrock(today, activityToday, summaryKey, data.settings, fired);
  const open = data.alerts.filter((alert) => !alert.acked);
  const banner = open.find((alert) => alert.level === 'critical') || open[0] || null;
  const ringView = ring.peek();
  return {
    mode: ring.live() ? 'live' : 'demo',
    paused: Boolean(data.settings.paused),
    pauseReason: data.settings.pauseReason || '',
    pending: open.length,
    settings: {
      deviceName: data.settings.deviceName,
      checkInBy: data.settings.checkInBy,
      leaveBy: data.settings.leaveBy || '08:15',
      homeBy: data.settings.homeBy || '18:30',
      timeZone: data.settings.timeZone,
      anomalyEnabled: data.settings.anomalyEnabled,
      lateHomeEnabled: data.settings.lateHomeEnabled !== false,
      bedsideMode: data.settings.bedsideMode !== false,
      playChimeOnDoorbell: data.settings.playChimeOnDoorbell,
      alerts: data.settings.alerts,
      emergencyName: data.settings.emergencyName,
      rules: (data.settings.rules || []).map((rule) => ({
        id: rule.id,
        kind: rule.kind,
        time: rule.time,
        end: rule.end || '',
        days: rule.days,
        condition: rule.condition,
        action: rule.action,
        minutes: rule.minutes || 0,
        sentence: rules.describeRule(rule, data.settings.emergencyName)
      }))
    },
    gemini: Boolean(process.env.GEMINI_API_KEY),
    banner: banner ? presentAlert(banner) : null,
    today: {
      date: today,
      label: dateLabel(today, today, yesterday),
      summary: todayText,
      source: cached ? 'bedrock' : 'local',
      moments: [...activityToday].sort((a, b) => String(a.at).localeCompare(String(b.at))).map(presentEvent)
    },
    yesterday: {
      date: yesterday,
      label: dateLabel(yesterday, today, yesterday),
      summary: summarizeDay(activityYesterday, {
      dayWord: 'Yesterday',
      leaveBy: data.settings.leaveBy,
      homeBy: data.settings.homeBy
    }),
      source: 'local',
      sample: activityYesterday.some((event) => event.sample)
    },
    log: [...events].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 80).map(presentEvent),
    chimeNote: ring.live()
      ? 'A doorbell press plays the tone already chosen on the Chime. Volume and snooze stay in the Ring app.'
      : 'A practice doorbell press plays a sound on this device. A Playground token uses the Chime tone instead.',
    playground: {
      source: ringView.source,
      connected: ringView.connected,
      deviceName: ringView.deviceName,
      error: ringView.error
    },
    door: ringView.door,
    chimeLine: ringView.chimeLine,
    ringApp: {
      configured: Boolean(process.env.RING_CLIENT_ID && process.env.RING_HMAC_KEY),
      name: 'ring-care',
      tokenExchange: '/oauth/token',
      accountLink: '/ring/link',
      webhook: '/webhooks/ring'
    },
    account: {
      name: (context.current() && context.current().name) || '',
      email: (context.current() && context.current().email) || ''
    },
    people: (data.people || []).map((person) => ({
      id: person.id,
      name: person.name,
      relationship: person.relationship,
      photoUrl: person.photoUrl || ''
    }))
  };
}

function broadcast() {
  const userId = context.current() && context.current().userId;
  const chunk = `data: ${JSON.stringify(viewModel())}\n\n`;
  for (const client of clients) {
    if (userId && client.userId !== userId) continue;
    try {
      client.res.write(chunk);
    } catch {
      clients.delete(client);
    }
  }
}

function scheduleBedrock(date: any, events: any, summaryKey: any, settings: any, anomaly: any) {
  if (!bedrock.configured() || bedrockPending.has(summaryKey)) return;
  const userId = context.current() && context.current().userId;
  bedrockPending.add(summaryKey);
  bedrock.summarizeWithBedrock(events, { anomaly: anomaly && events.length === 0, contactName: settings.emergencyName })
    .then((text) => {
      if (!text || !userId) return null;
      return accounts.run(userId, () => store.update((data: StoreDoc) => {
        data.summaries = data.summaries.filter((item) => item.hash !== summaryKey);
        data.summaries.push({ date, hash: summaryKey, text, source: 'bedrock' });
        if (data.summaries.length > 60) data.summaries.splice(0, data.summaries.length - 60);
      }));
    })
    .then((saved) => {
      if (saved) broadcast();
    })
    .catch(() => {})
    .finally(() => bedrockPending.delete(summaryKey));
}

function wantsAlert(data: any, event: any) {
  if (event.systemAction === 'resume' || event.systemAction === 'online') return false;
  if (data.settings.paused && event.systemAction !== 'pause') return false;
  if (event.alwaysNotify) return true;
  if (!event.notifyKey || !data.settings.alerts[event.notifyKey]) return false;
  if (event.level !== 'critical') {
    const recent = data.alerts.find((alert) => !alert.acked && alert.kind === event.kind);
    if (recent && Math.abs(new Date(event.at).getTime() - new Date(recent.at).getTime()) < 60000) return false;
  }
  return true;
}

function makeAlert(data: any, event: any, extra: any = {}): any {
  const demoDoorbell = event.kind === 'doorbell' && data.settings.playChimeOnDoorbell && !ring.live();
  return {
    id: newId(),
    eventId: event.id,
    at: event.at,
    localDate: event.localDate,
    localTime: event.localTime,
    level: extra.level || event.level || 'notice',
    kind: event.kind,
    title: event.title,
    detail: extra.detail || event.detail,
    snapshotUrl: '',
    snapshotNote: '',
    acked: false,
    drill: Boolean(extra.drill),
    contactName: data.settings.emergencyName,
    chimeMessage: demoDoorbell
      ? 'This device will play a sound. A Playground token uses the Chime tone already chosen at home.'
      : '',
    playSound: demoDoorbell || event.kind === 'anomaly' || event.kind === 'fall'
  };
}

function attachDemo(event: any, alert: any) {
  const svg = demoSnapshotSvg({
    title: event.title,
    timeLabel: speakTime(event.localTime),
    deviceName: event.deviceName || 'Front door',
    kind: event.kind
  });
  const url = store.saveMedia(`${newId()}.svg`, Buffer.from(svg, 'utf8'));
  event.snapshotUrl = url;
  alert.snapshotUrl = url;
  alert.snapshotNote = 'This is a practice image. With a Playground token, this shows a picture the doorbell already saved.';
}

function applyDoorScene(data: StoreDoc, event: any, alert: any, scene: { package?: boolean; fall?: boolean; loitering?: boolean; knock?: boolean; note?: string; events?: any[] }) {
  const copy = sceneCopy(scene as any, data.settings.emergencyName);
  if (!copy || !canRewriteKind(event.kind, event.familiarName, copy.kind)) return alert;
  event.kind = copy.kind;
  event.title = copy.title;
  event.detail = copy.detail;
  event.notifyKey = copy.notifyKey;
  event.level = copy.level;
  event.alwaysNotify = copy.alwaysNotify;
  if (scene.note) event.snapshotNote = scene.note;
  if (alert) {
    alert.kind = copy.kind;
    alert.title = copy.title;
    alert.detail = copy.detail;
    alert.level = copy.level;
    alert.playSound = copy.playSound;
    if (scene.note) alert.snapshotNote = scene.note;
    event.notified = true;
    return alert;
  }
  if (!wantsAlert(data, event)) return alert;
  alert = makeAlert(data, event, { level: copy.level, detail: copy.detail });
  alert.playSound = copy.playSound;
  if (scene.note) alert.snapshotNote = scene.note;
  data.alerts.unshift(alert);
  if (data.alerts.length > 200) data.alerts.length = 200;
  event.notified = true;
  return alert;
}

function enrichLater({ eventId, alertId, atTimestamp, start, end, chime, emptyNote }: any) {
  const userId = context.current() && context.current().userId;
  setImmediate(() => {
    if (!userId) return;
    accounts.run(userId, async () => {
      try {
        const image: any = atTimestamp
          ? await ring.downloadSampled(atTimestamp)
          : await ring.downloadLatest(start, end);
        const sound = chime ? await ring.playChime() : null;
        const bytes = image && image.ok && (image.bytes || (image.frames && image.frames[0] && image.frames[0].jpeg));
        const match = bytes ? matchPeople(bytes, store.get().people) : null;
        const words = describeMatch(match);
        const prior = store.get().events.find((item) => item.id === eventId);
        const duration = prior && prior.endMs > prior.timestampMs ? prior.endMs - prior.timestampMs : 8000;
        const clip = atTimestamp ? await ring.downloadClip(atTimestamp, duration) : null;
        const videoFrames = clip && clip.ok && clip.bytes
          ? await framesFromVideo(clip.bytes, { startAt: prior && prior.timestampMs, fps: 5, maxFrames: 40 })
          : [];
        const sampled = videoFrames.length
          ? videoFrames
          : (image && image.frames && image.frames.length
            ? image.frames.map((frame: { jpeg: Buffer; at: number }) => ({ jpeg: frame.jpeg, at: frame.at }))
            : (bytes ? [{ jpeg: bytes, at: prior && prior.timestampMs }] : []));
        const scene = sampled.length ? await observeHousehold({
          userId,
          frames: sampled,
          jpeg: bytes,
          at: prior && prior.timestampMs,
          ringKind: prior && prior.kind,
          contactName: store.get().settings.emergencyName
        }) : null;
        await store.update((data: StoreDoc) => {
          const event = data.events.find((item) => item.id === eventId);
          let alert = data.alerts.find((item) => item.id === alertId);
          if (event) event.snapshotChecked = true;
          if (image && image.ok && bytes) {
            const ext = String(image.contentType).includes('png') ? 'png' : 'jpg';
            const url = store.saveMedia(`${newId()}.${ext}`, bytes);
            if (event) {
              event.snapshotUrl = url;
              if (ext === 'jpg') event.photoHash = dhash(bytes);
            }
            if (alert) {
              alert.snapshotUrl = url;
              alert.snapshotNote = videoFrames.length
                ? 'CareBell looked at frames from the door recording on this computer.'
                : image.note;
            }
          } else if (alert) {
            alert.snapshotNote = (image && image.note) || emptyNote || 'No picture is available for this moment. The text alert still stands.';
          }
          if (alert && sound) {
            alert.chimeMessage = sound.message;
            alert.playSound = !sound.played;
          }
          if (words && event && (event.kind === 'person' || event.kind === 'doorbell')) {
            event.familiarName = match.name;
            event.familiarRelation = match.relationship;
            event.title = words.title;
            event.detail = words.detail;
            if (alert) {
              alert.title = words.title;
              alert.detail = words.detail;
            }
          }
          if (clip && clip.ok && clip.bytes) {
            const clipUrl = store.saveMedia(`${newId()}.mp4`, clip.bytes);
            if (event) {
              event.clipUrl = clipUrl;
              event.clipNote = clip.note;
            }
            if (alert) {
              alert.clipUrl = clipUrl;
              alert.clipNote = clip.note;
            }
          }
          if (event && scene && (scene.package || scene.fall || scene.loitering || scene.knock)) {
            alert = applyDoorScene(data, event, alert, scene);
          }
        });
        broadcast();
      } catch {
        /* The text alert remains when the picture step fails. */
      }
    }).catch(() => {});
  });
}

function settleRuleAlerts(data: any, event: any) {
  for (const alert of data.alerts) {
    if (alert.kind !== 'rule' || alert.acked || alert.localDate !== event.localDate) continue;
    const rule = (data.settings.rules || []).find((item) => item.id === alert.ruleId);
    if (rule && rule.kind !== 'stay' && rules.conditionMatches(rule.condition, event)) alert.acked = true;
  }
}

function applyTimeRule(data: any, event: any, alert: any) {
  if (data.settings.paused || event.sample || event.systemAction) return alert;
  const rule = rules.matchBetween(data.settings.rules, event, data.settings.timeZone);
  if (!rule) return alert;
  const name = data.settings.emergencyName || 'your emergency contact';
  const extra = rule.action === 'contact'
    ? `${name} has been notified.`
    : 'This is inside the time rule you set.';
  if (!alert) {
    alert = makeAlert(data, event, {
      level: rule.action === 'contact' || event.level === 'critical' ? 'critical' : (event.level || 'notice'),
      detail: extra
    });
    alert.ruleId = rule.id;
    data.alerts.unshift(alert);
    if (data.alerts.length > 200) data.alerts.length = 200;
    event.notified = true;
    return alert;
  }
  if (rule.action === 'contact' && !String(alert.detail).includes(name)) {
    alert.detail = `${extra} ${alert.detail}`;
    alert.level = 'critical';
    alert.ruleId = rule.id;
  }
  return alert;
}

async function handlePayload(raw: any, signature: any) {
  if (!verifySignature(raw, signature, signingKey())) return { code: 401, status: 'invalid signature' };
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return { code: 400, status: 'invalid json' };
  }
  const requestId = payload && payload.meta && payload.meta.request_id;
  if (!requestId) return { code: 400, status: 'missing request_id' };
  const event = translateWebhook(payload, store.get().settings);
  let created = false;
  let follow: any = null;
  await store.update((data: StoreDoc) => {
    if (data.processed.includes(requestId)) return;
    data.processed.push(requestId);
    if (data.processed.length > 5000) data.processed.splice(0, data.processed.length - 5000);
    created = true;
    if (!event) return;
    if (isActivity(event)) {
      for (const alert of data.alerts) {
        if (alert.kind === 'anomaly' && !alert.drill && !alert.acked && alert.localDate === event.localDate) alert.acked = true;
        if (alert.kind === 'late' && !alert.acked && alert.localDate === event.localDate && (event.kind === 'person' || event.kind === 'doorbell')) alert.acked = true;
      }
      settleRuleAlerts(data, event);
    }
    if (event.systemAction === 'online') {
      for (const alert of data.alerts) {
        if (alert.kind === 'offline' && !alert.acked) alert.acked = true;
      }
    }
    const notify = wantsAlert(data, event);
    if (event.systemAction === 'pause') {
      data.settings.paused = true;
      data.settings.pauseReason = event.detail;
    }
    if (event.systemAction === 'resume') {
      data.settings.paused = false;
      data.settings.pauseReason = '';
    }
    event.notified = notify;
    data.events.push(event);
    if (data.events.length > 2000) data.events.splice(0, data.events.length - 2000);
    let alert: any = null;
    if (notify) {
      alert = makeAlert(data, event);
      data.alerts.unshift(alert);
      if (data.alerts.length > 200) data.alerts.length = 200;
    }
    alert = applyTimeRule(data, event, alert);
    const needsPhoto = event.kind === 'doorbell' || event.kind === 'person' || event.kind === 'motion' || event.kind === 'offline';
    if (alert && needsPhoto && !ring.live() && !alert.snapshotUrl) attachDemo(event, alert);
    if (needsPhoto && ring.live()) {
      follow = {
        eventId: event.id,
        alertId: alert ? alert.id : '',
        atTimestamp: event.timestampMs,
        chime: Boolean(alert) && event.kind === 'doorbell' && data.settings.playChimeOnDoorbell
      };
    }
  });
  if (!created) return { code: 200, status: 'duplicate' };
  if (follow) enrichLater(follow);
  broadcast();
  return { code: 200, status: event ? 'processed' : 'ignored' };
}

async function raiseScene(kind: 'package' | 'fall' | 'loitering' | 'knock') {
  const notes = {
    fall: 'CareBell ran a pose model on this computer. Someone may be on the ground by the door.',
    package: 'CareBell looked at this photo on this computer. It looks like a package was left by the door.',
    loitering: 'CareBell tracked the same person near the door for one minute on this computer.',
    knock: 'CareBell looked at this photo on this computer. Someone is standing close to the door.'
  };
  const scene = {
    package: kind === 'package',
    fall: kind === 'fall',
    loitering: kind === 'loitering',
    knock: kind === 'knock',
    note: notes[kind],
    events: []
  };
  await store.update((data: StoreDoc) => {
    const copy = sceneCopy(scene, data.settings.emergencyName);
    if (!copy) return;
    const zoned = zonedParts(new Date(), data.settings.timeZone);
    const bytes = sceneJpeg(kind === 'loitering' || kind === 'knock' ? 'standing' : kind);
    const url = store.saveMedia(`${newId()}.jpg`, bytes);
    const event = {
      id: newId(),
      at: new Date().toISOString(),
      localDate: zoned.localDate,
      localTime: zoned.localTime,
      kind: copy.kind,
      title: copy.title,
      detail: copy.detail,
      deviceName: data.settings.deviceName,
      timestampMs: Date.now(),
      snapshotUrl: url,
      snapshotNote: scene.note,
      notified: true,
      sample: false,
      drill: true,
      notifyKey: copy.notifyKey,
      level: copy.level
    };
    const alert = makeAlert(data, event, { drill: true, level: copy.level, detail: copy.detail });
    alert.snapshotUrl = url;
    alert.snapshotNote = scene.note;
    alert.playSound = copy.playSound;
    data.events.push(event);
    data.alerts.unshift(alert);
  });
  broadcast();
}

async function raiseFromRecording(mp4: Buffer): Promise<{ code: number; error?: string }> {
  const read = await readVideoFrames(mp4, { fps: 5, maxFrames: 40, startAt: 0 });
  const frames = read.frames;
  if (!frames.length) {
    return { code: 400, error: read.error || 'CareBell could not read that recording. Try an MP4 or MOV under 40 MB.' };
  }
  const contactName = store.get().settings.emergencyName;
  const events = await new DoorWatchAgent({
    contactName,
    fallHoldMs: 400,
    knockWindowMs: 8000
  }).observeFrames({
    sessionId: 'file-test',
    frames,
    contactName
  });
  const scene = sceneFromEvents(events);
  const copy = sceneCopy(scene, contactName);
  if (!copy) {
    const seconds = Math.max(1, Math.round((read.durationMs || frames[frames.length - 1].at) / 1000));
    if (seconds < 60) {
      return {
        code: 400,
        error: `CareBell read ${frames.length} frames over about ${seconds} seconds. Waiting needs the same person near the door for one minute, so this clip is too short for that. It also did not notice a fall, a left parcel, or a knock.`
      };
    }
    return {
      code: 400,
      error: `CareBell read ${frames.length} frames and did not notice a fall, a parcel left behind, the same person waiting for one minute, or a knock. Use a door view, with the person or parcel in the lower half of the picture.`
    };
  }
  await store.update((data: StoreDoc) => {
    const zoned = zonedParts(new Date(), data.settings.timeZone);
    const still = frames[frames.length - 1].jpeg;
    const shot = store.saveMedia(`${newId()}.jpg`, still);
    const clipUrl = store.saveMedia(`${newId()}.mp4`, mp4);
    const note = 'This is a recording you loaded. CareBell looked at its frames on this computer. It was not sent to Ring.';
    const event = {
      id: newId(),
      at: new Date().toISOString(),
      localDate: zoned.localDate,
      localTime: zoned.localTime,
      kind: copy.kind,
      title: copy.title,
      detail: copy.detail,
      deviceName: data.settings.deviceName,
      timestampMs: Date.now(),
      snapshotUrl: shot,
      snapshotNote: note,
      clipUrl,
      clipNote: 'This is the recording you loaded.',
      notified: true,
      sample: false,
      drill: true,
      notifyKey: copy.notifyKey,
      level: copy.level
    };
    const alert = makeAlert(data, event, { drill: true, level: copy.level, detail: copy.detail });
    alert.snapshotUrl = shot;
    alert.snapshotNote = note;
    alert.clipUrl = clipUrl;
    alert.clipNote = event.clipNote;
    alert.playSound = copy.playSound;
    data.events.push(event);
    data.alerts.unshift(alert);
  });
  broadcast();
  return { code: 200 };
}

async function raiseAnomaly({ drill }: any) {
  let follow: any = null;
  await store.update((data: StoreDoc) => {
    const zoned = zonedParts(new Date(), data.settings.timeZone);
    const name = data.settings.emergencyName || 'your emergency contact';
    const event = {
      id: newId(),
      at: new Date().toISOString(),
      localDate: zoned.localDate,
      localTime: zoned.localTime,
      kind: 'anomaly',
      title: 'No activity by check-in time',
      detail: drill ? `This is a practice alert. ${name} would be notified.` : `${name} has been notified.`,
      deviceName: data.settings.deviceName,
      timestampMs: Date.now(),
      snapshotUrl: '',
      notified: true,
      sample: false,
      drill
    };
    const alert = makeAlert(data, event, { drill, level: 'critical', detail: event.detail });
    if (!ring.live()) attachDemo(event, alert);
    data.events.push(event);
    data.alerts.unshift(alert);
    if (!drill) data.settings.anomalyFiredOn = zoned.localDate;
    if (ring.live()) {
      follow = {
        eventId: event.id,
        alertId: alert.id,
        start: new Date(zonedTimeToUtc(zoned.localDate, '00:00', data.settings.timeZone)).getTime(),
        end: Date.now(),
        emptyNote: 'No saved picture is available yet today. The emergency contact has still been notified.'
      };
    }
  });
  if (follow) enrichLater(follow);
  broadcast();
}

async function checkAnomaly() {
  const data = store.get();
  if (data.settings.paused || !data.settings.anomalyEnabled) return { fired: false };
  const now = zonedParts(new Date(), data.settings.timeZone);
  const [hour, minute] = data.settings.checkInBy.split(':').map(Number);
  if (now.hour * 60 + now.minute < hour * 60 + minute) return { fired: false };
  if (data.settings.anomalyFiredOn === now.localDate) return { fired: false };
  const activity = data.events.some((event) => event.localDate === now.localDate && isActivity(event));
  if (activity) return { fired: false };
  await raiseAnomaly({ drill: false });
  return { fired: true };
}

async function raiseLate() {
  let follow: any = null;
  await store.update((data: StoreDoc) => {
    const zoned = zonedParts(new Date(), data.settings.timeZone);
    const name = data.settings.emergencyName || 'your emergency contact';
    const event = {
      id: newId(),
      at: new Date().toISOString(),
      localDate: zoned.localDate,
      localTime: zoned.localTime,
      kind: 'late',
      title: 'Not home by the usual time',
      detail: `Someone left this morning, and nobody has been at the door since ${data.settings.homeBy}. ${name} has been notified.`,
      deviceName: data.settings.deviceName,
      timestampMs: Date.now(),
      snapshotUrl: '',
      notified: true,
      sample: false,
      level: 'critical'
    };
    const alert = makeAlert(data, event, { level: 'critical', detail: event.detail });
    if (!ring.live()) attachDemo(event, alert);
    data.events.push(event);
    data.alerts.unshift(alert);
    data.settings.lateHomeFiredOn = zoned.localDate;
    if (ring.live()) {
      follow = {
        eventId: event.id,
        alertId: alert.id,
        start: new Date(zonedTimeToUtc(zoned.localDate, '00:00', data.settings.timeZone)).getTime(),
        end: Date.now(),
        emptyNote: 'No saved picture is available yet today. The emergency contact has still been notified.'
      };
    }
  });
  if (follow) enrichLater(follow);
  broadcast();
}

async function raiseRule(rule: any) {
  let follow: any = null;
  await store.update((data: StoreDoc) => {
    const saved = (data.settings.rules || []).find((item) => item.id === rule.id);
    const zoned = zonedParts(new Date(), data.settings.timeZone);
    if (!saved || saved.firedOn === zoned.localDate) return;
    const copy = rules.quietCopy(saved, data.settings.emergencyName);
    const event = {
      id: newId(),
      at: new Date().toISOString(),
      localDate: zoned.localDate,
      localTime: zoned.localTime,
      kind: 'rule',
      title: copy.title,
      detail: copy.detail,
      deviceName: data.settings.deviceName,
      timestampMs: Date.now(),
      snapshotUrl: '',
      notified: true,
      sample: false,
      level: 'critical'
    };
    const alert = makeAlert(data, event, { level: 'critical', detail: copy.detail });
    alert.ruleId = saved.id;
    if (!ring.live()) attachDemo(event, alert);
    data.events.push(event);
    data.alerts.unshift(alert);
    saved.firedOn = zoned.localDate;
    if (ring.live()) {
      follow = {
        eventId: event.id,
        alertId: alert.id,
        start: new Date(zonedTimeToUtc(zoned.localDate, '00:00', data.settings.timeZone)).getTime(),
        end: Date.now(),
        emptyNote: 'No saved picture is available yet today. The text alert still stands.'
      };
    }
  });
  if (follow) enrichLater(follow);
  broadcast();
}

async function raiseStay(rule: any, episode: any) {
  await store.update((data: StoreDoc) => {
    const saved = (data.settings.rules || []).find((item) => item.id === rule.id);
    if (!saved || saved.stayFrom === episode.startedAt) return;
    const zoned = zonedParts(new Date(), data.settings.timeZone);
    const copy = rules.stayCopy(saved, episode, data.settings.emergencyName);
    const event = {
      id: newId(),
      at: new Date().toISOString(),
      localDate: zoned.localDate,
      localTime: zoned.localTime,
      kind: 'rule',
      title: copy.title,
      detail: copy.detail,
      deviceName: data.settings.deviceName,
      timestampMs: Date.now(),
      snapshotUrl: episode.snapshotUrl || '',
      notified: true,
      sample: false,
      level: 'critical'
    };
    const alert = makeAlert(data, event, { level: 'critical', detail: copy.detail });
    alert.ruleId = saved.id;
    alert.snapshotUrl = episode.snapshotUrl || '';
    if (!episode.snapshotUrl && !ring.live()) attachDemo(event, alert);
    data.events.push(event);
    data.alerts.unshift(alert);
    saved.stayFrom = episode.startedAt;
  });
  broadcast();
}

async function checkRules() {
  const data = store.get();
  if (data.settings.paused) return;
  const now = new Date();
  const zoned = zonedParts(now, data.settings.timeZone);
  const due = (data.settings.rules || []).filter((rule) => quietRuleDueSafe(rule, zoned, data.events, data.settings.timeZone, now));
  for (const rule of due) {
    await raiseRule(rule);
  }
  for (const rule of data.settings.rules || []) {
    if (rule.kind !== 'stay') continue;
    const episode = rules.stayEpisode(rule, data.events, now.getTime(), data.settings.timeZone);
    if (episode && rule.stayFrom !== episode.startedAt) await raiseStay(rule, episode);
  }
}

function quietRuleDueSafe(rule: any, zoned: any, events: any, timeZone: any, now: any) {
  try {
    return rules.quietRuleDue(rule, zoned, events, timeZone, now);
  } catch {
    return false;
  }
}

async function checkLateHome() {
  const data = store.get();
  if (data.settings.paused || data.settings.lateHomeEnabled === false) return { fired: false };
  const now = zonedParts(new Date(), data.settings.timeZone);
  if (data.settings.lateHomeFiredOn === now.localDate) return { fired: false };
  if (!routineStatus(data.events, data.settings, now).lateHome) return { fired: false };
  await raiseLate();
  return { fired: true };
}

const liveSessions = new Map();

async function endLiveSession(id: any) {
  const session = liveSessions.get(id);
  if (!session) return false;
  liveSessions.delete(id);
  clearTimeout(session.timer);
  await ring.closeLive(session.location);
  return true;
}

async function attachClip(eventId: any) {
  const current = store.get();
  const event = current.events.find((item) => item.id === eventId);
  if (!event) return { code: 404, error: 'That event is not in the log.' };
  if (event.sample) return { code: 404, error: 'Practice events do not have a recording.' };
  if (event.clipUrl) return { code: 200 };
  if (!event.timestampMs) return { code: 404, error: 'No recording time is available for this event.' };
  const duration = event.endMs > event.timestampMs ? event.endMs - event.timestampMs : 8000;
  const clip = await ring.downloadClip(event.timestampMs, duration);
  if (!clip.ok) return { code: clip.status === 401 ? 401 : 404, error: clip.note };
  const url = store.saveMedia(`${newId()}.mp4`, clip.bytes as Buffer);
  await store.update((data: StoreDoc) => {
    const saved = data.events.find((item) => item.id === eventId);
    if (saved) {
      saved.clipUrl = url;
      saved.clipNote = clip.note;
    }
    for (const alert of data.alerts) {
      if (alert.eventId === eventId) {
        alert.clipUrl = url;
        alert.clipNote = clip.note;
      }
    }
  });
  broadcast();
  return { code: 200 };
}

async function ensureSeed() {
  await store.update((data: StoreDoc) => {
    if (data.settings.deviceName === '前门') data.settings.deviceName = 'Front door';
    if (data.settings.emergencyName === '女儿') data.settings.emergencyName = 'Daughter';
    if (!data.settings.playgroundConnectedAt && ring.live()) data.settings.playgroundConnectedAt = Date.now();
    if (!data.settings.leaveBy) data.settings.leaveBy = '08:15';
    if (!data.settings.homeBy) data.settings.homeBy = '18:30';
    if (typeof data.settings.lateHomeEnabled !== 'boolean') data.settings.lateHomeEnabled = true;
    if (typeof data.settings.bedsideMode !== 'boolean') data.settings.bedsideMode = true;
    if (!Array.isArray(data.settings.rules)) data.settings.rules = [];
    if (!data.settings.lateHomeFiredOn) data.settings.lateHomeFiredOn = '';
    if (ring.live()) data.events = (data.events || []).filter((event) => !event.sample);
    if (process.env.CAREBELL_NO_SEED === '1' || ring.live()) {
      data.seeded = true;
      data.seedVersion = 2;
      return;
    }
    if (data.seedVersion === 2) return;
    data.events = (data.events || []).filter((event) => !event.sample);
    data.events.push(...buildSampleDay(data.settings.timeZone, data.settings.deviceName));
    data.seeded = true;
    data.seedVersion = 2;
  });
}

const HISTORY_QUERIES = [
  ['ding', 'doorbell'],
  ['motion.human', 'person'],
  ['motion.vehicle', 'vehicle'],
  ['motion.other_motion', 'motion']
];

function applyPeopleNames(data: any) {
  const people = data.people || [];
  for (const event of data.events || []) {
    if (event.kind !== 'person' && event.kind !== 'doorbell') continue;
    if (!event.snapshotUrl || !/\.jpe?g($|\?)/i.test(event.snapshotUrl)) continue;
    const file = store.mediaPath(String(event.snapshotUrl).replace(/^\/media\//, ''));
    let match: any = null;
    if (file) {
      try {
        match = matchPeople(fs.readFileSync(file), people);
      } catch {
        match = null;
      }
    }
    const words = describeMatch(match);
    const targets = [event, ...(data.alerts || []).filter((alert) => alert.eventId === event.id)];
    for (const target of targets) {
      if (words) {
        target.familiarName = match.name;
        target.familiarRelation = match.relationship;
        target.title = words.title;
        target.detail = words.detail;
      } else if (target.familiarName) {
        const [title, detail] = historyTemplate(event.kind, event.deviceName || data.settings.deviceName);
        target.title = title;
        target.detail = detail;
        delete target.familiarName;
        delete target.familiarRelation;
      }
    }
  }
}

function historyTemplate(kind: any, deviceName: any) {
  if (kind === 'doorbell') return ['Someone pressed the doorbell', 'Please look at the door. Open it if you can.', 'doorbell', 'critical'];
  if (kind === 'person') return ['Someone at the door', `${deviceName} saw someone at the door.`, 'person', 'notice'];
  if (kind === 'vehicle') return ['A car passed the door', 'A car passed by.', 'vehicle', 'notice'];
  return ['Movement at the door', 'There was movement, and it is not clear what it was.', 'motion', 'notice'];
}

let polling = false;

async function pollHistory() {
  if (polling || !ring.live()) return;
  polling = true;
  const mediaJobs: any[] = [];
  try {
    const home = await ring.household();
    if (!home.doorbellId || home.unauthorized) {
      if (home.unauthorized) broadcast();
      return;
    }
    const current = store.get();
    const since = current.settings.playgroundConnectedAt || Date.now();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let changed = false;
    for (const [eventTypes, kind] of HISTORY_QUERIES) {
      const result = await ring.listEvents(home.doorbellId, eventTypes);
      if (!result.ok) continue;
      const recent = result.events
        .filter((item) => Number(item.attributes && item.attributes.start) >= cutoff)
        .slice(0, 20);
      for (const item of recent) {
        const imported = await importHistoryEvent(item, kind, home.doorbellName || current.settings.deviceName, since);
        if (imported.created) changed = true;
        if (imported.media) mediaJobs.push(imported.media);
      }
    }
    if (changed) broadcast();
    mediaJobs.forEach((job) => enrichLater(job));
    backfillSnapshots();
  } catch {
    /* Playground polling retries on the next interval. */
  } finally {
    polling = false;
  }
}

function backfillSnapshots() {
  const pending = store.get().events
    .filter((event) => !event.sample && !event.snapshotUrl && !event.snapshotChecked && event.timestampMs && (event.kind === 'doorbell' || event.kind === 'person'))
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .slice(0, 6);
  pending.forEach((event) => enrichLater({ eventId: event.id, atTimestamp: event.timestampMs, chime: false }));
}

async function importHistoryEvent(item: any, kind: any, deviceName: any, since: any) {
  const historyId = item && item.id;
  const start = Number(item && item.attributes && item.attributes.start);
  if (!historyId || !start) return { created: false };
  const key = `history:${historyId}:${kind}`;
  let created = false;
  let media: any = null;
  await store.update((data: StoreDoc) => {
    if (data.processed.includes(key)) return;
    data.processed.push(key);
    if (data.processed.length > 5000) data.processed.splice(0, data.processed.length - 5000);
    const when = new Date(start);
    const zoned = zonedParts(when, data.settings.timeZone);
    const [title, detail, notifyKey, level] = historyTemplate(kind, data.settings.deviceName || deviceName);
    const event = {
      id: newId(),
      requestId: key,
      at: when.toISOString(),
      localDate: zoned.localDate,
      localTime: zoned.localTime,
      deviceName: data.settings.deviceName || deviceName,
      timestampMs: start,
      endMs: Number(item.attributes && item.attributes.end) || 0,
      snapshotUrl: '',
      notified: false,
      sample: false,
      kind,
      title,
      detail,
      notifyKey,
      level
    };
    const notify = start >= since && wantsAlert(data, event);
    event.notified = notify;
    data.events.push(event);
    if (data.events.length > 2000) data.events.splice(0, data.events.length - 2000);
    created = true;
    let alert: any = null;
    if (notify) {
      alert = makeAlert(data, event);
      data.alerts.unshift(alert);
      if (data.alerts.length > 200) data.alerts.length = 200;
    }
    if (start >= since) {
      settleRuleAlerts(data, event);
      alert = applyTimeRule(data, event, alert);
    }
    if (kind === 'doorbell' || kind === 'person' || kind === 'motion') {
      media = {
        eventId: event.id,
        alertId: alert ? alert.id : '',
        atTimestamp: start,
        chime: Boolean(alert) && kind === 'doorbell' && data.settings.playChimeOnDoorbell
      };
    }
  });
  return { created, media };
}

async function readRaw(req: any, limit = 4_000_000) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('That recording is too large. Use a clip under 40 MB.');
      (error as HttpError).status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function serveStatic(res: any, pathname: any) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  if (!rel || rel.includes('..') || rel.includes('\\') || path.isAbsolute(rel)) return false;
  const full = path.resolve(PUBLIC, rel);
  const root = PUBLIC.endsWith(path.sep) ? PUBLIC : PUBLIC + path.sep;
  if (full !== PUBLIC && !full.startsWith(root)) return false;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml'
  };
  res.writeHead(200, {
    ...SECURITY,
    ...(res.corsHeaders || {}),
    'Content-Type': (types as Record<string, string>)[path.extname(full)] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(full).pipe(res);
  return true;
}

function serveMedia(res: any, pathname: any) {
  const filename = decodeURIComponent(pathname.slice('/media/'.length));
  const full = store.mediaPath(filename);
  if (!full) return false;
  const ext = path.extname(full);
  const types = { '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4' };
  const headers = {
    ...SECURITY,
    ...(res.corsHeaders || {}),
    'Content-Type': types[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  };
  if (ext === '.svg') headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
  res.writeHead(200, headers);
  fs.createReadStream(full).pipe(res);
  return true;
}

async function onRequest(req: any, res: any) {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.corsHeaders = corsHeaders(req);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, res.corsHeaders);
    res.end();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/oauth/token') {
    const raw = await readRaw(req);
    const code = new URLSearchParams(raw.toString('utf8')).get('code');
    if (!code) {
      send(res, 400, { error: 'missing code' });
      return;
    }
    try {
      await ringlink.exchangeCode(code);
      send(res, 200, { status: 'ok' });
    } catch (error: any) {
      send(res, (error as HttpError).status || 502, { error: 'token exchange failed' });
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/ring/link') {
    await beginRingLink(req, res, url);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/webhooks/ring') {
    const raw = await readRaw(req);
    const ids = await table.listUserIds();
    if (!ids.length) {
      send(res, 200, { status: 'ignored' });
      return;
    }
    let result = { code: 200, status: 'ignored' };
    for (const id of ids) {
      result = await accounts.run(id, () => handlePayload(raw, req.headers['x-signature']));
    }
    send(res, result.code, { status: result.status });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    send(res, 200, { ok: true, store: process.env.CAREBELL_STORE === 'dynamodb' ? 'dynamodb' : 'local' });
    return;
  }
  if (req.method === 'POST' && (url.pathname === '/api/register' || url.pathname === '/api/login')) {
    try {
      const body = JSON.parse((await readRaw(req)).toString('utf8') || '{}');
      const session = url.pathname === '/api/register'
        ? await accounts.register(body)
        : await accounts.login(body);
      const model = await accounts.run(session.userId, async () => {
        await ensureSeed();
        await finishPendingLink(req.headers.cookie);
        return viewModel();
      });
      send(res, url.pathname === '/api/register' ? 201 : 200, { ...model, sessionToken: session.token }, {
        'Set-Cookie': [accounts.cookie(session.token), clearLinkCookie()],
        'X-Carebell-Session': session.token
      });
    } catch (error: any) {
      send(res, (error as HttpError).status || 500, { error: (error as HttpError).status ? (error as HttpError).message : 'That did not finish. Please try again.' });
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    await accounts.logout(req);
    send(res, 200, { ok: true }, { 'Set-Cookie': accounts.clearCookie() });
    return;
  }
  const session = await accounts.sessionUser(req);
  if (!session) {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/media/') && serveStatic(res, url.pathname)) return;
    send(res, 401, { error: 'Please sign in.' });
    return;
  }
  return accounts.run(session.id, () => signedIn(req, res, url));
}

async function signedIn(req: any, res: any, url: any) {
  if (req.method === 'GET' && url.pathname === '/api/state') {
    if (ring.live()) await ring.household().catch(() => {});
    send(res, 200, viewModel());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      ...SECURITY,
      ...(res.corsHeaders || {}),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    if (ring.live()) await ring.household().catch(() => {});
    res.write(`data: ${JSON.stringify(viewModel())}\n\n`);
    const client = { res, userId: context.current().userId };
    clients.add(client);
    req.on('close', () => clients.delete(client));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/rules/suggest') {
    const body = JSON.parse((await readRaw(req)).toString('utf8') || '{}');
    const result = await gemini.suggestRule(body.text);
    if (result.ok === false) {
      send(res, 422, { error: result.error });
      return;
    }
    send(res, 200, {
      rule: result.rule,
      sentence: rules.describeRule(result.rule, store.get().settings.emergencyName)
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/rules') {
    const body = JSON.parse((await readRaw(req)).toString('utf8') || '{}');
    const text = String(body.text || '').trim();
    let rule: any = null;
    if (text) {
      const checked = await gemini.suggestRule(text);
      if (checked.ok === false) {
        send(res, 422, { error: checked.error });
        return;
      }
      rule = checked.rule;
    } else {
      rule = rules.sanitizeRule(body);
    }
    if (!rule) {
      send(res, 400, { error: 'Choose a time, what happens at the door, and whether to alert.' });
      return;
    }
    let saved = false;
    await store.update((data: StoreDoc) => {
      data.settings.rules = data.settings.rules || [];
      if (data.settings.rules.length >= 8) return;
      data.settings.rules.push(rule);
      saved = true;
    });
    if (!saved) {
      send(res, 400, { error: 'Eight rules is the maximum. Remove one to add another.' });
      return;
    }
    broadcast();
    send(res, 200, viewModel());
    return;
  }
  if (req.method === 'DELETE' && /^\/api\/rules\/[a-zA-Z0-9_-]+$/.test(url.pathname)) {
    const id = url.pathname.split('/')[3];
    await store.update((data: StoreDoc) => {
      data.settings.rules = (data.settings.rules || []).filter((rule) => rule.id !== id);
    });
    broadcast();
    send(res, 200, viewModel());
    return;
  }
  if (req.method === 'PUT' && url.pathname === '/api/settings') {
    const body = JSON.parse((await readRaw(req)).toString('utf8') || '{}');
    await store.update((data: StoreDoc) => {
      data.settings = sanitizeSettings(body, data.settings);
    });
    broadcast();
    send(res, 200, viewModel());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/summary') {
    send(res, 200, viewModel());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/check') {
    const result = await checkAnomaly();
    const late = await checkLateHome();
    send(res, 200, { ...viewModel(), check: result, late });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/live') {
    const body = JSON.parse((await readRaw(req)).toString('utf8') || '{}');
    const sdp = String(body.sdp || '');
    if (sdp.length < 20 || sdp.length > 30000 || !sdp.includes('m=video')) {
      send(res, 400, { error: 'The live view could not start. Please try again.' });
      return;
    }
    const opened = await ring.openLive(sdp);
    if (!opened.ok) {
      send(res, opened.status === 401 ? 401 : 502, { error: opened.error });
      return;
    }
    const id = newId();
    const timer = setTimeout(() => {
      endLiveSession(id).catch(() => {});
    }, 32000);
    timer.unref();
    liveSessions.set(id, { location: opened.location, timer });
    send(res, 201, { sessionId: id, sdp: opened.sdp, seconds: 30 });
    return;
  }
  if (req.method === 'DELETE' && /^\/api\/live\/[a-zA-Z0-9_-]+$/.test(url.pathname)) {
    await endLiveSession(url.pathname.split('/')[3]);
    send(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && /^\/api\/events\/[a-zA-Z0-9_-]+\/clip$/.test(url.pathname)) {
    const result = await attachClip(url.pathname.split('/')[3]);
    if (result.code !== 200) {
      send(res, result.code, { error: result.error });
      return;
    }
    send(res, 200, viewModel());
    return;
  }
  if (req.method === 'POST' && /^\/api\/alerts\/[a-zA-Z0-9_-]+\/ack$/.test(url.pathname)) {
    const id = url.pathname.split('/')[3];
    await store.update((data: StoreDoc) => {
      const alert = data.alerts.find((item) => item.id === id);
      if (alert) alert.acked = true;
    });
    broadcast();
    send(res, 200, viewModel());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/demo/video') {
    const raw = await readRaw(req, 40_000_000);
    const type = String(req.headers['content-type'] || '');
    let mp4: Buffer | null = null;
    if (/application\/json/i.test(type)) {
      const body = JSON.parse(raw.toString('utf8') || '{}');
      mp4 = store.readInboxClip(body.file);
      if (!mp4) {
        send(res, 400, { error: 'Put an MP4 in the CareBell inbox folder, then try again.' });
        return;
      }
    } else {
      mp4 = videoFromRequest(raw, type);
    }
    if (!mp4) {
      send(res, 400, { error: 'Choose a door recording (MP4 or MOV). CareBell reads it on this computer.' });
      return;
    }
    const result = await raiseFromRecording(mp4);
    if (result.code !== 200) {
      send(res, result.code, { error: result.error });
      return;
    }
    send(res, 200, viewModel());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/demo') {
    if (ring.live() || process.env.DEMO_MODE === 'false') {
      send(res, 404, { error: 'Practice events are turned off.' });
      return;
    }
    const body = JSON.parse((await readRaw(req)).toString('utf8') || '{}');
    if (body.kind === 'anomaly') {
      await raiseAnomaly({ drill: true });
      send(res, 200, viewModel());
      return;
    }
    if (body.kind === 'package' || body.kind === 'fall' || body.kind === 'loitering' || body.kind === 'knock') {
      await raiseScene(body.kind);
      send(res, 200, viewModel());
      return;
    }
    const allowed = ['doorbell', 'person', 'vehicle', 'motion'];
    if (!allowed.includes(body.kind)) {
      send(res, 400, { error: 'That event is not recognized.' });
      return;
    }
    const payload = createWebhookBody({ kind: body.kind });
    const raw = Buffer.from(JSON.stringify(payload));
    const key = signingKey();
    const result = await handlePayload(raw, key ? signBody(raw, key) : '');
    if (result.code !== 200) {
      send(res, result.code, { error: 'The practice event was not accepted.' });
      return;
    }
    send(res, 200, viewModel());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/playground') {
    const body = JSON.parse((await readRaw(req)).toString('utf8') || '{}');
    const token = String(body.token || '').trim();
    if (token.length < 20 || token.length > 8000 || /[\s]/.test(token)) {
      send(res, 400, { error: 'That does not look like a Playground token.' });
      return;
    }
    ring.saveToken(token);
    context.current().ringToken = token;
    const home = await ring.household();
    if (!home.live || home.unauthorized || home.error) {
      ring.clearToken();
      context.current().ringToken = '';
      send(res, 401, { error: home.error || 'Ring did not accept that token. Generate a new one in the Playground.' });
      return;
    }
    await store.update((data: StoreDoc) => {
      data.settings.ringToken = token;
      data.settings.playgroundConnectedAt = Date.now();
      if (home.doorbellName && (data.settings.deviceName === 'Front door' || data.settings.deviceName === '前门')) {
        data.settings.deviceName = String(home.doorbellName).slice(0, 24);
      }
    });
    broadcast();
    pollHistory().catch(() => {});
    send(res, 200, viewModel());
    return;
  }
  if (req.method === 'DELETE' && url.pathname === '/api/playground') {
    ring.clearToken();
    context.current().ringToken = '';
    await store.update((data: StoreDoc) => {
      data.settings.ringToken = '';
    });
    broadcast();
    send(res, 200, viewModel());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/door') {
    if (process.env.RING_DEVICE_ID) {
      send(res, 400, { error: 'This server is set to one door.' });
      return;
    }
    const body = JSON.parse((await readRaw(req)).toString('utf8') || '{}');
    const key = String(body.key || '');
    if (!/^[a-f0-9]{16}$/.test(key)) {
      send(res, 400, { error: 'Choose a door from the list.' });
      return;
    }
    const home = await ring.household();
    const door = (home.doors || []).find((item) => ring.doorKey(item.id) === key);
    if (!door) {
      send(res, 404, { error: 'That door is not on this Ring account.' });
      return;
    }
    await store.update((data: StoreDoc) => {
      data.settings.watchedDoorId = door.id;
      data.settings.deviceName = String(door.name || 'Front door').slice(0, 24);
    });
    ring.clearCache();
    await ring.household().catch(() => {});
    broadcast();
    send(res, 200, viewModel());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/people') {
    const body = JSON.parse((await readRaw(req)).toString('utf8') || '{}');
    const name = cleanName(body.name);
    const relationship = cleanRelation(body.relationship);
    if (!name) {
      send(res, 400, { error: 'Enter the person’s name.' });
      return;
    }
    let bytes: Buffer | null = null;
    if (body.eventId) {
      const event = store.get().events.find((item) => item.id === body.eventId);
      const file = event && event.snapshotUrl && store.mediaPath(event.snapshotUrl.replace(/^\/media\//, ''));
      if (!file || !/\.jpe?g$/i.test(file)) {
        send(res, 400, { error: 'Choose a JPEG picture from the door.' });
        return;
      }
      bytes = fs.readFileSync(file);
    } else if (body.image) {
      const match = String(body.image).match(/^data:image\/jpe?g;base64,([A-Za-z0-9+/=\s]+)$/);
      if (!match) {
        send(res, 400, { error: 'Use a JPEG photo.' });
        return;
      }
      bytes = Buffer.from(match[1], 'base64');
      if (bytes.length > 2_000_000) {
        send(res, 400, { error: 'That photo is too large.' });
        return;
      }
    } else if (body.source === 'ring') {
      const end = Date.now();
      const image = await ring.downloadLatest(end - (24 * 60 * 60 * 1000) + 2000, end);
      if (!image || !image.ok || !image.bytes) {
        const expired = image && image.status === 401;
        send(res, expired ? 401 : 404, {
          error: expired
            ? 'The Playground token expired. Generate a new one on Care, then try again.'
            : 'Ring has no saved door photo from the last day.'
        });
        return;
      }
      bytes = image.bytes;
    }
    const hash = bytes ? dhash(bytes) : '';
    if (!hash) {
      send(res, 400, { error: 'CareBell could not read that photo.' });
      return;
    }
    const photoUrl = store.saveMedia(`${newId()}.jpg`, bytes as Buffer);
    await store.update((data: StoreDoc) => {
      data.people = data.people || [];
      data.people.push({
        id: newId(),
        name,
        relationship,
        photoUrl,
        hashes: [hash],
        createdAt: new Date().toISOString()
      });
      applyPeopleNames(data);
    });
    broadcast();
    send(res, 200, viewModel());
    return;
  }
  if (req.method === 'DELETE' && /^\/api\/people\/[a-zA-Z0-9_-]+$/.test(url.pathname)) {
    const id = url.pathname.split('/')[3];
    await store.update((data: StoreDoc) => {
      data.people = (data.people || []).filter((person) => person.id !== id);
      applyPeopleNames(data);
    });
    broadcast();
    send(res, 200, viewModel());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/sample') {
    if (ring.live()) {
      send(res, 404, { error: 'Sample records stay off while Ring is connected.' });
      return;
    }
    await store.update((data: StoreDoc) => {
      data.events = data.events.filter((event) => !event.sample);
      data.events.push(...buildSampleDay(data.settings.timeZone, data.settings.deviceName));
      data.seeded = true;
    });
    broadcast();
    send(res, 200, viewModel());
    return;
  }
  if (req.method === 'DELETE' && url.pathname === '/api/household-data') {
    await store.update((data: StoreDoc) => {
      data.events = [];
      data.alerts = [];
      data.summaries = [];
      data.processed = [];
      data.people = [];
      data.settings.anomalyFiredOn = '';
      data.seeded = true;
    });
    store.clearMedia();
    broadcast();
    send(res, 200, viewModel());
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
    if (serveMedia(res, url.pathname)) return;
    send(res, 404, { error: 'Picture not found.' });
    return;
  }
  if (req.method === 'GET' && serveStatic(res, url.pathname)) return;
  send(res, 404, { error: 'Not found.' });
}

function start(port: number = Number(process.env.PORT) || 3780): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    onRequest(req, res).catch((error) => {
      const status = (error as HttpError).status || 500;
      const message = status >= 400 && status < 500 && error && error.message
        ? String(error.message)
        : 'That did not finish. Please try again.';
      if (!res.headersSent) send(res, status, { error: message });
      if (status === 500) console.error(error);
    });
  });
  const boot = (booted
    ? Promise.resolve()
    : table.ready().then(() => accounts.eachUser(() => ensureSeed())).then(() => {
      booted = true;
      const timer = setInterval(() => {
        accounts.eachUser(async () => {
          await checkAnomaly();
          await checkLateHome();
          await checkRules();
          await pollHistory();
        }).catch(() => {});
      }, 20000);
      timer.unref();
      accounts.eachUser(() => pollHistory()).catch(() => {});
    }));
  return boot.then(() => new Promise<http.Server>((resolve) => {
    server.listen(port, process.env.HOST || '0.0.0.0', () => resolve(server));
  }));
}

if (require.main === module) {
  start().then((server) => {
    const address = server.address();
    const listenPort = typeof address === 'object' && address ? address.port : 3780;
    console.log(`CareBell http://127.0.0.1:${listenPort}`);
  });
}

export { start, ensureSeed };
