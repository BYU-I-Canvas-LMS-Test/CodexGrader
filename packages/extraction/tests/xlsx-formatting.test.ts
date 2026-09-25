// Cell-formatting extraction: the coarse color names the AI reads must match
// what a human would call the color (faculty write "green headers", Excel
// stores #C6EFCE), defaults must produce NO annotation (plain cells stay
// byte-identical to the pre-formatting flatten), and the viewer's CSS must
// mirror the same inspection.
//
// Ported from: C:\Devs\AIGrader-C#\tests\AiGrader.Tests\XlsxFormattingTests.cs

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  coarseColorName,
  createColorResolver,
  cssStyle,
  describeCell,
  type CellStyleBaseline,
  type XlsxColor,
} from '../src/index.js';

function sheetWithResolver() {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('S1');
  return { sheet, resolve: createColorResolver(wb) };
}

describe('coarseColorName', () => {
  it.each([
    [0xc6, 0xef, 0xce, 'green'], // Excel "Good" fill
    [0x00, 0x61, 0x00, 'green'], // Excel "Good" text
    [0xff, 0xc7, 0xce, 'red'], // Excel "Bad" fill
    [0x9c, 0x00, 0x06, 'red'], // Excel "Bad" text
    [0xff, 0xeb, 0x9c, 'yellow'], // Excel "Neutral" fill
    [0x16, 0xa3, 0x4a, 'green'], // brand green
    [0xff, 0xa5, 0x00, 'orange'],
    [0x00, 0x00, 0xff, 'blue'],
    [0x80, 0x00, 0x80, 'purple'],
    [0x00, 0x80, 0x80, 'teal'],
    [0xd9, 0xd9, 0xd9, 'gray'],
    [0xff, 0xff, 0xff, 'white'],
    [0xfa, 0xfa, 0xfa, 'white'],
    [0x00, 0x00, 0x00, 'black'],
    [0x11, 0x11, 0x11, 'black'],
  ])('names rgb(%i, %i, %i) "%s" — matching human intuition', (r, g, b, expected) => {
    expect(coarseColorName(r, g, b)).toBe(expected);
  });
});

describe('describeCell', () => {
  it('produces no annotation for plain cells or explicit black-text/white-fill defaults', () => {
    const { sheet, resolve } = sheetWithResolver();
    sheet.getCell('A1').value = 'plain';
    const a2 = sheet.getCell('A2');
    a2.value = 'explicit defaults';
    a2.font = { color: { argb: 'FF000000' } };
    a2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };

    expect(describeCell(sheet.getCell('A1'), resolve)).toBeNull();
    expect(describeCell(a2, resolve)).toBeNull();
    expect(cssStyle(sheet.getCell('A1'), resolve)).toBeNull();
  });

  it('reports every facet in stable order: emphasis flags then text/fill colors', () => {
    const { sheet, resolve } = sheetWithResolver();

    const header = sheet.getCell('A1');
    header.value = 'Total';
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
    expect(describeCell(header, resolve)).toBe('bold, fill=green');

    const warn = sheet.getCell('B1');
    warn.value = 'late';
    warn.font = { italic: true, underline: 'single', color: { argb: 'FF9C0006' } };
    expect(describeCell(warn, resolve)).toBe('italic, underline, text=red');

    const gone = sheet.getCell('C1');
    gone.value = 'dropped';
    gone.font = { strike: true };
    expect(describeCell(gone, resolve)).toBe('strikethrough');
  });

  it('reports both channels of a dark banner — text skips only black, fill skips only white', () => {
    const { sheet, resolve } = sheetWithResolver();
    const cell = sheet.getCell('A1');
    cell.value = 'SECTION';
    cell.font = { color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000000' } };

    expect(describeCell(cell, resolve)).toBe('text=white, fill=black');
  });

  it('resolves theme-slot colors (with tint) through the workbook theme instead of dropping them', () => {
    const { sheet, resolve } = sheetWithResolver();
    const cell = sheet.getCell('A1');
    cell.value = 'themed';
    // theme slot 4 = accent1, 40% tint — XLColor.FromTheme(Accent1, 0.4) equivalent.
    const themed: XlsxColor = { theme: 4, tint: 0.4 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: themed as Partial<ExcelJS.Color> };

    const note = describeCell(cell, resolve);
    expect(note).not.toBeNull();
    expect(note!.startsWith('fill=')).toBe(true);
    expect(note).not.toBe('fill=white'); // resolved to a real hue, not skipped
  });

  it('suppresses font notes for cells matching the supplied column baseline', () => {
    const { sheet, resolve } = sheetWithResolver();
    const cell = sheet.getCell('A1');
    cell.value = 'data';
    cell.font = { name: 'Times New Roman', size: 12 };

    const baseline: CellStyleBaseline = {
      fontName: 'Times New Roman',
      fontSize: 12,
      alignment: 'general',
    };
    expect(describeCell(cell, resolve, baseline)).toBeNull();

    // Against the workbook default (no baseline) the same cell IS a deviation.
    expect(describeCell(cell, resolve)).toBe('font=Times New Roman, size=12');
  });

  it('describes font family, size, and alignment deviations for the AI and mirrors them into CSS', () => {
    const { sheet, resolve } = sheetWithResolver();
    const cell = sheet.getCell('A1');
    cell.value = 'Header';
    cell.font = { name: 'Times New Roman', size: 14 };
    cell.alignment = { horizontal: 'center' };

    expect(describeCell(cell, resolve)).toBe('font=Times New Roman, size=14, align=center');
    expect(cssStyle(cell, resolve)).toBe(
      "font-family:'Times New Roman';font-size:14pt;text-align:center",
    );
  });
});

describe('cssStyle', () => {
  it('emits inline formatting with real values for the viewer', () => {
    const { sheet, resolve } = sheetWithResolver();
    const cell = sheet.getCell('A1');
    cell.value = 'Total';
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };

    expect(cssStyle(cell, resolve)).toBe('font-weight:600;background-color:#c6efce');
  });
});
