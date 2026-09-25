// The Excel-like grid's structure: merged cells, freeze-pane emulation,
// row/column headers, formula mode, width mapping, gridline visibility — and
// the conversion-level guards (row caps, HTML escaping of student-controlled
// cell text, CSV/TSV parsing). Structure tests run on live worksheets;
// freeze/width behavior also runs through the save/load round-trip (students
// submit FILES, not API objects).
//
// Ported from: C:\Devs\AIGrader-C#\tests\AiGrader.Tests\SpreadsheetGridTests.cs
// and the grid half of SubmissionPreviewConversionTests.cs.

import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  GUTTER_WIDTH_PX,
  INITIAL_ROWS_PER_SHEET,
  excelWidthToPx,
  renderCsvGrid,
  renderSheetGrid,
  workbookSheetNames,
} from '../src/grid.js';
import { loadWorkbook } from '../src/xlsx.js';
import { utf8, xlsxBytes } from './helpers.js';

function liveSheet(): { wb: ExcelJS.Workbook; ws: ExcelJS.Worksheet } {
  const wb = new ExcelJS.Workbook();
  return { wb, ws: wb.addWorksheet('S1') };
}

describe('renderSheetGrid structure (SpreadsheetGridTests port)', () => {
  it('merged ranges span and skip covered cells', () => {
    const { ws } = liveSheet();
    ws.getCell('A1').value = 'Title';
    ws.mergeCells('A1:C2');
    ws.getCell('D1').value = 'side';
    ws.getCell('A3').value = 'below'; // extends the used range past the merge

    const html = renderSheetGrid(ws, false, 500).html!;
    expect(html).toContain('rowspan="2"');
    expect(html).toContain('colspan="3"');
    // Row 1 renders the merge master + D1 only: gutter th, master td, side td.
    let firstRow = html.slice(html.indexOf('<tbody>'));
    firstRow = firstRow.slice(0, firstRow.indexOf('</tr>'));
    expect(firstRow.split('<td').length - 1).toBe(2);
  });

  it('headers show column letters and real row numbers', () => {
    const { ws } = liveSheet();
    ws.getCell('B3').value = 'x'; // used range starts at B3 — headers must not lie

    const html = renderSheetGrid(ws, false, 500).html!;
    expect(html).toContain('sg-gcorner');
    expect(html).toContain('>B</th>');
    expect(html).toContain('<th class="sg-grow">3</th>'); // actual row number, not 1
  });

  it('freeze panes within the cap emulate sticky rows with computed offsets', async () => {
    const bytes = await xlsxBytes((sheet) => {
      sheet.getCell('A1').value = 'Header';
      sheet.getCell('A2').value = 'data';
      sheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 0 }];
    });

    const wb = await loadWorkbook(bytes);
    const html = renderSheetGrid(wb.worksheets[0]!, false, 500).html!;
    expect(html).toContain('sg-frozr');
    expect(html).toContain('top:26px');
  });

  it('freeze panes beyond the cap warn and degrade', () => {
    const { ws } = liveSheet();
    for (let r = 1; r <= 10; r++) ws.getCell(r, 1).value = r;
    ws.views = [{ state: 'frozen', ySplit: 8, xSplit: 0 }];

    const sheet = renderSheetGrid(ws, false, 500);
    expect(sheet.html).not.toContain('sg-frozr');
    expect(sheet.warnings.some((w) => w.includes('partially'))).toBe(true);
  });

  it('frozen columns stick left using the gutter + real column widths', () => {
    const { ws } = liveSheet();
    ws.getCell('A1').value = 'id';
    ws.getCell('B1').value = 'name';
    ws.views = [{ state: 'frozen', ySplit: 0, xSplit: 1 }];

    const html = renderSheetGrid(ws, false, 500).html!;
    expect(html).toContain('sg-frozc');
    expect(html).toContain(`left:${GUTTER_WIDTH_PX}px`);
  });

  it('formula mode shows escaped formulas; value mode shows results', () => {
    const { ws } = liveSheet();
    ws.getCell('A1').value = 1;
    ws.getCell('B1').value = 'fallback';
    // exceljs does not evaluate formulas — the cached result stands in for
    // ClosedXML's evaluation (files saved by real Excel always carry one).
    ws.getCell('C1').value = { formula: 'IF(A1<2,"x&y",B1)', result: 'x&y' };

    const formulas = renderSheetGrid(ws, true, 500);
    expect(formulas.hasFormulas).toBe(true);
    expect(formulas.html).toContain('=IF(A1&lt;2,&quot;x&amp;y&quot;,B1)');

    const values = renderSheetGrid(ws, false, 500);
    expect(values.html).toContain('x&amp;y');
    expect(values.html).not.toContain('IF(');
  });

  it('column widths map to pixels (pinned) and survive the file round-trip', async () => {
    expect(excelWidthToPx(8.43)).toBe(64); // Excel default ≈ 64px
    expect(excelWidthToPx(0)).toBe(30); // clamp floor
    expect(excelWidthToPx(100)).toBe(400); // clamp ceiling

    const bytes = await xlsxBytes((sheet) => {
      sheet.getCell('A1').value = 'wide';
      sheet.getColumn(1).width = 20; // → 145px
    });
    const wb = await loadWorkbook(bytes);
    const html = renderSheetGrid(wb.worksheets[0]!, false, 500).html!;
    expect(html).toContain('width:145px');
  });

  it('numeric cells right-align like Excel unless the sheet says otherwise', () => {
    const { ws } = liveSheet();
    ws.getCell('A1').value = 42;
    ws.getCell('B1').value = 'text';

    const html = renderSheetGrid(ws, false, 500).html!;
    expect(html).toContain('sg-num');
    expect(html).toContain('>text</td>');
    expect(html).not.toContain('sg-num">text');
  });

  it('sheets saved with gridlines hidden render without them', () => {
    const { ws } = liveSheet();
    ws.getCell('A1').value = 'x';
    ws.views = [{ showGridLines: false } as ExcelJS.WorksheetView];

    expect(renderSheetGrid(ws, false, 500).html).toContain('sg-sheetgrid-nolines');
  });

  it('an empty worksheet renders a friendly empty state, not a crash', () => {
    const { ws } = liveSheet();
    const sheet = renderSheetGrid(ws, false, 500);
    expect(sheet.html!.toLowerCase()).toContain('empty');
    expect(sheet.error).toBeNull();
  });
});

describe('grid conversions (SubmissionPreviewConversionTests port)', () => {
  it('workbook rows render as a capped, escaped grid with a visible notice', async () => {
    const bytes = await xlsxBytes((sheet) => {
      for (let row = 1; row <= INITIAL_ROWS_PER_SHEET + 100; row++) {
        sheet.getCell(row, 1).value = `row${row}`;
      }
      sheet.getCell(1, 2).value = '<b>not markup</b>';
    });

    const wb = await loadWorkbook(bytes);
    const sheet = renderSheetGrid(wb.worksheets[0]!, false, INITIAL_ROWS_PER_SHEET);

    expect(sheet.truncated).toBe(true);
    expect(sheet.html).toContain(`row${INITIAL_ROWS_PER_SHEET}`); // last kept row
    expect(sheet.html).not.toContain(`row${INITIAL_ROWS_PER_SHEET + 1}`); // first dropped
    expect(sheet.html).toContain('&lt;b&gt;not markup&lt;/b&gt;'); // escaped, not rendered
    expect(sheet.warnings.some((w) => w.includes(`first ${INITIAL_ROWS_PER_SHEET}`))).toBe(true);
  });

  it('cell formatting (fills, bold) carries into the grid as inline styles', async () => {
    const bytes = await xlsxBytes((sheet) => {
      sheet.getCell('A1').value = 'Header';
      sheet.getCell('A1').font = { bold: true };
      sheet.getCell('A1').fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFC6EFCE' },
      };
      sheet.getCell('A2').value = 'plain';
    });

    const wb = await loadWorkbook(bytes);
    const sheet = renderSheetGrid(wb.worksheets[0]!, false, 500);

    expect(sheet.html).toContain('font-weight:600;background-color:#c6efce');
    expect(sheet.html).toContain('>plain</td>');
  });

  it('CSV quoting survives into escaped grid cells with gutters and letters', () => {
    const csv = 'name,notes\nJane,"likes, commas"\nBob,<script>x</script>';
    const sheet = renderCsvGrid(utf8(csv), ',', 1000);

    expect(sheet.html).toContain('<td>likes, commas</td>');
    expect(sheet.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(sheet.html).not.toContain('<script>');
    expect(sheet.html).toContain('<th class="sg-grow">1</th>'); // row numbers
    expect(sheet.html).toContain('>A</th>'); // column letters
    expect(sheet.warnings).toEqual([]); // small file — no caps hit
  });

  it('TSV uses the tab delimiter (one row, three cells — not one cell)', () => {
    const sheet = renderCsvGrid(utf8('a\tb\tc'), '\t', 1000);
    expect(sheet.html).toContain('<td>a</td><td>b</td><td>c</td>');
  });

  it('CSV rows past the cap truncate with a notice', () => {
    const csv = Array.from({ length: 20 }, (_, i) => `r${i + 1}`).join('\n');
    const sheet = renderCsvGrid(utf8(csv), ',', 10);
    expect(sheet.truncated).toBe(true);
    expect(sheet.html).toContain('<td>r10</td>');
    expect(sheet.html).not.toContain('<td>r11</td>');
    expect(sheet.warnings.some((w) => w.includes('first 10'))).toBe(true);
  });

  it('the sheet-name shell caps at 10 sheets with a warning', () => {
    const wb = new ExcelJS.Workbook();
    for (let i = 1; i <= 12; i++) wb.addWorksheet(`Sheet${i}`);
    const shell = workbookSheetNames(wb);
    expect(shell.sheetNames).toHaveLength(10);
    expect(shell.warnings.some((w) => w.includes('first 10 of 12'))).toBe(true);
  });

  it('a zero-byte "workbook" throws deterministically (never OperationCanceled-like)', async () => {
    // The engine's /preview wrapper catches this and returns a friendly
    // SheetGrid error — the throw itself must be an ordinary Error.
    await expect(loadWorkbook(new Uint8Array(0))).rejects.toBeTruthy();
  });
});
