// XLSX workbook flatten for the grading prompt.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Extraction\SubmissionTextExtractor.cs
// (ExtractXlsx; ClosedXML → exceljs). The "# Sheet:" / "A1=value" shape also
// matches C:\Devs\AIgrader\lib\grading\excel-key.ts parseWorkbook, so the
// grading-key VALUE comparison and this flatten stay consistent — the key
// comparison is deliberately blind to everything else emitted here.
//
// Flattens a workbook to "# Sheet: name" / "A1=value" lines, plus what
// Excel-skills rubrics actually grade:
//   • a one-line notation legend and the worksheet roster up top, so the
//     model can answer "ALL the worksheets…" questions by counting;
//   • "## " sheet-fact lines — freeze panes, column widths, merged ranges,
//     per-column fonts/alignment (range-scoped, never percentages), and
//     formulas (autofill runs collapse to one entry per column) — see
//     xlsx-facts.ts;
//   • bracketed per-cell notes for visual formatting that DEVIATES from the
//     cell's column majority — "A1=Total [bold, fill=green, align=center]" —
//     see xlsx-formatting.ts.
// Plain cells stay bare.

import ExcelJS from 'exceljs';
import { Buffer } from 'node:buffer';
import {
  XLSX_NOTATION_LEGEND,
  baselineOf,
  computeColumnStyles,
  describeSheet,
  usedCells,
} from './xlsx-facts.js';
import { createColorResolver, describeCell } from './xlsx-formatting.js';

export type XlsxExtractResult = {
  text: string;
  warnings: string[];
};

export async function loadWorkbook(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wb = new ExcelJS.Workbook();
  // exceljs accepts Buffer/ArrayBuffer at runtime; its typings predate Node's
  // generic Buffer<ArrayBufferLike>, so route the cast through the declared
  // parameter type.
  await wb.xlsx.load(buffer as unknown as Parameters<ExcelJS.Xlsx['load']>[0]);
  return wb;
}

export async function extractXlsx(bytes: Uint8Array): Promise<XlsxExtractResult> {
  const wb = await loadWorkbook(bytes);
  const resolveColor = createColorResolver(wb);

  const sheetNames = wb.worksheets.map((s) => s.name);
  const lines: string[] = [
    XLSX_NOTATION_LEGEND,
    `## Worksheets (${sheetNames.length}): ${sheetNames.join(', ')}`,
  ];

  for (const sheet of wb.worksheets) {
    lines.push(`# Sheet: ${sheet.name}`);
    const cells = usedCells(sheet);
    const columns = computeColumnStyles(cells);
    lines.push(...describeSheet(sheet, cells, columns));
    for (const { cell, col } of cells) {
      const summary = columns.get(col);
      const note = describeCell(cell, resolveColor, summary ? baselineOf(summary) : null);
      const value = formatCellValue(cell.value);
      lines.push(note === null ? `${cell.address}=${value}` : `${cell.address}=${value} [${note}]`);
    }
  }
  return { text: lines.join('\n'), warnings: [] };
}

/** The display string for a cell value — the GetFormattedString stand-in.
 * exceljs does not apply number formats or evaluate formulas, so numbers
 * render raw and formula cells render their cached result (files saved by
 * real Excel always carry one). */
export function formatCellValue(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return formatDate(v);
  if (typeof v === 'object') {
    if ('formula' in v || 'sharedFormula' in v) {
      return formatCellValue((v as ExcelJS.CellFormulaValue).result ?? null);
    }
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('error' in v) return String(v.error);
    if ('text' in v) return String((v as ExcelJS.CellHyperlinkValue).text);
  }
  return String(v);
}

function formatDate(d: Date): string {
  // Whole days (the common spreadsheet case) render as a bare ISO date;
  // date-times keep the time part. Deterministic regardless of host locale.
  const iso = d.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
}
