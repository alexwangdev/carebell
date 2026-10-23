type OpenCv = any;

let ready: Promise<OpenCv> | null = null;

export function loadOpenCv(): Promise<OpenCv> {
  if (!ready) {
    ready = (async () => {
      const loaded = require('@techstark/opencv-js');
      const mod = loaded && loaded.default ? loaded.default : loaded;
      if (mod instanceof Promise) return mod;
      if (mod && mod.Mat) return mod;
      await new Promise<void>((resolve) => {
        mod.onRuntimeInitialized = () => resolve();
      });
      return mod;
    })();
  }
  return ready;
}
