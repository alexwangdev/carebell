export const VIEW_LABEL: Record<string, string> = {
  watch: 'Door',
  listen: 'Today',
  log: 'Family log',
  people: 'People',
  care: 'Care'
};

export type VoiceCommand =
  | { type: 'empty' }
  | { type: 'unknown' }
  | { type: 'signout' }
  | { type: 'ack' }
  | { type: 'read' }
  | { type: 'size'; size: 'large' | 'standard' }
  | { type: 'view'; view: 'watch' | 'listen' | 'log' | 'people' | 'care' };

function normalize(transcript: unknown): string {
  return String(transcript || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchCommand(transcript: unknown): VoiceCommand {
  const text = normalize(transcript);
  if (!text) return { type: 'empty' };
  if (/\b(sign out|log out)\b/.test(text)) return { type: 'signout' };
  if (/\b(seen this|acknowledge|dismiss)\b/.test(text)) return { type: 'ack' };
  if (/\b(read|speak|say)\b/.test(text) && /\b(this|that|it|aloud|page|today|alert)\b/.test(text)) return { type: 'read' };
  if (text === 'read' || text === 'speak') return { type: 'read' };
  if (/\blarge text\b/.test(text)) return { type: 'size', size: 'large' };
  if (/\bstandard text\b/.test(text)) return { type: 'size', size: 'standard' };
  if (/\b(family log|the log)\b/.test(text) || text === 'log') return { type: 'view', view: 'log' };
  if (/\bpeople\b/.test(text)) return { type: 'view', view: 'people' };
  if (/\b(settings)\b/.test(text) || text === 'care' || /\bcare\b/.test(text)) return { type: 'view', view: 'care' };
  if (/\btoday\b/.test(text) || text === 'summary') return { type: 'view', view: 'listen' };
  if (/\bdoor\b/.test(text)) return { type: 'view', view: 'watch' };
  return { type: 'unknown' };
}

export function pageWords(state: any, view: string): string {
  if (!state) return '';
  if (view === 'watch') {
    if (state.banner) return `${state.banner.title}. ${state.banner.detail}`;
    return 'The door is quiet.';
  }
  if (view === 'listen') return (state.today && state.today.summary) || 'No summary yet.';
  if (view === 'log') {
    const count = (state.log || []).length;
    return count === 1 ? 'Family log. 1 record.' : `Family log. ${count} records.`;
  }
  if (view === 'people') {
    const names = (state.people || []).map((person: { name?: string }) => person.name).filter(Boolean);
    return names.length ? `Familiar people. ${names.join(', ')}.` : 'No familiar people yet.';
  }
  if (view === 'care') return 'Care settings. Choose what should alert, or add a door rule.';
  return '';
}
