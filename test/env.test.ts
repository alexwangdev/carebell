import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from '../lib/env';

test('loadEnv sets missing keys and leaves existing ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carebell-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'NEW_KEY=from-file\nEXISTING_KEY=file-value\n# comment\nBADLINE\n');
  process.env.EXISTING_KEY = 'already-set';
  delete process.env.NEW_KEY;
  loadEnv(file);
  assert.equal(process.env.NEW_KEY, 'from-file');
  assert.equal(process.env.EXISTING_KEY, 'already-set');
});
