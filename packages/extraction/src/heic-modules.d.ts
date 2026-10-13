// heic-decode ships no type declarations (it wraps libheif-js, libheif
// compiled to WebAssembly). Only the single-image call is used.
declare module 'heic-decode' {
  interface DecodedHeicImage {
    width: number;
    height: number;
    /** RGBA, 4 bytes per pixel, row-major. */
    data: Uint8ClampedArray;
  }
  function decode(input: { buffer: Uint8Array | ArrayBuffer }): Promise<DecodedHeicImage>;
  export = decode;
}
