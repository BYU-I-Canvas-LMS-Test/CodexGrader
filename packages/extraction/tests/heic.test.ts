// HEIC → JPEG conversion (the vision grading path + the viewer's inline
// image). Unlike the other extraction suites this one needs a binary
// fixture: no JS HEIC encoder exists to build one in memory.
// fixtures/quadrants.heic is a 96×64 HEVC-coded HEIC (x265 via pillow-heif)
// with four solid quadrants: red, green / blue, white.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { HEIC_CONVERT_FAILED, convertHeicToJpeg } from '../src/index.js';

const QUADRANTS = readFileSync(fileURLToPath(new URL('./fixtures/quadrants.heic', import.meta.url)));

function pixel(img: { width: number; data: Uint8Array }, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
}

function near(actual: number[], expected: number[], tolerance = 40): boolean {
  return actual.every((v, i) => Math.abs(v - expected[i]!) <= tolerance);
}

describe('convertHeicToJpeg', () => {
  it('decodes a HEIC photo into a JPEG with the same size and colors', async () => {
    const out = await convertHeicToJpeg(QUADRANTS);

    expect([...out.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]); // JPEG magic
    const img = jpeg.decode(out, { useTArray: true });
    expect(img.width).toBe(96);
    expect(img.height).toBe(64);
    // Lossy twice over (HEVC, then JPEG) — sample quadrant centers loosely.
    expect(near(pixel(img, 24, 16), [220, 30, 30])).toBe(true);
    expect(near(pixel(img, 72, 16), [30, 200, 60])).toBe(true);
    expect(near(pixel(img, 24, 48), [30, 60, 220])).toBe(true);
    expect(near(pixel(img, 72, 48), [250, 250, 250])).toBe(true);
  });

  it('scales an oversized photo down to the longest-edge cap, keeping the aspect ratio', async () => {
    const img = jpeg.decode(await convertHeicToJpeg(QUADRANTS, { maxEdge: 48 }), {
      useTArray: true,
    });
    expect(img.width).toBe(48);
    expect(img.height).toBe(32);
    expect(near(pixel(img, 12, 8), [220, 30, 30])).toBe(true);
    expect(near(pixel(img, 36, 24), [250, 250, 250])).toBe(true);
  });

  it('accepts a pooled Buffer view (non-zero byteOffset)', async () => {
    const padded = Buffer.concat([Buffer.alloc(13, 7), QUADRANTS]);
    const view = padded.subarray(13);
    const img = jpeg.decode(await convertHeicToJpeg(view), { useTArray: true });
    expect(img.width).toBe(96);
  });

  it('passes a JPEG saved under a .heic name through unchanged', async () => {
    const realJpeg = jpeg.encode({ data: new Uint8Array(4 * 4 * 4).fill(128), width: 4, height: 4 }, 80).data;
    const out = await convertHeicToJpeg(realJpeg);
    expect(out.equals(realJpeg)).toBe(true);
  });

  it('throws the faculty-facing message for bytes that are not a HEIC image', async () => {
    await expect(convertHeicToJpeg(Buffer.from('definitely not a photo'))).rejects.toThrow(
      HEIC_CONVERT_FAILED,
    );
    // A truncated HEIC (valid header, missing image data).
    await expect(convertHeicToJpeg(QUADRANTS.subarray(0, 120))).rejects.toThrow(
      HEIC_CONVERT_FAILED,
    );
  });
});
