// Lifted from: C:\Devs\AIgrader\tests\unit\excel-key.test.ts (verbatim suite
// over the lifted module — in-memory workbooks only, no filesystem).

import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { compareToKey, summarizeComparison } from '../src/grading/excel-key.js';

// Build an in-memory xlsx as a Buffer. `sheets` maps a sheet name to a map of
// cell address -> value.
async function makeWorkbook(
  sheets: Record<string, Record<string, string | number>>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, cells] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const [addr, value] of Object.entries(cells)) {
      ws.getCell(addr).value = value;
    }
  }
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

describe('compareToKey', () => {
  it('reports a perfect match when the student equals the key', async () => {
    const key = await makeWorkbook({ Sheet1: { A1: 'Name', B2: 42, C3: 'yes' } });
    const student = await makeWorkbook({ Sheet1: { A1: 'Name', B2: 42, C3: 'yes' } });
    const cmp = await compareToKey(student, key);
    expect(cmp.structureValid).toBe(true);
    expect(cmp.totalCells).toBe(3);
    expect(cmp.matchedCells).toBe(3);
    expect(cmp.scorePct).toBe(100);
    expect(cmp.mismatches).toHaveLength(0);
  });

  it('flags individual cell mismatches', async () => {
    const key = await makeWorkbook({ Sheet1: { A1: 'Name', B2: 42 } });
    const student = await makeWorkbook({ Sheet1: { A1: 'Name', B2: 41 } });
    const cmp = await compareToKey(student, key);
    expect(cmp.structureValid).toBe(true);
    expect(cmp.matchedCells).toBe(1);
    expect(cmp.mismatches).toHaveLength(1);
    expect(cmp.mismatches[0]?.cell).toBe('B2');
    expect(cmp.mismatches[0]?.expected).toBe(42);
    expect(cmp.mismatches[0]?.got).toBe(41);
  });

  it('treats numeric and string forms of the same value as equal', async () => {
    const key = await makeWorkbook({ Sheet1: { A1: 5 } });
    const student = await makeWorkbook({ Sheet1: { A1: '5' } });
    const cmp = await compareToKey(student, key);
    expect(cmp.matchedCells).toBe(1);
  });

  it('marks structure invalid when a key sheet is missing from the student file', async () => {
    const key = await makeWorkbook({
      Data: { A1: 'x' },
      Answers: { A1: 'y' },
    });
    const student = await makeWorkbook({ Data: { A1: 'x' } });
    const cmp = await compareToKey(student, key);
    expect(cmp.structureValid).toBe(false);
    expect(cmp.missingSheets).toContain('Answers');
    // the missing sheet's cells count against the total
    expect(cmp.totalCells).toBe(2);
    expect(cmp.matchedCells).toBe(1);
  });

  it('summary flags a structure mismatch for instructor review', async () => {
    const key = await makeWorkbook({ Data: { A1: 'x' }, Answers: { A1: 'y' } });
    const student = await makeWorkbook({ Data: { A1: 'x' } });
    const summary = summarizeComparison(await compareToKey(student, key));
    expect(summary).toContain('STRUCTURE MISMATCH');
    expect(summary).toContain('Answers');
  });
});
