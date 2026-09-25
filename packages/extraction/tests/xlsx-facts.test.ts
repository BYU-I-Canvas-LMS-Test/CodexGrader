// Sheet-level workbook facts for Excel-skills rubrics: freeze panes, column
// widths, merged ranges, dominant font, and formula grouping. All tests run
// through the full extractXlsx save/load round-trip — the facts must survive
// the file format, because that's what students actually submit.
//
// Ported from: C:\Devs\AIGrader-C#\tests\AiGrader.Tests\XlsxSheetFactsTests.cs

import { describe, expect, it } from 'vitest';
import { extractXlsx } from '../src/index.js';
import { xlsxBytes } from './helpers.js';

describe('xlsx sheet facts', () => {
  it('ALWAYS reports freeze panes — rubrics grade their absence', async () => {
    const frozen = await xlsxBytes((sheet) => {
      sheet.getCell('A1').value = 'Header';
      sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
    });
    expect((await extractXlsx(frozen)).text).toContain('## Freeze panes: top 1 row frozen');

    const unfrozen = await xlsxBytes((sheet) => {
      sheet.getCell('A1').value = 'Header';
    });
    expect((await extractXlsx(unfrozen)).text).toContain('## Freeze panes: none');
  });

  it('lists adjusted column widths; untouched sheets say so explicitly', async () => {
    const adjusted = await xlsxBytes((sheet) => {
      sheet.getCell('A1').value = 'wide';
      sheet.getCell('B1').value = 'plain';
      sheet.getColumn(1).width = 15.4;
    });
    const text = (await extractXlsx(adjusted)).text;
    expect(text).toContain('## Column widths (characters): A=15.4; others default');

    const untouched = await xlsxBytes((sheet) => {
      sheet.getCell('A1').value = 'x';
    });
    expect((await extractXlsx(untouched)).text).toContain('## Column widths: all default');
  });

  it('reports merged ranges (merge & center headers are a rubric staple)', async () => {
    const bytes = await xlsxBytes((sheet) => {
      sheet.getCell('A1').value = 'Title';
      sheet.mergeCells('A1:C1');
    });
    expect((await extractXlsx(bytes)).text).toContain('## Merged cells: A1:C1');
  });

  it('states uniform column fonts ONCE at column level, not one note per cell', async () => {
    const bytes = await xlsxBytes((sheet) => {
      for (let r = 1; r <= 6; r++) {
        sheet.getCell(r, 1).value = `row${r}`;
        sheet.getCell(r, 1).font = { name: 'Times New Roman', size: 12 };
      }
      sheet.getCell('B1').value = 'odd one';
      sheet.getCell('B1').font = { name: 'Courier New', size: 14 };
    });

    const text = (await extractXlsx(bytes)).text;
    expect(text).toContain('## Fonts: A Times New Roman 12; B Courier New 14');
    expect(text + '\n').toContain('A1=row1\n'); // uniform columns: cells stay bare
    expect(text).not.toContain('A1=row1 [');
    expect(text).not.toContain('B1=odd one ['); // column line covers it
  });

  it('merges adjacent uniform columns to a range — the rubric\'s "columns A to C" shape', async () => {
    const bytes = await xlsxBytes((sheet) => {
      for (let c = 1; c <= 3; c++) {
        for (let r = 1; r <= 3; r++) {
          sheet.getCell(r, c).value = 'x';
          sheet.getCell(r, c).font = { name: 'Times New Roman', size: 12 };
        }
      }
    });

    expect((await extractXlsx(bytes)).text).toContain('## Fonts: A:C Times New Roman 12');
  });

  it('states a mixed column\'s majority with an exception count and annotates ONLY the deviants', async () => {
    const bytes = await xlsxBytes((sheet) => {
      for (let r = 1; r <= 5; r++) {
        sheet.getCell(r, 1).value = `row${r}`;
        sheet.getCell(r, 1).font = { name: 'Times New Roman', size: 12 };
      }
      sheet.getCell('A6').value = 'stray';
      sheet.getCell('A6').font = { name: 'Calibri', size: 11 };
    });

    const text = (await extractXlsx(bytes)).text;
    expect(text).toContain('## Fonts: A mostly Times New Roman 12 (1 exception noted on cells)');
    expect(text).toContain('A6=stray [font=Calibri, size=11]');
    expect(text).not.toContain('A1=row1 ['); // majority cells stay bare
  });

  it('opens every workbook with the legend and the worksheet roster', async () => {
    const bytes = await xlsxBytes((sheet, wb) => {
      sheet.getCell('A1').value = 'x';
      wb.addWorksheet('Extra').getCell('A1').value = 'y';
    });

    const text = (await extractXlsx(bytes)).text;
    expect(text.startsWith('[Workbook notation:')).toBe(true);
    expect(text).toContain('## Worksheets (2): S1, Extra');
  });

  it('annotates centered headers per cell when centering is the exception', async () => {
    const bytes = await xlsxBytes((sheet) => {
      sheet.getCell('A1').value = 'Header';
      sheet.getCell('A1').alignment = { horizontal: 'center' };
      sheet.getCell('A2').value = 'data';
      sheet.getCell('A3').value = 'data';
    });

    expect((await extractXlsx(bytes)).text).toContain('A1=Header [align=center]');
  });

  it('reports a fully-centered column at column level instead of noting every cell', async () => {
    const bytes = await xlsxBytes((sheet) => {
      for (let r = 1; r <= 4; r++) {
        sheet.getCell(r, 2).value = `v${r}`;
        sheet.getCell(r, 2).alignment = { horizontal: 'center' };
      }
    });

    const text = (await extractXlsx(bytes)).text;
    expect(text).toContain('## Alignment: B center');
    expect(text).not.toContain('[align=center]'); // the column line covers them
  });

  it('collapses autofill runs (identical relative formulas down a column) to one range entry', async () => {
    const bytes = await xlsxBytes((sheet) => {
      for (let r = 1; r <= 5; r++) {
        sheet.getCell(r, 1).value = r;
        sheet.getCell(r, 2).value = { formula: `A${r}*2` };
      }
      sheet.getCell('D1').value = { formula: 'SUM(A1:A5)' };
    });

    const text = (await extractXlsx(bytes)).text;
    expect(text).toContain('B1:B5 =A1*2 (same formula filled down 5 rows)');
    expect(text).toContain('D1 =SUM(A1:A5)');
  });
});
