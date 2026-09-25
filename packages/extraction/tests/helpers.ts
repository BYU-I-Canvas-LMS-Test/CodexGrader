// In-memory test-file builders so extraction/page-counting tests need no
// binary fixtures checked into the repo: a minimal-but-valid DOCX (zip +
// OOXML skeleton mammoth accepts), hand-crafted PDFs with correct xrefs
// (blank pages = what a scanned upload looks like to pdfjs; optional
// Helvetica text pages for the positive path), bare PPTX zips for the slide
// counters, and exceljs-built workbooks round-tripped through the real file
// format.
//
// Ported from: C:\Devs\AIGrader-C#\tests\AiGrader.Tests\TestFiles.cs
// (ZipArchive → jszip, ClosedXML → exceljs, parametric page counts added for
// the pages API).

import ExcelJS from 'exceljs';
import JSZip from 'jszip';

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** A minimal valid DOCX containing the given paragraphs. `pagesProp` adds a
 * docProps/app.xml with that <Pages> value (Office writes it; hand-built
 * files may omit it). */
export async function minimalDocx(
  paragraphs: string[],
  opts: { pagesProp?: number } = {},
): Promise<Uint8Array> {
  const hasApp = opts.pagesProp !== undefined;
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${
    hasApp
      ? '\n  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
      : ''
  }
</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${escapeXml(p)}</w:t></w:r></w:p>`).join('')}</w:body>
</w:document>`,
  );
  if (hasApp) {
    zip.file(
      'docProps/app.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Pages>${opts.pagesProp}</Pages><Words>1</Words></Properties>`,
    );
  }
  return zip.generateAsync({ type: 'uint8array' });
}

/** A valid PDF with one page per entry and a correct xref — offsets computed
 * at build time (pure ASCII, so char index == byte offset). A null entry is a
 * page with NO content stream: what a scanned upload looks like to pdfjs —
 * a page, but zero extractable words. A string entry draws that text in
 * Helvetica so the text layer is real. */
export function minimalPdf(pageTexts: Array<string | null>): Uint8Array {
  const hasText = pageTexts.some((t) => t !== null);
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  const obj = (content: string) => {
    offsets.push(body.length);
    body += content;
  };

  const fontNum = hasText ? 3 : 0;
  let next = hasText ? 4 : 3;
  const pageNums: number[] = [];
  const contentNums: Array<number | null> = [];
  for (const t of pageTexts) {
    pageNums.push(next++);
    contentNums.push(t !== null ? next++ : null);
  }

  obj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  obj(
    `2 0 obj\n<< /Type /Pages /Kids [${pageNums.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageTexts.length} >>\nendobj\n`,
  );
  if (hasText) obj(`${fontNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  pageTexts.forEach((t, i) => {
    const extras =
      t !== null
        ? ` /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNums[i]} 0 R`
        : '';
    obj(`${pageNums[i]} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${extras} >>\nendobj\n`);
    if (t !== null) {
      const stream = `BT /F1 12 Tf 72 720 Td (${t.replace(/([\\()])/g, '\\$1')}) Tj ET`;
      obj(`${contentNums[i]} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
    }
  });

  const xrefPos = body.length;
  const size = offsets.length + 1;
  body += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return new TextEncoder().encode(body);
}

/** An XLSX built by the given fill action (first sheet named "S1") and saved
 * through the real file format — styles/facts must survive save/load, because
 * that's what students actually submit. */
export async function xlsxBytes(
  fill: (sheet: ExcelJS.Worksheet, wb: ExcelJS.Workbook) => void,
): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('S1');
  fill(sheet, wb);
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as unknown as ArrayBuffer);
}
