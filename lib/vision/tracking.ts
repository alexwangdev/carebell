import crypto from 'node:crypto';
import { inRegion, ROI } from './preprocess';
import { withVelocity } from './pose';
import type { DoorObject, PoseHint, Track } from './types';

function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt((dx * dx) + (dy * dy));
}

const ROI_GAP_MS = 12_000;

function roiStreak(track: Track | undefined, inRoi: boolean, at: number): { inRoiHits: number; firstInRoi?: number; lastInRoi?: number } {
  if (!inRoi) return { inRoiHits: 0 };
  const continued = Boolean(track && track.lastInRoi != null && at - track.lastInRoi <= ROI_GAP_MS);
  return {
    inRoiHits: continued ? (track!.inRoiHits + 1) : 1,
    firstInRoi: continued && track!.firstInRoi != null ? track!.firstInRoi : at,
    lastInRoi: at
  };
}

function nearestPose(poses: PoseHint[], object: DoorObject): PoseHint | undefined {
  let best: PoseHint | undefined;
  let bestDist = 80;
  for (const pose of poses) {
    const dist = distance(pose.cx, pose.cy, object.cx, object.cy);
    if (dist < bestDist) {
      best = pose;
      bestDist = dist;
    }
  }
  return best;
}

export function pathLength(track: Track): number {
  let total = 0;
  for (let i = 1; i < track.path.length; i += 1) {
    total += distance(track.path[i - 1].cx, track.path[i - 1].cy, track.path[i].cx, track.path[i].cy);
  }
  return total;
}

export function updateTracks(
  previous: Track[],
  objects: DoorObject[],
  poses: PoseHint[],
  at: number,
  width: number,
  height: number
): Track[] {
  const maxGap = 8 * 60 * 1000;
  const live = previous.filter((track) => at - track.lastAt <= maxGap);
  const used = new Set<number>();
  const next: Track[] = [];
  const limit = Math.sqrt((width * width) + (height * height)) * 0.28;
  for (const track of live) {
    let best = -1;
    let bestDist = limit;
    objects.forEach((object, index) => {
      if (object.class !== track.class || used.has(index)) return;
      const dist = distance(track.cx, track.cy, object.cx, object.cy);
      if (dist < bestDist) {
        best = index;
        bestDist = dist;
      }
    });
    if (best < 0) continue;
    used.add(best);
    const object = objects[best];
    const pose = object.class === 'person'
      ? withVelocity(nearestPose(poses, object) || track.pose, track.pose, at - track.lastAt, height)
      : undefined;
    const inRoi = object.class === 'person' && inRegion(object.cx, object.cy, ROI.entrance, width, height);
    const streak = roiStreak(track, inRoi, at);
    const path = [...track.path, { cx: object.cx, cy: object.cy, at }].slice(-20);
    next.push({
      ...track,
      box: object,
      cx: object.cx,
      cy: object.cy,
      lastAt: at,
      hits: track.hits + 1,
      path,
      pose,
      source: object.source || track.source,
      inRoiHits: streak.inRoiHits,
      firstInRoi: streak.firstInRoi,
      lastInRoi: streak.lastInRoi
    });
  }
  objects.forEach((object, index) => {
    if (used.has(index)) return;
    const pose = object.class === 'person' ? nearestPose(poses, object) : undefined;
    const inRoi = object.class === 'person' && inRegion(object.cx, object.cy, ROI.entrance, width, height);
    const streak = roiStreak(undefined, inRoi, at);
    next.push({
      id: crypto.randomBytes(6).toString('hex'),
      class: object.class,
      box: object,
      cx: object.cx,
      cy: object.cy,
      firstAt: at,
      lastAt: at,
      hits: 1,
      path: [{ cx: object.cx, cy: object.cy, at }],
      pose,
      source: object.source,
      inRoiHits: streak.inRoiHits,
      firstInRoi: streak.firstInRoi,
      lastInRoi: streak.lastInRoi
    });
  });
  return next;
}
