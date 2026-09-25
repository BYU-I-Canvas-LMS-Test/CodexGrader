// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Grading\SubmissionAssembly.cs
//   (ImageMediaTypesByExtension / ImageMediaTypes / IsImage)
// and C:\Devs\AIGrader-C#\src\AiGrader\Services\Grading\GraderAgent.cs (IsImageAttachment).
//
// The gate into the vision grading path: JPG/PNG/GIF/WebP route to multimodal
// grading; everything else stays on the text-extraction path (or errors
// clearly for unsupported binaries). Keys off BOTH MIME and extension —
// Canvas sometimes reports images as octet-stream, same quirk as code files.
// Vision-unsupported image formats (bmp/tiff) stay off the vision path so
// they fail with a clear extraction error instead of an opaque model
// rejection.
//
// The CANONICAL lists moved to @aigrader/shared/preview (M5) so the submission
// viewer's classifier uses the exact same tables; this module re-exports them
// to keep the engine's import surface unchanged.

export {
  IMAGE_MEDIA_TYPES_BY_EXTENSION,
  IMAGE_MEDIA_TYPES,
  isImageAttachment,
  previewFileExtension as fileExtension,
} from '@aigrader/shared/preview';
