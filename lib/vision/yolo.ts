import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import type { DoorObject } from './types';

const SIZE = 640;
const MODEL_FILE = 'yolov8n.onnx';
const MODEL_URL = 'https://huggingface.co/Kalray/yolov8/resolve/main/yolov8n.onnx';
const PERSON = 0;
const VEHICLE = new Set([2, 3, 5, 7]);
const PARCEL = new Set([24, 26, 28]);

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
        reject(new Error(`Could not download the detector (${res.statusCode}).`));
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

async function loadSession(): Promise<any> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const dest = modelPath();
      if (!fs.existsSync(dest) || fs.statSync(dest).size < 100_000) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await download(MODEL_URL, dest);
      }
      const ort = require('onnxruntime-node');
      return ort.InferenceSession.create(dest, { executionProviders: ['cpu'] });
    })().catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

function letterbox(rgba: Uint8Array, width: number, height: number): { data: Float32Array; padX: number; padY: number; scale: number } {
  const scale = SIZE / Math.max(width, height);
  const nw = Math.max(1, Math.round(width * scale));
  const nh = Math.max(1, Math.round(height * scale));
  const padX = Math.floor((SIZE - nw) / 2);
  const padY = Math.floor((SIZE - nh) / 2);
  const data = new Float32Array(3 * SIZE * SIZE);
  for (let y = 0; y < nh; y += 1) {
    const srcY = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < nw; x += 1) {
      const srcX = Math.min(width - 1, Math.floor(x / scale));
      const si = ((srcY * width) + srcX) * 4;
      const dx = padX + x;
      const dy = padY + y;
      data[(dy * SIZE) + dx] = rgba[si] / 255;
      data[(SIZE * SIZE) + (dy * SIZE) + dx] = rgba[si + 1] / 255;
      data[(2 * SIZE * SIZE) + (dy * SIZE) + dx] = rgba[si + 2] / 255;
    }
  }
  return { data, padX, padY, scale };
}

function iou(a: DoorObject, b: DoorObject): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.area + b.area - inter;
  return union <= 0 ? 0 : inter / union;
}

export async function detectYolo(rgba: { width: number; height: number; data: Uint8Array }): Promise<DoorObject[]> {
  try {
    const session = await loadSession();
    const ort = require('onnxruntime-node');
    const packed = letterbox(rgba.data, rgba.width, rgba.height);
    const input = new ort.Tensor('float32', packed.data, [1, 3, SIZE, SIZE]);
    const result = await session.run({ images: input });
    const raw = result.predictions?.data as Float32Array | undefined;
    if (!raw || raw.length < 84) return [];
    const cols = 8400;
    const found: Array<DoorObject & { score: number }> = [];
    for (let col = 0; col < cols; col += 1) {
      let best = 0;
      let bestScore = 0;
      for (let cls = 0; cls < 80; cls += 1) {
        const score = raw[((4 + cls) * cols) + col];
        if (score > bestScore) {
          bestScore = score;
          best = cls;
        }
      }
      const kind = best === PERSON ? 'person' : (PARCEL.has(best) ? 'package' : (VEHICLE.has(best) ? 'vehicle' : null));
      const minScore = kind === 'person' ? 0.28 : 0.22;
      if (!kind || bestScore < minScore) continue;
      const cx = ((raw[col] - packed.padX) / packed.scale);
      const cy = ((raw[cols + col] - packed.padY) / packed.scale);
      const bw = raw[(2 * cols) + col] / packed.scale;
      const bh = raw[(3 * cols) + col] / packed.scale;
      const x = Math.max(0, cx - (bw / 2));
      const y = Math.max(0, cy - (bh / 2));
      const width = Math.min(rgba.width - x, bw);
      const height = Math.min(rgba.height - y, bh);
      if (width < 8 || height < 8) continue;
      found.push({
        class: kind,
        x,
        y,
        width,
        height,
        area: width * height,
        cx: x + (width / 2),
        cy: y + (height / 2),
        source: 'model',
        score: bestScore
      });
    }
    const ranked = found.sort((a, b) => b.score - a.score);
    const kept: DoorObject[] = [];
    for (const item of ranked) {
      if (kept.every((other) => item.class !== other.class || iou(item, other) < 0.5)) {
        const { score, ...box } = item;
        kept.push(box);
      }
    }
    return kept.slice(0, 8);
  } catch {
    return [];
  }
}
