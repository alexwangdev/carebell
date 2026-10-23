import { inRegion, ROI } from './preprocess';
import { choosePersonPose, handX } from './pose';
import { pathLength } from './tracking';
import { scoreFall, scoreKnock, scoreLoiter, scorePackage } from './heads';
import type { AgentOptions, FrameObservation, Track, VisionEvent } from './types';

const NOTE = {
  fall: 'CareBell ran a fall model on this computer. Someone may be on the ground. Please look and confirm.',
  package: 'CareBell ran a parcel model on this computer. A parcel looks like it was left near the door.',
  loitering: 'CareBell tracked the same person near the door for one minute on this computer.',
  knock: 'CareBell ran a knock model on this computer. A wave or a touch can look the same. CareBell does not listen for a knock.'
};

function hypot(width: number, height: number): number {
  return Math.sqrt((width * width) + (height * height));
}

function overlap(a: Track, b: Track): boolean {
  const ax2 = a.box.x + a.box.width;
  const ay2 = a.box.y + a.box.height;
  const bx2 = b.box.x + b.box.width;
  const by2 = b.box.y + b.box.height;
  return a.box.x < bx2 && ax2 > b.box.x && a.box.y < by2 && ay2 > b.box.y;
}

function centers(a: Track, b: Track): number {
  const dx = a.cx - b.cx;
  const dy = a.cy - b.cy;
  return Math.sqrt((dx * dx) + (dy * dy));
}

function fallEvent(at: number, name: string, confidence: number, needsReview: boolean): VisionEvent {
  return {
    type: 'FallEvent',
    kind: 'fall',
    at,
    title: 'Someone may have fallen at the door',
    detail: `${name} has been notified. Please look at the door now.`,
    notifyKey: 'fall',
    level: 'critical',
    note: NOTE.fall,
    alwaysNotify: false,
    playSound: true,
    confidence,
    needsReview
  };
}

function packageEvent(at: number, confidence: number): VisionEvent {
  return {
    type: 'PackageDeliveryEvent',
    kind: 'package',
    at,
    title: 'A package is at the door',
    detail: 'A parcel looks like it was left near the door.',
    notifyKey: 'package',
    level: 'notice',
    note: NOTE.package,
    alwaysNotify: false,
    playSound: false,
    confidence,
    needsReview: confidence < 0.7
  };
}

function loiterTitle(dwellMs: number): string {
  const minutes = Math.max(1, Math.round(dwellMs / 60000));
  if (dwellMs < 60000) return 'Someone has been waiting at the door';
  const label = minutes === 1 ? '1 minute' : `${minutes} minutes`;
  return `Someone has been at the door for ${label}`;
}

function loiterEvent(at: number, dwellMs: number, confidence: number): VisionEvent {
  return {
    type: 'LoiteringEvent',
    kind: 'loitering',
    at,
    title: loiterTitle(dwellMs),
    detail: 'The same person stayed near the door for that time. CareBell compared those frames on this computer.',
    notifyKey: 'loitering',
    level: 'notice',
    note: NOTE.loitering,
    alwaysNotify: false,
    playSound: false,
    confidence,
    needsReview: false
  };
}

function knockEvent(at: number, confidence: number): VisionEvent {
  return {
    type: 'KnockEvent',
    kind: 'knock',
    at,
    title: 'Someone is knocking at the door',
    detail: 'Please look at the door. Open it if you can.',
    notifyKey: 'knock',
    level: 'notice',
    note: NOTE.knock,
    alwaysNotify: false,
    playSound: false,
    confidence,
    needsReview: true
  };
}

function fallFrom(frames: FrameObservation[], holdMs: number, name: string): VisionEvent | null {
  const people = frames.map((frame) => {
    const pose = choosePersonPose(frame.poses)
      || frame.tracks.find((track) => track.pose && track.pose.stance === 'fallen')?.pose
      || frame.tracks.find((track) => track.class === 'person' && track.pose)?.pose;
    return { frame, pose };
  }).filter((item) => item.pose);
  if (!people.length) return null;
  const latest = people[people.length - 1];
  const scored = scoreFall(frames);
  if (!latest.pose || latest.pose.stance !== 'fallen' || scored < 0.55) return null;
  if (latest.pose.box.height >= latest.pose.box.width * 1.2 && latest.pose.torsoAngle < 40) return null;
  const descent = people.some((item) => item.pose && item.pose.verticalVelocity > 0.15);
  const dropped = people.some((item, index) => {
    if (!index || !item.pose || item.pose.stance !== 'fallen') return false;
    const previous = people[index - 1].pose;
    return Boolean(previous && previous.stance !== 'fallen');
  });
  const lowFrames = people.filter((item) => item.pose && item.pose.stance === 'fallen');
  const firstLow = lowFrames[0] || latest;
  const held = latest.frame.at - firstLow.frame.at >= holdMs || lowFrames.length >= 2 || scored >= 0.8;
  if (!held && !descent && !dropped) return null;
  const still = latest.pose.verticalVelocity > -0.08 && latest.pose.verticalVelocity < 0.08;
  let confidence = 0.62;
  if (descent) confidence += 0.16;
  if (held) confidence += 0.12;
  if (still) confidence += 0.08;
  if (scored >= 0.7) confidence += 0.08;
  return fallEvent(latest.frame.at, name, Math.min(0.97, confidence), confidence < 0.78);
}

function packageFrom(frames: FrameObservation[]): VisionEvent | null {
  if (!frames.length) return null;
  const latest = frames[frames.length - 1];
  const span = hypot(latest.width, latest.height);
  let associated = false;
  let placed = false;
  let separated = false;
  let left = false;
  let remains = 0;
  for (const frame of frames) {
    const people = frame.tracks.filter((track) => track.class === 'person' && track.source !== 'motion');
    const parcels = frame.tracks.filter((track) => {
      if (track.class !== 'package' || !inRegion(track.cx, track.cy, ROI.porch, frame.width, frame.height)) return false;
      return !people.some((person) => overlap(person, track) || centers(person, track) < span * 0.18);
    });
    if (!parcels.length) continue;
    placed = true;
    const parcel = parcels[0];
    const near = people.find((person) => overlap(person, parcel) || centers(person, parcel) < span * 0.28);
    if (near) associated = true;
    if (placed && people.length && !near) separated = true;
    const origin = parcel.path[0];
    const travel = origin ? Math.sqrt(((parcel.cx - origin.cx) ** 2) + ((parcel.cy - origin.cy) ** 2)) : 0;
    if (travel < span * 0.06) remains += 1;
    if (placed && !people.length) left = true;
  }
  if (!placed) return null;
  const latestPeople = latest.tracks.filter((track) => track.class === 'person' && track.source !== 'motion');
  const latestParcel = latest.tracks.find((track) => track.class === 'package' && inRegion(track.cx, track.cy, ROI.porch, latest.width, latest.height));
  const holding = Boolean(latestParcel && latestPeople.some((person) => overlap(person, latestParcel) || centers(person, latestParcel) < span * 0.2));
  if (holding) return null;
  if (latestParcel && !associated && latestParcel.box.area > (latest.width * latest.height * 0.08)) return null;
  left = left || Boolean(latestParcel && !holding);
  if (!(left || (associated && separated && remains >= 2))) return null;
  if (scorePackage(frames) < 0.28) return null;
  let confidence = 0.58;
  if (associated) confidence += 0.14;
  if (separated) confidence += 0.1;
  if (remains >= 2) confidence += 0.12;
  else confidence += 0.08;
  return packageEvent(latest.at, Math.min(0.96, confidence));
}

function loiterFrom(frames: FrameObservation[], loiterMs: number): VisionEvent | null {
  const latest = frames[frames.length - 1];
  if (!latest) return null;
  const span = hypot(latest.width, latest.height);
  const people = latest.tracks
    .filter((track) => track.class === 'person')
    .sort((a, b) => (b.lastAt - b.firstAt) - (a.lastAt - a.firstAt));
  for (const person of people) {
    const dwell = (person.lastInRoi ?? 0) - (person.firstInRoi ?? 0);
    const inRoi = inRegion(person.cx, person.cy, ROI.entrance, latest.width, latest.height);
    const travel = pathLength(person) / span;
    if (!inRoi || person.inRoiHits < 2 || dwell < loiterMs) continue;
    if (travel >= 0.28) continue;
    const head = scoreLoiter(dwell, person.inRoiHits);
    const confidence = Math.min(0.95, 0.7 + Math.min(0.2, dwell / (loiterMs * 4)) + (head * 0.08));
    return loiterEvent(latest.at, dwell, confidence);
  }
  return null;
}

function knockFrom(frames: FrameObservation[], peaksNeeded: number, windowMs: number): VisionEvent | null {
  const latest = frames[frames.length - 1];
  if (!latest) return null;
  const window = frames.filter((frame) => latest.at - frame.at <= windowMs);
  const nearDoor = window.filter((frame) => {
    const pose = frame.poses.find((item) => item.stance === 'standing') || frame.poses[0];
    return pose && inRegion(pose.cx, pose.cy, ROI.door, frame.width, frame.height);
  });
  if (!nearDoor.length) return null;
  const xs: number[] = [];
  for (const frame of nearDoor) {
    const pose = frame.poses.find((item) => item.stance === 'standing') || frame.poses[0];
    if (!pose) continue;
    xs.push(handX(pose) / Math.max(1, frame.width));
  }
  let peaks = 0;
  for (let i = 2; i < xs.length; i += 1) {
    const a = xs[i - 2];
    const b = xs[i - 1];
    const c = xs[i];
    const jump = Math.abs(b - a) > 0.012 && Math.abs(c - b) > 0.012;
    const turn = (b - a) * (c - b) < 0;
    if (jump && turn) peaks += 1;
  }
  const energyPeaks = nearDoor.filter((frame, index) => {
    if (index === 0) return false;
    return frame.motion.doorEnergy > 0.04 && frame.motion.doorEnergy >= (nearDoor[index - 1].motion.doorEnergy + 0.015);
  }).length;
  const total = Math.max(peaks, energyPeaks);
  if (total < peaksNeeded) return null;
  const head = scoreKnock(total, true);
  return knockEvent(latest.at, Math.min(0.9, 0.55 + (total * 0.08) + (head * 0.08)));
}

export function runMachines(frames: FrameObservation[], options: AgentOptions): VisionEvent[] {
  const name = options.contactName || 'your emergency contact';
  const found: VisionEvent[] = [];
  const fall = fallFrom(frames, options.fallHoldMs || 1500, name);
  const linger = loiterFrom(frames, options.loiterMs || 60_000);
  const parcel = packageFrom(frames);
  const knock = knockFrom(frames, options.knockPeaks || 2, options.knockWindowMs || 4000);
  if (fall) found.push(fall);
  if (linger && !fall) found.push(linger);
  if (parcel && !fall) found.push(parcel);
  if (knock && !fall) found.push(knock);
  return found;
}
