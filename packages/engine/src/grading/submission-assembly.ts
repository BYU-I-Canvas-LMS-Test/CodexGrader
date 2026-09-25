// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Grading\SubmissionAssembly.cs
//
// Multi-file submission assembly: turns ALL attachments of one submission into
// a single gradable payload — document texts as labeled per-file sections and
// images as vision parts, mixed freely. Two routes intentionally reproduce the
// pre-multi-file strings byte for byte so faculty calibration (and the prompt
// golden tests) hold: a single non-image attachment yields the raw extracted
// text with no header, and an all-image submission yields the original
// aggregate placeholder. Only submissions with 2+ files including a non-image
// produce the labeled-section format.
//
// PORT DELTA vs the C# original: the C# version took download/extract
// delegates and performed the I/O itself. Here downloads and extraction have
// already happened upstream (the engine owns them), so assembly consumes
// plain per-file results. Transient failures (downloads) therefore throw
// UPSTREAM before assembly is reached; deterministic extraction failures
// arrive as `error` on the input and keep the C# semantics below (hard error
// for a single file, inline "[This file could not be read: …]" note in a
// multi-file submission). Do NOT import @aigrader/extraction here — the input
// type is deliberately structural.

import { IMAGE_MEDIA_TYPES_BY_EXTENSION, fileExtension, isImageAttachment } from './vision-routing.js';

/**
 * Combined text cap for multi-file submissions (~100k tokens). Applied only
 * when 2+ files produce labeled sections — single-file submissions stay
 * uncapped to preserve pre-multi-file behavior exactly.
 */
export const MAX_COMBINED_TEXT_CHARS = 400_000;

/** One attachment's extraction result, in Canvas (upload) order. */
export type SubmissionFileInput = {
  filename: string | null;
  /** The Canvas-reported content type (may be generic, e.g. octet-stream). */
  mediaType?: string | null;
  /** Extracted plain text (document files). */
  text?: string | null;
  /** Raw bytes (image files — ride as vision parts). */
  imageBytes?: Uint8Array | null;
  /**
   * Deterministic extraction-failure reason (unsupported format, corrupt
   * file, scanned PDF's first extractor warning). Re-running would fail
   * identically, so it is noted rather than retried.
   */
  error?: string | null;
};

/** An image shown to the model alongside the grading prompt (vision path). */
export type VisionImagePart = {
  bytes: Uint8Array;
  /** image/png, image/jpeg, image/gif, or image/webp. */
  mediaType: string;
};

/** One submission's attachments assembled for grading. */
export type AssembledSubmission = {
  /**
   * The STUDENT SUBMISSION prompt section: raw extracted text (single file),
   * the aggregate image placeholder (all-image), or labeled per-file sections
   * (multi-file).
   */
  text: string;
  /**
   * Filename of the first .xlsx/.xlsm attachment, kept for the deterministic
   * Excel key comparison (the engine holds the bytes); null when none was
   * submitted or the Excel file was unreadable.
   */
  excelFilename: string | null;
  /** Vision parts for every image attachment, in submission order. */
  images: VisionImagePart[];
  /**
   * Faculty-visible problems: files that could not be read (also noted inline
   * in `text`) and cap truncation.
   */
  warnings: string[];
};

/**
 * The single owner of "is this an Excel workbook filename" for the
 * deterministic key-comparison routing. Case-insensitive: students upload
 * "Budget.XLSX" and Excel doesn't care, so neither do we.
 */
export function isExcelFilename(filename: string | null | undefined): boolean {
  if (filename == null) return false;
  const lower = filename.toLowerCase();
  return lower.endsWith('.xlsx') || lower.endsWith('.xlsm');
}

/**
 * Assembles every attachment's extraction result into one grading payload.
 * Deterministic extraction failures in a multi-file submission become inline
 * "[This file could not be read: …]" notes so the rest still grades; a
 * single-file submission keeps the original hard-error behavior.
 */
export function assembleSubmission(files: readonly SubmissionFileInput[]): AssembledSubmission {
  if (files.length === 0) {
    throw new Error('The submission has no file attachments.');
  }

  // Route 1 — every attachment is an image: the original vision path,
  // placeholder wording preserved verbatim.
  if (files.every((f) => isImageAttachment(f.mediaType, f.filename))) {
    return assembleAllImages(files);
  }

  // Route 2 — exactly one (non-image) file: the original text path,
  // raw extracted text with no header, errors byte-identical.
  if (files.length === 1) {
    return assembleSingleDocument(files[0]!);
  }

  // Route 3 — two or more files with at least one non-image: labeled-section
  // format; images still ride as vision parts.
  return assembleMixed(files);
}

function assembleAllImages(files: readonly SubmissionFileInput[]): AssembledSubmission {
  const images: VisionImagePart[] = [];
  const names: string[] = [];
  for (const file of files) {
    images.push(toVisionImage(file));
    names.push(file.filename ?? 'image');
  }

  // The STUDENT SUBMISSION section gets a placeholder; the actual content
  // rides as image parts in the same message.
  const placeholder =
    `[The student submission is provided as ${images.length} image(s) ` +
    `attached to this message: ${names.join(', ')}]`;
  return { text: placeholder, excelFilename: null, images, warnings: [] };
}

function assembleSingleDocument(file: SubmissionFileInput): AssembledSubmission {
  // Deterministic extraction failure: the one file IS the submission, so the
  // reason surfaces as the faculty-visible ERROR (C#: the extractor's throw
  // or its first warning propagated unchanged).
  if (file.error) throw new Error(file.error);
  const text = file.text ?? '';
  if (text.trim().length === 0) {
    throw new Error('The submission produced no extractable text.');
  }

  const isExcel = isExcelFilename(file.filename);
  return {
    text,
    excelFilename: isExcel ? file.filename : null,
    images: [],
    warnings: [],
  };
}

function assembleMixed(files: readonly SubmissionFileInput[]): AssembledSubmission {
  const totalImages = files.filter((f) => isImageAttachment(f.mediaType, f.filename)).length;
  const images: VisionImagePart[] = [];
  const sections: string[] = [];
  const warnings: string[] = [];
  const unreadable: { name: string; reason: string }[] = [];
  let excelFilename: string | null = null;
  let readableDocs = 0;

  // Budget for document text only — headers, image placeholders, and
  // unreadable notes are small and always emitted in full.
  let remaining = MAX_COMBINED_TEXT_CHARS;
  let capHit = false;

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const name = file.filename ?? 'file';
    const header = `=== File ${i + 1} of ${files.length}: ${name} ===`;

    if (isImageAttachment(file.mediaType, file.filename)) {
      images.push(toVisionImage(file));
      sections.push(
        `${header}\n[This file is provided as image ${images.length} of ${totalImages} attached to this message.]`,
      );
      continue;
    }

    // Deterministic failure: unsupported format, corrupt file, or no
    // extractable text. Re-running would fail identically, so note it and
    // grade the rest.
    const text = file.text ?? '';
    const reason =
      file.error ?? (text.trim().length === 0 ? 'The file produced no extractable text.' : null);

    if (reason != null) {
      sections.push(`${header}\n[This file could not be read: ${reason}]`);
      warnings.push(`Could not read '${name}': ${reason}`);
      unreadable.push({ name, reason });
      continue;
    }

    readableDocs++;
    if (excelFilename == null && isExcelFilename(file.filename)) {
      excelFilename = file.filename;
    }

    let body: string;
    if (capHit) {
      body = '[Omitted: combined submission exceeded the size limit.]';
    } else if (text.length > remaining) {
      body =
        text.slice(0, remaining) +
        '\n[Truncated: combined submission exceeded the size limit; remaining file content omitted.]';
      remaining = 0;
      capHit = true;
      warnings.push(
        'Combined submission text exceeded the size limit; some file content was truncated or omitted.',
      );
    } else {
      body = text;
      remaining -= text.length;
    }
    sections.push(`${header}\n${body}`);
  }

  // Nothing gradable at all: no images and every document unreadable.
  if (images.length === 0 && readableDocs === 0) {
    throw new Error(
      `None of the ${files.length} submitted files could be read: ` +
        unreadable.map((u) => `${u.name} (${u.reason})`).join('; '),
    );
  }

  return { text: sections.join('\n\n'), excelFilename, images, warnings };
}

function toVisionImage(file: SubmissionFileInput): VisionImagePart {
  // Downloads happen upstream; missing bytes on an image attachment keeps the
  // C# download-failure semantics (whole student errors, re-run recovers).
  if (file.imageBytes == null) {
    throw new Error(`Could not download image '${file.filename ?? ''}'.`);
  }
  const mediaType =
    IMAGE_MEDIA_TYPES_BY_EXTENSION.get(fileExtension(file.filename)) ??
    file.mediaType ??
    'image/png';
  return { bytes: file.imageBytes, mediaType };
}
