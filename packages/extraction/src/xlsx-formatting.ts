// Cell-formatting extraction for spreadsheets: faculty grade on visual
// formatting ("make the headers green and bold"), so the flattened text the
// AI reads — and the in-app preview faculty compare it against — must carry
// it. Two renderings of the same cell inspection:
//   describeCell() → "bold, fill=green" for the AI (coarse COLOR NAMES,
//     because assignment instructions say "green", never "#C6EFCE")
//   cssStyle() → "font-weight:600;background-color:#c6efce" for the viewer
// Colors resolve through the three OOXML storage forms (argb / indexed /
// theme+tint); anything unresolvable is skipped, never thrown — formatting is
// garnish, extraction must not fail over it. Defaults are skipped so plain
// cells stay byte-identical to the pre-formatting flatten: black text and
// white/no fill produce no annotation.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Extraction\XlsxFormatting.cs
// (ClosedXML → exceljs).

import type ExcelJS from 'exceljs';

/** The style a cell is compared against for per-cell deviation notes:
 * its column's majority font and alignment. */
export type CellStyleBaseline = {
  fontName: string;
  fontSize: number;
  /** Normalized alignment word ('general', 'center', …) — see alignName. */
  alignment: string;
};

/** Workbook default font (ClosedXML's workbook.Style.Font equivalent).
 * exceljs does not surface the file's Normal style, so we pin Excel's
 * universal default; loaded files materialize per-cell fonts anyway. */
export const WORKBOOK_DEFAULT_FONT_NAME = 'Calibri';
export const WORKBOOK_DEFAULT_FONT_SIZE = 11;

/** A resolved RGB triple. */
export type Rgb = { r: number; g: number; b: number };

/** exceljs color storage (its typings omit indexed/tint; runtime has them). */
export type XlsxColor = { argb?: string; theme?: number; tint?: number; indexed?: number };

/** Resolves an exceljs color to RGB, or null when it can't be resolved. */
export type ColorResolver = (color: XlsxColor | undefined) => Rgb | null;

/** Invariant "0.#" number formatting — a comma-decimal host locale must never
 * leak "15,4" into ", "-joined prompt lines (pinned by golden tests). */
export function fmt1(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** The prompt/CSS word for a horizontal alignment ('center', 'left', …;
 * 'general' for Excel's type-based default). */
export function alignName(horizontal: string | undefined): string {
  switch (horizontal) {
    case 'center':
    case 'centerContinuous':
      return 'center';
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'justify':
      return 'justify';
    case 'distributed':
      return 'distributed';
    case 'fill':
      return 'fill';
    default:
      return 'general';
  }
}

/** The formatting note for the AI flatten, e.g. "bold, fill=green" or
 * "font=Times New Roman, size=12, align=center"; null when the cell has no
 * reportable formatting (the common case — plain cells must stay
 * annotation-free). Font/size/alignment report DEVIATIONS from `baseline`
 * (the cell's COLUMN majority, see computeColumnStyles); without a baseline
 * they compare against the workbook default. Keeps a uniformly-styled column
 * from annotating every cell — the sheet-level "## Fonts:" line carries the
 * uniform story instead. */
export function describeCell(
  cell: ExcelJS.Cell,
  resolveColor: ColorResolver,
  baseline: CellStyleBaseline | null = null,
): string | null {
  const look = getLook(cell, resolveColor, baseline);
  const parts: string[] = [];
  if (look.bold) parts.push('bold');
  if (look.italic) parts.push('italic');
  if (look.underline) parts.push('underline');
  if (look.strikethrough) parts.push('strikethrough');
  if (look.fontName !== null) parts.push(`font=${look.fontName}`);
  if (look.fontSize !== null) parts.push(`size=${fmt1(look.fontSize)}`);
  if (look.align !== null) parts.push(`align=${look.align}`);
  if (look.fontRgb !== null) parts.push(`text=${coarseColorName(look.fontRgb.r, look.fontRgb.g, look.fontRgb.b)}`);
  if (look.fillRgb !== null) parts.push(`fill=${coarseColorName(look.fillRgb.r, look.fillRgb.g, look.fillRgb.b)}`);
  return parts.length === 0 ? null : parts.join(', ');
}

/** The same inspection as inline CSS for the viewer's table cells; null when
 * the cell is unformatted. Values are self-generated or sanitized — safe to
 * embed without further escaping. */
export function cssStyle(cell: ExcelJS.Cell, resolveColor: ColorResolver): string | null {
  const look = getLook(cell, resolveColor, null);
  const parts: string[] = [];
  if (look.bold) parts.push('font-weight:600');
  if (look.italic) parts.push('font-style:italic');
  if (look.underline || look.strikethrough) {
    const deco =
      look.underline && look.strikethrough
        ? 'underline line-through'
        : look.underline
          ? 'underline'
          : 'line-through';
    parts.push(`text-decoration:${deco}`);
  }
  if (look.fontName !== null) parts.push(`font-family:'${safeFontName(look.fontName)}'`);
  if (look.fontSize !== null) parts.push(`font-size:${fmt1(look.fontSize)}pt`);
  if (look.align !== null && look.align !== 'general') parts.push(`text-align:${look.align}`);
  if (look.fontRgb !== null) parts.push(`color:${hex(look.fontRgb)}`);
  if (look.fillRgb !== null) parts.push(`background-color:${hex(look.fillRgb)}`);
  return parts.length === 0 ? null : parts.join(';');
}

function hex(c: Rgb): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** Font names come from the file — keep only characters safe inside a quoted
 * CSS value. */
function safeFontName(name: string): string {
  return [...name].filter((ch) => /[A-Za-z0-9 _-]/.test(ch)).join('');
}

/** Everything visual we report about one cell, defaults/baseline filtered out. */
type CellLook = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  fontName: string | null;
  fontSize: number | null;
  align: string | null;
  fontRgb: Rgb | null;
  fillRgb: Rgb | null;
};

function getLook(
  cell: ExcelJS.Cell,
  resolveColor: ColorResolver,
  baseline: CellStyleBaseline | null,
): CellLook {
  const font = (cell.font ?? {}) as Partial<ExcelJS.Font>;

  // Font family/size/alignment report deviations from the column baseline
  // (or the workbook default when none) — uniform columns stay quiet.
  const baseName = baseline?.fontName ?? WORKBOOK_DEFAULT_FONT_NAME;
  const baseSize = baseline?.fontSize ?? WORKBOOK_DEFAULT_FONT_SIZE;
  const baseAlign = baseline?.alignment ?? 'general';

  const cellName = font.name ?? WORKBOOK_DEFAULT_FONT_NAME;
  const cellSize = font.size ?? WORKBOOK_DEFAULT_FONT_SIZE;
  const cellAlign = alignName(cell.alignment?.horizontal);

  const fontName = cellName.toLowerCase() !== baseName.toLowerCase() ? cellName : null;
  const fontSize = Math.abs(cellSize - baseSize) > 0.01 ? cellSize : null;
  const align = cellAlign !== baseAlign ? cellAlign : null;

  // Font color: report only when it resolves AND isn't the near-black
  // default. White text on a dark banner IS reported.
  let fontRgb: Rgb | null = null;
  const resolvedFont = resolveColor(font.color as XlsxColor | undefined);
  if (resolvedFont && coarseColorName(resolvedFont.r, resolvedFont.g, resolvedFont.b) !== 'black') {
    fontRgb = resolvedFont;
  }

  // Fill: report only for an actual pattern fill that isn't near-white.
  // A black header fill IS reported (it pairs with white text above).
  let fillRgb: Rgb | null = null;
  const fill = cell.fill as ExcelJS.Fill | undefined;
  if (fill && fill.type === 'pattern' && fill.pattern !== 'none') {
    const resolvedFill = resolveColor((fill.fgColor ?? fill.bgColor) as XlsxColor | undefined);
    if (resolvedFill && coarseColorName(resolvedFill.r, resolvedFill.g, resolvedFill.b) !== 'white') {
      fillRgb = resolvedFill;
    }
  }

  const underline = font.underline !== undefined && font.underline !== false && font.underline !== 'none';

  return {
    bold: font.bold === true,
    italic: font.italic === true,
    underline,
    strikethrough: font.strike === true,
    fontName,
    fontSize,
    align,
    fontRgb,
    fillRgb,
  };
}

// ---------------------------------------------------------------- colors --

/** Excel's theme tint: positive blends toward white, negative toward black. */
export function applyTint(c: Rgb, tint: number): Rgb {
  if (tint === 0) return c;
  const blend = (channel: number) =>
    Math.trunc(
      Math.min(255, Math.max(0, tint > 0 ? channel + (255 - channel) * tint : channel * (1 + tint))),
    );
  return { r: blend(c.r), g: blend(c.g), b: blend(c.b) };
}

/** Legacy indexed palette (indices 0–63; 64/65 are system colors — treated as
 * unresolvable, matching the "skip what can't be resolved" rule). */
const INDEXED_PALETTE: Record<number, string> = {
  0: '000000', 1: 'FFFFFF', 2: 'FF0000', 3: '00FF00', 4: '0000FF', 5: 'FFFF00', 6: 'FF00FF', 7: '00FFFF',
  8: '000000', 9: 'FFFFFF', 10: 'FF0000', 11: '00FF00', 12: '0000FF', 13: 'FFFF00', 14: 'FF00FF', 15: '00FFFF',
  16: '800000', 17: '008000', 18: '000080', 19: '808000', 20: '800080', 21: '008080', 22: 'C0C0C0', 23: '808080',
  24: '9999FF', 25: '993366', 26: 'FFFFCC', 27: 'CCFFFF', 28: '660066', 29: 'FF8080', 30: '0066CC', 31: 'CCCCFF',
  32: '000080', 33: 'FF00FF', 34: 'FFFF00', 35: '00FFFF', 36: '800080', 37: '800000', 38: '008080', 39: '0000FF',
  40: '00CCFF', 41: 'CCFFFF', 42: 'CCFFCC', 43: 'FFFF99', 44: '99CCFF', 45: 'FF99CC', 46: 'CC99FF', 47: 'FFCC99',
  48: '3366FF', 49: '33CCCC', 50: '99CC00', 51: 'FFCC00', 52: 'FF9900', 53: 'FF6600', 54: '666699', 55: '969696',
  56: '003366', 57: '339966', 58: '003300', 59: '333300', 60: '993300', 61: '993366', 62: '333399', 63: '333333',
};

/** Standard Office theme palette in xlsx `theme` attribute order
 * (0=lt1, 1=dk1, 2=lt2, 3=dk2, 4..9=accent1..6, 10=hlink, 11=folHlink —
 * Excel swaps 0↔1 and 2↔3 relative to the clrScheme XML order). Fallback for
 * workbooks whose theme XML is unavailable. */
const DEFAULT_THEME_PALETTE: string[] = [
  'FFFFFF', '000000', 'EEECE1', '1F497D',
  '4F81BD', 'C0504D', '9BBB59', '8064A2', '4BACC6', 'F79646',
  '0000FF', '800080',
];

function parseHex6(hex: string): Rgb | null {
  if (!/^[0-9A-Fa-f]{6}$/.test(hex)) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/** Extracts the 12-slot theme palette (xlsx `theme` index order) from a
 * workbook's theme1.xml, or null when it can't be read. */
function parseThemePalette(themeXml: string): string[] | null {
  const scheme = /<a:clrScheme[\s\S]*?<\/a:clrScheme>/.exec(themeXml)?.[0];
  if (!scheme) return null;
  const slot = (tag: string): string | null => {
    const inner = new RegExp(`<a:${tag}>([\\s\\S]*?)</a:${tag}>`).exec(scheme)?.[1];
    if (!inner) return null;
    const srgb = /<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/.exec(inner)?.[1];
    if (srgb) return srgb.toUpperCase();
    const last = /<a:sysClr\b[^>]*\blastClr="([0-9A-Fa-f]{6})"/.exec(inner)?.[1];
    if (last) return last.toUpperCase();
    const sys = /<a:sysClr\b[^>]*\bval="(\w+)"/.exec(inner)?.[1];
    if (sys === 'windowText') return '000000';
    if (sys === 'window') return 'FFFFFF';
    return null;
  };
  // clrScheme XML order → xlsx theme attribute order (0↔1 and 2↔3 swapped).
  const dk1 = slot('dk1');
  const lt1 = slot('lt1');
  const dk2 = slot('dk2');
  const lt2 = slot('lt2');
  const rest = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map(slot);
  const ordered = [lt1, dk1, lt2, dk2, ...rest];
  if (ordered.some((c) => c === null)) return null;
  return ordered as string[];
}

/** Builds a resolver for a workbook's colors: direct argb, the legacy indexed
 * palette, and theme slots with Excel's tint formula. Returns null (never
 * throws) for anything unresolvable. */
export function createColorResolver(workbook: ExcelJS.Workbook): ColorResolver {
  let palette = DEFAULT_THEME_PALETTE;
  try {
    // exceljs stores raw theme XML keyed by name (typings say string[]; the
    // runtime shape is an object).
    const themes = (workbook.model as unknown as { themes?: Record<string, string> }).themes;
    const parsed = themes?.theme1 ? parseThemePalette(themes.theme1) : null;
    if (parsed) palette = parsed;
  } catch {
    // formatting is garnish — never fail extraction over a theme parse
  }

  return (color: XlsxColor | undefined): Rgb | null => {
    if (!color) return null;
    try {
      if (typeof color.argb === 'string' && color.argb.length >= 6) {
        return parseHex6(color.argb.slice(-6));
      }
      if (typeof color.theme === 'number') {
        const base = palette[color.theme];
        if (!base) return null;
        const rgb = parseHex6(base);
        return rgb ? applyTint(rgb, color.tint ?? 0) : null;
      }
      if (typeof color.indexed === 'number') {
        const hex6 = INDEXED_PALETTE[color.indexed];
        return hex6 ? parseHex6(hex6) : null;
      }
      return null;
    } catch {
      return null;
    }
  };
}

/**
 * Buckets an RGB into the coarse name faculty instructions use ("green",
 * "red", …) via lightness → saturation → hue. Tuned so Excel's standard
 * conditional-format fills land where a human would put them (#C6EFCE →
 * green, #FFC7CE → red, #FFEB9C → yellow).
 */
export function coarseColorName(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2 / 255;
  if (lightness > 0.93) return 'white';
  if (lightness < 0.13) return 'black';

  const chroma = max - min;
  const saturation = chroma / (255 - Math.abs(max + min - 255));
  if (saturation < 0.15) return 'gray';

  // Hue in degrees (0–360), standard HSL derivation.
  let hue: number;
  if (max === r) hue = 60 * (((g - b) / chroma) % 6);
  else if (max === g) hue = 60 * ((b - r) / chroma + 2);
  else hue = 60 * ((r - g) / chroma + 4);
  if (hue < 0) hue += 360;

  if (hue < 15) return 'red';
  if (hue < 42) return 'orange';
  if (hue < 70) return 'yellow';
  if (hue < 165) return 'green';
  if (hue < 200) return 'teal';
  if (hue < 255) return 'blue';
  if (hue < 320) return 'purple'; // includes magenta-ish hues — HTML "purple" itself sits at 300°
  if (hue < 345) return 'pink';
  return 'red';
}
