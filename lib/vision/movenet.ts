import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { poseFromKeypoints } from './pose';
import type { DoorObject, PoseHint } from './types';

const SIZE = 192;
const MODEL_FILE = 'movenet-lightning.onnx';
const MODEL_URL = 'https://huggingface.co/Xenova/movenet-singlepose-lightning/resolve/main/onnx/model.onnx';
const NAMES = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle'
] as const;

let sessionPromise: Promise<any> | null = null;

function modelPath(): string {
  return path.resolve(__dirname, '..', '..', 'models', MODEL_FILE);
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.part`;
    const file = fs.createWriteStream(tmp);
    const req = https.get(url, { headers: { 'User-Agent': 'CareBell' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.rmSync(tmp, { force: true });
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.rmSync(tmp, { force: true });
        reject(new Error(`Could not download the pose model (${res.statusCode}).`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close((err) => {
        if (err) reject(err);
        else {
          fs.renameSync(tmp, dest);
          resolve();
        }
      }));
    });
    req.on('error', (err) => {
      file.close();
      fs.rmSync(tmp, { force: true });
      reject(err);
    });
  });
}

async function ensureModel(): Promise<string> {
  const dest = modelPath();
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100_000) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await download(MODEL_URL, dest);
  return dest;
}

async function loadSession(): Promise<any> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = require('onnxruntime-node');
      const file = await ensureModel();
      return ort.InferenceSession.create(file, { executionProviders: ['cpu'] });
    })().catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

function letterbox(rgba: Uint8Array, width: number, height: number): { data: Int32Array; padX: number; padY: number; scale: number } {
  const scale = SIZE / Math.max(width, height);
  const nw = Math.max(1, Math.round(width * scale));
  const nh = Math.max(1, Math.round(height * scale));
  const padX = Math.floor((SIZE - nw) / 2);
  const padY = Math.floor((SIZE - nh) / 2);
  const data = new Int32Array(SIZE * SIZE * 3);
  for (let y = 0; y < nh; y += 1) {
    const srcY = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < nw; x += 1) {
      const srcX = Math.min(width - 1, Math.floor(x / scale));
      const si = ((srcY * width) + srcX) * 4;
      const di = (((padY + y) * SIZE) + (padX + x)) * 3;
      data[di] = rgba[si];
      data[di + 1] = rgba[si + 1];
      data[di + 2] = rgba[si + 2];
    }
  }
  return { data, padX, padY, scale };
}

export function personFromPose(pose: PoseHint): DoorObject {
  return {
    ...pose.box,
    class: 'person',
    cx: pose.cx,
    cy: pose.cy,
    source: 'model'
  };
}

function cropRgba(
  rgba: { width: number; height: number; data: Uint8Array },
  x: number,
  y: number,
  w: number,
  h: number
): { width: number; height: number; data: Uint8Array; originX: number; originY: number } {
  const originX = Math.max(0, Math.min(rgba.width - 1, Math.floor(x)));
  const originY = Math.max(0, Math.min(rgba.height - 1, Math.floor(y)));
  const width = Math.max(8, Math.min(rgba.width - originX, Math.floor(w)));
  const height = Math.max(8, Math.min(rgba.height - originY, Math.floor(h)));
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const src = ((originY + row) * rgba.width + originX) * 4;
    data.set(rgba.data.subarray(src, src + (width * 4)), row * width * 4);
  }
  return { width, height, data, originX, originY };
}

function namedFromOutput(
  raw: Float32Array,
  packed: { padX: number; padY: number; scale: number },
  originX: number,
  originY: number
): Record<string, { x: number; y: number; score: number }> {
  const named: Record<string, { x: number; y: number; score: number }> = {};
  for (let i = 0; i < 17; i += 1) {
    const yNorm = raw[i * 3];
    const xNorm = raw[(i * 3) + 1];
    const score = raw[(i * 3) + 2];
    named[NAMES[i]] = {
      x: originX + (((xNorm * SIZE) - packed.padX) / packed.scale),
      y: originY + (((yNorm * SIZE) - packed.padY) / packed.scale),
      score
    };
  }
  named.head = named.nose;
  named.lShoulder = named.left_shoulder;
  named.rShoulder = named.right_shoulder;
  named.lHip = named.left_hip;
  named.rHip = named.right_hip;
  named.lHand = named.left_wrist;
  named.rHand = named.right_wrist;
  named.lAnkle = named.left_ankle;
  named.rAnkle = named.right_ankle;
  if (named.left_ankle && named.right_ankle) {
    named.feet = {
      x: (named.left_ankle.x + named.right_ankle.x) / 2,
      y: (named.left_ankle.y + named.right_ankle.y) / 2,
      score: Math.min(named.left_ankle.score, named.right_ankle.score)
    };
  }
  return named;
}

function poseScore(pose: PoseHint): number {
  const hips = pose.keypoints.filter((item) => item.name === 'lHip' || item.name === 'rHip' || item.name === 'lShoulder' || item.name === 'rShoulder');
  const lie = pose.stance === 'fallen' && pose.box.width > pose.box.height && pose.torsoAngle >= 42 ? 1 : 0;
  return lie + hips.length + (pose.box.area / 4000);
}

async function poseOnView(
  session: any,
  ort: any,
  view: { width: number; height: number; data: Uint8Array },
  frameWidth: number,
  frameHeight: number,
  originX = 0,
  originY = 0
): Promise<PoseHint | null> {
  const packed = letterbox(view.data, view.width, view.height);
  const input = new ort.Tensor('int32', packed.data, [1, SIZE, SIZE, 3]);
  const result = await session.run({ input });
  const raw = result.output_0?.data as Float32Array | undefined;
  if (!raw || raw.length < 51) return null;
  return poseFromKeypoints(namedFromOutput(raw, packed, originX, originY), frameWidth, frameHeight);
}

export async function detectPosesForPeople(
  rgba: { width: number; height: number; data: Uint8Array },
  people: Array<{ x: number; y: number; width: number; height: number }>
): Promise<PoseHint[]> {
  if (!people.length) return [];
  try {
    const session = await loadSession();
    const ort = require('onnxruntime-node');
    const found: PoseHint[] = [];
    for (const person of people.slice(0, 3)) {
      const pad = 0.24;
      const x = person.x - (person.width * pad);
      const y = person.y - (person.height * pad);
      const crop = cropRgba(rgba, x, y, person.width * (1 + (pad * 2)), person.height * (1 + (pad * 2)));
      const pose = await poseOnView(session, ort, crop, rgba.width, rgba.height, crop.originX, crop.originY);
      if (pose) found.push(pose);
    }
    return found;
  } catch {
    return [];
  }
}

export async function detectPoses(rgba: { width: number; height: number; data: Uint8Array }): Promise<PoseHint[]> {
  try {
    const session = await loadSession();
    const ort = require('onnxruntime-node');
    const doorstep = cropRgba(rgba, 0, rgba.height * 0.34, rgba.width, rgba.height * 0.66);
    const found: PoseHint[] = [];
    const full = await poseOnView(session, ort, rgba, rgba.width, rgba.height, 0, 0);
    const low = await poseOnView(session, ort, doorstep, rgba.width, rgba.height, doorstep.originX, doorstep.originY);
    if (full) found.push(full);
    const lowLies = Boolean(low && low.stance === 'fallen' && low.box.width > low.box.height && low.torsoAngle >= 42);
    if (low && (!full || !boxesOverlapSafe(full, low) || lowLies || full.stance !== 'standing')) found.push(low);
    if (!found.length) return [];
    found.sort((a, b) => poseScore(b) - poseScore(a));
    const best = found[0];
    const extra = found.filter((item) => item !== best && !boxesOverlapSafe(best, item));
    return [best, ...extra];
  } catch {
    return [];
  }
}

function boxesOverlapSafe(a: PoseHint, b: PoseHint): boolean {
  return a.box.x < b.box.x + b.box.width && a.box.x + a.box.width > b.box.x
    && a.box.y < b.box.y + b.box.height && a.box.y + a.box.height > b.box.y;
}
