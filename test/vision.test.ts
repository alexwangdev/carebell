import test from 'node:test';
import assert from 'node:assert/strict';
import { DoorWatchAgent, analyzeDoorPhoto, analyzeDoorVideo, canRewriteKind, poseFromKeypoints, sceneCopy, sceneJpeg, scoreFall, scorePackage, videoFromJpegs } from '../lib/vision';

test('OpenCV 5 notices a package on the porch and a person who has fallen', async () => {
  const empty = await analyzeDoorPhoto(sceneJpeg('empty'));
  assert.equal(empty.package, false);
  assert.equal(empty.fall, false);
  assert.equal(empty.knock, false);

  const parcel = await analyzeDoorPhoto(sceneJpeg('package'));
  assert.equal(parcel.package, true);
  assert.equal(parcel.fall, false);
  assert.equal(parcel.events[0].type, 'PackageDeliveryEvent');
  const pale = await analyzeDoorPhoto(sceneJpeg('package', { paleBox: true }));
  assert.equal(pale.package, true);
  assert.equal(pale.fall, false);
  const parcelCopy = sceneCopy(parcel, 'Daughter');
  assert.ok(parcelCopy);
  assert.equal(parcelCopy.kind, 'package');
  assert.equal(parcelCopy.title, 'A package is at the door');

  const standing = await analyzeDoorPhoto(sceneJpeg('standing'));
  assert.equal(standing.fall, false);
  assert.equal(standing.package, false);
  assert.equal(standing.knock, false);

  const fallen = await analyzeDoorPhoto(sceneJpeg('fall'));
  assert.equal(fallen.fall, true);
  assert.equal(fallen.package, false);
  assert.equal(fallen.events[0].type, 'FallEvent');
  const fallCopy = sceneCopy(fallen, 'Daughter');
  assert.ok(fallCopy);
  assert.equal(fallCopy.kind, 'fall');
  assert.match(fallCopy.detail, /Daughter/);

  const car = await analyzeDoorPhoto(sceneJpeg('car'));
  assert.equal(car.fall, false);
});

test('a fall needs a drop into a low posture, then a still body raises confidence', async () => {
  const agent = new DoorWatchAgent({ fallHoldMs: 80 });
  await agent.observe({ sessionId: 'fall', jpeg: sceneJpeg('standing'), at: 1_000 });
  const second = await agent.observe({ sessionId: 'fall', jpeg: sceneJpeg('fall'), at: 1_200 });
  assert.equal(second.some((event) => event.type === 'FallEvent'), true);
  const third = await agent.observe({ sessionId: 'fall', jpeg: sceneJpeg('fall'), at: 1_400 });
  const fallen = third.find((event) => event.type === 'FallEvent');
  assert.ok(fallen);
  assert.ok(fallen.confidence >= 0.7);
});

test('a package delivery is a person with a parcel, then the parcel left behind', async () => {
  const agent = new DoorWatchAgent();
  const first = await agent.observe({ sessionId: 'box', jpeg: sceneJpeg('handoff'), at: 1_000 });
  assert.equal(first.some((event) => event.type === 'PackageDeliveryEvent'), false);
  const second = await agent.observe({ sessionId: 'box', jpeg: sceneJpeg('package'), at: 1_400 });
  assert.equal(second.some((event) => event.type === 'PackageDeliveryEvent'), true);
  assert.equal(second.some((event) => event.type === 'FallEvent'), false);
});

test('the agent tracks a person over time and raises a loitering event', async () => {
  const agent = new DoorWatchAgent({ loiterMs: 80 });
  const first = await agent.observe({ sessionId: 'porch', jpeg: sceneJpeg('standing'), at: 1_000 });
  assert.equal(first.some((event) => event.type === 'KnockEvent'), false);
  assert.equal(first.some((event) => event.type === 'LoiteringEvent'), false);
  const second = await agent.observe({ sessionId: 'porch', jpeg: sceneJpeg('standing'), at: 1_090 });
  const linger = second.find((event) => event.type === 'LoiteringEvent');
  assert.ok(linger);
  assert.equal(linger.kind, 'loitering');
  assert.equal(second.some((event) => event.type === 'FallEvent'), false);
});

test('a six second visit is not a one minute wait', async () => {
  const agent = new DoorWatchAgent();
  await agent.observe({ sessionId: 'short-wait', jpeg: sceneJpeg('standing'), at: 0 });
  await agent.observe({ sessionId: 'short-wait', jpeg: sceneJpeg('standing'), at: 3_000 });
  const events = await agent.observe({ sessionId: 'short-wait', jpeg: sceneJpeg('standing'), at: 6_000 });
  assert.equal(events.some((event) => event.type === 'LoiteringEvent'), false);
});

test('the same person near the door for one minute raises a waiting alert', async () => {
  const agent = new DoorWatchAgent();
  let events = [];
  for (let i = 0; i <= 6; i += 1) {
    events = await agent.observe({
      sessionId: 'long-wait',
      jpeg: sceneJpeg('standing'),
      at: i * 10_000
    });
  }
  const linger = events.find((event) => event.type === 'LoiteringEvent');
  assert.ok(linger);
  assert.match(linger.title, /1 minute/);
  assert.equal(/minutes/.test(linger.title), false);
});

test('a short door recording does not become a one minute wait', async () => {
  const mp4 = await videoFromJpegs(Array.from({ length: 12 }, () => sceneJpeg('standing')), { fps: 2 });
  assert.ok(mp4 && mp4.length > 64);
  const scene = await analyzeDoorVideo(mp4, { startAt: 0 });
  assert.equal(scene.loitering, false);
});

test('a knock is repeated motion at the door, not a person standing still', async () => {
  const agent = new DoorWatchAgent({ knockPeaks: 2, knockWindowMs: 800 });
  const offsets = [132, 164, 128, 168];
  let events = [];
  for (let i = 0; i < offsets.length; i += 1) {
    events = await agent.observe({
      sessionId: 'knock',
      jpeg: sceneJpeg('standing', { personX: offsets[i] }),
      at: 1_000 + (i * 80)
    });
  }
  assert.equal(events.some((event) => event.type === 'KnockEvent'), true);
  assert.equal(events.some((event) => event.type === 'FallEvent'), false);
});

test('OpenCV reads a door recording and notices a leftover parcel', async () => {
  const mp4 = await videoFromJpegs([
    sceneJpeg('empty'),
    sceneJpeg('package', { paleBox: true }),
    sceneJpeg('package', { paleBox: true })
  ], { fps: 2 });
  assert.ok(mp4 && mp4.length > 64);
  const scene = await analyzeDoorVideo(mp4, { startAt: 1_000 });
  assert.equal(scene.package, true);
  assert.equal(scene.fall, false);
  assert.equal(scene.events.some((event) => event.type === 'PackageDeliveryEvent'), true);
});

test('OpenCV reads a door recording and notices a fall', async () => {
  const mp4 = await videoFromJpegs([
    sceneJpeg('standing'),
    sceneJpeg('standing'),
    sceneJpeg('fall'),
    sceneJpeg('fall')
  ], { fps: 2 });
  assert.ok(mp4 && mp4.length > 64);
  const scene = await analyzeDoorVideo(mp4, { startAt: 1_000 });
  assert.equal(scene.fall, true);
  assert.equal(scene.events.some((event) => event.type === 'FallEvent'), true);
});

test('a pose model treats a horizontal body as a fall and an upright body as standing', () => {
  const standing = poseFromKeypoints({
    lShoulder: { x: 140, y: 52, score: 0.9 },
    rShoulder: { x: 180, y: 52, score: 0.9 },
    lHip: { x: 146, y: 112, score: 0.9 },
    rHip: { x: 174, y: 112, score: 0.9 },
    nose: { x: 160, y: 28, score: 0.88 },
    lAnkle: { x: 148, y: 162, score: 0.8 },
    rAnkle: { x: 172, y: 162, score: 0.8 }
  }, 320, 180);
  assert.ok(standing);
  assert.equal(standing.stance, 'standing');
  assert.equal(standing.source, 'model');

  const fallen = poseFromKeypoints({
    lShoulder: { x: 78, y: 128, score: 0.86 },
    rShoulder: { x: 90, y: 150, score: 0.86 },
    lHip: { x: 168, y: 130, score: 0.86 },
    rHip: { x: 180, y: 152, score: 0.86 },
    nose: { x: 58, y: 140, score: 0.8 },
    lAnkle: { x: 236, y: 132, score: 0.72 },
    rAnkle: { x: 248, y: 154, score: 0.72 }
  }, 320, 180);
  assert.ok(fallen);
  assert.equal(fallen.stance, 'fallen');
  assert.equal(fallen.source, 'model');

  const porch = poseFromKeypoints({
    lShoulder: { x: 148, y: 108, score: 0.82 },
    rShoulder: { x: 176, y: 110, score: 0.82 },
    lHip: { x: 150, y: 138, score: 0.8 },
    rHip: { x: 174, y: 140, score: 0.8 },
    nose: { x: 162, y: 96, score: 0.78 },
    lAnkle: { x: 152, y: 154, score: 0.7 },
    rAnkle: { x: 170, y: 156, score: 0.7 }
  }, 320, 180);
  assert.ok(porch);
  assert.equal(porch.stance, 'standing');
});

test('event heads score a fall higher than an empty porch', () => {
  const empty = {
    at: 0,
    width: 320,
    height: 180,
    objects: [],
    poses: [],
    tracks: [],
    motion: { energy: 0, doorEnergy: 0, flow: 0, upperDx: 0 }
  };
  const fallen = {
    ...empty,
    poses: [poseFromKeypoints({
      lShoulder: { x: 78, y: 128, score: 0.86 },
      rShoulder: { x: 90, y: 150, score: 0.86 },
      lHip: { x: 168, y: 130, score: 0.86 },
      rHip: { x: 180, y: 152, score: 0.86 },
      nose: { x: 58, y: 140, score: 0.8 },
      lAnkle: { x: 236, y: 132, score: 0.72 },
      rAnkle: { x: 248, y: 154, score: 0.72 }
    }, 320, 180)]
  };
  const standingPose = poseFromKeypoints({
    lShoulder: { x: 140, y: 52, score: 0.9 },
    rShoulder: { x: 180, y: 52, score: 0.9 },
    lHip: { x: 146, y: 112, score: 0.9 },
    rHip: { x: 174, y: 112, score: 0.9 },
    nose: { x: 160, y: 28, score: 0.88 },
    lAnkle: { x: 148, y: 162, score: 0.8 },
    rAnkle: { x: 172, y: 162, score: 0.8 }
  }, 320, 180);
  assert.ok(scoreFall([fallen as any]) > 0.6);
  assert.ok(scoreFall([{ ...empty, poses: [standingPose] } as any]) < 0.4);
  assert.ok(scoreFall([fallen as any]) > scoreFall([empty as any]));
  assert.ok(scorePackage([{ ...empty, objects: [{ class: 'package', x: 118, y: 118, width: 84, height: 42, area: 3528, cx: 160, cy: 139, source: 'model' }] } as any]) > 0.4);
});

test('a leftover package can relabel a ding, but a named visitor stays a person', () => {
  assert.equal(canRewriteKind('person', 'a', 'package'), false);
  assert.equal(canRewriteKind('doorbell', undefined, 'package'), true);
  assert.equal(canRewriteKind('motion', undefined, 'package'), true);
  assert.equal(canRewriteKind('person', undefined, 'package'), true);
  assert.equal(canRewriteKind('doorbell', undefined, 'fall'), true);
  assert.equal(canRewriteKind('doorbell', undefined, 'knock'), false);
  assert.equal(canRewriteKind('motion', undefined, 'knock'), true);
  assert.equal(canRewriteKind('motion', undefined, 'loitering'), true);
});
