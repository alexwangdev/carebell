type OpenCv = any;

export const ROI = {
  doorstep: { x: 0.12, y: 0.52, width: 0.76, height: 0.46 },
  door: { x: 0.32, y: 0.18, width: 0.36, height: 0.55 },
  entrance: { x: 0.18, y: 0.28, width: 0.64, height: 0.70 }
};

export function inRegion(cx: number, cy: number, region: { x: number; y: number; width: number; height: number }, width: number, height: number): boolean {
  const x = region.x * width;
  const y = region.y * height;
  return cx >= x && cx <= x + (region.width * width) && cy >= y && cy <= y + (region.height * height);
}

function matToRgba(cv: OpenCv, mat: any): { width: number; height: number; data: Uint8Array } {
  const converted = new cv.Mat();
  if (mat.type() === cv.CV_8UC4) mat.copyTo(converted);
  else cv.cvtColor(mat, converted, cv.COLOR_BGR2RGBA);
  const data = converted.data.slice() as Uint8Array;
  const width = converted.cols;
  const height = converted.rows;
  converted.delete();
  return { width, height, data };
}

function matToGrayBytes(mat: any): Uint8Array {
  return mat.data.slice() as Uint8Array;
}

export function preprocess(cv: OpenCv, rgba: { width: number; height: number; data: Uint8Array }, previousGray?: Uint8Array): {
  rgba: { width: number; height: number; data: Uint8Array };
  gray: Uint8Array;
  motionMask?: Uint8Array;
  width: number;
  height: number;
  motionEnergy: number;
  doorEnergy: number;
} {
  const src = cv.matFromArray(rgba.height, rgba.width, cv.CV_8UC4, rgba.data);
  const bgr = new cv.Mat();
  const resized = new cv.Mat();
  const blurred = new cv.Mat();
  const gray = new cv.Mat();
  const diff = new cv.Mat();
  try {
    cv.cvtColor(src, bgr, cv.COLOR_RGBA2BGR);
    const scale = rgba.width > 480 ? 480 / rgba.width : 1;
    const width = Math.max(1, Math.round(rgba.width * scale));
    const height = Math.max(1, Math.round(rgba.height * scale));
    if (scale !== 1) cv.resize(bgr, resized, new cv.Size(width, height));
    else bgr.copyTo(resized);
    cv.GaussianBlur(resized, blurred, new cv.Size(5, 5), 0);
    cv.cvtColor(blurred, gray, cv.COLOR_BGR2GRAY);
    let motionEnergy = 0;
    let doorEnergy = 0;
    let motionMask: Uint8Array | undefined;
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
    if (previousGray && previousGray.length === gray.rows * gray.cols) {
      const prev = cv.matFromArray(gray.rows, gray.cols, cv.CV_8UC1, previousGray);
      const binary = new cv.Mat();
      cv.absdiff(prev, gray, diff);
      prev.delete();
      const mean = cv.mean(diff);
      motionEnergy = (mean[0] || 0) / 255;
      cv.threshold(diff, binary, 18, 255, cv.THRESH_BINARY);
      cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel);
      motionMask = matToGrayBytes(binary);
      const doorX = Math.max(0, Math.round(ROI.door.x * width));
      const doorY = Math.max(0, Math.round(ROI.door.y * height));
      const door = new cv.Rect(
        doorX,
        doorY,
        Math.min(width - doorX, Math.round(ROI.door.width * width)),
        Math.min(height - doorY, Math.round(ROI.door.height * height))
      );
      const doorMat = diff.roi(door);
      const doorMean = cv.mean(doorMat);
      doorEnergy = (doorMean[0] || 0) / 255;
      doorMat.delete();
      binary.delete();
    }
    kernel.delete();
    return {
      rgba: matToRgba(cv, blurred),
      gray: matToGrayBytes(gray),
      motionMask,
      width,
      height,
      motionEnergy,
      doorEnergy
    };
  } finally {
    src.delete();
    bgr.delete();
    resized.delete();
    blurred.delete();
    gray.delete();
    diff.delete();
  }
}
