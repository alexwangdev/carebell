import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function ffmpegBin(): string | null {
  try {
    const packed = require('ffmpeg-static');
    if (typeof packed === 'string' && packed && fs.existsSync(packed)) return packed;
  } catch {
    /* Use PATH if the packed binary is missing. */
  }
  return 'ffmpeg';
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `ffmpeg exited ${code}`));
    });
  });
}

function englishFfmpegError(err: unknown): string {
  const text = String(err && (err as Error).message || err || '');
  if (/invalid data|does not contain any stream|moov atom|unknown format/i.test(text)) {
    return 'That file is not a video CareBell can read. Try an MP4 or MOV from your phone camera.';
  }
  if (/permission|enoent|spawn/i.test(text)) {
    return 'CareBell could not start the video reader on this computer.';
  }
  return 'CareBell could not read frames from that recording. Try a shorter MP4 or MOV under 40 MB.';
}

function probeDurationMs(bin: string, input: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['-nostdin', '-hide_banner', '-i', input], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
      if (!match) {
        resolve(null);
        return;
      }
      const ms = Math.round((((Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3])) * 1000));
      resolve(ms > 0 ? ms : null);
    });
  });
}

const SCALE = 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,format=yuv420p';

export async function readVideoFrames(video: Buffer, options: { fps?: number; maxFrames?: number; startAt?: number } = {}): Promise<{ frames: { jpeg: Buffer; at: number }[]; durationMs?: number; error?: string }> {
  if (!video || video.length < 64) {
    return { frames: [], error: 'That recording was empty.' };
  }
  const bin = ffmpegBin();
  if (!bin) return { frames: [], error: 'CareBell could not start the video reader on this computer.' };
  const maxFrames = Math.min(90, Math.max(2, Number(options.maxFrames) || 40));
  const startAt = Number(options.startAt) || 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carebell-clip-'));
  const input = path.join(dir, 'input.bin');
  const pattern = path.join(dir, 'frame-%03d.jpg');
  fs.writeFileSync(input, video);
  try {
    const durationMs = await probeDurationMs(bin, input);
    const seconds = Math.max(0.2, (durationMs || 0) / 1000);
    const requestedFps = Number(options.fps) || 5;
    const fps = durationMs
      ? Math.min(requestedFps, 5, Math.max(maxFrames / seconds, 0.2))
      : Math.min(5, Math.max(1, requestedFps));
    try {
      await run(bin, ['-nostdin', '-y', '-i', input, '-an', '-vf', `fps=${fps},${SCALE}`, '-q:v', '5', '-vframes', String(maxFrames), pattern]);
    } catch {
      await run(bin, ['-nostdin', '-y', '-i', input, '-an', '-vf', `fps=${fps}`, '-q:v', '5', '-vframes', String(maxFrames), pattern]);
    }
    const files = fs.readdirSync(dir).filter((name) => /^frame-\d+\.jpg$/i.test(name)).sort();
    if (!files.length) return { frames: [], durationMs: durationMs || undefined, error: 'CareBell opened the file but found no pictures inside.' };
    const span = durationMs && durationMs > 0 ? durationMs : Math.round(((files.length - 1) * 1000) / fps);
    const last = Math.max(1, files.length - 1);
    return {
      durationMs: span,
      frames: files.map((name, index) => ({
        jpeg: fs.readFileSync(path.join(dir, name)),
        at: startAt + Math.round((index / last) * span)
      }))
    };
  } catch (error) {
    return { frames: [], error: englishFfmpegError(error) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function framesFromVideo(mp4: Buffer, options: { fps?: number; maxFrames?: number; startAt?: number } = {}): Promise<{ jpeg: Buffer; at: number }[]> {
  const read = await readVideoFrames(mp4, options);
  return read.frames;
}

export async function videoFromJpegs(frames: Buffer[], options: { fps?: number } = {}): Promise<Buffer | null> {
  if (!frames.length) return null;
  const fps = Math.min(5, Math.max(1, Number(options.fps) || 2));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carebell-make-'));
  try {
    frames.forEach((frame, index) => {
      fs.writeFileSync(path.join(dir, `frame-${String(index + 1).padStart(3, '0')}.jpg`), frame);
    });
    const out = path.join(dir, 'clip.mp4');
    await run(ffmpegBin(), [
      '-nostdin',
      '-y',
      '-framerate',
      String(fps),
      '-i',
      path.join(dir, 'frame-%03d.jpg'),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      out
    ]);
    if (!fs.existsSync(out)) return null;
    return fs.readFileSync(out);
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
