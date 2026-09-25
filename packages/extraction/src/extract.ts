// Submission text extraction: turns whatever a student handed in (DOCX, PDF,
// XLSX, CSV, code, plain text) into plain text for the grading prompt.
//
// Ported from: C:\Devs\AIgrader\lib\extract\index.ts (extract dispatcher) and
// C:\Devs\AIGrader-C#\src\AiGrader\Services\Extraction\SubmissionTextExtractor.cs
// (the functional spec — extension lists, per-format flatten behavior, and
// the exact user-facing unsupported/scanned-PDF messages, which appear in
// graded output).
//
// Canvas frequently serves code files as application/octet-stream, so
// dispatch keys off the extension (and any text/* mime) rather than trusting
// the content type. online_text_entry bodies don't come through here — use
// extractOnlineTextEntry from text.ts.

import { Buffer } from 'node:buffer';
import { TEXT_AND_CODE_EXTENSIONS, fileExtension } from './extensions.js';

export type ExtractKind = 'docx' | 'xlsx' | 'csv' | 'pdf' | 'text';

export type ExtractResult = {
  text: string;
  warnings: string[];
  kind: ExtractKind;
};

export type ExtractOptions = {
  /** Content type as reported by Canvas — often wrong (see above). */
  mime?: string | null;
};

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Extracts text from an attachment, dispatching on filename and MIME.
 * Throws for formats the AI can't read (the caller surfaces that as a
 * per-student ERROR with the message).
 */
export async function extractSubmissionText(
  filename: string | null | undefined,
  bytes: Uint8Array,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const mime = (opts.mime ?? '').toLowerCase();
  const name = (filename ?? '').toLowerCase();

  if (mime === DOCX_MIME || name.endsWith('.docx')) {
    const { extractDocx } = await import('./docx.js');
    const r = await extractDocx(bytes);
    return { text: r.text, warnings: r.warnings, kind: 'docx' };
  }

  if (
    name.endsWith('.xlsx') ||
    name.endsWith('.xlsm') ||
    mime.includes('spreadsheetml') ||
    mime === 'application/vnd.ms-excel'
  ) {
    const { extractXlsx } = await import('./xlsx.js');
    const r = await extractXlsx(bytes);
    return { text: r.text, warnings: r.warnings, kind: 'xlsx' };
  }

  if (name.endsWith('.csv') || mime === 'text/csv') {
    const { extractCsv } = await import('./csv.js');
    const r = extractCsv(bytes);
    return { text: r.text, warnings: r.warnings, kind: 'csv' };
  }

  if (name.endsWith('.pdf') || mime === 'application/pdf') {
    const { extractPdf } = await import('./pdf.js');
    const r = await extractPdf(bytes);
    return { text: r.text, warnings: r.warnings, kind: 'pdf' };
  }

  // Plain text and source code: decode as UTF-8, keyed off the extension
  // whitelist (and any text/* mime).
  const ext = fileExtension(name);
  if (mime.startsWith('text/') || TEXT_AND_CODE_EXTENSIONS.has(ext)) {
    const buffer = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { text: buffer.toString('utf8'), warnings: [], kind: 'text' };
  }

  // Exact user-facing message (parity contract — it appears in graded output).
  throw new Error(
    `Unsupported submission format: mime=${opts.mime ?? 'unknown'} filename=${filename ?? 'unknown'}. ` +
      'Supported: DOCX, PDF, XLSX, CSV, source code, plain text, and online_text_entry.',
  );
}
