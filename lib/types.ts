export type EventKind =
  | 'doorbell'
  | 'person'
  | 'vehicle'
  | 'motion'
  | 'anomaly'
  | 'late'
  | 'offline'
  | 'online'
  | 'system'
  | 'rule'
  | 'package'
  | 'fall'
  | 'loitering'
  | 'knock';

export type AlertKey = 'doorbell' | 'person' | 'vehicle' | 'motion' | 'package' | 'fall' | 'loitering' | 'knock';

export type RuleKind = 'by' | 'between' | 'stay';
export type RuleDays = 'every' | 'weekdays' | 'weekends';
export type RuleCondition = 'doorbell' | 'person' | 'familiar' | 'vehicle' | 'motion' | 'activity';
export type RuleAction = 'alert' | 'contact';

export interface AlertFlags {
  doorbell: boolean;
  person: boolean;
  vehicle: boolean;
  motion: boolean;
  package: boolean;
  fall: boolean;
  loitering: boolean;
  knock: boolean;
}

export interface Rule {
  id: string;
  enabled: boolean;
  kind: RuleKind;
  time: string;
  end: string;
  minutes: number;
  days: RuleDays;
  condition: RuleCondition;
  action: RuleAction;
  firedOn: string;
  stayFrom: number;
}

export interface Settings {
  deviceName: string;
  checkInBy: string;
  leaveBy: string;
  homeBy: string;
  timeZone: string;
  anomalyEnabled: boolean;
  lateHomeEnabled: boolean;
  bedsideMode: boolean;
  playChimeOnDoorbell: boolean;
  anomalyFiredOn: string;
  lateHomeFiredOn: string;
  playgroundConnectedAt: number;
  paused: boolean;
  pauseReason: string;
  alerts: AlertFlags;
  emergencyName: string;
  rules: Rule[];
  ringToken?: string;
  ringRefresh?: string;
  watchedDoorId?: string;
}

export interface DoorEvent {
  id: string;
  at: string;
  localDate: string;
  localTime: string;
  kind: EventKind | string;
  title: string;
  detail: string;
  deviceName?: string;
  timestampMs?: number;
  snapshotUrl?: string;
  snapshotNote?: string;
  snapshotChecked?: boolean;
  sceneChecked?: boolean;
  familiarName?: string;
  familiarRelation?: string;
  photoHash?: string;
  clipUrl?: string;
  clipNote?: string;
  notified?: boolean;
  sample?: boolean;
  drill?: boolean;
  requestId?: string;
  ringType?: string;
  notifyKey?: AlertKey | string | null;
  level?: 'critical' | 'notice' | string;
  alwaysNotify?: boolean;
  systemAction?: 'pause' | 'resume' | 'online';
  endMs?: number;
}

export interface Alert {
  id: string;
  at: string;
  localDate: string;
  localTime: string;
  level: 'critical' | 'notice' | string;
  kind: EventKind | string;
  title: string;
  detail: string;
  snapshotUrl?: string;
  snapshotNote?: string;
  clipUrl?: string;
  clipNote?: string;
  chimeMessage?: string;
  contactName?: string;
  drill?: boolean;
  acked?: boolean;
  eventId?: string;
  ruleId?: string;
  familiarName?: string;
  familiarRelation?: string;
  playSound?: boolean;
}

export interface Summary {
  date: string;
  hash: string;
  text: string;
  source?: string;
}

export interface Person {
  id: string;
  name: string;
  relationship: string;
  photoUrl?: string;
  hashes: string[];
  createdAt?: string;
}

export interface StoreDoc {
  seeded: boolean;
  seedVersion: number;
  processed: string[];
  events: DoorEvent[];
  alerts: Alert[];
  summaries: Summary[];
  people: Person[];
  settings: Settings;
}

export interface TableItem {
  pk: string;
  sk: string;
  [key: string]: any;
}

export interface HttpError extends Error {
  status?: number;
}

export interface RequestLike {
  headers?: {
    authorization?: string;
    cookie?: string;
    origin?: string;
    [key: string]: string | string[] | undefined;
  };
}

export interface UserContext {
  userId: string;
  name: string;
  email: string;
  ringToken: string;
  refreshToken: string;
  doc: StoreDoc;
  chain: Promise<unknown>;
}

export interface TableStore {
  get(pk: string, sk: string): Promise<TableItem | null>;
  put(item: TableItem): Promise<void>;
  delete(pk: string, sk: string): Promise<void>;
  query(pk: string): Promise<TableItem[]>;
  listUserIds(): Promise<string[]>;
  replaceUser(pk: string, items: TableItem[]): Promise<void>;
}

export interface ZonedParts {
  localDate: string;
  localTime: string;
  hour: number;
  minute: number;
}

export interface StayEpisode {
  startedAt: number;
  minutes: number;
  name: string;
  snapshotUrl: string;
}

export function httpError(message: string, status: number): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
}
