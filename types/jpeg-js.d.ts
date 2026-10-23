declare module 'jpeg-js' {
  export function decode(
    buffer: Buffer | Uint8Array,
    options?: { useTArray?: boolean; formatAsRGBA?: boolean }
  ): { width: number; height: number; data: Uint8Array | Buffer };

  export function encode(
    frame: { data: Buffer | Uint8Array; width: number; height: number },
    quality?: number
  ): { data: Buffer; width: number; height: number };
}
