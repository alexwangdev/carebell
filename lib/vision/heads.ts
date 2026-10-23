import { choosePersonPose } from './pose';
import type { FrameObservation, PoseHint } from './types';

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function posesOf(frames: FrameObservation[]): PoseHint[] {
  return frames.map((frame) => choosePersonPose(frame.poses)).filter((item): item is PoseHint => Boolean(item));
}

function fallFeatures(poses: PoseHint[]): number[] {
  if (!poses.length) return [0, 0, 0, 0, 0];
  const fallen = poses.filter((item) => item.stance === 'fallen').length / poses.length;
  const angles = poses.map((item) => item.torsoAngle / 90);
  const wides = poses.map((item) => item.box.width / Math.max(1, item.box.height));
  const drop = Math.max(0, (poses[poses.length - 1].cy - poses[0].cy) / 180);
  const descent = Math.max(0, ...poses.map((item) => item.verticalVelocity));
  return [
    fallen,
    Math.max(...angles),
    Math.min(2, Math.max(...wides)),
    Math.min(1, descent),
    Math.min(1, drop)
  ];
}

const FALL = { bias: -4.2, w: [1.4, 2.8, 2.2, 1.2, 1.0] };
const PACKAGE = { bias: -1.8, w: [2.6, 1.4, 1.1] };
const KNOCK = { bias: -2.2, w: [0.9, 1.8] };
const LOITER = { bias: -2.8, w: [2.4, 1.2] };

export function scoreFall(frames: FrameObservation[]): number {
  const x = fallFeatures(posesOf(frames));
  return sigmoid(FALL.bias + FALL.w.reduce((sum, weight, i) => sum + (weight * x[i]), 0));
}

export function scorePackage(frames: FrameObservation[]): number {
  if (!frames.length) return 0;
  const latest = frames[frames.length - 1];
  const parcels = latest.objects.filter((item) => item.class === 'package');
  const people = latest.objects.filter((item) => item.class === 'person' && item.source !== 'motion');
  const fromModel = parcels.some((item) => item.source === 'model') ? 1 : (parcels.length ? 0.45 : 0);
  const left = people.length ? 0 : 1;
  const earlierPerson = frames.some((frame) => frame.objects.some((item) => item.class === 'person' && item.source !== 'motion')) ? 1 : 0;
  return sigmoid(PACKAGE.bias + (PACKAGE.w[0] * fromModel) + (PACKAGE.w[1] * left) + (PACKAGE.w[2] * earlierPerson));
}

export function scoreKnock(peaks: number, personAtDoor: boolean): number {
  return sigmoid(KNOCK.bias + (KNOCK.w[0] * Math.min(4, peaks)) + (KNOCK.w[1] * (personAtDoor ? 1 : 0)));
}

export function scoreLoiter(dwellMs: number, inRoiHits: number): number {
  const minutes = Math.min(3, dwellMs / 60000);
  const hits = Math.min(1, inRoiHits / 8);
  return sigmoid(LOITER.bias + (LOITER.w[0] * minutes) + (LOITER.w[1] * hits));
}
