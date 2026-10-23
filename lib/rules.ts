import { minutes, newId, speakTime, zonedTimeToUtc } from './domain';
import type { DoorEvent, Rule, RuleAction, RuleCondition, RuleDays, RuleKind, StayEpisode } from './types';

export const DAYS: Record<RuleDays, string> = {
  every: 'Every day',
  weekdays: 'Weekdays',
  weekends: 'Weekends'
};

export const CONDITIONS: Record<RuleCondition, string> = {
  doorbell: 'Someone pressed the doorbell',
  person: 'Someone at the door',
  familiar: 'A familiar person',
  vehicle: 'A car passed',
  motion: 'Movement at the door',
  activity: 'Any activity at the door'
};

export const ACTIONS: Record<RuleAction, string> = {
  alert: 'Show an alert',
  contact: 'Show an alert and tell the emergency contact'
};

const WHEN = {
  doorbell: 'someone presses the doorbell',
  person: 'someone is at the door',
  familiar: 'a familiar person is at the door',
  vehicle: 'a car passes',
  motion: 'there is movement at the door',
  activity: 'there is activity at the door'
};

const QUIET = {
  doorbell: 'doorbell press',
  person: 'person at the door',
  familiar: 'familiar person',
  vehicle: 'car at the door',
  motion: 'movement at the door',
  activity: 'activity at the door'
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ACTIVITY = new Set(['doorbell', 'person', 'vehicle', 'motion', 'package', 'fall', 'loitering', 'knock']);

function dayMatches(days: string | undefined, date: Date, timeZone?: string): boolean {
  if (days === 'every') return true;
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    weekday: 'short'
  }).format(date);
  const weekend = name === 'Sat' || name === 'Sun';
  if (days === 'weekends') return weekend;
  if (days === 'weekdays') return !weekend;
  return false;
}

export function conditionMatches(condition: string | undefined, event: DoorEvent | null | undefined): boolean {
  if (!event || event.sample || !ACTIVITY.has(event.kind)) return false;
  if (condition === 'activity') return true;
  if (condition === 'familiar') return Boolean(event.familiarName);
  return event.kind === condition;
}

function inWindow(localTime: string, start: string, end: string): boolean {
  const value = minutes(localTime);
  const from = minutes(start);
  const to = minutes(end);
  if (Number.isNaN(value) || Number.isNaN(from) || Number.isNaN(to)) return false;
  if (from === to) return value === from;
  if (from < to) return value >= from && value <= to;
  return value >= from || value <= to;
}

function cleanMinutes(value: unknown): number {
  const number = Math.round(Number(value));
  if (number >= 1 && number <= 60) return number;
  return 3;
}

export function sanitizeRule(input: any, id?: string): Rule | null {
  if (!input || typeof input !== 'object') return null;
  if (input.kind !== 'by' && input.kind !== 'between' && input.kind !== 'stay') return null;
  if (input.kind !== 'stay' && !TIME.test(String(input.time || ''))) return null;
  if (input.kind === 'between' && !TIME.test(String(input.end || ''))) return null;
  if (!DAYS[input.days] || !ACTIONS[input.action]) return null;
  let condition = input.condition;
  if (input.kind === 'stay' && !['person', 'familiar', 'doorbell', 'activity'].includes(condition)) condition = 'person';
  if (!CONDITIONS[condition]) return null;
  return {
    id: id || newId(),
    enabled: input.enabled !== false,
    kind: input.kind as RuleKind,
    time: input.kind === 'stay' ? '' : input.time,
    end: input.kind === 'between' ? input.end : '',
    minutes: input.kind === 'stay' ? cleanMinutes(input.minutes) : 0,
    days: input.days as RuleDays,
    condition: condition as RuleCondition,
    action: input.action as RuleAction,
    firedOn: '',
    stayFrom: 0
  };
}

export function describeRule(rule: Rule, contactName?: string): string {
  const day = DAYS[rule.days] || 'Every day';
  const action = rule.action === 'contact'
    ? `show an alert and tell ${contactName || 'the emergency contact'}`
    : 'show an alert';
  if (rule.kind === 'stay') {
    const who = rule.condition === 'familiar' ? 'a familiar person' : 'someone';
    return `${day}, if ${who} keeps appearing at the door for ${rule.minutes} minutes, ${action}.`;
  }
  if (rule.kind === 'between') {
    return `${day}, from ${speakTime(rule.time)} to ${speakTime(rule.end)}, when ${WHEN[rule.condition]}, ${action}.`;
  }
  return `${day}, by ${speakTime(rule.time)}, if there is no ${QUIET[rule.condition]}, ${action}.`;
}

export function describesDoorRule(sentence: unknown): boolean {
  const text = String(sentence || '').trim().toLowerCase();
  if (text.length < 8 || text.length > 240) return false;
  const door = /\b(door|doorbell|bell|person|someone|somebody|visitor|car|vehicle|motion|movement|familiar|activity|quiet|home|arrive|arrived|left|leave|leaving|ring|rings|rang)\b/;
  const clock = /\b([01]?\d|2[0-3])(:[0-5]\d)?\s*(am|pm)?\b|\b(morning|evening|night|noon|midnight)\b/;
  const intent = /\b(alert|notify|tell|warn|notice|check|nobody|no one|hasn'?t|has not)\b/;
  const stay = /\b(stay|stays|staying|linger|lingering|walking|walks|walked|minutes|minute)\b/;
  if (door.test(text) && stay.test(text)) return true;
  if (door.test(text) && (clock.test(text) || intent.test(text))) return true;
  return clock.test(text) && intent.test(text);
}

export function quietCopy(rule: Rule, contactName?: string): { title: string; detail: string } {
  const name = contactName || 'your emergency contact';
  return {
    title: `No ${QUIET[rule.condition]} by ${speakTime(rule.time)}`,
    detail: rule.action === 'contact'
      ? `${name} has been notified.`
      : 'The door has been quiet past the time in your rule.'
  };
}

export function quietRuleDue(rule: Rule | null | undefined, zoned: { localDate: string; hour: number; minute: number } | null | undefined, events: DoorEvent[] | undefined, timeZone: string | undefined, now: Date): boolean {
  if (!rule || rule.enabled === false || rule.kind !== 'by') return false;
  if (!zoned || rule.firedOn === zoned.localDate) return false;
  if (!dayMatches(rule.days, now, timeZone)) return false;
  if ((zoned.hour * 60) + zoned.minute < minutes(rule.time)) return false;
  return !(events || []).some((event) => event.localDate === zoned.localDate && conditionMatches(rule.condition, event));
}

function hashesSimilar(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) score += 1;
  }
  return score <= 12;
}

export function stayCopy(rule: Rule, episode: StayEpisode, contactName?: string): { title: string; detail: string } {
  const who = episode.name || 'Someone';
  const name = contactName || 'your emergency contact';
  return {
    title: `${who} has been at the door for ${episode.minutes} minutes`,
    detail: rule.action === 'contact'
      ? `${name} has been notified. The same door photo kept appearing.`
      : 'The same door photo kept appearing. CareBell compared those photos on this computer.'
  };
}

export function stayEpisode(rule: Rule | null | undefined, events: DoorEvent[] | undefined, nowMs: number, timeZone?: string): StayEpisode | null {
  if (!rule || rule.enabled === false || rule.kind !== 'stay') return null;
  if (!dayMatches(rule.days || 'every', new Date(nowMs), timeZone || 'UTC')) return null;
  const needMs = cleanMinutes(rule.minutes) * 60 * 1000;
  const gapMs = needMs + (2 * 60 * 1000);
  const recent = (events || [])
    .filter((event) => event.timestampMs && conditionMatches(rule.condition || 'person', event))
    .filter((event) => nowMs - Number(event.timestampMs) <= needMs + gapMs)
    .sort((a, b) => Number(a.timestampMs) - Number(b.timestampMs));
  if (recent.length < 2) return null;
  const latest = recent[recent.length - 1];
  if (nowMs - Number(latest.timestampMs) > gapMs) return null;
  const visit = [latest];
  for (let index = recent.length - 2; index >= 0; index -= 1) {
    if (Number(visit[0].timestampMs) - Number(recent[index].timestampMs) > gapMs) break;
    visit.unshift(recent[index]);
  }
  const anchor = [...visit].reverse().find((event) => event.photoHash);
  const same = anchor
    ? visit.filter((event) => !event.photoHash || hashesSimilar(event.photoHash, anchor.photoHash))
    : visit;
  if (same.length < 2) return null;
  const span = Number(same[same.length - 1].timestampMs) - Number(same[0].timestampMs);
  if (span < needMs) return null;
  const names = [...new Set(same.map((event) => event.familiarName).filter(Boolean))];
  const photo = [...same].reverse().find((event) => event.snapshotUrl && /\.jpe?g($|\?)/i.test(event.snapshotUrl));
  return {
    startedAt: Number(same[0].timestampMs),
    minutes: Math.max(cleanMinutes(rule.minutes), Math.round(span / 60000)),
    name: names.length === 1 ? String(names[0]) : '',
    snapshotUrl: photo && photo.snapshotUrl ? photo.snapshotUrl : ''
  };
}

export function matchBetween(rules: Rule[] | undefined, event: DoorEvent | null | undefined, timeZone: string): Rule | null {
  if (!event || !event.localDate || !event.localTime) return null;
  let when;
  try {
    when = new Date(zonedTimeToUtc(event.localDate, event.localTime, timeZone));
  } catch {
    return null;
  }
  return (rules || []).find((rule) => {
    if (!rule || rule.enabled === false || rule.kind !== 'between') return false;
    if (!dayMatches(rule.days, when, timeZone)) return false;
    if (!inWindow(event.localTime, rule.time, rule.end)) return false;
    return conditionMatches(rule.condition, event);
  }) || null;
}
