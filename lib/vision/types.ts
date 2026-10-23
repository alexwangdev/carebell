export type VisionObjectClass = 'person' | 'package' | 'vehicle';
export type Stance = 'standing' | 'fallen' | 'unknown';
export type VisionEventType = 'FallEvent' | 'PackageDeliveryEvent' | 'LoiteringEvent' | 'KnockEvent';
export type FallPhase = 'idle' | 'descending' | 'low' | 'sustained';
export type PackagePhase = 'idle' | 'associated' | 'placed' | 'remains' | 'left';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  area: number;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DoorObject extends Box {
  class: VisionObjectClass;
  cx: number;
  cy: number;
  source?: 'tone' | 'motion' | 'model';
}

export interface Keypoint {
  name: string;
  x: number;
  y: number;
}

export interface PoseHint {
  box: Box;
  stance: Stance;
  cx: number;
  cy: number;
  keypoints: Keypoint[];
  torsoAngle: number;
  hipHeight: number;
  verticalVelocity: number;
  source?: 'model' | 'silhouette';
}

export interface PathPoint {
  cx: number;
  cy: number;
  at: number;
}

export interface Track {
  id: string;
  class: VisionObjectClass;
  box: Box;
  cx: number;
  cy: number;
  firstAt: number;
  lastAt: number;
  hits: number;
  path: PathPoint[];
  pose?: PoseHint;
  source?: 'tone' | 'motion' | 'model';
  inRoiHits: number;
  firstInRoi?: number;
  lastInRoi?: number;
}

export interface FrameMotion {
  energy: number;
  doorEnergy: number;
  flow: number;
  upperDx: number;
}

export interface FrameObservation {
  at: number;
  width: number;
  height: number;
  objects: DoorObject[];
  poses: PoseHint[];
  tracks: Track[];
  motion: FrameMotion;
  gray?: Uint8Array;
  ringKind?: string;
}

export interface VisionEvent {
  type: VisionEventType;
  kind: 'fall' | 'package' | 'loitering' | 'knock';
  at: number;
  title: string;
  detail: string;
  notifyKey: 'fall' | 'package' | 'loitering' | 'knock';
  level: 'notice' | 'critical';
  note: string;
  alwaysNotify: boolean;
  playSound: boolean;
  confidence: number;
  needsReview: boolean;
}

export interface DoorScene {
  package: boolean;
  fall: boolean;
  loitering: boolean;
  knock: boolean;
  note: string;
  events: VisionEvent[];
}

export interface AgentOptions {
  loiterMs?: number;
  fallHoldMs?: number;
  knockPeaks?: number;
  knockWindowMs?: number;
  contactName?: string;
}
