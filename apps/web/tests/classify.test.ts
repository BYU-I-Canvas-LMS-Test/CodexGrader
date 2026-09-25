// Viewer classification: extension-first (Canvas mislabels uploads as
// octet-stream), reusing the grading engine's exact lists so the viewer and
// grader can never disagree about a file. The one security-critical pin:
// student .html files classify as 'text' (escaped source) — NEVER as
// renderable HTML — and the streaming content-type allowlist never echoes
// Canvas's claim.
//
// Ported from: C:\Devs\AIGrader-C#\tests\AiGrader.Tests\PreviewClassificationTests.cs
// (every InlineData row) + the classification rows of PreviewConverterTests.cs.

import { describe, expect, it } from 'vitest';
import {
  classifyPreview,
  safeInlineContentType,
  type PreviewKind,
} from '../lib/viewing/classify';
import { buildFileResponseHeaders, contentDisposition } from '../lib/viewing/file-headers';

describe('classifyPreview (ClassifyCore port)', () => {
  it.each<[string | null, string | null, PreviewKind]>([
    ['application/pdf', 'essay.pdf', 'pdf'],
    ['application/octet-stream', 'essay.pdf', 'pdf'],
    ['image/png', 'whatever.bin', 'image'],
    ['application/octet-stream', 'photo.JPG', 'image'],
    [null, 'paper.docx', 'rich-html'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'paper', 'rich-html'],
    [null, 'book.xlsx', 'table'],
    [null, 'book.xlsm', 'table'],
    ['text/csv', 'data', 'table'],
    [null, 'data.tsv', 'table'],
    ['application/octet-stream', 'hw1.py', 'text'],
    ['text/plain', 'notes', 'text'],
    [null, 'notes.md', 'text'],
    ['application/zip', 'homework.zip', 'unsupported'],
    [null, 'keynote.pages', 'unsupported'],
    [null, 'slides.pptx', 'slides'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck', 'slides'],
    // Legacy binary .xls: the grid renderer can't open it — must go
    // unsupported so the converter seam/download card takes it, never a
    // renderer guaranteed to throw "corrupt".
    ['application/vnd.ms-excel', 'grades.xls', 'unsupported'],
    [null, 'grades.xls', 'unsupported'],
    // ...but the same MIME on a .csv is the Windows/Canvas CSV quirk → table.
    ['application/vnd.ms-excel', 'data.csv', 'table'],
    // RTF is converter territory (the RTF converter claims text/rtf too) —
    // classifying it text would show raw {\rtf1…} control codes.
    ['text/rtf', 'essay.rtf', 'unsupported'],
    ['application/rtf', 'essay', 'unsupported'],
    ['application/octet-stream', 'essay.rtf', 'unsupported'],
    // Legacy .doc stays unsupported (download-only card — no pure-JS converter).
    [null, 'old.doc', 'unsupported'],
  ])('classifies by extension first: (%s, %s) → %s', (mime, filename, expected) => {
    expect(classifyPreview(mime, filename)).toBe(expected);
  });

  it.each([
    ['text/html', 'page.html'],
    [null, 'page.htm'],
    ['application/octet-stream', 'page.html'],
  ])(
    'SECURITY: .html uploads show as escaped source, never renderable HTML (%s, %s)',
    (mime, filename) => {
      expect(classifyPreview(mime, filename)).toBe('text');
    },
  );
});

describe('safeInlineContentType (SafeInlineContentType port)', () => {
  it.each<[string | null, string | null, string]>([
    ['application/pdf', 'essay.pdf', 'application/pdf'],
    ['application/octet-stream', 'photo.png', 'image/png'],
    ['image/jpeg', 'shot', 'image/jpeg'],
    ['text/html', 'page.html', 'application/octet-stream'],
    [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'paper.docx',
      'application/octet-stream',
    ],
    ['application/x-msdownload', 'tool.exe', 'application/octet-stream'],
  ])('inline content type is allowlisted: (%s, %s) → %s', (mime, filename, expected) => {
    expect(safeInlineContentType(mime, filename)).toBe(expected);
  });
});

describe('buildFileResponseHeaders (SubmissionFileController header policy)', () => {
  it('inline allowlist passes through with inline disposition + nosniff + private cache', () => {
    const h = buildFileResponseHeaders({
      workerContentType: 'application/pdf',
      filename: 'essay.pdf',
      download: false,
      size: '123',
    });
    expect(h.get('Content-Type')).toBe('application/pdf');
    expect(h.get('Content-Disposition')).toContain('inline');
    expect(h.get('X-Content-Type-Options')).toBe('nosniff');
    expect(h.get('Cache-Control')).toBe('private, max-age=600');
    expect(h.get('Content-Length')).toBe('123');
  });

  it('anything off the allowlist ships as octet-stream + attachment — even text/html', () => {
    const h = buildFileResponseHeaders({
      workerContentType: 'text/html',
      filename: 'page.html',
      download: false,
      size: null,
    });
    expect(h.get('Content-Type')).toBe('application/octet-stream');
    expect(h.get('Content-Disposition')).toContain('attachment');
    expect(h.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('download=true forces attachment even for inline-safe types', () => {
    const h = buildFileResponseHeaders({
      workerContentType: 'image/png',
      filename: 'photo.png',
      download: true,
      size: '9',
    });
    expect(h.get('Content-Type')).toBe('application/octet-stream');
    expect(h.get('Content-Disposition')).toContain('attachment');
  });

  it('hostile filenames cannot smuggle header syntax', () => {
    const cd = contentDisposition('attachment', 'a"b\r\nSet-Cookie: x;\u2014.pdf');
    expect(cd).not.toContain('\r');
    expect(cd).not.toContain('\n');
    expect(cd).not.toContain('"b'); // the quote was neutralized in the fallback name
    expect(cd).toContain("filename*=UTF-8''");
  });
});
