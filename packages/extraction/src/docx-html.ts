// DOCX → sanitized HTML for the submission viewer's SERVER fallback path.
// The primary DOCX render is client-side (docx-preview in the browser); this
// conversion runs only when that fails — mammoth produces simplified HTML
// (embedded pictures inlined as data:image URIs) and the result flows through
// the canonical allowlist sanitizer like every other rendered-HTML path.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Viewing\SubmissionPreviewService.cs
// (ConvertDocx: Mammoth → PreviewHtmlSanitizer). Pinned by
// tests/preview-conversion.test.ts (SubmissionPreviewConversionTests port).

import mammoth from 'mammoth';
import { Buffer } from 'node:buffer';
import { sanitizeHtml } from './sanitize-html.js';

export type DocxHtmlResult = {
  /** Sanitized HTML, or null when the document produced nothing previewable. */
  html: string | null;
  /** Mammoth conversion messages (non-fatal). */
  warnings: string[];
  /** Why nothing could be rendered, when html is null. */
  error: string | null;
};

/** DOCX bytes → sanitized HTML. Throws for corrupt input (callers wrap, same
 * contract as the extraction paths). */
export async function convertDocxHtml(bytes: Uint8Array): Promise<DocxHtmlResult> {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = await mammoth.convertToHtml({ buffer });
  const warnings = result.messages.map((m) => m.message).filter((m) => m.length > 0);
  const html = sanitizeHtml(result.value);
  if (html.trim() === '') {
    return { html: null, warnings, error: 'The document produced no previewable content.' };
  }
  return { html, warnings, error: null };
}
