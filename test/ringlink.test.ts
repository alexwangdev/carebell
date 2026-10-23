import test from 'node:test';
import assert from 'node:assert/strict';
import { maskEmail, nonceFor, freshTime } from '../lib/ringlink';

test('a Ring link nonce uses the signing key as written', () => {
  const nonce = nonceFor('1771130906289', 'account-1', 'test-signing-key');
  assert.equal(nonce, nonceFor('1771130906289', 'account-1', 'test-signing-key'));
  assert.notEqual(nonce, nonceFor('1771130906289', 'account-2', 'test-signing-key'));
  assert.equal(nonce.includes('='), false);
});

test('an account email is masked before it is sent to Ring', () => {
  assert.equal(maskEmail('alex@example.com'), 'a***x@example.com');
});

test('a Ring link older than ten minutes is rejected', () => {
  assert.equal(freshTime(Date.now() - (11 * 60 * 1000)), false);
  assert.equal(freshTime(Date.now() - 1000), true);
});
