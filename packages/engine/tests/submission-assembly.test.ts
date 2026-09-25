// Ported from: C:\Devs\AIGrader-C#\tests\AiGrader.Tests\SubmissionAssemblyTests.cs
//
// Multi-file submission assembly: routing (single-file / all-image /
// labeled-section), error semantics (deterministic failures become inline
// notes in multi-file submissions), and the BYTE-PARITY pins — single-file
// and all-image submissions must produce the exact pre-multi-file strings so
// faculty calibration holds.
//
// PORT DELTA: the C# download-failure cases (transient — whole student
// errors upstream) don't reach assembly here because downloads happen in the
// engine before assembly; the surviving equivalent is an image input with no
// bytes, which keeps the C# message.

import { describe, expect, it } from 'vitest';
import {
  MAX_COMBINED_TEXT_CHARS,
  assembleSubmission,
  isExcelFilename,
  type SubmissionFileInput,
} from '../src/grading/submission-assembly.js';

const someBytes = new Uint8Array([1, 2, 3]);

function doc(name: string, text: string | null, opts: Partial<SubmissionFileInput> = {}): SubmissionFileInput {
  return { filename: name, text, ...opts };
}

function img(name: string, opts: Partial<SubmissionFileInput> = {}): SubmissionFileInput {
  return { filename: name, imageBytes: someBytes, ...opts };
}

describe('assembleSubmission — single-file parity', () => {
  it('returns raw extracted text with no header (THE single-file pin)', () => {
    const result = assembleSubmission([doc('essay.docx', 'ESSAY TEXT')]);

    expect(result.text).toBe('ESSAY TEXT');
    expect(result.images).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.excelFilename).toBeNull();
  });

  it('keeps the hard error for a single unsupported file', () => {
    expect(() =>
      assembleSubmission([
        doc('archive.zip', null, {
          mediaType: 'application/zip',
          error: 'Unsupported submission format: mime=unknown filename=archive.zip.',
        }),
      ]),
    ).toThrowError('Unsupported submission format: mime=unknown filename=archive.zip.');
  });

  it('surfaces the scanned-PDF warning as the single-file error message', () => {
    const scanned = 'No extractable text — the PDF appears to be scanned (needs vision).';
    expect(() =>
      assembleSubmission([doc('scan.pdf', '', { mediaType: 'application/pdf', error: scanned })]),
    ).toThrowError(scanned);
  });

  it('falls back to the no-extractable-text message when a single file is empty without a reason', () => {
    expect(() => assembleSubmission([doc('empty.txt', '  ', { mediaType: 'text/plain' })])).toThrowError(
      'The submission produced no extractable text.',
    );
  });

  it('rejects an empty attachment list', () => {
    expect(() => assembleSubmission([])).toThrowError('The submission has no file attachments.');
  });
});

describe('assembleSubmission — all-image parity', () => {
  it('produces the aggregate placeholder verbatim (THE all-image pin)', () => {
    const one = assembleSubmission([img('photo.png', { mediaType: 'image/png' })]);

    expect(one.text).toBe(
      '[The student submission is provided as 1 image(s) attached to this message: photo.png]',
    );
    expect(one.images).toHaveLength(1);
    expect(one.images[0]!.mediaType).toBe('image/png');

    const three = assembleSubmission([img('a.png'), img('b.jpg'), img('c.webp')]);

    expect(three.text).toBe(
      '[The student submission is provided as 3 image(s) attached to this message: a.png, b.jpg, c.webp]',
    );
    expect(three.images.map((i) => i.mediaType)).toEqual(['image/png', 'image/jpeg', 'image/webp']);
  });

  it('keeps the image-specific message when an image arrives without bytes', () => {
    expect(() =>
      assembleSubmission([{ filename: 'photo.png', mediaType: 'image/png' }]),
    ).toThrowError("Could not download image 'photo.png'.");
  });
});

describe('assembleSubmission — multi-file', () => {
  it('emits labeled sections in submission order (the new-format golden)', () => {
    const result = assembleSubmission([
      doc('a.docx', 'A'),
      doc('b.txt', 'B', { mediaType: 'text/plain' }),
    ]);

    expect(result.text).toBe('=== File 1 of 2: a.docx ===\nA\n\n=== File 2 of 2: b.txt ===\nB');
    expect(result.images).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('mixes documents and images with aligned inline placeholders and ordered vision parts', () => {
    const photoBytes = new Uint8Array([9]);
    const chartBytes = new Uint8Array([8]);
    const result = assembleSubmission([
      doc('essay.docx', 'ESSAY'),
      { filename: 'photo.png', imageBytes: photoBytes },
      { filename: 'chart.jpg', imageBytes: chartBytes },
    ]);

    expect(result.text).toBe(
      '=== File 1 of 3: essay.docx ===\nESSAY\n\n' +
        '=== File 2 of 3: photo.png ===\n[This file is provided as image 1 of 2 attached to this message.]\n\n' +
        '=== File 3 of 3: chart.jpg ===\n[This file is provided as image 2 of 2 attached to this message.]',
    );
    expect(result.images.map((i) => i.mediaType)).toEqual(['image/png', 'image/jpeg']);
    expect(result.images[0]!.bytes).toEqual(photoBytes);
  });

  it('grades the document too when the image comes first', () => {
    const result = assembleSubmission([
      img('photo.png', { mediaType: 'image/png' }),
      doc('essay.docx', 'ESSAY'),
    ]);

    expect(result.text).toContain('=== File 2 of 2: essay.docx ===\nESSAY');
    expect(result.images).toHaveLength(1);
  });
});

describe('assembleSubmission — multi-file error rules', () => {
  it('notes an unsupported file inline and grades the rest', () => {
    const reason = 'Unsupported submission format: mime=unknown filename=archive.zip.';
    const result = assembleSubmission([
      doc('notes.txt', 'NOTES', { mediaType: 'text/plain' }),
      doc('archive.zip', null, { mediaType: 'application/zip', error: reason }),
    ]);

    expect(result.text).toBe(
      '=== File 1 of 2: notes.txt ===\nNOTES\n\n' +
        `=== File 2 of 2: archive.zip ===\n[This file could not be read: ${reason}]`,
    );
    expect(result.warnings).toEqual([`Could not read 'archive.zip': ${reason}`]);
  });

  it('notes a scanned PDF beside a readable file instead of failing', () => {
    const scanned = 'No extractable text — the PDF appears to be scanned (needs vision).';
    const result = assembleSubmission([
      doc('essay.docx', 'ESSAY'),
      doc('scan.pdf', '', { mediaType: 'application/pdf', error: scanned }),
    ]);

    expect(result.text).toContain(
      `=== File 2 of 2: scan.pdf ===\n[This file could not be read: ${scanned}]`,
    );
    expect(result.warnings.some((w) => w.includes(scanned))).toBe(true);
  });

  it('notes an empty multi-file document with the default reason', () => {
    const result = assembleSubmission([doc('a.txt', 'A'), doc('empty.txt', '   ')]);
    expect(result.text).toContain(
      '=== File 2 of 2: empty.txt ===\n[This file could not be read: The file produced no extractable text.]',
    );
  });

  it('throws the aggregate hard error naming every file when nothing is readable', () => {
    let thrown: Error | undefined;
    try {
      assembleSubmission([
        doc('a.zip', null, { error: 'Unsupported submission format: mime=unknown filename=a.zip.' }),
        doc('b.zip', null, { error: 'Unsupported submission format: mime=unknown filename=b.zip.' }),
      ]);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message.startsWith('None of the 2 submitted files could be read:')).toBe(true);
    expect(thrown!.message).toContain('a.zip');
    expect(thrown!.message).toContain('b.zip');
  });
});

describe('assembleSubmission — Excel candidate', () => {
  it('picks the first .xlsx wherever it sits in the submission', () => {
    const result = assembleSubmission([
      doc('essay.docx', 'ESSAY'),
      doc('grades.xlsx', '# Sheet: S1\nA1=5'),
    ]);

    expect(result.excelFilename).toBe('grades.xlsx');
  });

  it('applies the single-file rules (xlsx keeps its name; non-Excel carries none)', () => {
    const xlsx = assembleSubmission([doc('book.xlsx', '# Sheet: S1\nA1=5')]);
    expect(xlsx.excelFilename).toBe('book.xlsx');

    const docx = assembleSubmission([doc('essay.docx', 'ESSAY')]);
    expect(docx.excelFilename).toBeNull();
  });

  it('skips unreadable Excel files as candidates', () => {
    const result = assembleSubmission([
      doc('essay.docx', 'ESSAY'),
      doc('broken.xlsx', null, { error: 'Corrupt workbook.' }),
    ]);
    expect(result.excelFilename).toBeNull();
  });

  it.each([
    ['Budget.XLSX', true],
    ['book.Xlsm', true],
    ['book.xlsx', true],
    ['essay.docx', false],
    [null, false],
  ] as const)('isExcelFilename(%j) === %j (case-insensitive)', (filename, expected) => {
    expect(isExcelFilename(filename)).toBe(expected);
  });
});

describe('assembleSubmission — combined size cap', () => {
  it('truncates with an explicit inline note, omits later documents, and warns faculty', () => {
    const big1 = 'a'.repeat(300_000);
    const big2 = 'b'.repeat(200_000);
    const result = assembleSubmission([
      doc('one.txt', big1, { mediaType: 'text/plain' }),
      doc('two.txt', big2, { mediaType: 'text/plain' }),
      doc('three.txt', 'tiny', { mediaType: 'text/plain' }),
    ]);

    expect(MAX_COMBINED_TEXT_CHARS).toBe(400_000);
    expect(result.text).toContain(big1); // first file fits whole
    expect(result.text).toContain(
      'b'.repeat(100_000) +
        '\n[Truncated: combined submission exceeded the size limit; remaining file content omitted.]',
    );
    expect(result.text).not.toContain('b'.repeat(100_001));
    expect(result.text).toContain(
      '=== File 3 of 3: three.txt ===\n[Omitted: combined submission exceeded the size limit.]',
    );
    expect(result.warnings.some((w) => w.includes('size limit'))).toBe(true);
  });
});
