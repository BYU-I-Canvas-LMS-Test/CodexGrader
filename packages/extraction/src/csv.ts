// CSV → tab-joined rows of text (papaparse handles quoting/newlines in cells).
//
// Ported from: C:\Devs\AIgrader\lib\extract\index.ts (extractCsvBuffer);
// cross-checked against C:\Devs\AIGrader-C#\src\AiGrader\Services\Extraction\
// SubmissionTextExtractor.cs (ExtractCsv), which additionally drops rows whose
// cells are all whitespace — we match that.

import Papa from 'papaparse';
import { Buffer } from 'node:buffer';

export type CsvExtractResult = {
  text: string;
  warnings: string[];
};

export function extractCsv(bytes: Uint8Array): CsvExtractResult {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parsed = Papa.parse<string[]>(buffer.toString('utf8'), { skipEmptyLines: true });
  const lines = (parsed.data as string[][])
    .filter((row) => row.length > 0 && row.some((c) => c != null && c.trim().length > 0))
    .map((row) => row.join('\t'));
  const warnings =
    parsed.errors && parsed.errors.length > 0
      ? [`${parsed.errors.length} CSV parse warning(s)`]
      : [];
  return { text: lines.join('\n'), warnings };
}
