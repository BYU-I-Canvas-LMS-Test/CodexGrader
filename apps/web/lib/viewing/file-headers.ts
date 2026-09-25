// Response-header policy for the same-origin file streaming proxy
// (app/api/submission-file/…). Pure so the security rules are unit-testable
// without HTTP: the browser-facing headers are decided HERE, from OUR
// classification — never from what the worker hop or Canvas claimed.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Controllers\SubmissionFileController.cs
// (nosniff + private caching + the inline-vs-attachment disposition split).

import { INLINE_CONTENT_TYPES } from './classify';

/** RFC 6266/5987 Content-Disposition with a safely encoded filename: the
 * quoted fallback strips anything that could smuggle header syntax; the
 * filename* form carries the exact UTF-8 name. */
export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * The headers the browser receives for one streamed attachment.
 * `workerContentType` is the type the worker hop resolved (already
 * allowlisted there) — re-checked against INLINE_CONTENT_TYPES here so a
 * compromised or buggy upstream can still never make the browser interpret a
 * student upload as active content (defense in depth).
 */
export function buildFileResponseHeaders(args: {
  workerContentType: string | null;
  filename: string;
  download: boolean;
  size: string | null;
}): Headers {
  const inlineOk =
    !args.download &&
    args.workerContentType !== null &&
    INLINE_CONTENT_TYPES.has(args.workerContentType.toLowerCase());

  const headers = new Headers({
    'Content-Type': inlineOk ? args.workerContentType! : 'application/octet-stream',
    'Content-Disposition': contentDisposition(inlineOk ? 'inline' : 'attachment', args.filename),
    // Never sniff — the whole point of the octet-stream fallback.
    'X-Content-Type-Options': 'nosniff',
    // Same 10-minute private cache the C# controller used.
    'Cache-Control': 'private, max-age=600',
  });
  if (args.size !== null && /^\d+$/.test(args.size)) headers.set('Content-Length', args.size);
  return headers;
}
