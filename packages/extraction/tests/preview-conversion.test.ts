// Preview conversions for the in-app viewer: DOCX→sanitized HTML (the server
// fallback behind the client-side page renderer) and RTF→sanitized HTML (the
// converter seam's pure-TS RtfPipe-subset implementation). Outputs must be
// sanitizer-clean and claim logic pinned tightly.
//
// Ported from: C:\Devs\AIGrader-C#\tests\AiGrader.Tests\SubmissionPreviewConversionTests.cs
// (DocxConvertsToSanitizedHtml) and PreviewConverterTests.cs (the RTF rows —
// LegacyDocPreviewConverter is deliberately NOT ported: no pure-JS .doc
// converter exists, so legacy .doc gets the download-only card).

import { describe, expect, it } from 'vitest';
import { convertDocxHtml } from '../src/docx-html.js';
import {
  RTF_APPROXIMATE_WARNING,
  convertRtfHtml,
  isRtfAttachment,
  rtfToHtml,
} from '../src/rtf-html.js';
import { minimalDocx, utf8 } from './helpers.js';

describe('convertDocxHtml (ConvertDocx port)', () => {
  it('DOCX converts to sanitized HTML: text is there, active content never is', async () => {
    const preview = await convertDocxHtml(await minimalDocx(['Hello <grader> & friends']));

    expect(preview.html).toContain('Hello');
    expect(preview.html).toContain('&lt;grader&gt;'); // document text stays text
    expect(preview.html!.toLowerCase()).not.toContain('<script');
    expect(preview.error).toBeNull();
  });

  it('an empty document reports "no previewable content"', async () => {
    const preview = await convertDocxHtml(await minimalDocx([]));
    expect(preview.html).toBeNull();
    expect(preview.error).toContain('no previewable content');
  });

  it('corrupt input throws deterministically (the route wrapper catches it)', async () => {
    await expect(convertDocxHtml(new Uint8Array([1, 2, 3, 4]))).rejects.toBeTruthy();
  });
});

describe('RTF converter (RtfPreviewConverter port)', () => {
  it.each([
    ['.rtf by ext', null, 'essay.rtf', true],
    ['.rtf by mime', 'application/rtf', 'essay', true],
    ['text/rtf by mime', 'text/rtf', 'essay', true],
    ['docx claims nothing', null, 'essay.docx', false],
    ['pdf claims nothing', 'application/pdf', 'essay.pdf', false],
    ['.doc claims nothing', 'application/msword', 'essay.doc', false],
  ])('claims exactly its own format: %s', (_label, mime, filename, expected) => {
    expect(isRtfAttachment(mime, filename)).toBe(expected);
  });

  it('RTF converts to sanitized rich HTML: emphasis survives, active content cannot', () => {
    const rtf = String.raw`{\rtf1\ansi Hello {\b bold} world\par}`;
    const preview = convertRtfHtml(utf8(rtf));

    expect(preview.html).not.toBeNull();
    expect(preview.html).toContain('bold');
    expect(preview.html).toContain('Hello');
    expect(preview.html!.toLowerCase()).not.toContain('<script');
    expect(preview.warnings.some((w) => w.includes('approximate'))).toBe(true);
    expect(preview.warnings).toContain(RTF_APPROXIMATE_WARNING);
  });

  it('bold/italic/underline map to strong/em/u and paragraphs split on \\par', () => {
    const rtf = String.raw`{\rtf1\ansi First {\b b}{\i i}{\ul u}\par Second\par}`;
    const html = rtfToHtml(rtf);
    expect(html).toContain('<strong>b</strong>');
    expect(html).toContain('<em>i</em>');
    expect(html).toContain('<u>u</u>');
    expect(html.match(/<p>/g)).toHaveLength(2);
  });

  it('destination groups (font/color tables, pictures, info) never leak as prose', () => {
    const rtf = String.raw`{\rtf1\ansi{\fonttbl{\f0 Calibri;}}{\colortbl;\red0\green0\blue0;}{\info{\author Eve}}{\*\generator Riched20}Visible\par}`;
    const html = rtfToHtml(rtf);
    expect(html).toContain('Visible');
    expect(html).not.toContain('Calibri');
    expect(html).not.toContain('Eve');
    expect(html).not.toContain('Riched20');
  });

  it('hex and unicode escapes decode; markup in RTF text is escaped', () => {
    // \'e9 = é (cp1252), \u8212 = em dash with one fallback char to skip.
    const rtf = String.raw`{\rtf1\ansi caf\'e9 \u8212 ?x <b>tag</b>\par}`;
    const html = rtfToHtml(rtf);
    expect(html).toContain('café');
    expect(html).toContain('\u2014');
    expect(html).not.toContain('\u2014 ?'); // the uc fallback char was swallowed
    expect(html).toContain('&lt;b&gt;tag&lt;/b&gt;');
  });

  it('an RTF file with no renderable text declines (null html → download card)', () => {
    const preview = convertRtfHtml(utf8(String.raw`{\rtf1\ansi{\fonttbl{\f0 X;}}}`));
    expect(preview.html).toBeNull();
  });
});
