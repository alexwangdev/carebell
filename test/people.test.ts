import test from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { dhash, matchPeople, describeMatch, cleanName, cleanRelation } from '../lib/people';

function picture(seed: number): Buffer {
  const width = 32;
  const height = 32;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = ((y * width) + x) * 4;
      data[index] = (seed + x * 20) % 255;
      data[index + 1] = (seed * 3 + y * 10) % 255;
      data[index + 2] = (x * y + seed) % 255;
      data[index + 3] = 255;
    }
  }
  return jpeg.encode({ data, width, height }, 90).data;
}

test('a saved door photo recognizes the same picture', () => {
  const bytes = picture(4);
  const hash = dhash(bytes);
  assert.equal(hash.length, 64);
  const match = matchPeople(bytes, [{ id: 'p1', name: 'Mia', relationship: 'Daughter', hashes: [hash] }]);
  assert.ok(match);
  assert.equal(match.name, 'Mia');
  assert.equal(match.relationship, 'Daughter');
  const words = describeMatch(match);
  assert.equal(words?.title, 'Mia is at the door');
  assert.equal(matchPeople(picture(90), [{ id: 'p1', name: 'Mia', relationship: 'Daughter', hashes: [hash] }]), null);
});

test('a missing name or relation is cleaned', () => {
  assert.equal(cleanName('  Mia  '), 'Mia');
  assert.equal(cleanRelation(''), 'Family');
});
