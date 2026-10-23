export const VIEWS = [
  ['watch', 'Door'],
  ['listen', 'Today'],
  ['log', 'Family log'],
  ['people', 'People'],
  ['care', 'Care']
];

export const KIND = {
  doorbell: 'Doorbell',
  person: 'Person',
  vehicle: 'Vehicle',
  motion: 'Motion',
  anomaly: 'Alert',
  late: 'Late',
  offline: 'Offline',
  online: 'Online',
  system: 'Account',
  rule: 'Rule',
  package: 'Package',
  fall: 'Fall',
  loitering: 'Waiting',
  knock: 'Knock'
};

export const PANEL = {
  doorbell: { bg: '#5c3b09', ink: '#fff8e8' },
  person: { bg: '#0e3f66', ink: '#f4f8ff' },
  vehicle: { bg: '#0e4a42', ink: '#f3fffb' },
  motion: { bg: '#3f3832', ink: '#fff8f1' },
  anomaly: { bg: '#7a1d1d', ink: '#fff6f6' },
  late: { bg: '#7a1d1d', ink: '#fff6f6' },
  offline: { bg: '#7a1d1d', ink: '#fff6f6' },
  rule: { bg: '#7a1d1d', ink: '#fff6f6' },
  system: { bg: '#7a1d1d', ink: '#fff6f6' },
  online: { bg: '#e6f4ea', ink: '#0f3d28' },
  quiet: { bg: '#e6f4ea', ink: '#0f3d28' },
  package: { bg: '#5c4a12', ink: '#fff8e8' },
  fall: { bg: '#7a1d1d', ink: '#fff6f6' },
  loitering: { bg: '#5c3b09', ink: '#fff8e8' },
  knock: { bg: '#5c3b09', ink: '#fff8e8' }
};

const CLUSTER = new Set(['doorbell', 'person', 'vehicle', 'motion', 'package', 'knock', 'loitering']);
const TAG_ORDER = ['doorbell', 'person', 'vehicle', 'motion', 'package', 'knock', 'loitering', 'fall', 'anomaly', 'late', 'rule', 'offline', 'online', 'system'];

export interface DoorMoment {
  id: string;
  kind: string;
  localDate: string;
  localTime: string;
  title?: string;
  detail?: string;
  snapshotUrl?: string;
  familiarName?: string;
  sample?: boolean;
  notified?: boolean;
  clipUrl?: string;
  clipNote?: string;
}

function clockMinutes(time: string): number {
  const [hour, minute] = String(time || '0:0').split(':').map(Number);
  return (hour * 60) + minute;
}

export function groupEvents(rows: DoorMoment[] = []): DoorMoment[][] {
  const groups: DoorMoment[][] = [];
  rows.forEach((event) => {
    const current = groups[groups.length - 1];
    const previous = current && current[current.length - 1];
    const close = previous
      && CLUSTER.has(event.kind)
      && CLUSTER.has(previous.kind)
      && event.localDate === previous.localDate
      && Math.abs(clockMinutes(event.localTime) - clockMinutes(previous.localTime)) <= 2;
    if (close) current.push(event);
    else groups.push([event]);
  });
  return groups;
}

export function kindsOf(events: DoorMoment[]): string[] {
  const present = new Set(events.map((event) => event.kind));
  return TAG_ORDER.filter((kind) => present.has(kind));
}

export function timeSpan(events: DoorMoment[]): string {
  const sorted = [...events].sort((a, b) => clockMinutes(a.localTime) - clockMinutes(b.localTime));
  const start = sorted[0].localTime;
  const end = sorted[sorted.length - 1].localTime;
  return start === end ? start : `${start}–${end}`;
}

export function photoEvent(events: DoorMoment[]): DoorMoment | null {
  const photos = events.filter((event) => /\.jpe?g($|\?)/i.test(event.snapshotUrl || ''));
  return photos.find((event) => event.kind === 'person')
    || photos.find((event) => event.kind === 'doorbell')
    || photos[0]
    || null;
}

export function latestClipEvent(moments?: DoorMoment[]): DoorMoment | null {
  const list = moments || [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (['doorbell', 'person'].includes(list[index].kind) && !list[index].sample) return list[index];
  }
  return null;
}

export function modeLine(state: any): string {
  const playground = (state && state.playground) || {};
  if (playground.error) return playground.error;
  if (playground.connected && playground.source === 'ring') return 'Connected through your Ring account. New door events appear here within about 20 seconds.';
  if (playground.connected) return 'Connected to the Ring Playground. New door events appear here within about 20 seconds.';
  return 'Practice mode. The buttons below pretend a door event just happened.';
}
