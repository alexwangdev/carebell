import type { Box, DoorObject, Keypoint, PoseHint } from './types';

function point(name: string, x: number, y: number): Keypoint {
  return { name, x, y };
}

function mid(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function stanceFromGeometry(
  width: number,
  height: number,
  box: Box,
  torsoAngle: number,
  hipHeight: number
): PoseHint['stance'] {
  const tall = box.height / Math.max(1, box.width);
  const wide = box.width / Math.max(1, box.height);
  const cy = box.y + (box.height / 2);
  const low = cy > height * 0.48;
  const short = box.height < height * 0.42;
  if (tall >= 1.35 && torsoAngle < 42) return 'standing';
  const lying = torsoAngle >= 48 && hipHeight > 0.36;
  const flat = wide >= 1.35 && wide <= 6.5 && short && low;
  if ((lying || flat) && box.width < width * 0.94) return 'fallen';
  return 'unknown';
}

export function poseFromKeypoints(
  named: Record<string, { x: number; y: number; score: number }>,
  width: number,
  height: number,
  minScore = 0.28
): PoseHint | null {
  const used = Object.values(named).filter((item) => item.score >= minScore);
  if (used.length < 4) return null;
  const ls = named.lShoulder;
  const rs = named.rShoulder;
  const lh = named.lHip;
  const rh = named.rHip;
  const shoulderOk = Boolean(ls && rs && ls.score >= minScore && rs.score >= minScore);
  const hipOk = Boolean(lh && rh && lh.score >= minScore && rh.score >= minScore);
  if (!shoulderOk && !hipOk) return null;
  const bodyScore = [ls, rs, lh, rh].filter((item) => item && item.score >= minScore).reduce((sum, item) => sum + item.score, 0)
    / Math.max(1, [ls, rs, lh, rh].filter((item) => item && item.score >= minScore).length);
  if (bodyScore < 0.32) return null;
  const neck = shoulderOk ? mid(ls, rs) : mid(lh, rh);
  const hips = hipOk ? mid(lh, rh) : mid(ls, rs);
  const xs = used.map((item) => item.x);
  const ys = used.map((item) => item.y);
  const x = Math.max(0, Math.min(...xs));
  const y = Math.max(0, Math.min(...ys));
  const right = Math.min(width, Math.max(...xs));
  const bottom = Math.min(height, Math.max(...ys));
  const box: Box = {
    x,
    y,
    width: Math.max(8, right - x),
    height: Math.max(8, bottom - y),
    area: 0
  };
  box.area = box.width * box.height;
  const torsoDx = Math.abs(hips.x - neck.x);
  const torsoDy = Math.abs(hips.y - neck.y);
  const torsoAngle = Math.abs((Math.atan2(hips.x - neck.x, Math.max(1, hips.y - neck.y)) * 180) / Math.PI);
  const hipHeight = hips.y / Math.max(1, height);
  let stance = stanceFromGeometry(width, height, box, torsoAngle, hipHeight);
  if (torsoDy >= torsoDx * 1.15 && torsoAngle < 38) stance = 'standing';
  const ySpan = Math.max(1, bottom - y);
  const xSpan = Math.max(1, right - x);
  const low = (y + (box.height / 2)) > height * 0.4;
  if (stance !== 'standing' && xSpan > ySpan * 1.25 && torsoAngle >= 42 && low) stance = 'fallen';
  const head = named.head || named.nose || neck;
  const lHand = named.lHand;
  const rHand = named.rHand;
  const feet = named.feet || (named.lAnkle && named.rAnkle ? mid(named.lAnkle, named.rAnkle) : named.lAnkle || named.rAnkle || hips);
  return {
    box,
    stance,
    cx: x + (box.width / 2),
    cy: y + (box.height / 2),
    keypoints: [
      point('head', head.x, head.y),
      point('neck', neck.x, neck.y),
      point('lShoulder', (ls || neck).x, (ls || neck).y),
      point('rShoulder', (rs || neck).x, (rs || neck).y),
      point('lHip', (lh || hips).x, (lh || hips).y),
      point('rHip', (rh || hips).x, (rh || hips).y),
      point('lHand', (lHand || ls || neck).x, (lHand || ls || neck).y),
      point('rHand', (rHand || rs || neck).x, (rHand || rs || neck).y),
      point('feet', feet.x, feet.y)
    ],
    torsoAngle,
    hipHeight,
    verticalVelocity: 0,
    source: 'model'
  };
}

export function estimatePose(objects: DoorObject[], width: number, height: number): PoseHint[] {
  return objects
    .filter((item) => item.class === 'person' && item.source !== 'motion')
    .map((person) => {
      const x = person.x;
      const y = person.y;
      const w = person.width;
      const h = person.height;
      const head = point('head', person.cx, y + (h * 0.08));
      const neck = point('neck', person.cx, y + (h * 0.18));
      const lShoulder = point('lShoulder', x + (w * 0.22), y + (h * 0.22));
      const rShoulder = point('rShoulder', x + (w * 0.78), y + (h * 0.22));
      const lHip = point('lHip', x + (w * 0.32), y + (h * 0.55));
      const rHip = point('rHip', x + (w * 0.68), y + (h * 0.55));
      const lHand = point('lHand', x + (w * 0.08), y + (h * 0.42));
      const rHand = point('rHand', x + (w * 0.92), y + (h * 0.42));
      const feet = point('feet', person.cx, y + h);
      const hipX = (lHip.x + rHip.x) / 2;
      const hipY = (lHip.y + rHip.y) / 2;
      const torsoAngle = Math.abs((Math.atan2(hipX - neck.x, hipY - neck.y) * 180) / Math.PI);
      const hipHeight = hipY / Math.max(1, height);
      const stance = stanceFromGeometry(width, height, person, torsoAngle, hipHeight);
      return {
        box: person,
        stance,
        cx: person.cx,
        cy: person.cy,
        keypoints: [head, neck, lShoulder, rShoulder, lHip, rHip, lHand, rHand, feet],
        torsoAngle,
        hipHeight,
        verticalVelocity: 0,
        source: 'silhouette' as const
      };
    });
}

function clearlyStanding(pose: PoseHint): boolean {
  return pose.stance === 'standing' || (pose.box.height >= pose.box.width * 1.25 && pose.torsoAngle < 42);
}

function clearlyFallen(pose: PoseHint): boolean {
  return pose.stance === 'fallen' && pose.box.width > pose.box.height * 1.15;
}

export function choosePersonPose(poses: PoseHint[]): PoseHint | undefined {
  if (!poses.length) return undefined;
  const standing = poses.filter(clearlyStanding);
  const fallen = poses.filter(clearlyFallen).filter((item) => {
    const rival = standing.find((other) => boxesOverlap(other.box, item.box));
    if (!rival) return true;
    if (rival.source === 'model' && rival.torsoAngle < 40 && rival.box.height >= rival.box.width * 1.25) return false;
    return item.box.width > rival.box.width;
  });
  if (fallen.length) return fallen.sort((a, b) => b.box.area - a.box.area)[0];
  return standing[0] || poses[0];
}

export function resolvePoses(poses: PoseHint[]): PoseHint[] {
  const kept: PoseHint[] = [];
  const ranked = [...poses].sort((a, b) => b.box.area - a.box.area);
  for (const pose of ranked) {
    const rival = kept.find((item) => boxesOverlap(item.box, pose.box));
    if (!rival) {
      kept.push(pose);
      continue;
    }
    if (clearlyStanding(rival) && !clearlyFallen(pose)) continue;
    if (clearlyStanding(pose) && !clearlyFallen(rival)) {
      kept.splice(kept.indexOf(rival), 1, pose);
    }
  }
  return kept;
}

export function mergePoses(modelPoses: PoseHint[], silhouette: PoseHint[]): PoseHint[] {
  const extra = silhouette.filter((item) => !modelPoses.some((pose) => boxesOverlap(pose.box, item.box)));
  return resolvePoses([...modelPoses, ...extra]);
}

export function withVelocity(pose: PoseHint, previous: PoseHint | undefined, dtMs: number, height: number): PoseHint {
  if (!previous || dtMs <= 0) return pose;
  return {
    ...pose,
    verticalVelocity: (pose.cy - previous.cy) / Math.max(1, height) / (dtMs / 1000)
  };
}

export function handX(pose: PoseHint): number {
  const left = pose.keypoints.find((item) => item.name === 'lHand');
  const right = pose.keypoints.find((item) => item.name === 'rHand');
  if (!left || !right) return pose.cx;
  return (left.x + right.x) / 2;
}
