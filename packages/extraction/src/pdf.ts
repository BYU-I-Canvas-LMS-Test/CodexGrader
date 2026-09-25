// PDF text layer via pdfjs (legacy build runs headless in Node; no worker —
// pdfjs falls back to its in-process fake worker automatically). Scanned PDFs
// with no text layer return empty text + a warning — those need the vision
// path (future milestone).
//
// Ported from: C:\Devs\AIgrader\lib\extract\index.ts (extractPdfBuffer);
// warning string pinned to C:\Devs\AIGrader-C#\src\AiGrader\Services\
// Extraction\SubmissionTextExtractor.cs (ExtractPdf) — it appears in graded
// output.

export type PdfExtractResult = {
  text: string;
  warnings: string[];
};

/** Exact user-facing string for text-layer-free PDFs (parity contract). */
export const SCANNED_PDF_WARNING =
  'No extractable text — the PDF appears to be scanned (needs vision).';

export async function extractPdf(bytes: Uint8Array): Promise<PdfExtractResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Fresh copy: pdfjs wants a plain Uint8Array (not a Buffer) and may detach
  // the underlying ArrayBuffer when handing it to its (fake) worker.
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  try {
    const parts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      parts.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
    }
    const text = parts.join('\n\n').replace(/[ \t]{2,}/g, ' ').trim();
    return {
      text,
      warnings: text ? [] : [SCANNED_PDF_WARNING],
    };
  } finally {
    await doc.destroy();
  }
}
