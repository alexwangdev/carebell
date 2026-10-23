import fs from 'node:fs';
import path from 'node:path';
import type { TableItem, TableStore } from './types';

function filePath(): { root: string; file: string } {
  const root = process.env.CAREBELL_DATA_DIR || path.join(__dirname, '..', 'data');
  return { root, file: path.join(root, 'table.json') };
}

function readItems(): TableItem[] {
  const { root, file } = filePath();
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { items?: TableItem[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

function writeItems(items: TableItem[]): void {
  const { root, file } = filePath();
  fs.mkdirSync(root, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ items }));
  fs.renameSync(tmp, file);
}

let chain = Promise.resolve();
let dynamo: TableStore | null = null;

function enqueue<T>(work: () => T): Promise<T> {
  const run = chain.then(work, work);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

const local: TableStore = {
  async get(pk, sk) {
    return enqueue(() => readItems().find((item) => item.pk === pk && item.sk === sk) || null);
  },
  async put(item) {
    return enqueue(() => {
      const items = readItems();
      const index = items.findIndex((entry) => entry.pk === item.pk && entry.sk === item.sk);
      if (index >= 0) items[index] = item;
      else items.push(item);
      writeItems(items);
    });
  },
  async delete(pk, sk) {
    return enqueue(() => {
      writeItems(readItems().filter((item) => item.pk !== pk || item.sk !== sk));
    });
  },
  async query(pk) {
    return enqueue(() => readItems()
      .filter((item) => item.pk === pk)
      .sort((a, b) => String(a.sk).localeCompare(String(b.sk))));
  },
  async listUserIds() {
    return enqueue(() => readItems()
      .filter((item) => item.sk === 'PROFILE' && String(item.pk).startsWith('USER#'))
      .map((item) => String(item.pk).slice('USER#'.length)));
  },
  async replaceUser(pk, items) {
    return enqueue(() => {
      const kept = readItems().filter((item) => item.pk !== pk || item.sk === 'PROFILE');
      writeItems(kept.concat(items));
    });
  }
};

export async function ready(): Promise<TableStore> {
  if (process.env.CAREBELL_STORE !== 'dynamodb') return local;
  if (!dynamo) dynamo = await (await import('./dynamodb')).create();
  return dynamo;
}

function api(): TableStore {
  if (process.env.CAREBELL_STORE === 'dynamodb') {
    if (!dynamo) throw new Error('DynamoDB is not ready yet.');
    return dynamo;
  }
  return local;
}

export function get(pk: string, sk: string): Promise<TableItem | null> {
  return api().get(pk, sk);
}

export function put(item: TableItem): Promise<void> {
  return api().put(item);
}

export function del(pk: string, sk: string): Promise<void> {
  return api().delete(pk, sk);
}

export function query(pk: string): Promise<TableItem[]> {
  return api().query(pk);
}

export function listUserIds(): Promise<string[]> {
  return api().listUserIds();
}

export function replaceUser(pk: string, items: TableItem[]): Promise<void> {
  return api().replaceUser(pk, items);
}

export { del as delete };
