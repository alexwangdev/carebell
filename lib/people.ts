import jpeg from 'jpeg-js';
import type { Person } from './types';

export const RELATIONS = ['Daughter', 'Son', 'Partner', 'Caregiver', 'Neighbor', 'Friend', 'Family'] as const;

export function cleanName(value: unknown): string {
  return String(value || '').trim().slice(0, 24);
}

export function cleanRelation(value: unknown): string {
  const text = String(value || '').trim().slice(0, 24);
  return text || 'Family';
}

export function dhash(buffer: Buffer): string {
  let decoded: { width: number; height: number; data: Uint8Array | Buffer };
  try {
    decoded = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
  } catch {
    return '';
  }
  if (!decoded || !decoded.width || !decoded.height) return '';
  const { width, height, data } = decoded;
  const x0 = Math.floor(width * 0.25);
  const y0 = Math.floor(height * 0.15);
  const cropWidth = Math.max(1, Math.floor(width * 0.5));
  const cropHeight = Math.max(1, Math.floor(height * 0.7));
  const cols = 9;
  const rows = 8;
  const gray: number[] = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const sx = Math.min(width - 1, x0 + Math.floor(((x + 0.5) * cropWidth) / cols));
      const sy = Math.min(height - 1, y0 + Math.floor(((y + 0.5) * cropHeight) / rows));
      const index = (sy * width + sx) * 4;
      gray.push((data[index] * 0.299) + (data[index + 1] * 0.587) + (data[index + 2] * 0.114));
    }
  }
  let bits = '';
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols - 1; x += 1) {
      bits += gray[(y * cols) + x] < gray[(y * cols) + x + 1] ? '1' : '0';
    }
  }
  return bits;
}

export function hamming(left: string, right: string): number {
  if (!left || !right || left.length !== right.length) return 64;
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) score += 1;
  }
  return score;
}

export interface PersonMatch {
  id: string;
  name: string;
  relationship: string;
  distance: number;
}

export function matchPeople(buffer: Buffer, people: Person[] | undefined): PersonMatch | null {
  const hash = dhash(buffer);
  if (!hash) return null;
  let best: { person: Person; distance: number } | null = null;
  for (const person of people || []) {
    for (const known of person.hashes || []) {
      const distance = hamming(hash, known);
      if (!best || distance < best.distance) best = { person, distance };
    }
  }
  if (!best || best.distance > 12) return null;
  return {
    id: best.person.id,
    name: best.person.name,
    relationship: best.person.relationship,
    distance: best.distance
  };
}

export function describeMatch(match: PersonMatch | null): { title: string; detail: string } | null {
  if (!match) return null;
  if (match.distance <= 8) {
    return {
      title: `${match.name} is at the door`,
      detail: `Your ${match.relationship} is at the door.`
    };
  }
  return {
    title: `This looks like ${match.name}`,
    detail: `This picture looks like your ${match.relationship}, ${match.name}.`
  };
}
