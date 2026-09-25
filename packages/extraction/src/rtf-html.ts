// RTF → sanitized HTML for the submission viewer's converter seam.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Viewing\Converters\RtfPreviewConverter.cs
// — but where the C# app leaned on RtfPipe (a managed library), no
// well-maintained pure-JS RTF parser exists without native deps, so this
// module implements the RtfPipe SUBSET the viewer needs directly:
// paragraphs/line breaks, bold/italic/underline/strikethrough, tabs, hex
// (\'hh cp1252) and unicode (\uN with \uc fallback skipping) escapes, and
// destination groups (font/color/style tables, pictures, metadata) skipped
// wholesale. Exotic RTF (tables, embedded objects) degrades to its text —
// the same "simplified but safe" trade-off as the mammoth DOCX fallback; the
// Download link always has the original.
//
// The output flows through the canonical allowlist sanitizer like every
// other rendered-HTML path. Pinned by tests/rtf-html.test.ts (the RTF part
// of PreviewConverterTests).

import { Buffer } from 'node:buffer';
import { previewFileExtension } from '@aigrader/shared/preview';
import { sanitizeHtml } from './sanitize-html.js';

/** The standing notice every RTF conversion carries (parity with the C#
 * converter's warning — pinned by test). */
export const RTF_APPROXIMATE_WARNING =
  'Converted preview — formatting is approximate. Use Download for the original.';

/** True when this converter claims the file (checked BEFORE any bytes are
 * downloaded, so refuse cheaply). Port of RtfPreviewConverter.CanConvert. */
export function isRtfAttachment(
  contentType: string | null | undefined,
  filename: string | null | undefined,
): boolean {
  if (previewFileExtension(filename) === '.rtf') return true;
  const mime = (contentType ?? '').toLowerCase();
  return mime === 'application/rtf' || mime === 'text/rtf';
}

export type RtfHtmlResult = {
  /** Sanitized HTML, or null when the file produced nothing previewable
   * (decline → download card). */
  html: string | null;
  warnings: string[];
  error: string | null;
};

/** RTF bytes → sanitized HTML (subset: text + basic formatting). */
export function convertRtfHtml(bytes: Uint8Array): RtfHtmlResult {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // RTF is 7-bit ASCII with escapes; latin1 keeps raw bytes intact for \'hh.
  const src = buffer.toString('latin1');
  const html = sanitizeHtml(rtfToHtml(src));
  if (html.trim() === '') return { html: null, warnings: [], error: null };
  return { html, warnings: [RTF_APPROXIMATE_WARNING], error: null };
}

// ------------------------------------------------------------------- parser --

type Style = { bold: boolean; italic: boolean; underline: boolean; strike: boolean };

type GroupState = Style & {
  /** Inside a destination group whose content is data, not prose. */
  skip: boolean;
  /** \ucN — ANSI fallback chars to skip after each \uN. */
  uc: number;
};

/** One formatted run of text within a paragraph. */
type Run = Style & { text: string };

/** Destinations whose entire group content is data/chrome, never prose. */
const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header',
  'footer', 'headerl', 'headerr', 'headerf', 'footerl', 'footerr', 'footerf',
  'themedata', 'colorschememapping', 'filetbl', 'listtable',
  'listoverridetable', 'revtbl', 'generator', 'xmlnstbl', 'fldinst',
  'datastore', 'latentstyles', 'pgptbl', 'rsidtbl',
]);

/** Windows-1252 codepoints for the 0x80–0x9F range (latin1 maps them to C1
 * controls; RTF from Word uses cp1252 smart quotes/dashes there). */
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderRun(run: Run): string {
  let out = escapeHtml(run.text);
  if (run.strike) out = `<s>${out}</s>`;
  if (run.underline) out = `<u>${out}</u>`;
  if (run.italic) out = `<em>${out}</em>`;
  if (run.bold) out = `<strong>${out}</strong>`;
  return out;
}

/** Parses an RTF document body to simple paragraph HTML (unsanitized — the
 * caller sanitizes). Exposed for tests. */
export function rtfToHtml(src: string): string {
  const paragraphs: Run[][] = [];
  let current: Run[] = [];

  const stack: GroupState[] = [];
  let state: GroupState = { bold: false, italic: false, underline: false, strike: false, skip: false, uc: 1 };
  /** Pending ANSI fallback chars to swallow after a \uN escape. */
  let ucPending = 0;

  const append = (text: string): void => {
    if (state.skip || text.length === 0) return;
    if (ucPending > 0) {
      const eat = Math.min(ucPending, text.length);
      ucPending -= eat;
      text = text.slice(eat);
      if (text.length === 0) return;
    }
    const last = current[current.length - 1];
    if (
      last &&
      last.bold === state.bold &&
      last.italic === state.italic &&
      last.underline === state.underline &&
      last.strike === state.strike
    ) {
      last.text += text;
    } else {
      current.push({
        text,
        bold: state.bold,
        italic: state.italic,
        underline: state.underline,
        strike: state.strike,
      });
    }
  };

  const endParagraph = (): void => {
    paragraphs.push(current);
    current = [];
  };

  let i = 0;
  /** True immediately after a '{' — where a destination control word names
   * the whole group (possibly behind the \* marker). */
  let groupStart = false;

  while (i < src.length) {
    const ch = src[i]!;

    if (ch === '{') {
      stack.push(state);
      state = { ...state };
      groupStart = true;
      i++;
      continue;
    }
    if (ch === '}') {
      const prev = stack.pop();
      if (prev) state = prev;
      groupStart = false;
      i++;
      continue;
    }
    if (ch === '\\') {
      const next = src[i + 1];
      if (next === undefined) break;

      // Control symbols (single non-alpha character).
      if (!/[a-zA-Z]/.test(next)) {
        if (next === '\\' || next === '{' || next === '}') append(next);
        else if (next === '~') append('\u00a0');
        else if (next === '_') append('\u2011');
        else if (next === '*') {
          // \* marks an (often unknown) destination; skip the group unless a
          // known-prose destination follows (none in our subset).
          if (groupStart) state.skip = true;
        } else if (next === "'") {
          const hex = src.slice(i + 2, i + 4);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            const code = parseInt(hex, 16);
            append(String.fromCodePoint(CP1252_HIGH[code] ?? code));
            i += 4;
            groupStart = false;
            continue;
          }
        }
        // \- (optional hyphen) and anything else: no output.
        i += 2;
        groupStart = next === '*' ? groupStart : false;
        continue;
      }

      // Control word: letters + optional signed number + optional space delimiter.
      const m = /^([a-zA-Z]+)(-?\d+)?( ?)/.exec(src.slice(i + 1));
      if (!m) {
        i++;
        continue;
      }
      const word = m[1]!;
      const param = m[2] !== undefined ? parseInt(m[2], 10) : null;
      i += 1 + m[0].length;

      if (groupStart && SKIP_DESTINATIONS.has(word)) {
        state.skip = true;
      }
      groupStart = false;

      switch (word) {
        case 'par':
        case 'sect':
        case 'page':
          if (!state.skip) endParagraph();
          break;
        case 'line':
          append('\n');
          break;
        case 'tab':
          append('\t');
          break;
        case 'b':
          state.bold = param !== 0;
          break;
        case 'i':
          state.italic = param !== 0;
          break;
        case 'ul':
          state.underline = param !== 0;
          break;
        case 'ulnone':
          state.underline = false;
          break;
        case 'strike':
          state.strike = param !== 0;
          break;
        case 'plain':
          state.bold = state.italic = state.underline = state.strike = false;
          break;
        case 'uc':
          state.uc = param ?? 1;
          break;
        case 'u': {
          if (param !== null && !state.skip) {
            const code = param < 0 ? param + 65536 : param;
            append(String.fromCodePoint(code));
            ucPending += state.uc;
          }
          break;
        }
        case 'emdash': append('\u2014'); break;
        case 'endash': append('\u2013'); break;
        case 'bullet': append('\u2022'); break;
        case 'lquote': append('\u2018'); break;
        case 'rquote': append('\u2019'); break;
        case 'ldblquote': append('\u201c'); break;
        case 'rdblquote': append('\u201d'); break;
        default:
          break; // every other control word (fonts, colors, margins…) is ignored
      }
      continue;
    }

    // Plain text run up to the next syntax character. Raw CR/LF in RTF source
    // are formatting of the FILE, not the document — ignored.
    let j = i;
    while (j < src.length && src[j] !== '\\' && src[j] !== '{' && src[j] !== '}') j++;
    append(src.slice(i, j).replace(/[\r\n]+/g, ''));
    groupStart = false;
    i = j;
  }

  if (current.length > 0) endParagraph();

  return paragraphs
    .map((runs) => runs.map(renderRun).join(''))
    .filter((p) => p.trim() !== '')
    .map((p) => `<p>${p}</p>`)
    .join('');
}
