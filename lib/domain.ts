import crypto from 'node:crypto';
import type { AlertFlags, AlertKey, DoorEvent, Settings, ZonedParts } from './types';

export const ALERT_KEYS: AlertKey[] = ['doorbell', 'person', 'vehicle', 'motion', 'package', 'fall', 'loitering', 'knock'];

export function newId(): string {
  return crypto.randomBytes(9).toString('hex');
}

function xmlEscape(value: unknown): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  };
  return String(value).replace(/[&<>'"]/g, (ch) => map[ch] || ch);
}

export function safeZone(timeZone: unknown): string {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: String(timeZone) }).format(new Date());
    return String(timeZone);
  } catch {
    return 'UTC';
  }
}

export function zonedParts(date: Date, timeZone: unknown): ZonedParts {
  const tz = safeZone(timeZone);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value])) as Record<string, string>;
  let hour = parts.hour === '24' ? '00' : parts.hour;
  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${hour}:${parts.minute}`,
    hour: Number(hour),
    minute: Number(parts.minute)
  };
}

export function shiftDate(localDate: string, days: number): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${mm}-${dd}`;
}

export function zonedTimeToUtc(localDate: string, localTime: string, timeZone: unknown): string {
  const tz = safeZone(timeZone);
  const [year, month, day] = localDate.split('-').map(Number);
  const [hour, minute] = localTime.split(':').map(Number);
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 4; i += 1) {
    const parts = zonedParts(new Date(utc), tz);
    const [gotYear, gotMonth, gotDay] = parts.localDate.split('-').map(Number);
    const got = Date.UTC(gotYear, gotMonth - 1, gotDay, parts.hour, parts.minute);
    const want = Date.UTC(year, month - 1, day, hour, minute);
    if (got === want) break;
    utc += want - got;
  }
  return new Date(utc).toISOString();
}

export function minutes(hhmm: string): number {
  const [hour, minute] = String(hhmm).split(':').map(Number);
  return hour * 60 + minute;
}

export function speakTime(hhmm: string): string {
  const [hour, minute] = String(hhmm).split(':');
  return `${Number(hour)}:${minute}`;
}

export function signBody(rawBody: Buffer | string, signingKey: string): string {
  const hex = crypto.createHmac('sha256', Buffer.from(signingKey, 'utf8')).update(rawBody).digest('hex');
  return `sha256=${hex}`;
}

export function verifySignature(rawBody: Buffer | string, header: unknown, signingKey: unknown): boolean {
  if (!header || !signingKey) return false;
  const expected = signBody(rawBody, String(signingKey));
  const received = String(header).trim().toLowerCase();
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function createWebhookBody({ kind, requestId, timestamp, source }: {
  kind: string;
  requestId?: string;
  timestamp?: number;
  source?: string;
}): Record<string, unknown> {
  const map = {
    doorbell: ['button_press', null],
    person: ['motion_detected', 'human'],
    vehicle: ['motion_detected', 'vehicle'],
    motion: ['motion_detected', 'motion'],
    offline: ['device_offline', null],
    online: ['device_online', null],
    paused: ['subscription_deactivated', null],
    removed: ['app_integration_removed', null],
    resumed: ['subscription_activated', null]
  };
  const [type, subType] = (map as unknown as Record<string, [string, string | null]>)[kind] || [];
  if (!type) throw new Error('unknown demo kind');
  const body: {
    meta: Record<string, unknown>;
    data: { id: string; type: string; attributes: Record<string, unknown>; relationships: Record<string, unknown>; subType?: string };
  } = {
    meta: {
      version: '1.1',
      time: new Date().toISOString(),
      request_id: requestId || newId(),
      account_id: 'local-demo'
    },
    data: {
      id: newId(),
      type,
      attributes: {
        source: source || 'local-doorbell',
        source_type: 'devices',
        timestamp: timestamp || Date.now()
      },
      relationships: {
        devices: { links: { self: `/v1/devices/${source || 'local-doorbell'}` } }
      }
    }
  };
  if (subType) body.data.subType = subType;
  return body;
}

export function translateWebhook(payload: any, settings: Settings): DoorEvent | null {
  const type = payload && payload.data && payload.data.type;
  const subType = payload && payload.data && payload.data.subType;
  const timestamp = Number(payload && payload.data && payload.data.attributes && payload.data.attributes.timestamp) || Date.now();
  const when = new Date(timestamp);
  const zoned = zonedParts(when, settings.timeZone);
  const requestId = payload && payload.meta && payload.meta.request_id;
  const base = {
    id: newId(),
    requestId: requestId || newId(),
    at: when.toISOString(),
    localDate: zoned.localDate,
    localTime: zoned.localTime,
    deviceName: settings.deviceName,
    timestampMs: timestamp,
    snapshotUrl: '',
    notified: false,
    sample: false
  };
  const name = settings.deviceName || 'Front door';

  if (type === 'button_press') {
    return {
      ...base,
      kind: 'doorbell',
      title: 'Someone pressed the doorbell',
      detail: 'Please look at the door. Open it if you can.',
      notifyKey: 'doorbell',
      level: 'critical'
    };
  }
  if (type === 'motion_detected') {
    if (subType === 'human') {
      return { ...base, kind: 'person', title: 'Someone at the door', detail: `${name} saw someone at the door.`, notifyKey: 'person', level: 'notice' };
    }
    if (subType === 'vehicle') {
      return { ...base, kind: 'vehicle', title: 'A car passed the door', detail: 'A car passed by.', notifyKey: 'vehicle', level: 'notice' };
    }
    const vague = subType === 'other_motion';
    return {
      ...base,
      kind: 'motion',
      title: 'Movement at the door',
      detail: vague ? 'There was movement, and it is not clear what it was.' : 'There was movement. It is not clear whether it was a person or a car.',
      notifyKey: 'motion',
      level: 'notice'
    };
  }
  if (type === 'device_offline') {
    return {
      ...base,
      kind: 'offline',
      title: 'The doorbell is offline',
      detail: 'CareBell cannot see the door right now. Check the doorbell power and network.',
      notifyKey: null,
      level: 'critical',
      alwaysNotify: true
    };
  }
  if (type === 'device_online') {
    return {
      ...base,
      kind: 'online',
      title: 'The doorbell is back online',
      detail: 'Door events can come through again.',
      notifyKey: null,
      level: 'notice',
      systemAction: 'online'
    };
  }
  if (type === 'subscription_deactivated') {
    return {
      ...base,
      kind: 'system',
      title: 'Door watch is paused',
      detail: 'The Ring subscription is off, so door alerts are paused. Check Ring My Apps. Alerts resume when the subscription is active again.',
      notifyKey: null,
      level: 'critical',
      alwaysNotify: true,
      systemAction: 'pause'
    };
  }
  if (type === 'app_integration_removed') {
    return {
      ...base,
      kind: 'system',
      title: 'The doorbell account was disconnected',
      detail: 'Reconnect to keep watching the door.',
      notifyKey: null,
      level: 'critical',
      alwaysNotify: true,
      systemAction: 'pause'
    };
  }
  if (type === 'subscription_activated' || type === 'app_integration_added') {
    return {
      ...base,
      kind: 'system',
      title: 'Door watch is back on',
      detail: 'Door alerts can continue.',
      notifyKey: null,
      level: 'notice',
      systemAction: 'resume'
    };
  }
  return null;
}

export function isActivity(event: { kind?: string } | null | undefined): boolean {
  return ['doorbell', 'person', 'vehicle', 'motion', 'package', 'fall', 'loitering', 'knock'].includes(event && event.kind ? event.kind : '');
}

function isIsolated(event: DoorEvent, list: DoorEvent[]): boolean {
  const at = minutes(event.localTime);
  return !list.some((other) => {
    if (other.id === event.id) return false;
    if (other.kind !== 'person' && other.kind !== 'doorbell') return false;
    return Math.abs(minutes(other.localTime) - at) <= 45;
  });
}

function highlights(list: DoorEvent[], options: { leaveBy?: string; homeBy?: string } = {}): string[] {
  const leaveBy = minutes(options.leaveBy || '11:00');
  const homeBy = minutes(options.homeBy || '16:00');
  const people = list.filter((event) => event.kind === 'person' || event.kind === 'doorbell');
  const first = people[0];
  const last = people[people.length - 1];
  const midday = list.filter((event) => {
    if (event.kind !== 'person' || !first || !last) return false;
    if (event.id === first.id || event.id === last.id) return false;
    const at = minutes(event.localTime);
    if (at < 9 * 60 || at >= 16 * 60) return false;
    return isIsolated(event, list);
  });
  const phrases: string[] = [];
  for (const event of list) {
    const at = minutes(event.localTime);
    const time = speakTime(event.localTime);
    const who = event.familiarName;
    if (event.kind === 'person' && first && people.length >= 2 && event.id === first.id && at <= leaveBy) {
      phrases.push(who ? `${who} left at ${time}` : `left at ${time}`);
    } else if (event.kind === 'person' && last && people.length >= 2 && event.id === last.id && at >= homeBy) {
      phrases.push(who ? `${who} home at ${time}` : `home at ${time}`);
    } else if (event.kind === 'package') {
      phrases.push(`a package at ${time}`);
    } else if (event.kind === 'fall') {
      phrases.push(`a fall alert at ${time}`);
    } else if (event.kind === 'loitering') {
      phrases.push(`waiting at the door at ${time}`);
    } else if (event.kind === 'knock') {
      phrases.push(`knocking at ${time}`);
    } else if (event.kind === 'doorbell') {
      phrases.push(`doorbell at ${time}`);
    } else if (event.kind === 'person' && who) {
      phrases.push(`${who} at ${time}`);
    } else if (event.kind === 'person' && midday.length === 1 && event.id === midday[0].id) {
      phrases.push(`package drop-off at ${time}`);
    } else if (event.kind === 'person') {
      phrases.push(`someone at the door at ${time}`);
    }
  }
  if (phrases.length === 0) {
    const car = list.find((event) => event.kind === 'vehicle');
    if (car) phrases.push(`a car passed at ${speakTime(car.localTime)}`);
  }
  return phrases;
}

function capPhrases(phrases: string[]): string[] {
  if (phrases.length <= 3) return phrases;
  const middle = phrases[Math.floor((phrases.length - 1) / 2)];
  return [phrases[0], middle, phrases[phrases.length - 1]];
}

export function summarizeDay(events: DoorEvent[] | undefined, options: {
  dayWord?: string;
  contactName?: string;
  leaveBy?: string;
  homeBy?: string;
  anomaly?: boolean;
} = {}): string {
  const dayWord = options.dayWord || 'Today';
  const contact = options.contactName || 'your emergency contact';
  const list = [...(events || [])]
    .filter((event) => isActivity(event))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.localTime).localeCompare(String(b.localTime)));
  const countWord = list.length === 1 ? 'activity' : 'activities';
  if (list.length === 0) {
    if (options.anomaly) return `It is past check-in time and there has been no activity at the door. ${contact} has been notified.`;
    return `No activity at the door ${dayWord.toLowerCase()}.`;
  }
  const phrases = capPhrases(highlights(list, options));
  const ending = options.anomaly ? 'Someone should take a look.' : 'All clear.';
  if (phrases.length === 0) return `${dayWord}, ${list.length} ${countWord} at the door, all of them small movements. ${ending}`;
  return `${dayWord}, ${list.length} ${countWord} at the door: ${phrases.join(', ')}. ${ending}`;
}

export function buildSampleDay(timeZone: unknown, deviceName?: string): DoorEvent[] {
  const tz = safeZone(timeZone);
  const today = zonedParts(new Date(), tz).localDate;
  const day = shiftDate(today, -1);
  const rows = [
    ['07:40', 'motion', 'Movement at the door', 'The doorbell saw movement. It is not clear whether it was a person or a car.'],
    ['08:02', 'person', 'Someone at the door', 'The doorbell saw someone at the door.'],
    ['09:18', 'vehicle', 'A car passed the door', 'A car passed by.'],
    ['10:30', 'person', 'Someone at the door', 'The doorbell saw someone at the door.'],
    ['12:06', 'motion', 'Movement at the door', 'The doorbell saw movement. It is not clear whether it was a person or a car.'],
    ['15:22', 'motion', 'Movement at the door', 'The doorbell saw movement. It is not clear whether it was a person or a car.'],
    ['18:40', 'person', 'Someone at the door', 'The doorbell saw someone at the door.']
  ];
  return rows.map(([localTime, kind, title, detail]) => ({
    id: newId(),
    at: zonedTimeToUtc(day, localTime, tz),
    localDate: day,
    localTime,
    kind: kind as DoorEvent['kind'],
    title,
    detail,
    deviceName: deviceName || 'Front door',
    timestampMs: new Date(zonedTimeToUtc(day, localTime, tz)).getTime(),
    snapshotUrl: '',
    notified: false,
    sample: true
  }));
}

const SNAPSHOT_COLORS = {
  doorbell: ['#5c3b09', '#fff8e8'],
  person: ['#0e3f66', '#f4f8ff'],
  vehicle: ['#0e4a42', '#f3fffb'],
  motion: ['#3f3832', '#fff8f1'],
  anomaly: ['#7a1d1d', '#fff6f6'],
  package: ['#5c4a12', '#fff8e8'],
  fall: ['#7a1d1d', '#fff6f6'],
  loitering: ['#5c3b09', '#fff8e8'],
  knock: ['#5c3b09', '#fff8e8']
};

export function demoSnapshotSvg({ title, timeLabel, deviceName, kind }: {
  title: string;
  timeLabel: string;
  deviceName: string;
  kind: string;
}): string {
  const [bg, fg] = (SNAPSHOT_COLORS as Record<string, string[]>)[kind] || SNAPSHOT_COLORS.motion;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="${bg}"/>
  <rect x="860" y="120" width="280" height="460" rx="18" fill="none" stroke="${fg}" stroke-width="10"/>
  <circle cx="1100" cy="360" r="10" fill="${fg}"/>
  <text x="72" y="150" fill="${fg}" font-size="36" font-family="Segoe UI, sans-serif">${xmlEscape(deviceName)} · practice image</text>
  <text x="72" y="330" fill="${fg}" font-size="84" font-family="Microsoft YaHei, Segoe UI, sans-serif">${xmlEscape(title)}</text>
  <text x="72" y="430" fill="${fg}" font-size="42" font-family="Microsoft YaHei, Segoe UI, sans-serif">${xmlEscape(timeLabel)}</text>
</svg>`;
}

export function dateLabel(localDate: string, today: string, yesterday: string): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const formatted = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, day)));
  if (localDate === today) return `Today, ${formatted}`;
  if (localDate === yesterday) return `Yesterday, ${formatted}`;
  return `${formatted}, ${year}`;
}

export function hashEvents(events: { id: string }[]): string {
  return crypto.createHash('sha256').update(events.map((event) => event.id).sort().join('|')).digest('hex').slice(0, 16);
}

export function routineStatus(events: DoorEvent[] | undefined, settings: Partial<Settings> | undefined, now: ZonedParts): { lateHome: boolean } {
  const leaveBy = minutes((settings && settings.leaveBy) || '08:15');
  const homeBy = minutes((settings && settings.homeBy) || '18:30');
  const nowMin = now.hour * 60 + now.minute;
  const people = (events || []).filter((event) => event.localDate === now.localDate && !event.sample && (event.kind === 'person' || event.kind === 'doorbell'));
  const left = people.some((event) => minutes(event.localTime) <= leaveBy);
  const home = people.some((event) => minutes(event.localTime) >= homeBy);
  return { lateHome: nowMin >= homeBy && left && !home };
}

export function defaultSettings(timeZone?: unknown): Settings {
  return {
    deviceName: 'Front door',
    checkInBy: '10:00',
    leaveBy: '08:15',
    homeBy: '18:30',
    timeZone: safeZone(timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone),
    anomalyEnabled: true,
    lateHomeEnabled: true,
    bedsideMode: true,
    playChimeOnDoorbell: true,
    anomalyFiredOn: '',
    lateHomeFiredOn: '',
    playgroundConnectedAt: 0,
    paused: false,
    pauseReason: '',
    alerts: { doorbell: true, person: true, vehicle: false, motion: false, package: true, fall: true, loitering: true, knock: true },
    emergencyName: 'Daughter',
    rules: []
  };
}

export function sanitizeSettings(input: Record<string, unknown>, current: Settings): Settings {
  const next: Settings = { ...current, alerts: { ...current.alerts } as AlertFlags };
  if (typeof input.deviceName === 'string' && input.deviceName.trim()) {
    next.deviceName = input.deviceName.trim().slice(0, 24);
  }
  if (typeof input.emergencyName === 'string' && input.emergencyName.trim()) {
    next.emergencyName = input.emergencyName.trim().slice(0, 24);
  }
  if (typeof input.checkInBy === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.checkInBy)) {
    next.checkInBy = input.checkInBy;
  }
  if (typeof input.leaveBy === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.leaveBy)) {
    next.leaveBy = input.leaveBy;
  }
  if (typeof input.homeBy === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.homeBy)) {
    next.homeBy = input.homeBy;
  }
  if (typeof input.timeZone === 'string') next.timeZone = safeZone(input.timeZone);
  if (typeof input.anomalyEnabled === 'boolean') next.anomalyEnabled = input.anomalyEnabled;
  if (typeof input.lateHomeEnabled === 'boolean') next.lateHomeEnabled = input.lateHomeEnabled;
  if (typeof input.bedsideMode === 'boolean') next.bedsideMode = input.bedsideMode;
  if (typeof input.playChimeOnDoorbell === 'boolean') next.playChimeOnDoorbell = input.playChimeOnDoorbell;
  if (input.alerts && typeof input.alerts === 'object') {
    const alerts = input.alerts as Record<string, unknown>;
    for (const key of ALERT_KEYS) {
      if (typeof alerts[key] === 'boolean') next.alerts[key] = alerts[key];
    }
  }
  return next;
}
