// Ported from: C:\Devs\AIGrader-C#\tests\AiGrader.Tests\VisionRoutingTests.cs
//
// Verifies image-submission detection — the gate into the vision grading
// path. JPG/PNG/GIF/WebP route to multimodal grading; everything else stays
// on the text-extraction path (or errors clearly for unsupported binaries).

import { describe, expect, it } from 'vitest';
import {
  IMAGE_MEDIA_TYPES,
  IMAGE_MEDIA_TYPES_BY_EXTENSION,
  fileExtension,
  isImageAttachment,
} from '../src/grading/vision-routing.js';

describe('isImageAttachment', () => {
  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])(
    'detects %s by MIME',
    (mime) => {
      expect(isImageAttachment(mime, 'whatever.bin')).toBe(true);
    },
  );

  it('matches MIME case-insensitively (C# OrdinalIgnoreCase)', () => {
    expect(isImageAttachment('IMAGE/PNG', 'whatever.bin')).toBe(true);
    expect(isImageAttachment('Image/Jpeg', 'whatever.bin')).toBe(true);
  });

  // Canvas often reports images as octet-stream — the extension must carry
  // the decision (same quirk-handling as code files).
  it.each(['photo.jpg', 'scan.JPEG', 'art.png', 'diagram.webp'])(
    'detects %s by extension when MIME is generic',
    (filename) => {
      expect(isImageAttachment('application/octet-stream', filename)).toBe(true);
    },
  );

  it.each([
    ['application/pdf', 'essay.pdf'],
    ['text/plain', 'notes.txt'],
    [null, 'report.docx'],
    ['application/octet-stream', 'code.py'],
  ] as const)('never routes non-images to vision (%s, %s)', (mime, filename) => {
    expect(isImageAttachment(mime, filename)).toBe(false);
  });

  // Vision-unsupported image formats (bmp/tiff) stay off the vision path so
  // they fail with a clear extraction error instead of an opaque model
  // rejection.
  it.each([
    ['image/bmp', 'old.bmp'],
    ['image/tiff', 'scan.tiff'],
  ])('rejects vision-unsupported image formats (%s)', (mime, filename) => {
    expect(isImageAttachment(mime, filename)).toBe(false);
  });

  it('handles null/undefined inputs', () => {
    expect(isImageAttachment(null, null)).toBe(false);
    expect(isImageAttachment(undefined, undefined)).toBe(false);
    expect(isImageAttachment(null, 'photo.png')).toBe(true);
  });
});

describe('extension/MIME tables', () => {
  it('derives the MIME set from the extension map so the routes cannot drift', () => {
    expect(new Set(IMAGE_MEDIA_TYPES_BY_EXTENSION.values())).toEqual(new Set(IMAGE_MEDIA_TYPES));
    expect([...IMAGE_MEDIA_TYPES_BY_EXTENSION.keys()]).toEqual([
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.webp',
    ]);
  });

  it('extracts extensions like .NET Path.GetExtension', () => {
    expect(fileExtension('scan.JPEG')).toBe('.jpeg');
    expect(fileExtension('archive.tar.gz')).toBe('.gz');
    expect(fileExtension('folder/photo.png')).toBe('.png');
    expect(fileExtension('C:\\dir.name\\file')).toBe('');
    expect(fileExtension('noext')).toBe('');
    expect(fileExtension('trailingdot.')).toBe('');
    expect(fileExtension(null)).toBe('');
  });
});
