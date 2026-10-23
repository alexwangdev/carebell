import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CAREBELL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carebell-accounts-'));
process.env.CAREBELL_NO_SEED = '1';

import { register, login, requestToken, cookie } from '../lib/accounts';
import { HttpError } from '../lib/types';

test('register refuses a short password and a bad email', async () => {
  await assert.rejects(() => register({ name: 'Alex', email: 'not-an-email', password: 'long-enough' }), (error: unknown) => {
    assert.equal((error as HttpError).status, 400);
    return true;
  });
  await assert.rejects(() => register({ name: 'Alex', email: 'ok@example.com', password: 'short' }), (error: unknown) => {
    assert.equal((error as HttpError).status, 400);
    return true;
  });
});

test('login fails until the account exists, then returns a session token', async () => {
  await assert.rejects(() => login({ email: 'ts@example.com', password: 'test-password' }), (error: unknown) => {
    assert.equal((error as HttpError).status, 401);
    return true;
  });
  const session = await register({ name: 'Alex', email: 'ts@example.com', password: 'test-password' });
  assert.equal(session.token.length, 48);
  const again = await login({ email: 'ts@example.com', password: 'test-password' });
  assert.equal(again.userId, session.userId);
  assert.equal(requestToken({ headers: { authorization: `Bearer ${again.token}` } }), again.token);
  assert.match(cookie(again.token), /HttpOnly/);
});
