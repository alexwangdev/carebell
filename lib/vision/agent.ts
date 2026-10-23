import jpeg from 'jpeg-js';
import { detectObjects } from './objects';
import { loadOpenCv } from './opencv';
import { detectPoses, detectPosesForPeople, personFromPose } from './movenet';
import { boxesOverlap, estimatePose, mergePoses } from './pose';
import { detectYolo } from './yolo';
import { preprocess } from './preprocess';
import { detectEvents, pickEvent } from './events';
import { TemporalEngine } from './temporal';
import { verifyEvents } from './verify';
import type { AgentOptions, DoorScene, VisionEvent } from './types';

function jpegToRgba(buffer: Buffer): { width: number; height: number; data: Uint8Array } | null {
  try {
    const decoded = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
    if (!decoded || !decoded.width || !decoded.height) return null;
    return { width: decoded.width, height: decoded.height, data: decoded.data as Uint8Array };
  } catch {
    return null;
  }
}

export class DoorWatchAgent {
  private sessions = new Map<string, TemporalEngine>();
  options: AgentOptions;

  constructor(options: AgentOptions = {}) {
    this.options = {
      loiterMs: options.loiterMs || 60_000,
      fallHoldMs: options.fallHoldMs || 1500,
      knockPeaks: options.knockPeaks || 2,
      knockWindowMs: options.knockWindowMs || 4000,
      contactName: options.contactName || ''
    };
  }

  engine(sessionId: string): TemporalEngine {
    let engine = this.sessions.get(sessionId);
    if (!engine) {
      engine = new TemporalEngine();
      this.sessions.set(sessionId, engine);
    }
    return engine;
  }

  reset(sessionId?: string): void {
    if (sessionId) this.sessions.delete(sessionId);
    else this.sessions.clear();
  }

  async observe(input: {
    jpeg: Buffer;
    at?: number;
    sessionId?: string;
    ringKind?: string;
    contactName?: string;
  }): Promise<VisionEvent[]> {
    const rgba = jpegToRgba(input.jpeg);
    if (!rgba) return [];
    const cv = await loadOpenCv();
    const sessionId = input.sessionId || 'once';
    const engine = this.engine(sessionId);
    const prepared = preprocess(cv, rgba, engine.previousGray);
    const found = detectObjects(cv, prepared.sharp || prepared.rgba, prepared.motionMask);
    const yolo = await detectYolo(prepared.rgba);
    const yoloPeople = yolo.filter((item) => item.class === 'person');
    const modelPoses = [
      ...await detectPosesForPeople(prepared.rgba, yoloPeople),
      ...await detectPoses(prepared.rgba)
    ];
    const posePeople = modelPoses.map(personFromPose)
      .filter((person) => !yoloPeople.some((other) => boxesOverlap(other, person)));
    const modelPeople = [
      ...yoloPeople,
      ...yolo.filter((item) => item.class === 'package' || item.class === 'vehicle'),
      ...posePeople
    ];
    const keep = found.filter((item) => {
      const onPerson = modelPeople.some((person) => person.class === 'person' && boxesOverlap(person, item));
      if (item.class === 'package' && onPerson) return false;
      if (item.class === 'person' && onPerson) return false;
      if (item.class === 'package' && yolo.some((det) => det.class === 'package' && boxesOverlap(det, item))) return false;
      return true;
    });
    const objects = [...keep, ...modelPeople];
    const poses = mergePoses(modelPoses, estimatePose(objects, prepared.width, prepared.height));
    engine.push({
      at: Number.isFinite(Number(input.at)) ? Number(input.at) : Date.now(),
      width: prepared.width,
      height: prepared.height,
      objects,
      poses,
      motion: {
        energy: prepared.motionEnergy,
        doorEnergy: prepared.doorEnergy,
        flow: prepared.doorEnergy,
        upperDx: 0
      },
      gray: prepared.gray,
      ringKind: input.ringKind
    });
    const events = verifyEvents(detectEvents(engine.frames, {
      ...this.options,
      contactName: input.contactName || this.options.contactName
    }), engine.frames);
    if (sessionId === 'once') this.reset('once');
    return events;
  }

  async observeFrames(input: {
    frames: { jpeg: Buffer; at?: number }[];
    sessionId?: string;
    ringKind?: string;
    contactName?: string;
  }): Promise<VisionEvent[]> {
    let events: VisionEvent[] = [];
    for (const frame of input.frames) {
      events = await this.observe({
        jpeg: frame.jpeg,
        at: frame.at,
        sessionId: input.sessionId || 'clip',
        ringKind: input.ringKind,
        contactName: input.contactName
      });
    }
    if ((input.sessionId || 'clip') === 'clip') this.reset('clip');
    return events;
  }
}

const household = new DoorWatchAgent();

export function householdAgent(): DoorWatchAgent {
  return household;
}

export function sceneFromEvents(events: VisionEvent[]): DoorScene {
  const chosen = pickEvent(events);
  return {
    package: events.some((event) => event.type === 'PackageDeliveryEvent'),
    fall: events.some((event) => event.type === 'FallEvent'),
    loitering: events.some((event) => event.type === 'LoiteringEvent'),
    knock: events.some((event) => event.type === 'KnockEvent'),
    note: chosen ? chosen.note : '',
    events
  };
}
