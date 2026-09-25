// Excel-like grid HTML for the viewer's spreadsheet preview: column letters
// and row numbers, real column widths, merged cells, sticky freeze-pane
// emulation, per-cell styling (via xlsx-formatting's cssStyle — the SAME
// inspection the AI flatten describes), and a show-formulas mode. Faculty
// grade Excel-skills rubrics against what the workbook LOOKS like, so the
// preview has to look like Excel.
//
// Freeze-pane emulation is honest about its limits: sticky offsets must be
// computed server-side, which requires FIXED row heights — so frozen data
// rows render at 24px with nowrap, and freezing is capped at 5 rows / 3
// columns (beyond that only the letter header sticks, with a warning). The
// column-letter header row is always sticky.
//
// All cell content is HTML-escaped in BOTH value and formula modes —
// workbook text is student-controlled.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Viewing\SpreadsheetGridRenderer.cs
// (ClosedXML → exceljs, CsvHelper → papaparse). Pinned by tests/grid.test.ts
// (SpreadsheetGridTests + the grid half of SubmissionPreviewConversionTests).
// One deviation, inherited from the extraction flatten: exceljs does not
// apply Excel number formats, so value mode shows raw values (and formula
// cells show their cached result — files saved by real Excel always carry one).

import type ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { Buffer } from 'node:buffer';
import { columnLetter, getCellFormula, usedCells } from './xlsx-facts.js';
import { alignName, createColorResolver, cssStyle, type ColorResolver } from './xlsx-formatting.js';
import { formatCellValue } from './xlsx.js';

/** One worksheet (or CSV pseudo-sheet) rendered as grid HTML. */
export type SheetGrid = {
  /** The grid markup; null when `error` is set. */
  html: string | null;
  /** Non-fatal notices (row/column caps, partial freeze emulation). */
  warnings: string[];
  /** Why the sheet could not be rendered, when it couldn't. */
  error: string | null;
  /** True when the row cap cut the sheet off (drives "Show all rows"). */
  truncated: boolean;
  /** True when any cell holds a formula (drives the formulas toggle). */
  hasFormulas: boolean;
};

/** Rows rendered by default; "Show all rows" raises to MAX_ROWS_PER_SHEET. */
export const INITIAL_ROWS_PER_SHEET = 500;
/** Hard row cap even with "Show all rows" (payload discipline on the wire). */
export const MAX_ROWS_PER_SHEET = 2000;
/** Column cap. */
export const MAX_COLUMNS = 50;
/** Frozen-row emulation cap (sticky offsets need fixed heights). */
export const MAX_FROZEN_ROWS = 5;
/** Frozen-column emulation cap. */
export const MAX_FROZEN_COLUMNS = 3;
/** Sticky column-letter header height (px) — frozen-row offsets build on it. */
export const HEADER_ROW_HEIGHT_PX = 26;
/** Fixed height (px) of emulated frozen data rows. */
export const FROZEN_ROW_HEIGHT_PX = 24;
/** Row-number gutter width (px) — frozen-column offsets build on it. */
export const GUTTER_WIDTH_PX = 44;
/** Worksheet-tab cap — grading reads every sheet; the PREVIEW only needs
 * enough for faculty to recognize the work. */
export const MAX_SHEETS = 10;

/** ClosedXML/Excel default column width in characters. */
const DEFAULT_COLUMN_WIDTH = 8.43;

/** Maps Excel's character-based column width to CSS pixels
 * (Calibri-11 approximation: ≈7px per character + padding). */
export function excelWidthToPx(chars: number): number {
  return Math.min(400, Math.max(30, Math.round(chars * 7 + 5)));
}

/** WebUtility.HtmlEncode parity: &, <, >, ", ' (as &#39;). */
function encodeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const LETTER_A = 'A'.charCodeAt(0);

function lettersToColumn(letters: string): number {
  let n = 0;
  const upper = letters.toUpperCase();
  for (let i = 0; i < upper.length; i++) n = n * 26 + (upper.charCodeAt(i) - LETTER_A + 1);
  return n;
}

/** "A1:C2" → numeric bounds, or null when unparsable. */
function parseRange(range: string): { r1: number; c1: number; r2: number; c2: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+):\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(range);
  if (!m) return null;
  return {
    c1: lettersToColumn(m[1]!),
    r1: parseInt(m[2]!, 10),
    c2: lettersToColumn(m[3]!),
    r2: parseInt(m[4]!, 10),
  };
}

/** The frozen-pane split of a worksheet (0/0 when not frozen). */
function frozenSplit(sheet: ExcelJS.Worksheet): { rows: number; cols: number } {
  const frozen = (sheet.views ?? []).find((v) => v.state === 'frozen') as
    | { xSplit?: number; ySplit?: number }
    | undefined;
  return { rows: frozen?.ySplit ?? 0, cols: frozen?.xSplit ?? 0 };
}

/** True when a cell should right-align like Excel does for numbers/dates,
 * absent an explicit horizontal alignment. */
function isNumericLike(cell: ExcelJS.Cell): boolean {
  const v = cell.value;
  if (typeof v === 'number' || v instanceof Date) return true;
  if (v !== null && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v)) {
    const result = (v as ExcelJS.CellFormulaValue).result;
    return typeof result === 'number' || result instanceof Date;
  }
  return false;
}

/** The worksheet-name shell for the Table kind's tab strip (sheets render
 * lazily). Port of SubmissionPreviewService.BuildWorkbookShell's XLSX half —
 * the CSV half is the caller's single "Data" entry. */
export function workbookSheetNames(workbook: ExcelJS.Workbook): {
  sheetNames: string[];
  warnings: string[];
} {
  let names = workbook.worksheets.map((w) => w.name);
  const warnings: string[] = [];
  if (names.length > MAX_SHEETS) {
    warnings.push(`Showing the first ${MAX_SHEETS} of ${names.length} sheets.`);
    names = names.slice(0, MAX_SHEETS);
  }
  return { sheetNames: names, warnings };
}

/** Renders one worksheet as grid HTML, honoring freeze panes, merges, widths,
 * styles, and gridline visibility. `resolveColor` defaults to the sheet's own
 * workbook (pass one resolver when rendering several sheets). */
export function renderSheetGrid(
  sheet: ExcelJS.Worksheet,
  showFormulas: boolean,
  maxRows: number,
  resolveColor?: ColorResolver,
): SheetGrid {
  const resolver = resolveColor ?? createColorResolver(sheet.workbook);

  const cells = usedCells(sheet);
  if (cells.length === 0) {
    return {
      html: '<div class="sg-empty">This sheet is empty.</div>',
      warnings: [],
      error: null,
      truncated: false,
      hasFormulas: false,
    };
  }

  const warnings: string[] = [];
  let firstRow = Number.MAX_SAFE_INTEGER;
  let lastRow = 0;
  let firstCol = Number.MAX_SAFE_INTEGER;
  let lastCol = 0;
  for (const { row, col } of cells) {
    if (row < firstRow) firstRow = row;
    if (row > lastRow) lastRow = row;
    if (col < firstCol) firstCol = col;
    if (col > lastCol) lastCol = col;
  }
  const truncated = lastRow - firstRow + 1 > maxRows;
  if (truncated) {
    warnings.push(`Showing the first ${maxRows} of ${lastRow - firstRow + 1} rows.`);
    lastRow = firstRow + maxRows - 1;
  }
  const colsTruncated = lastCol - firstCol + 1 > MAX_COLUMNS;
  if (colsTruncated) {
    warnings.push(`Showing the first ${MAX_COLUMNS} of ${lastCol - firstCol + 1} columns.`);
    lastCol = firstCol + MAX_COLUMNS - 1;
  }

  // Freeze emulation caps: beyond them only the letter header sticks.
  let { rows: frozenRows, cols: frozenCols } = frozenSplit(sheet);
  if (frozenRows > MAX_FROZEN_ROWS) {
    warnings.push(
      `Freeze panes shown partially (the sheet freezes ${frozenRows} rows; the preview keeps the header row sticky).`,
    );
    frozenRows = 0;
  }
  if (frozenCols > MAX_FROZEN_COLUMNS) {
    warnings.push(`Frozen columns shown partially (the sheet freezes ${frozenCols} columns).`);
    frozenCols = 0;
  }

  // Merged ranges: masters keep rowspan/colspan (clamped to the window);
  // covered cells are skipped. Ranges whose master sits outside the window
  // render as ordinary cells.
  const masters = new Map<string, { rowSpan: number; colSpan: number }>();
  const covered = new Set<string>();
  const merges: string[] = (sheet.model?.merges as string[] | undefined) ?? [];
  for (const rangeStr of merges) {
    const range = parseRange(rangeStr);
    if (!range) continue;
    const { r1: mr, c1: mc } = range;
    if (mr < firstRow || mr > lastRow || mc < firstCol || mc > lastCol) continue;
    const lr = Math.min(range.r2, lastRow);
    const lc = Math.min(range.c2, lastCol);
    masters.set(`${mr}:${mc}`, { rowSpan: lr - mr + 1, colSpan: lc - mc + 1 });
    for (let r = mr; r <= lr; r++) {
      for (let c = mc; c <= lc; c++) {
        if (r !== mr || c !== mc) covered.add(`${r}:${c}`);
      }
    }
  }

  const showGridLines =
    ((sheet.views ?? [])[0] as { showGridLines?: boolean } | undefined)?.showGridLines !== false;
  const defaultWidth = sheet.properties?.defaultColWidth ?? DEFAULT_COLUMN_WIDTH;

  const parts: string[] = [];
  let hasFormulas = false;
  // Class is sg-sheetgrid, NOT sg-grid — the review page already uses
  // .sg-grid for its two-column layout (display:grid), which would destroy
  // table layout if inherited here.
  parts.push(
    `<table class="sg-sheetgrid${showGridLines ? '' : ' sg-sheetgrid-nolines'}" style="table-layout:fixed">`,
  );

  // Column widths: gutter + real widths per rendered column. Also the
  // cumulative left offsets frozen columns stick to.
  parts.push(`<colgroup><col style="width:${GUTTER_WIDTH_PX}px">`);
  const leftOffsets = new Map<number, number>();
  let runningLeft = GUTTER_WIDTH_PX;
  for (let c = firstCol; c <= lastCol; c++) {
    const width = sheet.getColumn(c).width;
    const px = excelWidthToPx(width === undefined ? defaultWidth : width);
    leftOffsets.set(c, runningLeft);
    // xSplit counts ABSOLUTE columns from A (same as ySplit counts absolute
    // rows) — never window-relative, or a used range starting past column A
    // would freeze the wrong columns.
    if (c <= frozenCols) runningLeft += px;
    parts.push(`<col style="width:${px}px">`);
  }
  parts.push('</colgroup>');

  // Sticky column-letter header (frozen-column header cells also stick left).
  parts.push('<thead><tr><th class="sg-gcorner"></th>');
  for (let c = firstCol; c <= lastCol; c++) {
    const frozen = c <= frozenCols;
    parts.push(
      `<th class="sg-gcol${frozen ? ' sg-frozc' : ''}"${frozen ? ` style="left:${leftOffsets.get(c)}px"` : ''}>${columnLetter(c)}</th>`,
    );
  }
  parts.push('</tr></thead><tbody>');

  let frozenRowIndex = 0; // how many frozen rows rendered so far (offset stacking)
  for (let r = firstRow; r <= lastRow; r++) {
    const rowFrozen = r <= frozenRows;
    const top = HEADER_ROW_HEIGHT_PX + FROZEN_ROW_HEIGHT_PX * frozenRowIndex;
    if (rowFrozen) frozenRowIndex++;

    parts.push('<tr>');
    // Row-number gutter — sticky left; frozen rows stick top too.
    parts.push(
      `<th class="sg-grow${rowFrozen ? ' sg-frozr' : ''}"${rowFrozen ? ` style="top:${top}px"` : ''}>${r}</th>`,
    );

    const row = sheet.getRow(r);
    for (let c = firstCol; c <= lastCol; c++) {
      if (covered.has(`${r}:${c}`)) continue;

      const cell = row.getCell(c);
      const colFrozen = c <= frozenCols;
      const formula = getCellFormula(cell);
      const isFormula = formula !== null;
      hasFormulas = hasFormulas || isFormula;

      const classes: string[] = [];
      if (rowFrozen) classes.push('sg-frozr');
      if (colFrozen) classes.push('sg-frozc');
      if (!isFormula && isNumericLike(cell) && alignName(cell.alignment?.horizontal) === 'general') {
        classes.push('sg-num');
      }

      const styles: string[] = [];
      if (rowFrozen) styles.push(`top:${top}px`);
      if (colFrozen) styles.push(`left:${leftOffsets.get(c)}px`);
      const cellCss = cssStyle(cell, resolver);
      if (cellCss !== null) styles.push(cellCss);

      let td = '<td';
      const span = masters.get(`${r}:${c}`);
      if (span) {
        if (span.rowSpan > 1) td += ` rowspan="${span.rowSpan}"`;
        if (span.colSpan > 1) td += ` colspan="${span.colSpan}"`;
      }
      if (classes.length > 0) td += ` class="${classes.join(' ')}"`;
      if (styles.length > 0) td += ` style="${styles.join(';')}"`;
      td += '>';

      const text = showFormulas && isFormula ? `=${formula}` : formatCellValue(cell.value);
      parts.push(`${td}${encodeHtml(text)}</td>`);
    }
    parts.push('</tr>');
  }
  parts.push('</tbody></table>');

  // Formulas can sit entirely past the row/column caps (totals on the bottom
  // rows are the classic layout) — the ƒx toggle must still appear, so scan
  // the rest of the used range when the window missed them.
  if (!hasFormulas && (truncated || colsTruncated)) {
    hasFormulas = cells.some(({ cell }) => getCellFormula(cell) !== null);
  }

  return { html: parts.join(''), warnings, error: null, truncated, hasFormulas };
}

/** Renders CSV/TSV as a single grid "sheet": letters, row numbers,
 * quoting-aware parsing — no styles/merges/freezes to honor. */
export function renderCsvGrid(bytes: Uint8Array, delimiter: string, maxRows: number): SheetGrid {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parsed = Papa.parse<string[]>(buffer.toString('utf8'), {
    delimiter,
    skipEmptyLines: true, // tolerate malformed/blank rows, same as the grading extractor
  });

  let rows = (parsed.data as string[][]).filter((row) => row.length > 0);
  const truncated = rows.length > maxRows;
  if (truncated) rows = rows.slice(0, maxRows);
  let maxCols = rows.reduce((acc, row) => Math.max(acc, row.length), 0);

  const warnings: string[] = [];
  if (truncated) warnings.push(`Showing the first ${maxRows} rows.`);
  if (maxCols > MAX_COLUMNS) {
    warnings.push(`Showing the first ${MAX_COLUMNS} of ${maxCols} columns.`);
    maxCols = MAX_COLUMNS;
  }

  const parts: string[] = ['<table class="sg-sheetgrid" style="table-layout:fixed">'];
  parts.push(`<colgroup><col style="width:${GUTTER_WIDTH_PX}px">`);
  for (let c = 0; c < maxCols; c++) parts.push('<col style="width:120px">');
  parts.push('</colgroup><thead><tr><th class="sg-gcorner"></th>');
  for (let c = 0; c < maxCols; c++) parts.push(`<th class="sg-gcol">${columnLetter(c + 1)}</th>`);
  parts.push('</tr></thead><tbody>');
  for (let r = 0; r < rows.length; r++) {
    parts.push(`<tr><th class="sg-grow">${r + 1}</th>`);
    for (let c = 0; c < maxCols; c++) {
      parts.push(`<td>${c < rows[r]!.length ? encodeHtml(rows[r]![c]!) : ''}</td>`);
    }
    parts.push('</tr>');
  }
  parts.push('</tbody></table>');

  return { html: parts.join(''), warnings, error: null, truncated, hasFormulas: false };
}
