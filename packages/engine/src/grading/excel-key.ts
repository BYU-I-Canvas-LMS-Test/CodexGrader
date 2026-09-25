// Ported from: C:\Devs\AIgrader\lib\grading\excel-key.ts (verbatim lift —
// same normalization, scoring, and report wording; cross-checked against
// C:\Devs\AIGrader-C#\src\AiGrader\Services\Grading\ExcelKeyComparer.cs,
// which is itself a ClosedXML port of this module).
//
// Deterministic Excel grading-key comparison.
//
// Used when an assignment has an Excel grading key and the student submitted
// an Excel workbook. The flow the instructor asked for:
//   1. Validate the student's workbook has the SAME STRUCTURE as the key
//      (same sheet names; the key's populated cells exist in the student file).
//   2. Compare the key's populated answer cells against the student's same
//      cell addresses and report matched / mismatched.
//   3. If structure does not match, flag for instructor review rather than
//      scoring against a mismatched layout.
//
// The result is summarized into prompt context for the grader; it does not by
// itself assign points.

import ExcelJS from 'exceljs';

export type ParsedSheet = {
  name: string;
  // address (e.g. "B7") -> normalized primitive value of every populated cell
  cells: Map<string, string | number | boolean>;
};

export type ParsedWorkbook = {
  sheets: ParsedSheet[];
};

export type CellMismatch = {
  sheet: string;
  cell: string;
  expected: string | number | boolean;
  got: string | number | boolean | null;
};

export type KeyComparison = {
  structureValid: boolean;
  missingSheets: string[];
  totalCells: number;
  matchedCells: number;
  scorePct: number;
  mismatches: CellMismatch[];
  truncated: boolean;
};

const MAX_MISMATCHES = 50;

function normalize(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const t = value.trim();
    return t.length === 0 ? null : t;
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    // ExcelJS rich/formula/hyperlink cell shapes.
    if ('result' in v) return normalize(v.result);
    if ('text' in v) return normalize(v.text);
    if ('richText' in v && Array.isArray(v.richText)) {
      return normalize(v.richText.map((r) => (r as { text?: string }).text ?? '').join(''));
    }
    if (v instanceof Date) return v.toISOString();
  }
  return null;
}

function valuesEqual(
  a: string | number | boolean,
  b: string | number | boolean | null,
): boolean {
  if (b === null) return false;
  if (typeof a === 'number' && typeof b === 'number') {
    // tolerate tiny float drift
    return Math.abs(a - b) < 1e-9;
  }
  // Intentional cross-type leniency: a key cell of 5 (incl. a formula result)
  // matches a student cell of "5", and "True" matches true. This favors
  // counting a correct answer regardless of how the cell was typed. If a course
  // ever needs strict type matching, tighten this here.
  return String(a).trim() === String(b).trim();
}

export async function parseWorkbook(bytes: Buffer): Promise<ParsedWorkbook> {
  const wb = new ExcelJS.Workbook();
  // exceljs's typings want a plain ArrayBuffer; hand it an exact slice so the
  // value and the type agree (a Node Buffer would mismatch under noUncheckedIndexedAccess).
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  await wb.xlsx.load(ab);
  const sheets: ParsedSheet[] = [];
  wb.eachSheet((sheet) => {
    const cells = new Map<string, string | number | boolean>();
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = normalize(cell.value);
        if (v !== null) cells.set(cell.address, v);
      });
    });
    sheets.push({ name: sheet.name, cells });
  });
  return { sheets };
}

export function compareParsed(
  student: ParsedWorkbook,
  key: ParsedWorkbook,
): KeyComparison {
  const studentByName = new Map(student.sheets.map((s) => [s.name, s]));
  const missingSheets: string[] = [];
  const mismatches: CellMismatch[] = [];
  let totalCells = 0;
  let matchedCells = 0;
  let truncated = false;

  for (const keySheet of key.sheets) {
    const studentSheet = studentByName.get(keySheet.name);
    if (!studentSheet) {
      missingSheets.push(keySheet.name);
      // Count the key's cells as unmatched so the score reflects the gap.
      totalCells += keySheet.cells.size;
      continue;
    }
    for (const [addr, expected] of keySheet.cells) {
      totalCells += 1;
      const got = studentSheet.cells.get(addr) ?? null;
      if (valuesEqual(expected, got)) {
        matchedCells += 1;
      } else if (mismatches.length < MAX_MISMATCHES) {
        mismatches.push({ sheet: keySheet.name, cell: addr, expected, got });
      } else {
        truncated = true;
      }
    }
  }

  const structureValid = missingSheets.length === 0;
  const scorePct = totalCells > 0 ? Math.round((matchedCells / totalCells) * 100) : 0;
  return {
    structureValid,
    missingSheets,
    totalCells,
    matchedCells,
    scorePct,
    mismatches,
    truncated,
  };
}

export async function compareToKey(
  studentBytes: Buffer,
  keyBytes: Buffer,
): Promise<KeyComparison> {
  const [student, key] = await Promise.all([
    parseWorkbook(studentBytes),
    parseWorkbook(keyBytes),
  ]);
  return compareParsed(student, key);
}

// Render a comparison into compact prompt context for the grader.
export function summarizeComparison(cmp: KeyComparison): string {
  const lines: string[] = [];
  if (!cmp.structureValid) {
    lines.push(
      `STRUCTURE MISMATCH — the student's workbook is missing expected sheet(s): ${cmp.missingSheets.join(', ')}. Flag for instructor review; do not assume the layout matches the key.`,
    );
  } else {
    lines.push('Structure matches the grading key (all expected sheets present).');
  }
  lines.push(
    `Answer cells matched: ${cmp.matchedCells} of ${cmp.totalCells} (${cmp.scorePct}%).`,
  );
  if (cmp.mismatches.length > 0) {
    lines.push('Cells that differ from the key:');
    for (const m of cmp.mismatches) {
      lines.push(
        `  ${m.sheet}!${m.cell}: expected "${String(m.expected)}", got ${
          m.got === null ? '(empty)' : `"${String(m.got)}"`
        }`,
      );
    }
    if (cmp.truncated) lines.push('  …(additional mismatches omitted)');
  }
  return lines.join('\n');
}
