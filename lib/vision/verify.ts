import type { FrameObservation, VisionEvent } from './types';

export function verifyEvents(events: VisionEvent[], frames: FrameObservation[]): VisionEvent[] {
  const extra = Math.min(0.08, Math.max(0, (frames.length - 1) * 0.03));
  return events.map((event) => {
    const confidence = Math.min(0.98, event.confidence + extra);
    const needsReview = event.kind === 'fall'
      ? confidence < 0.78
      : event.kind === 'knock' || confidence < 0.68;
    return { ...event, confidence, needsReview };
  });
}
