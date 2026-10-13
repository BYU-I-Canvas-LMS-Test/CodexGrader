/// <reference path="./heic-modules.d.ts" />
// HEIC/HEIF photo → JPEG. iPhones save photos as HEIC by default, but the
// vision models accept only PNG/JPEG/GIF/WebP and Chrome/Edge can't render
// HEIC in an <img>, so the grading engine converts before the vision call
// and the submission viewer converts before streaming the image inline.
//
// Pure JavaScript + WebAssembly (libheif-js via heic-decode, jpeg-js) — no
// native modules. Both load lazily: the libheif bundle is ~1.5 MB of JS and
// most runs never see a HEIC file.

/** JPEG quality for converted photos (handwriting stays legible). */
export const HEIC_JPEG_QUALITY = 90;

/** Longest edge kept, in pixels. A standard 12 MP iPhone photo (4032 px)
 * converts at full size; 48 MP "HEIF Max" shots are scaled down by half. */
export const HEIC_MAX_EDGE = 4096;

/** The one faculty-facing wording for a photo that could not be converted. */
export const HEIC_CONVERT_FAILED =
  'This HEIC photo could not be converted for grading. It may be corrupt or an unsupported HEIC variant; ask the student to resubmit it as a JPG or PNG.';

type RgbaImage = { width: number; height: number; data: Uint8Array | Uint8ClampedArray };

/**
 * Converts HEIC/HEIF bytes to a JPEG. Bytes that are already a JPEG (some
 * apps save JPEGs under a .heic name) are returned unchanged. Throws an
 * Error with HEIC_CONVERT_FAILED as its message when the file can't be
 * decoded (the cause rides along).
 */
export async function convertHeicToJpeg(
  bytes: Uint8Array,
  opts: { maxEdge?: number } = {},
): Promise<Buffer> {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return Buffer.from(bytes);
  }

  let image: RgbaImage;
  try {
    const { default: decode } = await import('heic-decode');
    image = await decode({ buffer: bytes });
  } catch (err) {
    throw new Error(HEIC_CONVERT_FAILED, { cause: err });
  }

  const { default: jpeg } = await import('jpeg-js');
  const scaled = downscale(image, opts.maxEdge ?? HEIC_MAX_EDGE);
  return Buffer.from(jpeg.encode(scaled, HEIC_JPEG_QUALITY).data);
}

/** Box-filter downscale so the longest edge is at most `maxEdge` (a no-op
 * for images already within it). */
function downscale(image: RgbaImage, maxEdge: number): RgbaImage {
  const { width, height, data } = image;
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return image;

  const scale = maxEdge / longest;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y / scale);
    const sy1 = Math.min(height, Math.max(sy0 + 1, Math.floor((y + 1) / scale)));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x / scale);
      const sx1 = Math.min(width, Math.max(sx0 + 1, Math.floor((x + 1) / scale)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0, i = (sy * width + sx0) * 4; sx < sx1; sx++, i += 4) {
          r += data[i]!;
          g += data[i + 1]!;
          b += data[i + 2]!;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}
