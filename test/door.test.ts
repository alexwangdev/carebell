import test from 'node:test';
import assert from 'node:assert/strict';
import { describeHousehold, doorKey } from '../lib/ring';

const SECRET_ID = 'device-should-not-leak-9f3a';

test('door health uses the Ring name and never the device id', () => {
  const described = describeHousehold({
    live: true,
    doorbellId: SECRET_ID,
    doorbellName: 'Playground Device',
    doorOnline: true,
    motionEnabled: 'on',
    doors: [{ id: SECRET_ID, name: 'Playground Device' }, { id: 'second-door-id', name: 'Side door' }],
    chimeChecked: true,
    chimeId: 'chime-id',
    online: true,
    snoozed: false
  });
  assert.equal(described.line, 'Playground Device is online');
  assert.equal(described.motion, '');
  assert.equal(described.chime, 'Chime is ready');
  assert.deepEqual(described.doors.map((door) => door.name), ['Playground Device', 'Side door']);
  assert.equal(described.doors[0].watching, true);
  assert.equal(described.doors[1].watching, false);
  const packed = JSON.stringify(described);
  assert.equal(packed.includes(SECRET_ID), false);
  assert.equal(packed.includes('second-door-id'), false);
  assert.equal(packed.includes('chime-id'), false);
  assert.equal(described.doors[0].key, doorKey(SECRET_ID));
  assert.notEqual(described.doors[0].key, SECRET_ID);
});

test('offline door and a snoozed chime use the plain sentences', () => {
  const described = describeHousehold({
    live: true,
    doorbellId: 'front',
    doorbellName: 'Front door',
    doorOnline: false,
    motionEnabled: 'off',
    doors: [{ id: 'front', name: 'Front door' }],
    chimeChecked: true,
    chimeId: 'chime',
    online: true,
    snoozed: true
  });
  assert.equal(described.line, 'The doorbell is offline, so new events will not arrive.');
  assert.equal(described.motion, 'Motion alerts are off. Turn them on in the Ring app.');
  assert.equal(described.chime, 'Chime is snoozed');
});

test('a missing chime is said in words', () => {
  const described = describeHousehold({
    live: true,
    doorbellId: 'front',
    doorbellName: 'Front door',
    doorOnline: true,
    motionEnabled: null,
    doors: [],
    chimeChecked: true,
    chimeId: ''
  });
  assert.equal(described.chime, 'No Chime was found on this Ring account.');
  assert.equal(described.motion, '');
});
