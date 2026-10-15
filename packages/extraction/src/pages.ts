// Apple Pages (.pages) text extraction — students on Macs hand in Pages
// documents, and neither Canvas nor the model can read them as-is.
//
// A modern .pages file (Pages 5, 2013 and later) is a ZIP bundle whose
// Index/*.iwa files use Apple's "iWork Archive" format: Snappy-compressed
// chunks (no stream identifier, no CRCs) holding length-prefixed protobuf
// objects. Text lives in TSWP.StorageArchive objects (registry types 2001 and
// 2005): field 1 is the storage kind (body, header, text box, …) and field 3
// the text. Plain table-cell strings live in TST.TableDataList (6005) and
// TST.TableDataListSegment (6011) entries. A package-format document zipped
// for upload nests those files in an inner Index.zip. Older Pages '09 bundles
// carry a full QuickLook/Preview.pdf instead, which goes through the PDF
// extractor.
//
// Format references: github.com/obriensp/iWorkFileFormat (IWA framing,
// ArchiveInfo/MessageInfo) and github.com/masaccio/numbers-parser (type
// registry; TSWPArchives.proto / TSTArchives.proto field numbers).
//
// Pure JavaScript (jszip + the small Snappy/protobuf readers below) — no
// native modules.

import JSZip from 'jszip';

export type PagesExtractResult = {
  text: string;
  warnings: string[];
};

/** The one faculty-facing wording for a Pages file that can't be read. */
export const PAGES_UNREADABLE =
  'This Pages document could not be read. Ask the student to export it from Pages as a PDF or Word file (File > Export To) and resubmit.';

export const PAGES_PASSWORD_PROTECTED =
  'This Pages document is password-protected, so it cannot be read. Ask the student to remove the password (File > Set Password) or export it as a PDF or Word file and resubmit.';

export const PAGES_NO_TEXT =
  'This Pages document has no readable text (it may contain only images). Check the original file.';

export const PAGES_IMAGES_WARNING =
  'This Pages document contains images; they were not sent to the AI. Check the original file if they matter.';

export const PAGES_TABLE_WARNING =
  'Text from tables in this Pages document is listed without its row and column layout.';

// TSWP.StorageArchive.KindType
const KIND_BODY = 0;
const KIND_HEADER = 1; // headers and footers
const KIND_FOOTNOTE = 2;
const KIND_TEXTBOX = 3; // also the proto default when the field is absent
const KIND_NOTE = 4;
const KIND_CELL = 5;
const KIND_UNCLASSIFIED = 6;
const KIND_TOC = 7; // repeats the headings — skipped
const KIND_UNDEFINED = 8;

/** Reading order of the storage kinds in the extracted text. */
const KIND_ORDER = [
  KIND_HEADER,
  KIND_BODY,
  KIND_TEXTBOX,
  KIND_CELL,
  KIND_UNCLASSIFIED,
  KIND_UNDEFINED,
  KIND_FOOTNOTE,
  KIND_NOTE,
];

const TYPE_STORAGE = new Set([2001, 2005]);
const TYPE_TABLE_DATA_LIST = 6005;
const TYPE_TABLE_DATA_LIST_SEGMENT = 6011;
const TABLE_LIST_STRING = 1;

/** Ceiling on decompressed archive bytes per document (zip-bomb guard). */
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

/** Archive files that never hold the student's text. */
const SKIPPED_IWA = /(?:Stylesheet|Metadata|ViewState|CalculationEngine|AnnotationAuthorStorage)[^/]*\.iwa$/i;

const IMAGE_FILE = /\.(?:jpe?g|png|gif|heic|heif|tiff?|bmp|webp)$/i;

/**
 * Extracts a Pages document's text. Throws an Error carrying a faculty-facing
 * message (PAGES_UNREADABLE / PAGES_PASSWORD_PROTECTED) when the file can't
 * be opened; a readable document with no text returns '' plus PAGES_NO_TEXT.
 */
export async function extractPages(bytes: Uint8Array): Promise<PagesExtractResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    throw new Error(PAGES_UNREADABLE, { cause: err });
  }
  const names = Object.keys(zip.files).filter((name) => !zip.files[name]!.dir);

  // Password-protected bundles carry a hint/verifier file and AES-encrypted
  // archives.
  if (names.some((name) => /(?:^|\/)\.iwp/i.test(name))) {
    throw new Error(PAGES_PASSWORD_PROTECTED);
  }

  const warnings: string[] = [];
  if (names.some((name) => /(?:^|\/)Data\//.test(name) && IMAGE_FILE.test(name))) {
    warnings.push(PAGES_IMAGES_WARNING);
  }

  let index = zip;
  let indexNames = names;
  const nested = names.find((name) => /(?:^|\/)Index\.zip$/i.test(name));
  if (nested) {
    try {
      index = await JSZip.loadAsync(await zip.files[nested]!.async('uint8array'));
    } catch (err) {
      throw new Error(PAGES_UNREADABLE, { cause: err });
    }
    indexNames = Object.keys(index.files).filter((name) => !index.files[name]!.dir);
  }

  const isDocument = (name: string) => /(?:^|\/)Document\.iwa$/i.test(name);
  const iwaNames = indexNames
    .filter((name) => /(?:^|\/)Index\/.+\.iwa$/i.test(name) && !SKIPPED_IWA.test(name))
    // Document.iwa (the body) first, the rest in a stable order.
    .sort((a, b) => Number(isDocument(b)) - Number(isDocument(a)) || a.localeCompare(b));

  if (iwaNames.length === 0) {
    // Pages '09: no archives, but a full-fidelity PDF preview.
    const preview = names.find((name) => /(?:^|\/)QuickLook\/Preview\.pdf$/i.test(name));
    if (preview) {
      const { extractPdf } = await import('./pdf.js');
      const r = await extractPdf(await zip.files[preview]!.async('uint8array'));
      return { text: r.text, warnings: [...warnings, ...r.warnings] };
    }
    throw new Error(PAGES_UNREADABLE);
  }

  const collected = new Collector();
  let decompressed = 0;
  let readAny = false;
  for (const name of iwaNames) {
    try {
      const data = decodeIwa(await index.files[name]!.async('uint8array'), MAX_DECOMPRESSED_BYTES - decompressed);
      decompressed += data.length;
      readAny = true;
      for (const object of archiveObjects(data)) collected.add(object);
    } catch {
      // A damaged or unexpected archive: keep whatever the others yielded.
    }
  }
  if (!readAny) throw new Error(PAGES_UNREADABLE);

  const text = collected.text();
  if (collected.hasTableText) warnings.push(PAGES_TABLE_WARNING);
  if (text === '') return { text: '', warnings: [PAGES_NO_TEXT, ...warnings] };
  return { text, warnings };
}

// ------------------------------------------------------------- collection --

class Collector {
  private readonly storages = new Map<number, string[]>();
  private readonly tableStrings: Array<{ key: number; text: string }> = [];

  get hasTableText(): boolean {
    return this.tableStrings.length > 0;
  }

  add(object: { type: number; payload: Uint8Array }): void {
    try {
      if (TYPE_STORAGE.has(object.type)) this.addStorage(object.payload);
      else if (object.type === TYPE_TABLE_DATA_LIST || object.type === TYPE_TABLE_DATA_LIST_SEGMENT) {
        this.addTableList(object.payload);
      }
    } catch {
      // One malformed object never sinks the document.
    }
  }

  text(): string {
    const sections: string[] = [];
    const seen = new Set<string>();
    for (const kind of KIND_ORDER) {
      for (const text of this.storages.get(kind) ?? []) {
        // Repeated headers/footers and placeholder boxes appear once.
        if (kind !== KIND_BODY && seen.has(text)) continue;
        seen.add(text);
        sections.push(text);
      }
    }
    if (this.tableStrings.length > 0) {
      const cells = [...this.tableStrings].sort((a, b) => a.key - b.key).map((c) => c.text);
      sections.push(`[Table text]\n${cells.join('\n')}`);
    }
    return sections.join('\n\n');
  }

  private addStorage(payload: Uint8Array): void {
    let kind = KIND_TEXTBOX;
    const parts: string[] = [];
    for (const f of protoFields(payload)) {
      if (f.field === 1 && typeof f.value === 'number') kind = f.value;
      else if (f.field === 3 && f.value instanceof Uint8Array) parts.push(UTF8.decode(f.value));
    }
    if (kind === KIND_TOC) return;
    const text = cleanText(parts.join(''));
    if (text === '') return;
    const list = this.storages.get(kind) ?? [];
    list.push(text);
    this.storages.set(kind, list);
  }

  private addTableList(payload: Uint8Array): void {
    const fields = protoFields(payload);
    const listType = fields.find((f) => f.field === 1)?.value;
    if (listType !== TABLE_LIST_STRING) return;
    for (const f of fields) {
      if (f.field !== 3 || !(f.value instanceof Uint8Array)) continue;
      let key = 0;
      let text: string | null = null;
      for (const e of protoFields(f.value)) {
        if (e.field === 1 && typeof e.value === 'number') key = e.value;
        else if (e.field === 3 && e.value instanceof Uint8Array) text = cleanText(UTF8.decode(e.value));
      }
      if (text) this.tableStrings.push({ key, text });
    }
  }
}

const UTF8 = new TextDecoder('utf-8');

/** iWork text → plain text: paragraph/line separators become newlines;
 * attachment and smart-field placeholders (U+FFFC) drop out; page, column,
 * and section breaks (C0 controls) become paragraph breaks. */
function cleanText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/[\uFFFC\uFEFF]/g, '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// -------------------------------------------------------------- IWA format --

/** Decompresses an .iwa file's chunks into the raw object stream. */
export function decodeIwa(bytes: Uint8Array, maxBytes = MAX_DECOMPRESSED_BYTES): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  let pos = 0;
  while (pos < bytes.length) {
    if (pos + 4 > bytes.length) throw new Error('Truncated IWA chunk header.');
    const chunkType = bytes[pos]!;
    const length = bytes[pos + 1]! | (bytes[pos + 2]! << 8) | (bytes[pos + 3]! << 16);
    pos += 4;
    if (chunkType !== 0) throw new Error(`Unknown IWA chunk type ${chunkType}.`);
    if (pos + length > bytes.length) throw new Error('Truncated IWA chunk.');
    const data = snappyDecompress(bytes.subarray(pos, pos + length), maxBytes - total);
    pos += length;
    total += data.length;
    parts.push(data);
  }
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Walks the object stream: each ArchiveInfo (varint-length-prefixed) lists
 * MessageInfos (type + payload length); the payloads follow it in order. */
export function* archiveObjects(data: Uint8Array): Generator<{ type: number; payload: Uint8Array }> {
  let pos = 0;
  while (pos < data.length) {
    const [infoLength, start] = readVarint(data, pos);
    const end = start + infoLength;
    if (end > data.length) throw new Error('Truncated IWA ArchiveInfo.');
    const info = data.subarray(start, end);
    pos = end;
    for (const f of protoFields(info)) {
      if (f.field !== 2 || !(f.value instanceof Uint8Array)) continue; // message_infos
      let type = 0;
      let length = 0;
      for (const m of protoFields(f.value)) {
        if (m.field === 1 && typeof m.value === 'number') type = m.value;
        else if (m.field === 3 && typeof m.value === 'number') length = m.value;
      }
      if (pos + length > data.length) throw new Error('Truncated IWA object.');
      yield { type, payload: data.subarray(pos, pos + length) };
      pos += length;
    }
  }
}

/** Raw Snappy block decompression (the format inside each IWA chunk). */
export function snappyDecompress(src: Uint8Array, maxBytes = MAX_DECOMPRESSED_BYTES): Uint8Array {
  const [length, start] = readVarint(src, 0);
  if (length > maxBytes) throw new Error('Snappy block exceeds the size limit.');
  const out = new Uint8Array(length);
  let pos = start;
  let o = 0;
  const need = (n: number) => {
    if (pos + n > src.length) throw new Error('Truncated Snappy block.');
  };
  while (pos < src.length) {
    const tag = src[pos++]!;
    const elementType = tag & 3;
    if (elementType === 0) {
      // Literal: length-1 in the tag, or in the next 1–4 bytes (tag 60–63).
      let len = tag >>> 2;
      if (len >= 60) {
        const extra = len - 59;
        need(extra);
        len = 0;
        for (let i = 0; i < extra; i++) len += src[pos + i]! * 2 ** (8 * i);
        pos += extra;
      }
      len += 1;
      need(len);
      if (o + len > out.length) throw new Error('Snappy literal overruns the block.');
      out.set(src.subarray(pos, pos + len), o);
      pos += len;
      o += len;
      continue;
    }
    let len: number;
    let offset: number;
    if (elementType === 1) {
      need(1);
      len = ((tag >>> 2) & 7) + 4;
      offset = ((tag >>> 5) << 8) | src[pos++]!;
    } else if (elementType === 2) {
      need(2);
      len = (tag >>> 2) + 1;
      offset = src[pos]! | (src[pos + 1]! << 8);
      pos += 2;
    } else {
      need(4);
      len = (tag >>> 2) + 1;
      offset = (src[pos]! | (src[pos + 1]! << 8) | (src[pos + 2]! << 16)) + src[pos + 3]! * 2 ** 24;
      pos += 4;
    }
    if (offset === 0 || offset > o || o + len > out.length) throw new Error('Corrupt Snappy copy.');
    // Byte by byte: a copy may overlap the bytes it is producing.
    for (let i = 0; i < len; i++) out[o + i] = out[o + i - offset]!;
    o += len;
  }
  if (o !== out.length) throw new Error('Snappy block length mismatch.');
  return out;
}

// ---------------------------------------------------------------- protobuf --

type ProtoField = { field: number; value: number | Uint8Array };

/** Decodes one protobuf message's top-level fields (varints as numbers,
 * length-delimited fields as byte views; fixed-width fields skipped). */
function protoFields(msg: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let pos = 0;
  while (pos < msg.length) {
    const [key, afterKey] = readVarint(msg, pos);
    pos = afterKey;
    const field = Math.floor(key / 8);
    const wireType = key % 8;
    if (wireType === 0) {
      const [value, next] = readVarint(msg, pos);
      out.push({ field, value });
      pos = next;
    } else if (wireType === 2) {
      const [length, start] = readVarint(msg, pos);
      const end = start + length;
      if (end > msg.length) throw new Error('Truncated protobuf field.');
      out.push({ field, value: msg.subarray(start, end) });
      pos = end;
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}.`);
    }
    if (pos > msg.length) throw new Error('Truncated protobuf field.');
  }
  return out;
}

/** Base-128 varint → [value, next position] (exact up to 2^53). */
function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let scale = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new Error('Truncated varint.');
    const byte = buf[pos++]!;
    result += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return [result, pos];
    scale *= 128;
  }
  throw new Error('Varint too long.');
}
