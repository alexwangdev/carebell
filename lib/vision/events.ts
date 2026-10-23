import { runMachines } from './machines';
import type { AgentOptions, FrameObservation, VisionEvent } from './types';

export function detectEvents(frames: FrameObservation[], options: AgentOptions): VisionEvent[] {
  return runMachines(frames, options);
}

export function pickEvent(events: VisionEvent[]): VisionEvent | null {
  const order = ['FallEvent', 'LoiteringEvent', 'PackageDeliveryEvent', 'KnockEvent'];
  for (const type of order) {
    const match = events.find((event) => event.type === type);
    if (match) return match;
  }
  return null;
}
