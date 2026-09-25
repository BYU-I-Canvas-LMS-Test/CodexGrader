// The submission viewer's classifier — extension-FIRST dispatch using the
// grading engine's exact lists, so the viewer and grader can never disagree
// about a file. The implementation lives in @aigrader/shared/preview (a zero-dep,
// client-bundle-safe subpath — importing the shared package ROOT from client
// code would drag Node-only modules into the bundle, and importing
// @aigrader/extraction from apps/web is forbidden outright: the engine owns
// extraction). This module is the web app's one import point for it.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Viewing\SubmissionPreviewService.cs
// (ClassifyCore / SafeInlineContentType). Pinned by tests/classify.test.ts —
// the PreviewClassificationTests port, including the security pins: student
// .html files classify as 'text' (escaped source, NEVER renderable HTML), and
// the streaming content-type allowlist never echoes Canvas's claim.

export {
  classifyPreview,
  safeInlineContentType,
  isCsvLike,
  csvDelimiterFor,
  previewFileExtension,
  isImageAttachment,
  INLINE_CONTENT_TYPES,
  MAX_PREVIEW_BYTES,
  TEXT_AND_CODE_EXTENSIONS,
  IMAGE_EXTENSIONS,
  IMAGE_MEDIA_TYPES,
  IMAGE_MEDIA_TYPES_BY_EXTENSION,
  type PreviewKind,
} from '@aigrader/shared/preview';
