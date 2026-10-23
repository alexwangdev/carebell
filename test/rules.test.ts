import test from 'node:test';
import assert from 'node:assert/strict';
import { zonedParts } from '../lib/domain';
import { sanitizeRule, describeRule, quietRuleDue, matchBetween, describesDoorRule, stayEpisode } from '../lib/rules';
import type { DoorEvent } from '../lib/types';

test('a written rule must name the door and a time', () => {
  assert.equal(describesDoorRule('aaaadsad'), false);
  assert.equal(describesDoorRule('Turn on the porch lights'), false);
  assert.equal(describesDoorRule('Alert me if nobody has been at the door by 10:00'), true);
});

test('a rule only accepts door choices', () => {
  assert.equal(sanitizeRule({
    kind: 'by',
    time: '10:00',
    days: 'every',
    condition: 'siren',
    action: 'alert'
  }), null);
  const rule = sanitizeRule({
    kind: 'by',
    time: '10:00',
    days: 'every',
    condition: 'activity',
    action: 'contact'
  });
  assert.ok(rule);
  assert.equal(rule.condition, 'activity');
  assert.equal(describeRule(rule, 'Daughter'), 'Every day, by 10:00, if there is no activity at the door, show an alert and tell Daughter.');
});

test('a quiet-morning rule is due only when the door stayed quiet', () => {
  const now = new Date('2026-10-17T15:00:00Z');
  const zoned = zonedParts(now, 'UTC');
  const rule = sanitizeRule({
    kind: 'by',
    time: '10:00',
    days: 'weekends',
    condition: 'activity',
    action: 'alert'
  });
  assert.ok(rule);
  assert.equal(quietRuleDue(rule, zoned, [], 'UTC', now), true);
  const person: DoorEvent = { id: '1', at: '', localDate: zoned.localDate, localTime: '09:00', kind: 'person', title: '', detail: '', sample: false };
  assert.equal(quietRuleDue(rule, zoned, [person], 'UTC', now), false);
  assert.equal(quietRuleDue({ ...rule, days: 'weekdays' }, zoned, [], 'UTC', now), false);
});

test('someone at the door for several minutes alerts once the photos match', () => {
  const rule = sanitizeRule({
    kind: 'stay',
    minutes: 3,
    days: 'every',
    condition: 'person',
    action: 'alert'
  });
  assert.ok(rule);
  assert.equal(describeRule(rule, 'Daughter'), 'Every day, if someone keeps appearing at the door for 3 minutes, show an alert.');
  const now = Date.parse('2026-10-17T15:10:00Z');
  const same = '1'.repeat(64);
  const other = `${'0'.repeat(20)}${'1'.repeat(44)}`;
  const stayed = stayEpisode(rule, [
    { id: 'a', at: '', localDate: '2026-10-17', localTime: '15:05', kind: 'person', title: '', detail: '', timestampMs: now - 5 * 60 * 1000, photoHash: same, snapshotUrl: '/media/a.jpg' },
    { id: 'b', at: '', localDate: '2026-10-17', localTime: '15:09', kind: 'person', title: '', detail: '', timestampMs: now - 60 * 1000, photoHash: same, snapshotUrl: '/media/b.jpg', familiarName: 'Mia' }
  ], now, 'UTC');
  assert.ok(stayed);
  assert.equal(stayed.minutes, 4);
  assert.equal(stayed.name, 'Mia');
  assert.equal(stayEpisode(rule, [
    { id: 'a', at: '', localDate: '2026-10-17', localTime: '15:09', kind: 'person', title: '', detail: '', timestampMs: now - 60 * 1000, photoHash: same },
    { id: 'b', at: '', localDate: '2026-10-17', localTime: '15:09', kind: 'person', title: '', detail: '', timestampMs: now - 30 * 1000, photoHash: same }
  ], now, 'UTC'), null);
  assert.equal(stayEpisode(rule, [
    { id: 'a', at: '', localDate: '2026-10-17', localTime: '15:05', kind: 'person', title: '', detail: '', timestampMs: now - 5 * 60 * 1000, photoHash: same },
    { id: 'b', at: '', localDate: '2026-10-17', localTime: '15:09', kind: 'person', title: '', detail: '', timestampMs: now - 60 * 1000, photoHash: other }
  ], now, 'UTC'), null);
});

test('a time window can cross midnight and still match a doorbell', () => {
  const rule = sanitizeRule({
    kind: 'between',
    time: '21:00',
    end: '07:00',
    days: 'every',
    condition: 'doorbell',
    action: 'alert'
  });
  assert.ok(rule);
  const night: DoorEvent = { id: 'n', at: '', localDate: '2026-10-17', localTime: '22:10', kind: 'doorbell', title: '', detail: '', sample: false };
  const noon: DoorEvent = { id: 'd', at: '', localDate: '2026-10-17', localTime: '12:00', kind: 'doorbell', title: '', detail: '', sample: false };
  assert.equal(matchBetween([rule], night, 'UTC')?.id, rule.id);
  assert.equal(matchBetween([rule], noon, 'UTC'), null);
});
