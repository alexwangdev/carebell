import jpeg from 'jpeg-js';
import { DoorWatchAgent, householdAgent, sceneFromEvents } from './agent';
import { pickEvent } from './events';
import { framesFromVideo } from './video';
import type { DoorScene } from './types';

export { loadOpenCv } from './opencv';
export { DoorWatchAgent, householdAgent, sceneFromEvents } from './agent';
export { pickEvent } from './events';
export { framesFromVideo, readVideoFrames, videoFromJpegs } from './video';
export { poseFromKeypoints } from './pose';
export { scoreFall, scoreKnock, scoreLoiter, scorePackage } from './heads';
export type { DoorScene, VisionEvent, VisionEventType } from './types';

export interface SceneCopy {
  kind: 'package' | 'fall' | 'loitering' | 'knock';
  title: string;
  detail: string;
  notifyKey: 'package' | 'fall' | 'loitering' | 'knock';
  level: 'notice' | 'critical';
  alwaysNotify: boolean;
  playSound: boolean;
}

function fillRect(data: Uint8Array, width: number, x: number, y: number, w: number, h: number, r: number, g: number, b: number): void {
  const maxX = Math.min(width, x + w);
  const height = data.length / (width * 4);
  const maxY = Math.min(height, y + h);
  for (let row = Math.max(0, y); row < maxY; row += 1) {
    for (let col = Math.max(0, x); col < maxX; col += 1) {
      const i = ((row * width) + col) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
}

export function sceneJpeg(
  kind: 'empty' | 'package' | 'standing' | 'fall' | 'car' | 'knock' | 'handoff',
  options: { personX?: number } = {}
): Buffer {
  const width = 320;
  const height = 180;
  const data = new Uint8Array(width * height * 4);
  fillRect(data, width, 0, 0, width, 80, 150, 190, 220);
  fillRect(data, width, 0, 80, width, 100, 186, 184, 176);
  const personX = Number.isFinite(options.personX) ? Number(options.personX) : 148;
  if (kind === 'package' || kind === 'handoff') fillRect(data, width, 118, 118, 84, 42, 168, 112, 58);
  if (kind === 'standing' || kind === 'knock' || kind === 'handoff') fillRect(data, width, personX, 48, 36, 108, 42, 42, 52);
  if (kind === 'fall') fillRect(data, width, 78, 122, 164, 38, 42, 42, 52);
  if (kind === 'car') fillRect(data, width, 20, 86, 250, 48, 28, 28, 32);
  return Buffer.from(jpeg.encode({ data: Buffer.from(data), width, height }, 85).data);
}

export async function analyzeDoorPhoto(buffer: Buffer, contactName?: string): Promise<DoorScene> {
  const events = await new DoorWatchAgent().observe({ jpeg: buffer, contactName });
  return sceneFromEvents(events);
}

export async function analyzeDoorVideo(mp4: Buffer, options: { startAt?: number; contactName?: string; sessionId?: string } = {}): Promise<DoorScene> {
  const frames = await framesFromVideo(mp4, { startAt: options.startAt, fps: 5, maxFrames: 40 });
  if (!frames.length) {
    return { package: false, fall: false, loitering: false, knock: false, note: '', events: [] };
  }
  const events = await new DoorWatchAgent().observeFrames({
    sessionId: options.sessionId || 'clip',
    frames,
    contactName: options.contactName
  });
  return sceneFromEvents(events);
}

export async function observeHousehold(input: {
  userId: string;
  jpeg?: Buffer;
  mp4?: Buffer;
  frames?: { jpeg: Buffer; at?: number }[];
  at?: number;
  ringKind?: string;
  contactName?: string;
}): Promise<DoorScene> {
  const fromVideo = input.mp4 && !input.frames?.length
    ? await framesFromVideo(input.mp4, { startAt: input.at, fps: 5, maxFrames: 40 })
    : [];
  const frames = (input.frames && input.frames.length)
    ? input.frames
    : (fromVideo.length ? fromVideo : (input.jpeg ? [{ jpeg: input.jpeg, at: input.at }] : []));
  if (!frames.length) {
    return { package: false, fall: false, loitering: false, knock: false, note: '', events: [] };
  }
  const events = await householdAgent().observeFrames({
    sessionId: input.userId,
    frames,
    ringKind: input.ringKind,
    contactName: input.contactName
  });
  return sceneFromEvents(events);
}

export function sceneCopy(scene: DoorScene, contactName?: string): SceneCopy | null {
  const chosen = pickEvent(scene.events || []);
  if (chosen) {
    const detail = chosen.kind === 'fall' && contactName
      ? `${contactName} has been notified. Please look at the door now.`
      : chosen.detail;
    return {
      kind: chosen.kind,
      title: chosen.title,
      detail,
      notifyKey: chosen.notifyKey,
      level: chosen.level,
      alwaysNotify: chosen.alwaysNotify,
      playSound: chosen.playSound
    };
  }
  const name = contactName || 'your emergency contact';
  if (scene.fall) {
    return {
      kind: 'fall',
      title: 'Someone may have fallen at the door',
      detail: `${name} has been notified. Please look at the door now.`,
      notifyKey: 'fall',
      level: 'critical',
      alwaysNotify: false,
      playSound: true
    };
  }
  if (scene.loitering) {
    return {
      kind: 'loitering',
      title: 'Someone has been waiting at the door',
      detail: 'The same person stayed near the door for one minute. CareBell compared those frames on this computer.',
      notifyKey: 'loitering',
      level: 'notice',
      alwaysNotify: false,
      playSound: false
    };
  }
  if (scene.package) {
    return {
      kind: 'package',
      title: 'A package is at the door',
      detail: 'A parcel looks like it was left near the door.',
      notifyKey: 'package',
      level: 'notice',
      alwaysNotify: false,
      playSound: false
    };
  }
  if (scene.knock) {
    return {
      kind: 'knock',
      title: 'Someone is knocking at the door',
      detail: 'Please look at the door. Open it if you can.',
      notifyKey: 'knock',
      level: 'notice',
      alwaysNotify: false,
      playSound: false
    };
  }
  return null;
}

export function canRewriteKind(kind: string | undefined, familiarName?: string, next?: 'package' | 'fall' | 'loitering' | 'knock'): boolean {
  const current = String(kind || '');
  if (['system', 'anomaly', 'late', 'rule', 'offline', 'online'].includes(current)) return false;
  if (next === 'fall') return current !== 'fall';
  if (current === 'fall' || current === 'doorbell' || current === 'vehicle') return false;
  if (current === 'person' && familiarName) return false;
  return true;
}
