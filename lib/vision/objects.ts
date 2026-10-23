import type { Box, DoorObject } from './types';

type OpenCv = any;

function collectBlobs(cv: OpenCv, mask: any, frameArea: number, minShare = 0.008, maxShare = 0.42): Box[] {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  const blobs: Box[] = [];
  for (let i = 0; i < contours.size(); i += 1) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);
    const rect = cv.boundingRect(contour);
    contour.delete();
    if (area < frameArea * minShare || area > frameArea * maxShare) continue;
    blobs.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, area });
  }
  contours.delete();
  hierarchy.delete();
  return blobs;
}

function colorMask(cv: OpenCv, hsv: any, low: number[], high: number[]): any {
  const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), low);
  const hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), high);
  const mask = new cv.Mat();
  cv.inRange(hsv, lo, hi, mask);
  lo.delete();
  hi.delete();
  return mask;
}

function asObject(blob: Box, className: DoorObject['class'], source: 'tone' | 'motion' | 'model' = 'tone'): DoorObject {
  return {
    ...blob,
    class: className,
    cx: blob.x + (blob.width / 2),
    cy: blob.y + (blob.height / 2),
    source
  };
}

export function detectObjects(
  cv: OpenCv,
  rgba: { width: number; height: number; data: Uint8Array },
  motionMask?: Uint8Array
): DoorObject[] {
  const src = cv.matFromArray(rgba.height, rgba.width, cv.CV_8UC4, rgba.data);
  const bgr = new cv.Mat();
  const hsv = new cv.Mat();
  const gray = new cv.Mat();
  const dark = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  let brown: any;
  let brown2: any;
  let brownMask: any;
  let motion: any;
  try {
    cv.cvtColor(src, bgr, cv.COLOR_RGBA2BGR);
    cv.cvtColor(bgr, hsv, cv.COLOR_BGR2HSV);
    cv.cvtColor(bgr, gray, cv.COLOR_BGR2GRAY);
    brown = colorMask(cv, hsv, [8, 40, 40, 0], [35, 255, 230, 0]);
    brown2 = colorMask(cv, hsv, [0, 30, 40, 0], [12, 180, 180, 0]);
    brownMask = new cv.Mat();
    cv.bitwise_or(brown, brown2, brownMask);
    cv.morphologyEx(brownMask, brownMask, cv.MORPH_CLOSE, kernel);
    cv.threshold(gray, dark, 90, 255, cv.THRESH_BINARY_INV);
    cv.morphologyEx(dark, dark, cv.MORPH_OPEN, kernel);
    const frameArea = rgba.width * rgba.height;
    const packages = collectBlobs(cv, brownMask, frameArea)
      .filter((blob) => {
        const ratio = blob.width / Math.max(1, blob.height);
        const cy = blob.y + (blob.height / 2);
        const share = blob.area / frameArea;
        return ratio >= 0.85 && ratio <= 2.2
          && blob.height < rgba.height * 0.32
          && share < 0.12
          && cy > rgba.height * 0.52;
      })
      .map((blob) => asObject(blob, 'package'));
    const bodyBlobs = collectBlobs(cv, dark, frameArea);
    const motionBoxes: Box[] = [];
    if (motionMask && motionMask.length === rgba.width * rgba.height) {
      motion = cv.matFromArray(rgba.height, rgba.width, cv.CV_8UC1, motionMask);
      collectBlobs(cv, motion, frameArea, 0.006, 0.5).forEach((blob) => {
        bodyBlobs.push(blob);
        motionBoxes.push(blob);
      });
    }
    const unique: Box[] = [];
    for (const blob of bodyBlobs) {
      const same = unique.find((item) => Math.abs(item.x - blob.x) < 8 && Math.abs(item.y - blob.y) < 8);
      if (!same) unique.push(blob);
    }
    const vehicles = unique
      .filter((blob) => blob.width / Math.max(1, blob.height) >= 2.5 && blob.width >= rgba.width * 0.55)
      .map((blob) => asObject(blob, 'vehicle'));
    const people = unique
      .filter((blob) => !vehicles.some((car) => car.x === blob.x && car.y === blob.y && car.width === blob.width))
      .filter((blob) => blob.width < rgba.width * 0.82)
      .map((blob) => {
        const fromMotion = motionBoxes.some((item) => item.x === blob.x && item.y === blob.y && item.width === blob.width);
        return asObject(blob, 'person', fromMotion ? 'motion' : 'tone');
      });
    return [...packages, ...people, ...vehicles];
  } finally {
    src.delete();
    bgr.delete();
    hsv.delete();
    gray.delete();
    dark.delete();
    kernel.delete();
    if (brown) brown.delete();
    if (brown2) brown2.delete();
    if (brownMask) brownMask.delete();
    if (motion) motion.delete();
  }
}
