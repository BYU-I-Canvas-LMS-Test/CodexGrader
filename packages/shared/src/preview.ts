// Canonical file-type lists + preview classification for the submission
// viewer (M5). This module is SHARED-SAFE: zero dependencies, no Node APIs —
// it is bundled into the web CLIENT (via the '@aigrader/shared/preview' subpath
// export) as well as the engine, so the viewer, the file-streaming proxy, and
// the grading engine all classify with the identical lists and can never
// disagree about a file.
//
// Ported from:
//   C:\Devs\AIGrader-C#\src\AiGrader\Services\Viewing\SubmissionPreviewService.cs
//     (ClassifyCore / SafeInlineContentType / IsCsvLike / CsvDelimiterFor)
//   C:\Devs\AIGrader-C#\src\AiGrader\Services\Extraction\SubmissionTextExtractor.cs
//     (TextAndCodeExtensions)
//   C:\Devs\AIGrader-C#\src\AiGrader\Services\Grading\SubmissionAssembly.cs
//     (ImageMediaTypesByExtension / ImageMediaTypes / IsImage)
//
// The extension lists used to live in @aigrader/extraction (extensions.ts) and
// the grading engine (vision-routing.ts); both now re-export from here so the
// single source of truth is this file. Behavior pinned by
// apps/web/tests/classify.test.ts (the PreviewClassificationTests port).

// ---------------------------------------------------------------- extensions --

// Extensions decoded as UTF-8 text: plain-text/markup formats plus common
// source-code languages. Canvas frequently serves code files as
// application/octet-stream, so dispatch keys off the extension (and any
// text/* mime) rather than trusting the content type. Binary formats
// (docx/xlsx/pdf) are handled by dedicated extractors and intentionally
// excluded here.
export const TEXT_AND_CODE_EXTENSIONS: ReadonlySet<string> = new Set<string>([
  // plain text / markup / config
  '.txt', '.md', '.markdown', '.rst', '.tex', '.log',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.json', '.jsonc', '.xml', '.yaml', '.yml', '.toml', '.ini', '.env', '.csv', '.tsv',
  // source code
  '.py', '.ipynb', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  '.java', '.kt', '.kts', '.scala', '.groovy',
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.cs',
  '.go', '.rs', '.rb', '.php', '.swift', '.m', '.mm',
  '.sql', '.r', '.jl', '.pl', '.pm', '.lua', '.dart', '.vue', '.svelte',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.asm', '.s', '.vb', '.fs', '.clj', '.ex', '.exs', '.erl', '.hs', '.ml',
]);

// Image formats billed at one page each (plan §Metering) and fed to the
// multimodal grading path — also the viewer's <img> kinds.
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set<string>([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
]);

/** Image types the vision model accepts, by lowercase file extension. */
export const IMAGE_MEDIA_TYPES_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

/**
 * The accepted image MIME types (lowercase), derived from
 * IMAGE_MEDIA_TYPES_BY_EXTENSION so the extension and MIME routes can never
 * drift apart. MIME matching is case-insensitive (C# OrdinalIgnoreCase).
 */
export const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(
  IMAGE_MEDIA_TYPES_BY_EXTENSION.values(),
);

/**
 * Lowercased extension (including the dot) of a filename, matching .NET's
 * Path.GetExtension semantics: last dot of the last path segment; empty when
 * there is no dot or the dot is the final character.
 */
export function previewFileExtension(filename: string | null | undefined): string {
  const base = (filename ?? '').replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) return '';
  return base.slice(dot).toLowerCase();
}

/**
 * True when an attachment should be treated as an image (vision grading path
 * AND the viewer's Image kind). Port of GraderAgent.IsImageAttachment /
 * SubmissionAssembly.IsImage.
 */
export function isImageAttachment(
  mime: string | null | undefined,
  filename: string | null | undefined,
): boolean {
  if (mime != null && IMAGE_MEDIA_TYPES.has(mime.toLowerCase())) return true;
  return IMAGE_MEDIA_TYPES_BY_EXTENSION.has(previewFileExtension(filename));
}

// ------------------------------------------------------------ classification --

/** How the viewer should render one attachment (C# PreviewKind). */
export type PreviewKind =
  /** Browser-native PDF viewer via a same-origin iframe. */
  | 'pdf'
  /** <img> / pan-zoom stage pointing at the streaming endpoint. */
  | 'image'
  /** DOCX: client page-faithful render, or server-converted sanitized HTML. */
  | 'rich-html'
  /** Excel-like grid (XLSX/CSV/TSV), row-capped. */
  | 'table'
  /** Escaped monospace text (txt/markdown/source code; .html shows as SOURCE). */
  | 'text'
  /** PowerPoint deck rendered client-side (best-effort fidelity). */
  | 'slides'
  /** No in-app rendering — download card (or a registered converter, e.g. RTF). */
  | 'unsupported';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** True when the file is CSV/TSV — rendered as a single pseudo-sheet with no
 * workbook to open. The single owner of "what is CSV-like": both the Table
 * classification branch and the sheet renderers call this, so classification
 * can never promise a renderer that disagrees. (C# IsCsvLike.) */
export function isCsvLike(contentType: string | null | undefined, filename: string | null | undefined): boolean {
  const ext = previewFileExtension(filename);
  return ext === '.csv' || ext === '.tsv' || (contentType ?? '').toLowerCase() === 'text/csv';
}

/** The CSV parser delimiter for a CSV-like file (tab for .tsv). */
export function csvDelimiterFor(filename: string | null | undefined): string {
  return previewFileExtension(filename) === '.tsv' ? '\t' : ',';
}

/**
 * Classifies by extension FIRST, MIME second (Canvas often claims
 * octet-stream). Port of SubmissionPreviewService.ClassifyCore — the ordering
 * of the branches is load-bearing:
 *   - .html/.htm classify as 'text' (escaped SOURCE, never renderable HTML);
 *   - legacy .xls/.rtf go 'unsupported' so the converter seam / download card
 *     takes them, never a renderer guaranteed to throw "corrupt";
 *   - application/vnd.ms-excel is ALSO what Windows/Canvas report for .csv
 *     uploads — with .xls excluded above, it is treated as tabular.
 */
export function classifyPreview(
  contentType: string | null | undefined,
  filename: string | null | undefined,
): PreviewKind {
  const mime = (contentType ?? '').toLowerCase();
  const ext = previewFileExtension(filename);

  if (isImageAttachment(contentType, filename)) return 'image';
  if (ext === '.pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === '.docx' || mime === DOCX_MIME) return 'rich-html';
  if (ext === '.pptx' || mime === PPTX_MIME) return 'slides';
  if (ext === '.xls' || ext === '.rtf' || mime === 'application/rtf' || mime === 'text/rtf') {
    return 'unsupported';
  }
  if (ext === '.xlsx' || ext === '.xlsm' || mime.includes('spreadsheetml')) return 'table';
  if (isCsvLike(contentType, filename) || mime === 'application/vnd.ms-excel') return 'table';
  if (TEXT_AND_CODE_EXTENSIONS.has(ext) || mime.startsWith('text/')) return 'text';
  return 'unsupported';
}

// ----------------------------------------------------- inline streaming policy --

/** Inline preview size cap (streaming + conversion) — 50 MB. */
export const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;

/** The complete inline content-type ALLOWLIST the streaming proxy may emit:
 * application/pdf plus the four image types. Everything else must stream as
 * application/octet-stream + attachment disposition + nosniff. */
export const INLINE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  ...IMAGE_MEDIA_TYPES,
]);

/**
 * The content type a streamed file may carry. Inline allowlist only — PDF and
 * the four image types, decided by OUR classification (never Canvas's claimed
 * type). Everything else streams as octet-stream so the browser can never
 * interpret student uploads (e.g. .html) as active content.
 * Port of SubmissionPreviewService.SafeInlineContentType.
 */
export function safeInlineContentType(
  contentType: string | null | undefined,
  filename: string | null | undefined,
): string {
  switch (classifyPreview(contentType, filename)) {
    case 'pdf':
      return 'application/pdf';
    case 'image': {
      const byExt = IMAGE_MEDIA_TYPES_BY_EXTENSION.get(previewFileExtension(filename));
      if (byExt) return byExt;
      // Same canonical MIME set the grading gate uses — one list, no drift.
      const mime = (contentType ?? '').toLowerCase();
      return IMAGE_MEDIA_TYPES.has(mime) ? mime : 'application/octet-stream';
    }
    default:
      return 'application/octet-stream';
  }
}
