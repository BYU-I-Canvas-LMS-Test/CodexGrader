// Extractor grading-path behavior: dispatch by extension (Canvas lies with
// octet-stream), per-format flatten shapes, the documented unsupported-format
// error, and the scanned-PDF warning. These pin the outputs the multi-file
// assembler and the prompts consume.
//
// Ported from: C:\Devs\AIGrader-C#\tests\AiGrader.Tests\SubmissionTextExtractorTests.cs

import { describe, expect, it } from 'vitest';
import {
  TEXT_AND_CODE_EXTENSIONS,
  extractOnlineTextEntry,
  extractSubmissionText,
} from '../src/index.js';
import { minimalDocx, minimalPdf, utf8, xlsxBytes } from './helpers.js';

describe('extractSubmissionText', () => {
  it('passes plain text through as UTF-8, byte for byte', async () => {
    const text = "print('hi')\nsecond line";
    const result = await extractSubmissionText('notes.txt', utf8(text), { mime: 'text/plain' });
    expect(result.text).toBe(text);
    expect(result.warnings).toEqual([]);
    expect(result.kind).toBe('text');
  });

  it('dispatches octet-stream code files by extension (the documented Canvas quirk)', async () => {
    const code = 'def main():\n    pass';
    const result = await extractSubmissionText('hw1.py', utf8(code), {
      mime: 'application/octet-stream',
    });
    expect(result.text).toBe(code);
    expect(result.kind).toBe('text');
  });

  it('re-joins CSV rows with tabs, quoting (commas, embedded newlines) handled by the parser', async () => {
    const csv = 'a,"b,c"\n"line\nbreak",d';
    const result = await extractSubmissionText('data.csv', utf8(csv), { mime: 'text/csv' });
    expect(result.text).toBe('a\tb,c\nline\nbreak\td');
    expect(result.kind).toBe('csv');
  });

  it('throws the documented, faculty-readable message for unsupported binaries', async () => {
    await expect(
      extractSubmissionText('homework.zip', new Uint8Array([0x50, 0x4b]), {
        mime: 'application/zip',
      }),
    ).rejects.toThrow(
      'Unsupported submission format: mime=application/zip filename=homework.zip. ' +
        'Supported: DOCX, PDF, XLSX, CSV, source code, plain text, and online_text_entry.',
    );
  });

  it('flattens workbooks to "# Sheet: name" / "A1=value" lines (the Excel-key parse shape)', async () => {
    const bytes = await xlsxBytes((sheet) => {
      sheet.getCell('A1').value = 'Name';
      sheet.getCell('B2').value = 5;
    });

    const result = await extractSubmissionText('book.xlsx', bytes);
    expect(result.kind).toBe('xlsx');
    expect(result.text).toContain('# Sheet: S1');
    expect(result.text).toContain('A1=Name');
    expect(result.text).toContain('B2=5');
  });

  it('carries bracketed formatting notes on formatted cells; plain cells stay bare', async () => {
    const bytes = await xlsxBytes((sheet) => {
      sheet.getCell('A1').value = 'Header';
      sheet.getCell('A1').font = { bold: true };
      sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
      sheet.getCell('A2').value = 'plain';
    });

    const result = await extractSubmissionText('book.xlsx', bytes);
    expect(result.text).toContain('A1=Header [bold, fill=green]');
    expect(result.text + '\n').toContain('A2=plain\n'); // no annotation on unformatted cells
    expect(result.text).not.toContain('A2=plain [');
  });

  it('returns empty text plus the "appears scanned" warning for a PDF with no text layer', async () => {
    const result = await extractSubmissionText('scan.pdf', minimalPdf([null]), {
      mime: 'application/pdf',
    });
    expect(result.text).toBe('');
    expect(result.warnings).toEqual([
      'No extractable text — the PDF appears to be scanned (needs vision).',
    ]);
    expect(result.kind).toBe('pdf');
  });

  it('extracts the text layer from a PDF that has one', async () => {
    const result = await extractSubmissionText('essay.pdf', minimalPdf(['Hello PDF grader']));
    expect(result.text).toContain('Hello PDF grader');
    expect(result.warnings).toEqual([]);
  });

  it('extracts DOCX raw text via mammoth', async () => {
    const result = await extractSubmissionText('essay.docx', await minimalDocx(['Hello grader']));
    expect(result.text).toContain('Hello grader');
    expect(result.kind).toBe('docx');
  });
});

describe('extractOnlineTextEntry', () => {
  it('strips Canvas WYSIWYG markup, decodes entities, and keeps paragraph breaks', () => {
    expect(extractOnlineTextEntry('<p>Hello &amp; welcome</p><p>Second&nbsp;line</p>')).toBe(
      'Hello & welcome\nSecond line',
    );
  });
});

describe('TEXT_AND_CODE_EXTENSIONS', () => {
  it('pins the exact 75-entry list shared with the C# extractor and the viewer', () => {
    expect(TEXT_AND_CODE_EXTENSIONS.size).toBe(75);
    for (const ext of ['.txt', '.md', '.html', '.csv', '.py', '.ipynb', '.ts', '.cs', '.sql', '.ml']) {
      expect(TEXT_AND_CODE_EXTENSIONS.has(ext)).toBe(true);
    }
    // Binary formats have dedicated extractors and must stay excluded.
    for (const ext of ['.docx', '.xlsx', '.pdf', '.pptx', '.zip']) {
      expect(TEXT_AND_CODE_EXTENSIONS.has(ext)).toBe(false);
    }
  });
});
