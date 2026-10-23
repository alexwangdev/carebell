import type { Box, DoorObject } from './types';

type OpenCv = any;

function collectBlobs(cv: OpenCv, mask: any, frameArea: number, minShare = 0.004, maxShare = 0.42, mode?: number): Box[] {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(mask, contours, hierarchy, mode == null ? cv.RETR_EXTERNAL : mode, cv.CHAIN_APPROX_SIMPLE);
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

function looksLikeParcel(blob: Box, width: number, height: number): boolean {
  const ratio = blob.width / Math.max(1, blob.height);
  const cy = blob.y + (blob.height / 2);
  const share = blob.area / Math.max(1, width * height);
  const filled = blob.area / Math.max(1, blob.width * blob.height);
  return ratio >= 0.7 && ratio <= 3.4
    && blob.height >= height * 0.045
    && blob.height < height * 0.38
    && blob.width >= width * 0.05
    && blob.width < width * 0.58
    && share >= 0.003 && share < 0.16
    && filled >= 0.55
    && cy > height * 0.36
    && blob.y > height * 0.18;
}

function isEdgeSliver(blob: Box, width: number): boolean {
  return blob.width < width * 0.1 && (blob.x <= 3 || blob.x + blob.width >= width - 3);
}

function looksLikePerson(blob: Box, width: number, height: number): boolean {
  if (isEdgeSliver(blob, width)) return false;
  if (blob.height > height * 0.72) return false;
  if (blob.y <= 4 && blob.height > height * 0.5) return false;
  const tall = blob.height / Math.max(1, blob.width);
  const wide = blob.width / Math.max(1, blob.height);
  const share = blob.area / Math.max(1, width * height);
  const cy = blob.y + (blob.height / 2);
  if (tall >= 1.05 && blob.height >= height * 0.16 && blob.width < width * 0.5 && share < 0.12) return true;
  return wide >= 2.15 && wide <= 6.5
    && blob.height < height * 0.32
    && blob.width < width * 0.72
    && share < 0.16
    && cy > height * 0.48;
}

function uniqueBoxes(blobs: Box[]): Box[] {
  const unique: Box[] = [];
  for (const blob of blobs) {
    const same = unique.find((item) => Math.abs(item.x - blob.x) < 10 && Math.abs(item.y - blob.y) < 10);
    if (!same) unique.push(blob);
  }
  return unique;
}

function rectanglesFromEdges(cv: OpenCv, gray: any, width: number, height: number): Box[] {
  const y0 = Math.max(0, Math.round(height * 0.34));
  const bandH = Math.max(8, height - y0);
  const roi = gray.roi(new cv.Rect(0, y0, width, bandH));
  const edges = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const blobs: Box[] = [];
  try {
    cv.Canny(roi, edges, 40, 130);
    cv.dilate(edges, edges, kernel);
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      const rect = cv.boundingRect(contour);
      const approx = new cv.Mat();
      cv.approxPolyDP(contour, approx, 0.04 * cv.arcLength(contour, true), true);
      const sides = approx.rows;
      contour.delete();
      approx.delete();
      const blob: Box = {
        x: rect.x,
        y: rect.y + y0,
        width: rect.width,
        height: rect.height,
        area
      };
      if (sides >= 4 && sides <= 8 && looksLikeParcel(blob, width, height)) blobs.push(blob);
    }
    return blobs;
  } finally {
    roi.delete();
    edges.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
  }
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
  const bright = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  let brown: any;
  let brown2: any;
  let pale: any;
  let carton: any;
  let parcelMask: any;
  let stoop: any;
  let onStoop: any;
  let grow: any;
  let motion: any;
  try {
    cv.cvtColor(src, bgr, cv.COLOR_RGBA2BGR);
    cv.cvtColor(bgr, hsv, cv.COLOR_BGR2HSV);
    cv.cvtColor(bgr, gray, cv.COLOR_BGR2GRAY);
    brown = colorMask(cv, hsv, [8, 40, 40, 0], [35, 255, 230, 0]);
    brown2 = colorMask(cv, hsv, [0, 30, 40, 0], [12, 180, 180, 0]);
    pale = colorMask(cv, hsv, [8, 16, 100, 0], [42, 170, 255, 0]);
    carton = colorMask(cv, hsv, [12, 22, 80, 0], [40, 230, 255, 0]);
    parcelMask = new cv.Mat();
    cv.bitwise_or(brown, brown2, parcelMask);
    cv.bitwise_or(parcelMask, pale, parcelMask);
    cv.bitwise_or(parcelMask, carton, parcelMask);
    cv.morphologyEx(parcelMask, parcelMask, cv.MORPH_CLOSE, kernel);
    cv.threshold(gray, dark, 90, 255, cv.THRESH_BINARY_INV);
    cv.morphologyEx(dark, dark, cv.MORPH_OPEN, kernel);
    cv.threshold(gray, bright, 142, 255, cv.THRESH_BINARY);
    cv.rectangle(bright, new cv.Point(0, 0), new cv.Point(rgba.width, Math.max(0, Math.round(rgba.height * 0.34))), new cv.Scalar(0), -1);
    cv.morphologyEx(bright, bright, cv.MORPH_OPEN, kernel);
    stoop = new cv.Mat();
    onStoop = new cv.Mat();
    grow = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(21, 21));
    cv.threshold(gray, stoop, 88, 255, cv.THRESH_BINARY_INV);
    cv.dilate(stoop, stoop, grow);
    cv.bitwise_and(bright, stoop, onStoop);
    const frameArea = rgba.width * rgba.height;
    const rawPackages = uniqueBoxes([
      ...collectBlobs(cv, parcelMask, frameArea, 0.003, 0.16, cv.RETR_LIST),
      ...collectBlobs(cv, onStoop, frameArea, 0.003, 0.16, cv.RETR_LIST),
      ...rectanglesFromEdges(cv, gray, rgba.width, rgba.height)
    ]);
    const packages = rawPackages
      .filter((blob) => looksLikeParcel(blob, rgba.width, rgba.height))
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
    const unique = uniqueBoxes(bodyBlobs);
    const vehicles = unique
      .filter((blob) => blob.width / Math.max(1, blob.height) >= 2.5 && blob.width >= rgba.width * 0.68)
      .map((blob) => asObject(blob, 'vehicle'));
    const people = unique
      .filter((blob) => !vehicles.some((car) => car.x === blob.x && car.y === blob.y && car.width === blob.width))
      .filter((blob) => {
        const fromMotion = motionBoxes.some((item) => item.x === blob.x && item.y === blob.y && item.width === blob.width);
        return fromMotion || looksLikePerson(blob, rgba.width, rgba.height);
      })
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
    bright.delete();
    kernel.delete();
    if (brown) brown.delete();
    if (brown2) brown2.delete();
    if (pale) pale.delete();
    if (carton) carton.delete();
    if (parcelMask) parcelMask.delete();
    if (stoop) stoop.delete();
    if (onStoop) onStoop.delete();
    if (grow) grow.delete();
    if (motion) motion.delete();
  }
}
