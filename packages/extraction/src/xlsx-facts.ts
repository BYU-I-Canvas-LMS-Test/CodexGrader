// Sheet-level workbook facts for the grading prompt: the things Excel-skills
// rubrics actually grade that live OUTSIDE cell values — freeze panes, column
// widths, merged ranges, fonts, alignment, and formulas. Emitted as "## "
// lines under each "# Sheet:" header by the XLSX flatten.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Extraction\XlsxSheetFacts.cs
// (ClosedXML → exceljs).
//
// Two design rules, learned the hard way:
//
// 1. RANGE-SCOPED, NEVER STATISTICAL. Rubrics ask range questions ("columns A
//    to G in Times New Roman 12"), so fonts/alignment are stated per column —
//    "## Fonts: A:G Times New Roman 12; H:O Calibri 11" — never as sheet-wide
//    percentages. An earlier "87% of cells" phrasing made the model conclude
//    "only some" even when every graded column complied.
//
// 2. TOKEN DISCIPLINE VIA COLUMN RUNS. A 314-row sheet uniformly in Times New
//    Roman must not produce 2,000 font annotations: uniform columns get one
//    line entry, and per-cell notes (describeCell) exist only for cells
//    deviating from their COLUMN's majority. Likewise a column autofilled
//    with one formula compresses to a single entry ("J3:J314 =H3*I3 (same
//    formula filled down 312 rows)") — identical R1C1 formulas down a column
//    are exactly what autofill leaves behind.

import type ExcelJS from 'exceljs';
import {
  alignName,
  fmt1,
  WORKBOOK_DEFAULT_FONT_NAME,
  WORKBOOK_DEFAULT_FONT_SIZE,
  type CellStyleBaseline,
} from './xlsx-formatting.js';

/** Cap on individually listed columns in the width line. */
export const MAX_WIDTH_COLUMNS = 60;
/** Cap on listed merged ranges. */
export const MAX_MERGED_RANGES = 20;
/** Cap on listed formula groups per sheet. */
export const MAX_FORMULA_GROUPS = 100;
/** Cap on font/alignment segments per line. */
export const MAX_STYLE_SEGMENTS = 60;

/** ClosedXML's default column width, used when the sheet doesn't state one. */
const DEFAULT_COLUMN_WIDTH = 8.43;

/** One-line key to the flatten's notation, emitted once at the top of every
 * workbook so the model never has to guess what silence means. */
export const XLSX_NOTATION_LEGEND =
  '[Workbook notation: "##" lines are per-worksheet facts. Bracketed notes flag a cell\'s formatting. ' +
  'Cells WITHOUT notes match their column\'s "## Fonts" / "## Alignment" entry; ' +
  'alignment is Excel\'s default (General) wherever no entry or note says otherwise.]';

/** One column's style summary: the majority font/alignment across its used
 * cells and how many cells deviate. */
export type ColumnStyleSummary = {
  /** Most common font name in the column. */
  fontName: string;
  /** Most common font size in the column. */
  fontSize: number;
  /** Used cells whose font differs from the majority (0 = uniform). */
  fontExceptions: number;
  /** Most common horizontal alignment (normalized word) in the column. */
  alignment: string;
  /** Used cells whose alignment differs from the majority (0 = uniform). */
  alignmentExceptions: number;
};

/** The comparison baseline for cells in a column. */
export function baselineOf(summary: ColumnStyleSummary): CellStyleBaseline {
  return { fontName: summary.fontName, fontSize: summary.fontSize, alignment: summary.alignment };
}

/** A content-bearing cell plus its numeric coordinates (exceljs types cell
 * row/col as strings; the iteration callbacks give us real numbers). */
export type UsedCell = { cell: ExcelJS.Cell; row: number; col: number };

/** The sheet's content-bearing cells in row-major order — the ClosedXML
 * CellsUsed() equivalent. Merged slaves are excluded (exceljs mirrors the
 * master's value onto them; ClosedXML treats them as empty). */
export function usedCells(sheet: ExcelJS.Worksheet): UsedCell[] {
  const out: UsedCell[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      if (cell.isMerged && cell.master !== cell) return; // merged slave
      out.push({ cell, row: rowNumber, col: colNumber });
    });
  });
  return out;
}

/** Computes each used column's majority font and alignment plus deviation
 * counts. Per-cell notes report against these majorities, so a uniform column
 * costs one line-segment and zero cell notes. */
export function computeColumnStyles(cells: UsedCell[]): Map<number, ColumnStyleSummary> {
  type FontCount = { name: string; size: number; count: number };
  const fonts = new Map<number, Map<string, FontCount>>();
  const aligns = new Map<number, Map<string, number>>();

  for (const { cell, col } of cells) {
    const font = (cell.font ?? {}) as Partial<ExcelJS.Font>;
    const name = font.name ?? WORKBOOK_DEFAULT_FONT_NAME;
    const size = font.size ?? WORKBOOK_DEFAULT_FONT_SIZE;
    const fontKey = `${name}\u0000${size}`;

    let f = fonts.get(col);
    if (!f) fonts.set(col, (f = new Map()));
    const entry = f.get(fontKey);
    if (entry) entry.count += 1;
    else f.set(fontKey, { name, size, count: 1 });

    let a = aligns.get(col);
    if (!a) aligns.set(col, (a = new Map()));
    const alignKey = alignName(cell.alignment?.horizontal);
    a.set(alignKey, (a.get(alignKey) ?? 0) + 1);
  }

  const result = new Map<number, ColumnStyleSummary>();
  for (const [col, fontCounts] of fonts) {
    let total = 0;
    let topFont: FontCount | null = null;
    for (const fc of fontCounts.values()) {
      total += fc.count;
      if (!topFont || fc.count > topFont.count) topFont = fc; // first max wins ties
    }
    let topAlign = 'general';
    let topAlignCount = -1;
    for (const [key, count] of aligns.get(col)!) {
      if (count > topAlignCount) {
        topAlign = key;
        topAlignCount = count;
      }
    }
    result.set(col, {
      fontName: topFont!.name,
      fontSize: topFont!.size,
      fontExceptions: total - topFont!.count,
      alignment: topAlign,
      alignmentExceptions: total - topAlignCount,
    });
  }
  return result;
}

/** The "## " fact lines for one sheet, in stable order: freeze panes, column
 * widths, merged ranges, fonts, alignment, formulas. Lines that would say
 * "nothing here" are omitted — EXCEPT freeze panes, which is always stated
 * (rubrics grade its absence, so the model must be able to distinguish
 * "none" from "not reported"). */
export function describeSheet(
  sheet: ExcelJS.Worksheet,
  cells: UsedCell[],
  columns: Map<number, ColumnStyleSummary>,
): string[] {
  const lines: string[] = [freezeLine(sheet)];
  if (cells.length === 0) return lines; // empty sheet: nothing else to report

  let firstCol = Number.MAX_SAFE_INTEGER;
  let lastCol = 0;
  for (const { col } of cells) {
    if (col < firstCol) firstCol = col;
    if (col > lastCol) lastCol = col;
  }

  lines.push(widthLine(sheet, firstCol, lastCol));

  const merged = mergedLine(sheet);
  if (merged !== null) lines.push(merged);

  const fonts = fontsLine(columns, firstCol, lastCol);
  if (fonts !== null) lines.push(fonts);

  const alignment = alignmentLine(columns, firstCol, lastCol);
  if (alignment !== null) lines.push(alignment);

  const formulas = formulaLine(cells, firstCol, lastCol);
  if (formulas !== null) lines.push(formulas);

  return lines;
}

function freezeLine(sheet: ExcelJS.Worksheet): string {
  const frozen = (sheet.views ?? []).find((v) => v.state === 'frozen') as
    | { xSplit?: number; ySplit?: number }
    | undefined;
  const rows = frozen?.ySplit ?? 0;
  const cols = frozen?.xSplit ?? 0;
  if (rows <= 0 && cols <= 0) return '## Freeze panes: none';
  const parts: string[] = [];
  if (rows > 0) parts.push(`top ${rows} row${rows === 1 ? '' : 's'} frozen`);
  if (cols > 0) parts.push(`first ${cols} column${cols === 1 ? '' : 's'} frozen`);
  return `## Freeze panes: ${parts.join(', ')}`;
}

function widthLine(sheet: ExcelJS.Worksheet, firstCol: number, lastCol: number): string {
  const defaultWidth = sheet.properties?.defaultColWidth ?? DEFAULT_COLUMN_WIDTH;

  const custom: string[] = [];
  let defaults = 0;
  for (let c = firstCol; c <= lastCol; c++) {
    const width = sheet.getColumn(c).width;
    if (width === undefined || Math.abs(width - defaultWidth) < 0.05) {
      defaults++;
      continue;
    }
    if (custom.length < MAX_WIDTH_COLUMNS) custom.push(`${columnLetter(c)}=${fmt1(width)}`);
    else custom[custom.length - 1] = '…'; // over the cap: signal truncation, keep one marker
  }

  if (custom.length === 0) return `## Column widths: all default (${fmt1(defaultWidth)})`;
  const others = defaults > 0 ? `; others default (${fmt1(defaultWidth)})` : '';
  return `## Column widths (characters): ${custom.join(', ')}${others}`;
}

function mergedLine(sheet: ExcelJS.Worksheet): string | null {
  const ranges: string[] = sheet.model?.merges ?? [];
  if (ranges.length === 0) return null;
  const listed = ranges.slice(0, MAX_MERGED_RANGES).join(', ');
  const more = ranges.length > MAX_MERGED_RANGES ? ` (+${ranges.length - MAX_MERGED_RANGES} more)` : '';
  return `## Merged cells: ${listed}${more}`;
}

/** Every used column's font, as column-range segments: uniform runs merge
 * ("A:G Times New Roman 12"), mixed columns state their majority and the
 * exception count. Always emitted when the sheet has cells, so "not Times New
 * Roman" is as visible as "is". */
function fontsLine(
  columns: Map<number, ColumnStyleSummary>,
  firstCol: number,
  lastCol: number,
): string | null {
  const segments: string[] = [];
  let runStart = -1;
  let runEnd = -1;
  let runName = '';
  let runSize = 0;

  const flush = () => {
    if (runStart < 0) return;
    segments.push(`${columnRange(runStart, runEnd)} ${runName} ${fmt1(runSize)}`);
    runStart = -1;
  };

  for (let c = firstCol; c <= lastCol; c++) {
    const s = columns.get(c);
    if (!s) continue; // empty column: bridge the run

    if (s.fontExceptions === 0) {
      if (runStart >= 0 && s.fontName === runName && Math.abs(s.fontSize - runSize) < 0.01) {
        runEnd = c;
      } else {
        flush();
        runStart = c;
        runEnd = c;
        runName = s.fontName;
        runSize = s.fontSize;
      }
    } else {
      flush();
      segments.push(
        `${columnLetter(c)} mostly ${s.fontName} ${fmt1(s.fontSize)} ` +
          `(${s.fontExceptions} exception${s.fontExceptions === 1 ? '' : 's'} noted on cells)`,
      );
    }
  }
  flush();

  return segments.length === 0 ? null : '## Fonts: ' + joinSegments(segments);
}

/** Columns whose majority alignment is non-General, as range segments
 * ("A:G center"). Columns that are mostly General are omitted — their
 * occasional centered cells (classic centered headers) carry per-cell
 * "align=" notes instead. */
function alignmentLine(
  columns: Map<number, ColumnStyleSummary>,
  firstCol: number,
  lastCol: number,
): string | null {
  const segments: string[] = [];
  let runStart = -1;
  let runEnd = -1;
  let runAlign = 'general';

  const flush = () => {
    if (runStart < 0) return;
    segments.push(`${columnRange(runStart, runEnd)} ${runAlign}`);
    runStart = -1;
  };

  for (let c = firstCol; c <= lastCol; c++) {
    const s = columns.get(c);
    if (!s) continue;
    if (s.alignment === 'general') {
      flush();
      continue;
    }

    if (s.alignmentExceptions === 0) {
      if (runStart >= 0 && s.alignment === runAlign) {
        runEnd = c;
      } else {
        flush();
        runStart = c;
        runEnd = c;
        runAlign = s.alignment;
      }
    } else {
      flush();
      segments.push(
        `${columnLetter(c)} mostly ${s.alignment} ` +
          `(${s.alignmentExceptions} exception${s.alignmentExceptions === 1 ? '' : 's'} noted on cells)`,
      );
    }
  }
  flush();

  return segments.length === 0 ? null : '## Alignment: ' + joinSegments(segments);
}

function joinSegments(segments: string[]): string {
  if (segments.length <= MAX_STYLE_SEGMENTS) return segments.join('; ');
  return (
    segments.slice(0, MAX_STYLE_SEGMENTS).join('; ') +
    `; +${segments.length - MAX_STYLE_SEGMENTS} more columns`
  );
}

function columnRange(first: number, last: number): string {
  return first === last ? columnLetter(first) : `${columnLetter(first)}:${columnLetter(last)}`;
}

/** 1 → A, 26 → Z, 27 → AA (XLHelper.GetColumnLetterFromNumber equivalent). */
export function columnLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const LETTER_A = 'A'.charCodeAt(0);

function lettersToColumn(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - LETTER_A + 1);
  return n;
}

/** Converts an A1-style formula to R1C1 relative to (row, col) — the
 * autofill-equivalence fingerprint ClosedXML's FormulaR1C1 provided. String
 * literals and quoted sheet names pass through untouched; tokens that look
 * like function calls (`LOG10(`) or oversized references are left alone. */
export function toR1C1(formula: string, row: number, col: number): string {
  let out = '';
  let i = 0;
  const refRe = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/;
  while (i < formula.length) {
    const ch = formula[i]!;
    if (ch === '"') {
      // string literal — doubled quotes escape
      let j = i + 1;
      while (j < formula.length) {
        if (formula[j] === '"') {
          if (formula[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      out += formula.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "'") {
      // quoted sheet name
      let j = i + 1;
      while (j < formula.length && formula[j] !== "'") j++;
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const m = refRe.exec(formula.slice(i));
    if (m) {
      const prev = i > 0 ? formula[i - 1]! : '';
      const next = formula[i + m[0].length] ?? '';
      const looksLikeRef = !/[A-Za-z0-9_.$]/.test(prev) && !/[A-Za-z0-9_.(]/.test(next);
      const colNum = lettersToColumn(m[2]!.toUpperCase());
      const rowNum = parseInt(m[4]!, 10);
      if (looksLikeRef && colNum <= 16384 && rowNum >= 1 && rowNum <= 1048576) {
        const rPart = m[3] === '$' ? `R${rowNum}` : rowNum === row ? 'R' : `R[${rowNum - row}]`;
        const cPart = m[1] === '$' ? `C${colNum}` : colNum === col ? 'C' : `C[${colNum - col}]`;
        out += rPart + cPart;
        i += m[0].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** The cell's formula string (no leading '='), translating shared-formula
 * slaves through exceljs's master translation; null for non-formula cells. */
export function getCellFormula(cell: ExcelJS.Cell): string | null {
  const v = cell.value;
  if (v !== null && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v)) {
    try {
      const f = cell.formula;
      if (typeof f === 'string' && f.length > 0) return f;
    } catch {
      // master unavailable — fall through to the raw model value
    }
    const direct = (v as { formula?: string }).formula;
    return typeof direct === 'string' && direct.length > 0 ? direct : null;
  }
  return null;
}

/** Formula cells grouped per column: consecutive rows sharing one R1C1
 * formula collapse to a range entry — the fingerprint of autofill. */
function formulaLine(cells: UsedCell[], firstCol: number, lastCol: number): string | null {
  type FormulaCell = { row: number; addr: string; formula: string };
  const byCol = new Map<number, FormulaCell[]>();
  for (const { cell, row, col } of cells) {
    const formula = getCellFormula(cell);
    if (formula === null) continue;
    let list = byCol.get(col);
    if (!list) byCol.set(col, (list = []));
    list.push({ row, addr: cell.address, formula }); // row-major input keeps each column sorted
  }

  const groups: string[] = [];
  let overflow = 0;

  for (let c = firstCol; c <= lastCol; c++) {
    const list = byCol.get(c);
    if (!list) continue;
    let i = 0;
    while (i < list.length) {
      const start = list[i]!;
      const r1c1 = toR1C1(start.formula, start.row, c);
      let j = i;
      while (
        j + 1 < list.length &&
        list[j + 1]!.row === list[j]!.row + 1 &&
        toR1C1(list[j + 1]!.formula, list[j + 1]!.row, c) === r1c1
      ) {
        j++;
      }

      if (groups.length >= MAX_FORMULA_GROUPS) {
        overflow += j - i + 1;
      } else if (j === i) {
        groups.push(`${start.addr} =${start.formula}`);
      } else {
        const count = j - i + 1;
        groups.push(`${start.addr}:${list[j]!.addr} =${start.formula} (same formula filled down ${count} rows)`);
      }
      i = j + 1;
    }
  }

  if (groups.length === 0) return null;
  let line = '## Formulas: ' + groups.join('; ');
  if (overflow > 0) line += `; +${overflow} more formula cells`;
  return line;
}
