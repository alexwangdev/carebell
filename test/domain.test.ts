import test from 'node:test';
import assert from 'node:assert/strict';
import { addH265ToSdp } from '../lib/ring';
import {
  signBody,
  verifySignature,
  summarizeDay,
  routineStatus,
  buildSampleDay,
  translateWebhook,
  alreadyHaveDoorMoment,
  suppressRepeatVisionAlert,
  shouldRaiseDoorAlert,
  holdPlaygroundDing,
  applyPlaygroundDingHold,
  restoreHeldDing,
  zonedParts,
  zonedTimeToUtc,
  defaultSettings,
  sanitizeSettings
} from '../lib/domain';

test('sample day becomes one plain sentence', () => {
  const events = buildSampleDay('UTC', 'Front door');
  assert.equal(
    summarizeDay(events),
    'Today, 7 activities at the door: left at 8:02, package drop-off at 10:30, home at 18:40. All clear.'
  );
  assert.equal(
    summarizeDay(events, { dayWord: 'Yesterday' }),
    'Yesterday, 7 activities at the door: left at 8:02, package drop-off at 10:30, home at 18:40. All clear.'
  );
});

test('quiet morning tells the emergency contact', () => {
  assert.equal(
    summarizeDay([], { anomaly: true, contactName: 'Daughter' }),
    'It is past check-in time and there has been no activity at the door. Daughter has been notified.'
  );
});

test('caregiver times keep the sample sentence', () => {
  const events = buildSampleDay('UTC', 'Front door');
  assert.equal(
    summarizeDay(events, { leaveBy: '08:15', homeBy: '18:30' }),
    'Today, 7 activities at the door: left at 8:02, package drop-off at 10:30, home at 18:40. All clear.'
  );
});

test('late return needs a morning departure and no evening arrival', () => {
  const morning = [
    { id: '1', at: '', localDate: '2026-10-17', localTime: '08:02', kind: 'person' as const, title: '', detail: '' },
    { id: '2', at: '', localDate: '2026-10-17', localTime: '10:30', kind: 'person' as const, title: '', detail: '' }
  ];
  const settings = { leaveBy: '08:15', homeBy: '18:30' };
  assert.equal(routineStatus(morning, settings, { localDate: '2026-10-17', localTime: '18:30', hour: 18, minute: 30 }).lateHome, true);
  assert.equal(routineStatus(morning, settings, { localDate: '2026-10-17', localTime: '18:00', hour: 18, minute: 0 }).lateHome, false);
  const home = morning.concat([{ id: '3', at: '', localDate: '2026-10-17', localTime: '18:40', kind: 'person' as const, title: '', detail: '' }]);
  assert.equal(routineStatus(home, settings, { localDate: '2026-10-17', localTime: '18:45', hour: 18, minute: 45 }).lateHome, false);
});

test('doorbell press stays a doorbell press', () => {
  assert.equal(
    summarizeDay([{ id: 'a', at: '2026-10-17T02:30:00.000Z', localDate: '2026-10-17', localTime: '10:30', kind: 'doorbell', title: '', detail: '' }]),
    'Today, 1 activity at the door: doorbell at 10:30. All clear.'
  );
});

test('hmac accepts the raw body and rejects a different body', () => {
  const raw = Buffer.from('{"data":{"type":"button_press"}}');
  const signature = signBody(raw, 'local-key');
  assert.equal(signature.startsWith('sha256='), true);
  assert.equal(verifySignature(raw, signature, 'local-key'), true);
  assert.equal(verifySignature(Buffer.from('{"data":{"type":"button_press"}} '), signature, 'local-key'), false);
  assert.equal(verifySignature(raw, signature, 'other-key'), false);
});

test('an open package alert is not stacked', () => {
  const open = { kind: 'package', at: '2026-10-23T17:04:00.000Z', acked: false, drill: false };
  const seen = { kind: 'package', at: '2026-10-23T17:04:00.000Z', acked: true, drill: false };
  assert.equal(suppressRepeatVisionAlert([open], 'package', Date.parse('2026-10-23T18:00:00.000Z')), true);
  assert.equal(suppressRepeatVisionAlert([seen], 'package', Date.parse('2026-10-23T17:06:00.000Z')), false);
  assert.equal(alreadyHaveDoorMoment([{ timestampMs: 1_000 }], 1_400), true);
  assert.equal(alreadyHaveDoorMoment([{ timestampMs: 1_000 }], 200_000), false);
  assert.equal(alreadyHaveDoorMoment([{ timestampMs: 1_000, kind: 'person' }], 1_400, 'package'), true);
  assert.equal(alreadyHaveDoorMoment([{ timestampMs: 1_000, kind: 'vehicle' }], 1_400, 'person'), false);
  assert.equal(shouldRaiseDoorAlert([open], 'person', Date.parse('2026-10-23T17:06:00.000Z')), false);
  assert.equal(shouldRaiseDoorAlert([seen], 'person', Date.parse('2026-10-23T17:06:00.000Z')), true);
  assert.equal(shouldRaiseDoorAlert([seen], 'fall', Date.parse('2026-10-23T17:06:00.000Z')), true);
});

test('a Playground ding is not a doorbell press until the clip is checked', () => {
  assert.equal(holdPlaygroundDing('doorbell', 'playground'), true);
  assert.equal(holdPlaygroundDing('doorbell', 'ring'), false);
  const event = { kind: 'doorbell', deviceName: 'Playground Device', title: '', detail: '', notifyKey: 'doorbell', level: 'critical', ringType: '' };
  assert.equal(applyPlaygroundDingHold(event, 'playground'), true);
  assert.equal(event.kind, 'person');
  assert.equal(event.ringType, 'ding');
  assert.equal(restoreHeldDing(event), true);
  assert.equal(event.kind, 'doorbell');
});

test('motion human subtype becomes a person at the door', () => {
  const event = translateWebhook({
    meta: { request_id: 'req-1' },
    data: {
      type: 'motion_detected',
      subType: 'human',
      attributes: { timestamp: Date.parse('2026-10-17T12:02:00Z') }
    }
  }, defaultSettings('UTC'));
  assert.ok(event);
  assert.equal(event.kind, 'person');
  assert.equal(event.title, 'Someone at the door');
  assert.equal(event.notifyKey, 'person');
});

test('local time round-trips through a timezone', () => {
  const at = zonedTimeToUtc('2026-10-16', '08:02', 'America/New_York');
  const parts = zonedParts(new Date(at), 'America/New_York');
  assert.equal(parts.localDate, '2026-10-16');
  assert.equal(parts.localTime, '08:02');
});

test('live view offer includes an H.265 codec for newer doorbells', () => {
  const offer = addH265ToSdp('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\na=recvonly\r\n');
  assert.match(offer, /m=video 9 UDP\/TLS\/RTP\/SAVPF 96 127/);
  assert.match(offer, /a=rtpmap:127 H265\/90000/);
  assert.equal(addH265ToSdp(offer), offer);
});

test('care settings keep the Ring token off the form', () => {
  const current = defaultSettings('UTC');
  current.ringToken = 'secret-token';
  const next = sanitizeSettings({ deviceName: 'Porch', alerts: { vehicle: true } }, current);
  assert.equal(next.deviceName, 'Porch');
  assert.equal(next.alerts.vehicle, true);
  assert.equal(next.ringToken, 'secret-token');
  assert.equal(next.rules.length, 0);
});
