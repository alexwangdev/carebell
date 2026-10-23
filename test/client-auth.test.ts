import test from 'node:test';
import assert from 'node:assert/strict';
import { requestToken } from '../lib/accounts';
import { allowedOrigin } from '../server';

test('a phone app can send its session as a bearer token', () => {
  assert.equal(requestToken({ headers: { authorization: 'Bearer abc123' } }), 'abc123');
  assert.equal(requestToken({ headers: { cookie: 'carebell=from-cookie' } }), 'from-cookie');
  assert.equal(requestToken('carebell=browser'), 'browser');
});

test('the api allows the local app and refuses other sites', () => {
  assert.equal(allowedOrigin('http://localhost:8081'), 'http://localhost:8081');
  assert.equal(allowedOrigin('http://127.0.0.1:8081'), 'http://127.0.0.1:8081');
  assert.equal(allowedOrigin('https://example.com'), '');
});
