import { updateTracks } from './tracking';
import type { DoorObject, FrameMotion, FrameObservation, PoseHint, Track } from './types';

export class TemporalEngine {
  tracks: Track[] = [];
  frames: FrameObservation[] = [];
  previousGray?: Uint8Array;

  push(input: {
    at: number;
    width: number;
    height: number;
    objects: DoorObject[];
    poses: PoseHint[];
    motion: FrameMotion;
    gray?: Uint8Array;
    ringKind?: string;
  }): FrameObservation {
    this.tracks = updateTracks(this.tracks, input.objects, input.poses, input.at, input.width, input.height);
    const frame: FrameObservation = {
      at: input.at,
      width: input.width,
      height: input.height,
      objects: input.objects,
      poses: input.poses,
      tracks: this.tracks.slice(),
      motion: input.motion,
      gray: input.gray,
      ringKind: input.ringKind
    };
    this.frames.push(frame);
    if (this.frames.length > 40) this.frames.splice(0, this.frames.length - 40);
    this.previousGray = input.gray;
    return frame;
  }

  clear(): void {
    this.tracks = [];
    this.frames = [];
    this.previousGray = undefined;
  }
}
