// DOCX text extraction via mammoth.
//
// Ported from: C:\Devs\AIgrader\lib\extract\docx.ts
//
// Mammoth's `extractRawText` returns a plain-text serialization of the
// document body — sufficient for grading prose. We deliberately discard
// formatting (bold, italics, lists) at this layer because the grader
// reasons about content, not layout. If we ever need richer structure,
// `convertToMarkdown` is the upgrade path.

import mammoth from 'mammoth';
import { Buffer } from 'node:buffer';

export type DocxExtractResult = {
  text: string;
  warnings: string[];
};

export async function extractDocx(bytes: Uint8Array): Promise<DocxExtractResult> {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = await mammoth.extractRawText({ buffer });
  return {
    text: result.value,
    warnings: result.messages.map((m) => m.message),
  };
}
