// Apple Pages extraction: the IWA container (Snappy chunks + protobuf
// objects), storage-kind ordering, table strings, the nested Index.zip and
// Pages '09 layouts, and the faculty-facing failure messages. Fixtures are
// built here byte by byte so the reader is checked against the format, not
// against itself.

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  PAGES_NO_TEXT,
  PAGES_PASSWORD_PROTECTED,
  PAGES_UNREADABLE,
  extractPages,
  extractSubmissionText,
} from '../src/index.js';
import { snappyDecompress } from '../src/pages.js';
import { minimalPdf, utf8 } from './helpers.js';

// ------------------------------------------------------------ fixture bytes --

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

const vField = (num: number, value: number) => [...varint(num * 8), ...varint(value)];
const bField = (num: number, bytes: ArrayLike<number>) => [
  ...varint(num * 8 + 2),
  ...varint(bytes.length),
  ...Array.from(bytes),
];

/** TSWP.StorageArchive: kind = 1 (omitted ⇒ the TEXTBOX default), text = 3. */
function storage(kind: number | null, text: string): number[] {
  return [...(kind === null ? [] : vField(1, kind)), ...bField(3, utf8(text))];
}

/** TST.TableDataList: listType = 1, entries = 3 { key = 1, refcount = 2, string = 3 }. */
function stringList(entries: Array<[number, string]>): number[] {
  return [
    ...vField(1, 1),
    ...vField(2, entries.length + 1),
    ...entries.flatMap(([key, text]) => bField(3, [...vField(1, key), ...vField(2, 1), ...bField(3, utf8(text))])),
  ];
}

/** One ArchiveInfo (identifier + one MessageInfo) followed by its payload. */
function archive(objects: Array<{ type: number; payload: number[] }>): Uint8Array {
  const out: number[] = [];
  objects.forEach((o, i) => {
    const messageInfo = [...vField(1, o.type), ...bField(2, varint(1)), ...vField(3, o.payload.length)];
    const info = [...vField(1, i + 1), ...bField(2, messageInfo)];
    out.push(...varint(info.length), ...info, ...o.payload);
  });
  return Uint8Array.from(out);
}

/** Literal-only Snappy (valid, uncompressed) — the reader must accept it. */
function snappyLiteral(data: Uint8Array): number[] {
  const out = varint(data.length);
  for (let pos = 0; pos < data.length; pos += 65_536) {
    const part = data.subarray(pos, pos + 65_536);
    const n = part.length - 1;
    if (n < 60) out.push(n << 2);
    else if (n < 256) out.push(60 << 2, n);
    else out.push(61 << 2, n & 0xff, n >> 8);
    out.push(...part);
  }
  return out;
}

/** An .iwa file: one chunk (type 0 + 24-bit LE length) of Snappy data. */
function iwa(stream: Uint8Array): Uint8Array {
  const body = snappyLiteral(stream);
  return Uint8Array.from([0, body.length & 0xff, (body.length >> 8) & 0xff, body.length >> 16, ...body]);
}

async function zip(files: Record<string, Uint8Array | string>): Promise<Uint8Array> {
  const z = new JSZip();
  for (const [name, content] of Object.entries(files)) z.file(name, content);
  return z.generateAsync({ type: 'uint8array' });
}

async function pagesFile(objects: Array<{ type: number; payload: number[] }>, extra: Record<string, Uint8Array | string> = {}) {
  return zip({
    'Index/Document.iwa': iwa(archive(objects)),
    'Metadata/Properties.plist': '<plist/>',
    'preview.jpg': Uint8Array.from([0xff, 0xd8, 0xff]),
    ...extra,
  });
}

// -------------------------------------------------------------------- tests --

describe('snappyDecompress', () => {
  it('expands 1-byte-offset and 2-byte-offset copies, including overlapping ones', () => {
    // "abcd" literal, then copy(len 8, offset 4) as a 1-byte-offset element.
    expect(new TextDecoder().decode(snappyDecompress(Uint8Array.from([12, 0x0c, 97, 98, 99, 100, 0x11, 4])))).toBe(
      'abcdabcdabcd',
    );
    // Same, as a 2-byte-offset element.
    expect(
      new TextDecoder().decode(snappyDecompress(Uint8Array.from([12, 0x0c, 97, 98, 99, 100, 0x1e, 4, 0]))),
    ).toBe('abcdabcdabcd');
  });

  it('rejects a copy reaching before the start of the output', () => {
    expect(() => snappyDecompress(Uint8Array.from([8, 0x11, 4]))).toThrow(/Corrupt Snappy copy/);
  });
});

describe('extractPages', () => {
  it('reads header, body, and text boxes in reading order, cleaning iWork separators', async () => {
    const bytes = await pagesFile([
      { type: 2005, payload: storage(3, 'Figure caption') },
      { type: 2001, payload: storage(0, 'My Essay\u2029First paragraph.\uFFFC\u2028Second line.\u000CAfter the break.') },
      { type: 2001, payload: storage(1, 'Jane Student — ENG 101') },
      { type: 2001, payload: storage(7, 'Contents (skipped)') },
    ]);
    const result = await extractPages(bytes);
    expect(result.text).toBe(
      'Jane Student — ENG 101\n\nMy Essay\nFirst paragraph.\nSecond line.\nAfter the break.\n\nFigure caption',
    );
    expect(result.warnings).toEqual([]);
  });

  it('treats a storage without a kind as a text box and lists repeated ones once', async () => {
    const bytes = await pagesFile([
      { type: 2001, payload: storage(0, 'Body') },
      { type: 2001, payload: storage(null, 'Sidebar') },
      { type: 2001, payload: storage(null, 'Sidebar') },
    ]);
    expect((await extractPages(bytes)).text).toBe('Body\n\nSidebar');
  });

  it('lists plain table-cell strings (key order) with a layout warning', async () => {
    const bytes = await pagesFile([
      { type: 2001, payload: storage(0, 'Results below.') },
      { type: 6005, payload: stringList([[2, 'Trial 2'], [1, 'Trial 1']]) },
    ]);
    const result = await extractPages(bytes);
    expect(result.text).toBe('Results below.\n\n[Table text]\nTrial 1\nTrial 2');
    expect(result.warnings).toEqual([
      'Text from tables in this Pages document is listed without its row and column layout.',
    ]);
  });

  it('opens a package-format document zipped with an inner Index.zip', async () => {
    const inner = await zip({ 'Index/Document.iwa': iwa(archive([{ type: 2001, payload: storage(0, 'Nested body') }])) });
    const bytes = await zip({ 'Essay.pages/Index.zip': inner, 'Essay.pages/preview.jpg': Uint8Array.from([1]) });
    expect((await extractPages(bytes)).text).toBe('Nested body');
  });

  it('skips stylesheet archives', async () => {
    const bytes = await pagesFile([{ type: 2001, payload: storage(0, 'Real text') }], {
      'Index/DocumentStylesheet.iwa': iwa(archive([{ type: 2001, payload: storage(3, 'Style sample') }])),
    });
    expect((await extractPages(bytes)).text).toBe('Real text');
  });

  it('warns that embedded images were not read, and reports an image-only document', async () => {
    const bytes = await pagesFile([], { 'Data/photo-12.jpg': Uint8Array.from([0xff, 0xd8, 0xff]) });
    const result = await extractPages(bytes);
    expect(result.text).toBe('');
    expect(result.warnings[0]).toBe(PAGES_NO_TEXT);
    expect(result.warnings[1]).toMatch(/contains images/);
  });

  it('falls back to the QuickLook PDF in an older (Pages 2009) bundle', async () => {
    const bytes = await zip({ 'index.xml.gz': Uint8Array.from([1]), 'QuickLook/Preview.pdf': minimalPdf(['Old Pages text']) });
    expect((await extractPages(bytes)).text).toContain('Old Pages text');
  });

  it('explains password-protected and unreadable files', async () => {
    const locked = await zip({ '.iwph': 'hint', 'Index/Document.iwa': Uint8Array.from([9, 9, 9]) });
    await expect(extractPages(locked)).rejects.toThrow(PAGES_PASSWORD_PROTECTED);
    await expect(extractPages(utf8('not a zip'))).rejects.toThrow(PAGES_UNREADABLE);
    await expect(extractPages(await zip({ 'Index/Document.iwa': Uint8Array.from([7, 1, 0, 0, 0]) }))).rejects.toThrow(
      PAGES_UNREADABLE,
    );
  });
});

describe('extractSubmissionText — Pages', () => {
  it('dispatches by extension and by the Mac MIME type', async () => {
    const bytes = await pagesFile([{ type: 2001, payload: storage(0, 'Hello from Pages') }]);
    const byName = await extractSubmissionText('Essay.PAGES', bytes, { mime: 'application/zip' });
    expect(byName).toEqual({ text: 'Hello from Pages', warnings: [], kind: 'pages' });
    const byMime = await extractSubmissionText('upload', bytes, { mime: 'application/x-iwork-pages-sffpages' });
    expect(byMime.kind).toBe('pages');
  });
});
