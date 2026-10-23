import test from 'node:test';
import assert from 'node:assert/strict';
import { OUT_OF_SCOPE, suggestRule } from '../lib/gemini';

test('a sentence that is not about the door is refused before Gemini', async () => {
  delete process.env.GEMINI_API_KEY;
  const result = await suggestRule('aaaadsad');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, OUT_OF_SCOPE);
});

test('an empty sentence asks for a time and a door event', async () => {
  const result = await suggestRule('   ');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, 'Describe the time and what should alert.');
});

test('a door sentence without a Gemini key still stays in scope', async () => {
  delete process.env.GEMINI_API_KEY;
  const result = await suggestRule('Alert me if nobody has been at the door by 10:00');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /Gemini key is not set/);
});
