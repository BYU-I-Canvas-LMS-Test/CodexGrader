// @aigrader/extraction — submission text extraction, spreadsheet facts, and
// the submission-viewer conversions.
//
// ENGINE-ONLY dependency (never imported by apps/web client code). Ported
// from: C:\Devs\AIgrader\lib\extract\* and
// C:\Devs\AIGrader-C#\src\AiGrader\Services\Extraction\*.
// Everything is bytes-in (Buffer/Uint8Array), string-out: no filesystem
// access, no Canvas awareness — the caller supplies the bytes.

export const EXTRACTION_PACKAGE_SENTINEL = '@aigrader/extraction';

// Dispatcher (attachments) + online_text_entry.
export {
  extractSubmissionText,
  type ExtractKind,
  type ExtractOptions,
  type ExtractResult,
} from './extract.js';
export { extractOnlineTextEntry, stripHtml } from './text.js';

// Per-format extractors (the dispatcher covers normal use; these are exported
// for targeted callers and tests).
export { extractDocx, type DocxExtractResult } from './docx.js';
export { extractCsv, type CsvExtractResult } from './csv.js';
export { extractPdf, SCANNED_PDF_WARNING, type PdfExtractResult } from './pdf.js';
export { extractXlsx, loadWorkbook, formatCellValue, type XlsxExtractResult } from './xlsx.js';

// Extension lists (the submission viewer must classify with these — no
// drift; the canonical copies live in @aigrader/shared/preview).
export { TEXT_AND_CODE_EXTENSIONS, IMAGE_EXTENSIONS, fileExtension } from './extensions.js';

// Submission-viewer conversions (M5): the canonical allowlist sanitizer and
// the DOCX/RTF → sanitized HTML + Excel-like grid renderers the engine's
// /preview endpoints serve. The web tier only ever RECEIVES this output.
export { sanitizeHtml } from './sanitize-html.js';
export { convertDocxHtml, type DocxHtmlResult } from './docx-html.js';
export {
  convertRtfHtml,
  isRtfAttachment,
  rtfToHtml,
  RTF_APPROXIMATE_WARNING,
  type RtfHtmlResult,
} from './rtf-html.js';
export {
  renderSheetGrid,
  renderCsvGrid,
  workbookSheetNames,
  excelWidthToPx,
  INITIAL_ROWS_PER_SHEET,
  MAX_ROWS_PER_SHEET,
  MAX_COLUMNS,
  MAX_FROZEN_ROWS,
  MAX_FROZEN_COLUMNS,
  HEADER_ROW_HEIGHT_PX,
  FROZEN_ROW_HEIGHT_PX,
  GUTTER_WIDTH_PX,
  MAX_SHEETS,
  type SheetGrid,
} from './grid.js';

// XLSX sheet facts + per-cell formatting (prompt lines and viewer CSS).
export {
  XLSX_NOTATION_LEGEND,
  computeColumnStyles,
  describeSheet,
  usedCells,
  baselineOf,
  columnLetter,
  toR1C1,
  getCellFormula,
  type ColumnStyleSummary,
  type UsedCell,
} from './xlsx-facts.js';
export {
  describeCell,
  cssStyle,
  alignName,
  coarseColorName,
  applyTint,
  createColorResolver,
  type CellStyleBaseline,
  type ColorResolver,
  type Rgb,
  type XlsxColor,
} from './xlsx-formatting.js';
