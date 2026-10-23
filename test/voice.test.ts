import test from 'node:test';
import assert from 'node:assert/strict';
import { matchCommand, pageWords } from '../app/src/commands';

test('spoken commands open a page or acknowledge an alert', () => {
  assert.deepEqual(matchCommand('Open the door'), { type: 'view', view: 'watch' });
  assert.deepEqual(matchCommand('Today'), { type: 'view', view: 'listen' });
  assert.deepEqual(matchCommand('Family log'), { type: 'view', view: 'log' });
  assert.deepEqual(matchCommand('People'), { type: 'view', view: 'people' });
  assert.deepEqual(matchCommand('Care settings'), { type: 'view', view: 'care' });
  assert.deepEqual(matchCommand('I have seen this'), { type: 'ack' });
  assert.deepEqual(matchCommand('Read this aloud'), { type: 'read' });
  assert.deepEqual(matchCommand('Sign out'), { type: 'signout' });
  assert.equal(matchCommand('turn on the porch lights').type, 'unknown');
  assert.equal(matchCommand('').type, 'empty');
});

test('the spoken page does not include a token', () => {
  const words = pageWords({
    banner: { title: 'Someone at the door', detail: 'Please look at the door.' },
    today: { summary: 'Today, 1 activity at the door.' },
    playground: { token: 'secret-token' }
  }, 'watch');
  assert.equal(words, 'Someone at the door. Please look at the door.');
  assert.equal(words.includes('secret'), false);
});
