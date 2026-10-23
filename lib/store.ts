import fs from 'node:fs';
import path from 'node:path';
import { defaultSettings } from './domain';
import * as context from './context';
import * as table from './table';
import { httpError, type StoreDoc, type TableItem } from './types';

function locations(): { root: string; legacy: string; token: string; media: string } {
  const root = process.env.CAREBELL_DATA_DIR || path.join(__dirname, '..', 'data');
  return {
    root,
    legacy: path.join(root, 'store.json'),
    token: path.join(root, 'playground-token'),
    media: path.join(root, 'media')
  };
}

export function emptyStore(): StoreDoc {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    seeded: false,
    seedVersion: 0,
    processed: [],
    events: [],
    alerts: [],
    summaries: [],
    people: [],
    settings: defaultSettings(zone)
  };
}

function withoutKeys(item: TableItem): any {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest;
}

export function itemsToDoc(items: TableItem[]): StoreDoc {
  const doc = emptyStore();
  for (const item of items) {
    if (item.sk === 'SETTINGS') {
      const settings = withoutKeys(item) as Record<string, unknown>;
      doc.seeded = Boolean(settings.seeded);
      doc.seedVersion = Number(settings.seedVersion || 0);
      delete settings.seeded;
      delete settings.seedVersion;
      doc.settings = { ...doc.settings, ...settings } as StoreDoc['settings'];
      doc.settings.alerts = Object.assign(
        { doorbell: true, person: true, vehicle: false, motion: false, package: true, fall: true, loitering: true, knock: true },
        doc.settings.alerts
      );
    } else if (item.sk === 'PROCESSED') {
      doc.processed = Array.isArray(item.ids) ? item.ids as string[] : [];
    } else if (String(item.sk).startsWith('EVENT#')) {
      doc.events.push(withoutKeys(item) as StoreDoc['events'][number]);
    } else if (String(item.sk).startsWith('ALERT#')) {
      doc.alerts.push(withoutKeys(item) as StoreDoc['alerts'][number]);
    } else if (String(item.sk).startsWith('SUMMARY#')) {
      doc.summaries.push(withoutKeys(item) as StoreDoc['summaries'][number]);
    } else if (String(item.sk).startsWith('PERSON#')) {
      doc.people.push(withoutKeys(item) as StoreDoc['people'][number]);
    }
  }
  doc.events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  doc.alerts.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return doc;
}

export function docToItems(userId: string, doc: StoreDoc): TableItem[] {
  const pk = `USER#${userId}`;
  const items: TableItem[] = [];
  items.push({
    pk,
    sk: 'SETTINGS',
    ...doc.settings,
    seeded: Boolean(doc.seeded),
    seedVersion: doc.seedVersion || 0
  });
  items.push({ pk, sk: 'PROCESSED', ids: doc.processed || [] });
  for (const event of doc.events || []) {
    items.push({ pk, sk: `EVENT#${event.at}#${event.id}`, ...event });
  }
  for (const alert of doc.alerts || []) {
    items.push({ pk, sk: `ALERT#${alert.at}#${alert.id}`, ...alert });
  }
  for (const summary of doc.summaries || []) {
    items.push({ pk, sk: `SUMMARY#${summary.date}#${summary.hash}`, ...summary });
  }
  for (const person of doc.people || []) {
    items.push({ pk, sk: `PERSON#${person.id}`, ...person });
  }
  return items;
}

export async function load(userId: string): Promise<StoreDoc> {
  const items = await table.query(`USER#${userId}`);
  if (!items.some((item) => item.sk === 'SETTINGS')) return emptyStore();
  return itemsToDoc(items);
}

function active() {
  const ctx = context.current();
  if (!ctx || !ctx.doc) throw httpError('Please sign in.', 401);
  return ctx;
}

export function get(): StoreDoc {
  return structuredClone(active().doc);
}

export function update(mutator: (data: StoreDoc) => void): Promise<StoreDoc> {
  const ctx = active();
  const run = (ctx.chain || Promise.resolve()).then(async () => {
    mutator(ctx.doc);
    await table.replaceUser(`USER#${ctx.userId}`, docToItems(ctx.userId, ctx.doc));
    return ctx.doc;
  });
  ctx.chain = run.then(() => {}, () => {});
  return run;
}

export function claimLegacy(): StoreDoc | null {
  const { legacy, token } = locations();
  if (!fs.existsSync(legacy)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(legacy, 'utf8')) as Partial<StoreDoc>;
    const doc = emptyStore();
    doc.seeded = Boolean(parsed.seeded);
    doc.seedVersion = parsed.seedVersion || 0;
    doc.processed = parsed.processed || [];
    doc.events = parsed.events || [];
    doc.alerts = parsed.alerts || [];
    doc.summaries = parsed.summaries || [];
    doc.people = parsed.people || [];
    doc.settings = { ...doc.settings, ...(parsed.settings || {}) };
    if (!doc.settings.ringToken && fs.existsSync(token)) {
      doc.settings.ringToken = fs.readFileSync(token, 'utf8').trim();
    }
    fs.renameSync(legacy, `${legacy}.migrated`);
    return doc;
  } catch {
    return null;
  }
}

export function readInboxClip(name: string): Buffer | null {
  const file = path.basename(String(name || ''));
  if (!/^[a-zA-Z0-9._-]+\.mp4$/i.test(file)) return null;
  const { root } = locations();
  const dir = path.join(root, 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, file);
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  if (!full.startsWith(prefix)) return null;
  if (!fs.existsSync(full)) return null;
  const bytes = fs.readFileSync(full);
  if (bytes.length < 64 || bytes.length > 40_000_000) return null;
  return bytes;
}

export function saveMedia(filename: string, buffer: Buffer): string {
  if (!/^[a-zA-Z0-9_-]+\.(svg|jpe?g|png|mp4)$/.test(filename)) {
    throw new Error('bad media name');
  }
  const { media } = locations();
  fs.mkdirSync(media, { recursive: true });
  fs.writeFileSync(path.join(media, filename), buffer);
  return `/media/${filename}`;
}

export function mediaPath(filename: string): string | null {
  if (!/^[a-zA-Z0-9_-]+\.(svg|jpe?g|png|mp4)$/.test(filename)) return null;
  const { media } = locations();
  const full = path.join(media, filename);
  if (!full.startsWith(media)) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

export function clearMedia(): void {
  const { media } = locations();
  if (!fs.existsSync(media)) return;
  for (const name of fs.readdirSync(media)) {
    if (/^[a-zA-Z0-9_-]+\.(svg|jpe?g|png|mp4)$/.test(name)) fs.unlinkSync(path.join(media, name));
  }
}
