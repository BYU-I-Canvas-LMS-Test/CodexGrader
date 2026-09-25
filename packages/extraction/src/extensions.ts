// Extension lists shared by the extractor dispatch and the submission
// viewer — they classify with the identical list and must not
// drift. The CANONICAL lists live in @aigrader/shared/preview (shared-safe, so
// the web viewer's classifier can bundle them client-side without dragging
// this engine-only package); this module re-exports them so extraction's
// public surface is unchanged.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Extraction\SubmissionTextExtractor.cs
//   (TextAndCodeExtensions) and C:\Devs\AIgrader\lib\extract\index.ts
//   (TEXT_AND_CODE_EXTENSIONS) — the two lists are verbatim-identical.

export { TEXT_AND_CODE_EXTENSIONS, IMAGE_EXTENSIONS } from '@aigrader/shared/preview';

/** The lowercase extension including the dot ('.py'), or '' when there is
 * none. Callers lowercase the filename first (dispatch is case-insensitive).
 * NOTE: deliberately NOT @aigrader/shared/preview's previewFileExtension — this
 * one predates it and extraction callers rely on its exact semantics. */
export function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot) : '';
}
