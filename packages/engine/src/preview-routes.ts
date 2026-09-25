// Submission-viewer service endpoints — mounted at /preview on the
// in-process engine app. The engine owns every Canvas API call; apps/web
// only relays. Every body carries {apiDomain?, courseId}; the token never
// travels.
//
//   POST /preview/submission {…, assignmentId, userId} → the viewer's
//        submission descriptor: attachment tab metadata + the text-entry body
//        SANITIZED server-side (the web tier never sanitizes — the canonical
//        sanitizer lives in @aigrader/extraction, next to the conversions).
//   POST /preview/file {…, assignmentId, userId, attachmentId, download?} →
//        locates the attachment ON THAT STUDENT'S SUBMISSION (a client can
//        never name an arbitrary Canvas file id — the same
//        no-cross-course/no-SSRF construction as the C# controller), resolves
//        a FRESH signed URL, and returns the raw bytes with the inline
//        content-type ALLOWLIST applied (application/pdf + png/jpeg/gif/webp;
//        everything else octet-stream). 404 attachment gone / 413 over the
//        50 MB cap / 502 Canvas refused.
//   POST /preview/convert {…, attachmentId, kind, sheetIndex?, showFormulas?,
//        allRows?} → server-side conversions as JSON: kind 'preview' (classify
//        + build: text / table shell / RTF→HTML / unsupported), 'docx-html'
//        (mammoth→sanitized HTML — the client renderer's fallback), 'rtf-html',
//        'grid' (one worksheet as Excel-like grid HTML, 500-row default /
//        2,000 cap). Conversion failures come back as friendly payload errors
//        (200), matching the C# AttachmentPreview.Error contract.
//   POST /preview/quiz-answer {…, quizSubmissionId, questionId} → the
//        student's full formatted essay answer, sanitized ('' when Canvas has
//        nothing richer than the stored excerpt).
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Viewing\SubmissionPreviewService.cs
// and Controllers\SubmissionFileController.cs. Short-lived in-memory caching
// is correct here per the single-instance architecture (one local server):
// bytes ≤15 MB cache for 10 minutes; the submission JSON micro-caches for 60 s
// so a multi-attachment submission doesn't re-fetch identical JSON per tab.
//
// Transport note (streaming-vs-base64): /preview/file answers with RAW BYTES,
// not a base64 JSON envelope — apps/web reaches it through engineFetchRaw,
// which exposes the Response so the web relay pipes the body straight
// through without buffering ~1.33x-inflated JSON.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  CanvasError,
  type CanvasAttachment,
  type CanvasSubmission,
  type QuizSubmissionAnswer,
} from '@aigrader/canvas';
import {
  MAX_PREVIEW_BYTES,
  classifyPreview,
  csvDelimiterFor,
  isCsvLike,
  safeInlineContentType,
} from '@aigrader/shared/preview';
import {
  INITIAL_ROWS_PER_SHEET,
  MAX_ROWS_PER_SHEET,
  convertDocxHtml,
  convertRtfHtml,
  createColorResolver,
  isRtfAttachment,
  loadWorkbook,
  renderCsvGrid,
  renderSheetGrid,
  sanitizeHtml,
  workbookSheetNames,
  type SheetGrid,
} from '@aigrader/extraction';
import { CredentialError } from './credentials.js';

// ------------------------------------------------------------------- limits --

/** Character cap for text previews (a 50 MB text file must not become one
 * 50M-char JSON string). Same rationale + value as the C# service. */
export const MAX_TEXT_PREVIEW_CHARS = 1_000_000;
/** Only files up to this size enter the byte cache. */
const MAX_CACHE_ENTRY_BYTES = 15 * 1024 * 1024;
/** Total byte-cache budget (single instance — keep grading headroom). */
const CACHE_BYTE_BUDGET = 150 * 1024 * 1024;
/** Cache lifetime for bytes and converted previews. */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** Submission-JSON micro-cache (signed URLs stay valid far longer). */
const SUBMISSION_TTL_MS = 60 * 1000;

// ------------------------------------------------------------- body schemas --

const baseBody = z.object({
  /** Canvas host the course lives on; null/absent = the teacher's primary instance. */
  apiDomain: z.string().nullish(),
  courseId: z.number().int().positive(),
});

const submissionBody = baseBody.extend({
  assignmentId: z.number().int().positive(),
  userId: z.number().int().positive(),
});

const fileBody = submissionBody.extend({
  attachmentId: z.number().int().positive(),
  download: z.boolean().optional(),
});

const convertBody = submissionBody.extend({
  attachmentId: z.number().int().positive(),
  kind: z.enum(['preview', 'docx-html', 'rtf-html', 'grid']),
  sheetIndex: z.number().int().nonnegative().default(0),
  showFormulas: z.boolean().default(false),
  allRows: z.boolean().default(false),
});

const quizAnswerBody = baseBody.extend({
  quizSubmissionId: z.number().int().positive(),
  questionId: z.number().int().positive(),
});

// ------------------------------------------------------- structural clients --

export interface PreviewCanvasPort {
  getSubmission(
    courseId: number,
    assignmentId: number,
    userId: number,
  ): Promise<CanvasSubmission | null>;
  downloadUrl(url: string): Promise<Buffer>;
  getQuizSubmissionAnswers(quizSubmissionId: number): Promise<QuizSubmissionAnswer[]>;
}

export interface PreviewRouteClients {
  canvas: PreviewCanvasPort;
}

export type PreviewRouteClientFactory = (args: {
  apiDomain: string | null;
}) => Promise<PreviewRouteClients>;

export interface PreviewRoutesDeps {
  /** The shared per-instance client factory (src/clients.ts); tests inject fakes. */
  clients: PreviewRouteClientFactory;
  /** Clock injection (cache-expiry tests). */
  now?: () => number;
}

// ------------------------------------------------------------------ plumbing --

class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.message ?? body.error ?? 'route error'));
  }
}

/** Uniform error → response mapping (no token material ever). */
function sendError(res: Response, err: unknown): void {
  if (err instanceof RouteError) {
    res.status(err.status).json(err.body);
    return;
  }
  if (err instanceof CredentialError) {
    res.status(409).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof CanvasError) {
    if (err.status === 401 || err.status === 403) {
      res
        .status(422)
        .json({ error: 'invalid_token', message: 'Canvas did not accept the access token.' });
      return;
    }
    if (err.status === 404) {
      res.status(404).json({ error: 'not_found', message: 'Canvas resource not found.' });
      return;
    }
    res
      .status(502)
      .json({ error: 'canvas_error', message: `Canvas request failed with status ${err.status}.` });
    return;
  }
  console.error(
    JSON.stringify({
      severity: 'ERROR',
      message: `preview-routes failure: ${err instanceof Error ? err.message : 'unknown'}`,
    }),
  );
  res.status(500).json({ error: 'internal', message: 'Unexpected engine error.' });
}

function parseBody<S extends z.ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new RouteError(400, {
      error: 'invalid_request',
      message: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body.',
    });
  }
  return result.data as z.infer<S>;
}

function handle(res: Response, fn: () => Promise<void>): void {
  void fn().catch((err: unknown) => sendError(res, err));
}

// -------------------------------------------------------------------- cache --

type CacheEntry<T> = { value: T; expires: number; size: number };

/** Minimal TTL + byte-budget cache (single local server, in-memory only). */
class TtlCache<T> {
  private readonly map = new Map<string, CacheEntry<T>>();
  private total = 0;

  constructor(
    private readonly budget: number,
    private readonly now: () => number,
  ) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.total -= entry.size;
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, size: number, ttlMs: number): void {
    const prior = this.map.get(key);
    if (prior) this.total -= prior.size;
    this.map.set(key, { value, expires: this.now() + ttlMs, size });
    this.total += size;
    // Insertion-order eviction keeps the budget honest without bookkeeping.
    for (const [k, e] of this.map) {
      if (this.total <= this.budget) break;
      this.map.delete(k);
      this.total -= e.size;
    }
  }
}

// ------------------------------------------------------------- file fetching --

type FetchOutcome =
  | { status: 'ok'; attachment: CanvasAttachment; bytes: Buffer }
  | { status: 'not_found' | 'too_large' | 'download_failed' };

/** The one faculty-facing wording for each failed fetch status — every
 * preview path (built-in, sheet, converter) reports the same words. */
function statusMessage(status: 'not_found' | 'too_large' | 'download_failed'): string {
  switch (status) {
    case 'not_found':
      return "This file is no longer on the student's latest submission — reopen the run to refresh.";
    case 'too_large':
      return 'This file is too large to preview — download it instead.';
    default:
      return 'The file could not be downloaded from Canvas — try again in a moment.';
  }
}

const CONVERT_FAILED_MESSAGE =
  'The file could not be converted for preview — it may be corrupt. Download it to view the original.';
const SHEET_FAILED_MESSAGE =
  'The sheet could not be rendered — the file may be corrupt. Download it to view the original.';

/** Original filename for headers/tabs (C# CanvasAttachment.EffectiveName). */
export function effectiveName(att: CanvasAttachment): string {
  return att.display_name ?? att.filename ?? `file-${att.id}`;
}

// -------------------------------------------------------------------- routes --

export function createPreviewRouter(deps: PreviewRoutesDeps): Router {
  const clients: PreviewRouteClientFactory =
    deps.clients;
  const now = deps.now ?? Date.now;

  const byteCache = new TtlCache<{ attachment: CanvasAttachment; bytes: Buffer }>(
    CACHE_BYTE_BUDGET,
    now,
  );
  const submissionCache = new TtlCache<CanvasSubmission>(Number.MAX_SAFE_INTEGER, now);
  const convertCache = new TtlCache<Record<string, unknown>>(64 * 1024 * 1024, now);

  /** Resolve body → canvas client (one shape for every route). */
  async function resolve(req: Request) {
    const body = parseBody(baseBody.passthrough(), req);
    const bundle = await clients({
      apiDomain: body.apiDomain ?? null,
    });
    return { apiDomain: body.apiDomain ?? null, canvas: bundle.canvas };
  }

  function cacheKey(
    apiDomain: string | null,
    b: { courseId: number; assignmentId: number; userId: number },
  ): string {
    // Scoped by the instance host — course ids are only unique per instance.
    return `${apiDomain ?? 'default'}:${b.courseId}:${b.assignmentId}:${b.userId}`;
  }

  /** Re-fetch the submission so the signed URL is fresh (stored attachment
   * URLs are short-lived and never trusted), through the 60 s micro-cache. */
  async function getSubmission(
    canvas: PreviewCanvasPort,
    apiDomain: string | null,
    b: { courseId: number; assignmentId: number; userId: number },
  ): Promise<CanvasSubmission | null> {
    const key = `sub:${cacheKey(apiDomain, b)}`;
    const cached = submissionCache.get(key);
    if (cached) return cached;
    const submission = await canvas.getSubmission(b.courseId, b.assignmentId, b.userId);
    if (submission) submissionCache.set(key, submission, 1, SUBMISSION_TTL_MS);
    return submission;
  }

  /** Locates the attachment ON the student's submission and resolves bytes —
   * the authorization construction: the client only ever names ids, and the
   * engine re-derives the download URL from Canvas's own answer. */
  async function getFileBytes(
    canvas: PreviewCanvasPort,
    apiDomain: string | null,
    b: { courseId: number; assignmentId: number; userId: number; attachmentId: number },
  ): Promise<FetchOutcome> {
    const key = `bytes:${cacheKey(apiDomain, b)}:${b.attachmentId}`;
    const cached = byteCache.get(key);
    if (cached) return { status: 'ok', ...cached };

    let submission: CanvasSubmission | null;
    try {
      submission = await getSubmission(canvas, apiDomain, b);
    } catch (err) {
      if (err instanceof CanvasError) return { status: 'download_failed' };
      throw err;
    }
    const attachment = submission?.attachments?.find((a) => a.id === b.attachmentId);
    if (!attachment?.url) return { status: 'not_found' };

    // Refuse before moving bytes when Canvas told us the size up front.
    if ((attachment.size ?? 0) > MAX_PREVIEW_BYTES) return { status: 'too_large' };

    let bytes: Buffer;
    try {
      bytes = await canvas.downloadUrl(attachment.url);
    } catch {
      // Either Canvas refused or the network hiccuped — the 502 contract.
      return { status: 'download_failed' };
    }
    if (bytes.byteLength > MAX_PREVIEW_BYTES) return { status: 'too_large' };

    if (bytes.byteLength <= MAX_CACHE_ENTRY_BYTES) {
      byteCache.set(key, { attachment, bytes }, bytes.byteLength, CACHE_TTL_MS);
    }
    return { status: 'ok', attachment, bytes };
  }

  const router = Router();

  // -------------------------------------------------------------- submission --

  router.post('/submission', (req, res) => {
    handle(res, async () => {
      const body = parseBody(submissionBody, req);
      const { apiDomain, canvas } = await resolve(req);

      const submission = await getSubmission(canvas, apiDomain, body);
      if (!submission) {
        throw new RouteError(404, {
          error: 'not_found',
          message: 'No submission found for that student.',
        });
      }

      res.json({
        submission: {
          userId: submission.user_id,
          submissionType: submission.submission_type ?? null,
          late: submission.late === true,
          submittedAt: submission.submitted_at ?? null,
          url: submission.url ?? null,
          // Text-entry bodies are student HTML — sanitized HERE, so the web
          // tier only ever receives allowlisted markup.
          bodyHtml:
            typeof submission.body === 'string' && submission.body.trim() !== ''
              ? sanitizeHtml(submission.body)
              : null,
          attachments: (submission.attachments ?? []).map((a) => ({
            id: a.id,
            filename: a.filename ?? null,
            displayName: effectiveName(a),
            size: a.size ?? null,
            contentType: a['content-type'] ?? null,
          })),
        },
      });
    });
  });

  // -------------------------------------------------------------------- file --

  router.post('/file', (req, res) => {
    handle(res, async () => {
      const body = parseBody(fileBody, req);
      const { apiDomain, canvas } = await resolve(req);

      const outcome = await getFileBytes(canvas, apiDomain, body);
      if (outcome.status !== 'ok') {
        const status =
          outcome.status === 'not_found' ? 404 : outcome.status === 'too_large' ? 413 : 502;
        const error =
          outcome.status === 'not_found'
            ? 'not_found'
            : outcome.status === 'too_large'
              ? 'file_too_large'
              : 'download_failed';
        throw new RouteError(status, { error, message: statusMessage(outcome.status) });
      }

      const { attachment, bytes } = outcome;
      // Inline allowlist decided by OUR classification, never Canvas's claim;
      // forced downloads always ride as octet-stream.
      const contentType = body.download
        ? 'application/octet-stream'
        : safeInlineContentType(attachment['content-type'], attachment.filename);
      res.status(200);
      res.set({
        'content-type': contentType,
        'content-length': String(bytes.byteLength),
        // Metadata for the web proxy's Content-Disposition (RFC 5987-encoded
        // so hostile filenames can't smuggle header syntax).
        'x-preview-filename': encodeURIComponent(effectiveName(attachment)),
        'x-preview-size': String(bytes.byteLength),
      });
      res.end(bytes);
    });
  });

  // ----------------------------------------------------------------- convert --

  router.post('/convert', (req, res) => {
    handle(res, async () => {
      const body = parseBody(convertBody, req);
      const { apiDomain, canvas } = await resolve(req);

      const convertKey =
        `conv:${cacheKey(apiDomain, body)}:${body.attachmentId}:${body.kind}` +
        `:${body.sheetIndex}:${body.showFormulas}:${body.allRows}`;
      const cached = convertCache.get(convertKey);
      if (cached) {
        res.json(cached);
        return;
      }

      const outcome = await getFileBytes(canvas, apiDomain, body);
      if (outcome.status !== 'ok') {
        // A fetch failure is not "this file type can't be previewed" —
        // report the real (often transient) reason, C# StatusMessage wording.
        const message = statusMessage(outcome.status);
        res.json(
          body.kind === 'grid'
            ? { sheet: failedSheet(message) }
            : { preview: { kind: 'unsupported', error: message, warnings: [] } },
        );
        return;
      }

      const { attachment, bytes } = outcome;
      const payload =
        body.kind === 'grid'
          ? await buildGrid(bytes, attachment, body)
          : { preview: await buildPreview(bytes, attachment, body.kind) };

      const size = JSON.stringify(payload).length;
      convertCache.set(convertKey, payload as Record<string, unknown>, size, CACHE_TTL_MS);
      res.json(payload);
    });
  });

  // -------------------------------------------------------------- quiz answer --

  router.post('/quiz-answer', (req, res) => {
    handle(res, async () => {
      const body = parseBody(quizAnswerBody, req);
      const { canvas } = await resolve(req);

      const answers = await canvas.getQuizSubmissionAnswers(body.quizSubmissionId);
      const entry = answers.find((a) => a.id === body.questionId);
      const raw = typeof entry?.answer === 'string' ? entry.answer : '';
      // '' = "fetched, nothing richer than the excerpt" (the C# semantics).
      res.json({ html: sanitizeHtml(raw) });
    });
  });

  return router;
}

// -------------------------------------------------------------- conversions --

function failedSheet(error: string): SheetGrid {
  return { html: null, warnings: [], error, truncated: false, hasFormulas: false };
}

/** kind 'grid': one worksheet (or the CSV pseudo-sheet) as grid HTML. */
async function buildGrid(
  bytes: Buffer,
  attachment: CanvasAttachment,
  opts: { sheetIndex: number; showFormulas: boolean; allRows: boolean },
): Promise<{ sheet: SheetGrid; sheetNames?: string[] }> {
  const maxRows = opts.allRows ? MAX_ROWS_PER_SHEET : INITIAL_ROWS_PER_SHEET;
  try {
    if (isCsvLike(attachment['content-type'], attachment.filename)) {
      return { sheet: renderCsvGrid(bytes, csvDelimiterFor(attachment.filename), maxRows) };
    }
    const workbook = await loadWorkbook(bytes);
    const sheets = workbook.worksheets;
    if (opts.sheetIndex < 0 || opts.sheetIndex >= sheets.length) {
      return { sheet: failedSheet('That sheet no longer exists in the workbook.') };
    }
    const resolver = createColorResolver(workbook);
    return {
      sheet: renderSheetGrid(sheets[opts.sheetIndex]!, opts.showFormulas, maxRows, resolver),
    };
  } catch {
    return { sheet: failedSheet(SHEET_FAILED_MESSAGE) };
  }
}

/** The viewer's AttachmentPreview wire shape (C# AttachmentPreview). */
export type PreviewPayload = {
  kind: 'pdf' | 'image' | 'rich-html' | 'table' | 'text' | 'slides' | 'unsupported';
  html?: string;
  plainText?: string;
  warnings: string[];
  error?: string;
  sheetNames?: string[];
};

/** kinds 'preview' | 'docx-html' | 'rtf-html': the C# BuildPreviewAsync port. */
async function buildPreview(
  bytes: Buffer,
  attachment: CanvasAttachment,
  kind: 'preview' | 'docx-html' | 'rtf-html',
): Promise<PreviewPayload> {
  try {
    if (kind === 'docx-html') return await docxPreview(bytes);
    if (kind === 'rtf-html') return rtfPreview(bytes);

    const classified = classifyPreview(attachment['content-type'], attachment.filename);
    switch (classified) {
      // Pdf/Image/Slides render straight off the streaming endpoint —
      // nothing to build (the web viewer shouldn't ask, but answer honestly).
      case 'pdf':
      case 'image':
      case 'slides':
        return { kind: classified, warnings: [] };
      case 'rich-html':
        return await docxPreview(bytes);
      case 'table': {
        if (isCsvLike(attachment['content-type'], attachment.filename)) {
          return { kind: 'table', sheetNames: ['Data'], warnings: [] };
        }
        const shell = workbookSheetNames(await loadWorkbook(bytes));
        return { kind: 'table', sheetNames: shell.sheetNames, warnings: shell.warnings };
      }
      case 'text': {
        const text = bytes.toString('utf8');
        if (text.length <= MAX_TEXT_PREVIEW_CHARS) {
          return { kind: 'text', plainText: text, warnings: [] };
        }
        return {
          kind: 'text',
          plainText: text.slice(0, MAX_TEXT_PREVIEW_CHARS),
          warnings: [
            'Preview truncated to the first 1,000,000 characters — use Download for the full file.',
          ],
        };
      }
      default: {
        // The converter seam: RTF converts; legacy .doc (no pure-JS
        // converter exists) and everything else get the download card.
        if (isRtfAttachment(attachment['content-type'], attachment.filename)) {
          return rtfPreview(bytes);
        }
        return {
          kind: 'unsupported',
          warnings: [],
          error: "This file type can't be previewed in the app.",
        };
      }
    }
  } catch {
    return { kind: 'unsupported', warnings: [], error: CONVERT_FAILED_MESSAGE };
  }
}

async function docxPreview(bytes: Buffer): Promise<PreviewPayload> {
  const result = await convertDocxHtml(bytes);
  if (result.html === null) {
    return { kind: 'unsupported', warnings: result.warnings, error: result.error ?? CONVERT_FAILED_MESSAGE };
  }
  return { kind: 'rich-html', html: result.html, warnings: result.warnings };
}

function rtfPreview(bytes: Buffer): PreviewPayload {
  const result = convertRtfHtml(bytes);
  if (result.html === null) {
    return {
      kind: 'unsupported',
      warnings: [],
      error: "This file type can't be previewed in the app.",
    };
  }
  return { kind: 'rich-html', html: result.html, warnings: result.warnings };
}
