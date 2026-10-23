import { AsyncLocalStorage } from 'node:async_hooks';
import type { UserContext } from './types';

const storage = new AsyncLocalStorage<UserContext>();

export function current(): UserContext | null {
  return storage.getStore() || null;
}

export function run<T>(bag: UserContext, fn: () => T): T {
  return storage.run(bag, fn);
}
