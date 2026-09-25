// /preview service endpoints: the attachment-ownership check (clients name
// ids, the worker locates the attachment ON that student's submission), the
// 50 MB → 413 cap, the inline content-type allowlist (never Canvas's claimed
// type), the sanitized submission descriptor, and the conversion payloads.
// Canvas is faked at the client-factory seam — route-level tests over real
// HTTP, same pattern as course-routes.test.ts. Heavy conversion logic is
// pinned in @aigrader/extraction's own suites; here we pin the WIRE contract.

import { describe, expect, it } from 'vitest';
import express from 'express';
import type { CanvasAttachment, CanvasSubmission } from '@aigrader/canvas';
import { MAX_PREVIEW_BYTES } from '@aigrader/shared/preview';
import {
  createPreviewRouter,
  effectiveName,
  type PreviewRouteClients,
} from '../src/preview-routes.js';
import ExcelJS from 'exceljs';
import { postJson, withServer } from './helpers.js';

/** An XLSX round-tripped through the real file format (students submit files). */
async function xlsxBytes(fill: (sheet: ExcelJS.Worksheet) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  fill(wb.addWorksheet('S1'));
  return new Uint8Array((await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer);
}


function baseBody(extra: Record<string, unknown> = {}) {
  return {
    apiDomain: 'school.instructure.com',
    courseId: 42,
    assignmentId: 7,
    userId: 901,
    ...extra,
  };
}

function attachment(partial: Partial<CanvasAttachment> & { id: number }): CanvasAttachment {
  return {
    filename: `file-${partial.id}.pdf`,
    display_name: null,
    size: 1234,
    'content-type': 'application/pdf',
    mime_class: null,
    url: `https://files.canvas.test/${partial.id}/signed`,
    preview_url: null,
    ...partial,
  } as CanvasAttachment;
}

function submission(partial: Partial<CanvasSubmission> = {}): CanvasSubmission {
  return {
    id: 1,
    user_id: 901,
    assignment_id: 7,
    attempt: 1,
    workflow_state: 'submitted',
    late: false,
    attachments: [],
    body: null,
    url: null,
    submission_type: 'online_upload',
    submitted_at: '2026-07-01T00:00:00Z',
    ...partial,
  } as CanvasSubmission;
}

function makeApp(overrides: {
  submission?: CanvasSubmission | null;
  files?: Record<string, Uint8Array>;
  quizAnswers?: Array<{ id: number; answer: unknown }>;
}) {
  const downloads: string[] = [];
  const clients: PreviewRouteClients = {
    canvas: {
      getSubmission: async () => overrides.submission ?? null,
      downloadUrl: async (url) => {
        downloads.push(url);
        const bytes = overrides.files?.[url];
        if (!bytes) throw new Error(`no fake bytes for ${url}`);
        return Buffer.from(bytes);
      },
      getQuizSubmissionAnswers: async () => (overrides.quizAnswers ?? []) as never,
    },
  };
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/preview', createPreviewRouter({ clients: async () => clients }));
  return { app, downloads };
}

async function postRaw(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /preview/file', () => {
  it('streams bytes for an attachment that belongs to the submission, with the safe content type', async () => {
    const att = attachment({ id: 11, filename: 'essay.pdf', 'content-type': 'application/pdf' });
    const { app } = makeApp({
      submission: submission({ attachments: [att] }),
      files: { [att.url!]: new TextEncoder().encode('%PDF-1.4 fake') },
    });

    await withServer(app, async (baseUrl) => {
      const res = await postRaw(baseUrl, '/preview/file', baseBody({ attachmentId: 11 }));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(res.headers.get('x-preview-filename')).toBe(encodeURIComponent('essay.pdf'));
      expect(await res.text()).toBe('%PDF-1.4 fake');
    });
  });

  it('classifies the content type itself — Canvas claiming text/html never rides through', async () => {
    const att = attachment({ id: 12, filename: 'page.html', 'content-type': 'text/html' });
    const { app } = makeApp({
      submission: submission({ attachments: [att] }),
      files: { [att.url!]: new TextEncoder().encode('<script>alert(1)</script>') },
    });

    await withServer(app, async (baseUrl) => {
      const res = await postRaw(baseUrl, '/preview/file', baseBody({ attachmentId: 12 }));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
    });
  });

  it('trusts the extension over an octet-stream claim for images', async () => {
    const att = attachment({
      id: 13,
      filename: 'photo.JPG',
      'content-type': 'application/octet-stream',
    });
    const { app } = makeApp({
      submission: submission({ attachments: [att] }),
      files: { [att.url!]: new Uint8Array([0xff, 0xd8]) },
    });

    await withServer(app, async (baseUrl) => {
      const res = await postRaw(baseUrl, '/preview/file', baseBody({ attachmentId: 13 }));
      expect(res.headers.get('content-type')).toBe('image/jpeg');
    });
  });

  it('download=true forces octet-stream even for the inline allowlist', async () => {
    const att = attachment({ id: 14, filename: 'essay.pdf' });
    const { app } = makeApp({
      submission: submission({ attachments: [att] }),
      files: { [att.url!]: new TextEncoder().encode('%PDF') },
    });

    await withServer(app, async (baseUrl) => {
      const res = await postRaw(
        baseUrl,
        '/preview/file',
        baseBody({ attachmentId: 14, download: true }),
      );
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
    });
  });

  it("404s when the attachment id is not on that student's submission (never downloads)", async () => {
    const att = attachment({ id: 15 });
    const { app, downloads } = makeApp({ submission: submission({ attachments: [att] }) });

    await withServer(app, async (baseUrl) => {
      const { status } = await postJson(baseUrl, '/preview/file', baseBody({ attachmentId: 999 }));
      expect(status).toBe(404);
      expect(downloads).toEqual([]);
    });
  });

  it('413s past the 50 MB cap before moving bytes', async () => {
    const att = attachment({ id: 16, size: MAX_PREVIEW_BYTES + 1 });
    const { app, downloads } = makeApp({ submission: submission({ attachments: [att] }) });

    await withServer(app, async (baseUrl) => {
      const { status } = await postJson(baseUrl, '/preview/file', baseBody({ attachmentId: 16 }));
      expect(status).toBe(413);
      expect(downloads).toEqual([]);
    });
  });

  it('502s when Canvas will not serve the bytes', async () => {
    const att = attachment({ id: 17 });
    const { app } = makeApp({ submission: submission({ attachments: [att] }), files: {} });

    await withServer(app, async (baseUrl) => {
      const { status } = await postJson(baseUrl, '/preview/file', baseBody({ attachmentId: 17 }));
      expect(status).toBe(502);
    });
  });
});

describe('POST /preview/submission', () => {
  it('returns attachment tabs and the SANITIZED text-entry body', async () => {
    const atts = [
      attachment({ id: 21, filename: 'a.docx', display_name: 'Essay draft.docx', size: 10 }),
      attachment({ id: 22, filename: 'b.py', 'content-type': 'application/octet-stream' }),
    ];
    const { app } = makeApp({
      submission: submission({
        attachments: atts,
        body: '<p onclick="steal()">essay</p><script>alert(1)</script>',
        submission_type: 'online_text_entry',
      }),
    });

    await withServer(app, async (baseUrl) => {
      const { status, body } = await postJson(baseUrl, '/preview/submission', baseBody());
      expect(status).toBe(200);
      const sub = (body as { submission: Record<string, unknown> }).submission;
      expect(sub.bodyHtml).toContain('<p>essay</p>');
      expect(String(sub.bodyHtml)).not.toContain('script');
      expect(String(sub.bodyHtml)).not.toContain('onclick');
      const tabs = sub.attachments as Array<Record<string, unknown>>;
      expect(tabs.map((t) => t.displayName)).toEqual(['Essay draft.docx', 'b.py']);
    });
  });

  it('404s when the student has no submission', async () => {
    const { app } = makeApp({ submission: null });
    await withServer(app, async (baseUrl) => {
      const { status } = await postJson(baseUrl, '/preview/submission', baseBody());
      expect(status).toBe(404);
    });
  });
});

describe('POST /preview/convert', () => {
  it("kind 'preview' on a code file returns decoded text", async () => {
    const att = attachment({
      id: 31,
      filename: 'hw1.py',
      'content-type': 'application/octet-stream',
    });
    const { app } = makeApp({
      submission: submission({ attachments: [att] }),
      files: { [att.url!]: new TextEncoder().encode('print("hi")\n') },
    });

    await withServer(app, async (baseUrl) => {
      const { status, body } = await postJson(
        baseUrl,
        '/preview/convert',
        baseBody({ attachmentId: 31, kind: 'preview' }),
      );
      expect(status).toBe(200);
      const preview = (body as { preview: Record<string, unknown> }).preview;
      expect(preview.kind).toBe('text');
      expect(preview.plainText).toBe('print("hi")\n');
    });
  });

  it("kind 'preview' on an XLSX returns the sheet-name shell; kind 'grid' renders escaped cells", async () => {
    const bytes = await xlsxBytes((sheet) => {
      sheet.getCell('A1').value = '<b>cell</b>';
    });
    const att = attachment({ id: 32, filename: 'book.xlsx', 'content-type': null });
    const { app } = makeApp({
      submission: submission({ attachments: [att] }),
      files: { [att.url!]: bytes },
    });

    await withServer(app, async (baseUrl) => {
      const shell = await postJson(
        baseUrl,
        '/preview/convert',
        baseBody({ attachmentId: 32, kind: 'preview' }),
      );
      const preview = (shell.body as { preview: Record<string, unknown> }).preview;
      expect(preview.kind).toBe('table');
      expect(preview.sheetNames).toEqual(['S1']);

      const grid = await postJson(
        baseUrl,
        '/preview/convert',
        baseBody({ attachmentId: 32, kind: 'grid', sheetIndex: 0 }),
      );
      const sheet = (grid.body as { sheet: Record<string, unknown> }).sheet;
      expect(sheet.error).toBeNull();
      expect(String(sheet.html)).toContain('&lt;b&gt;cell&lt;/b&gt;');
      expect(String(sheet.html)).not.toContain('<b>cell</b>');
    });
  });

  it("kind 'rtf-html' converts through the sanitizer (the C# converter seam)", async () => {
    const att = attachment({ id: 33, filename: 'essay.rtf', 'content-type': 'text/rtf' });
    const { app } = makeApp({
      submission: submission({ attachments: [att] }),
      files: { [att.url!]: new TextEncoder().encode(String.raw`{\rtf1\ansi Hello {\b bold}\par}`) },
    });

    await withServer(app, async (baseUrl) => {
      const { body } = await postJson(
        baseUrl,
        '/preview/convert',
        baseBody({ attachmentId: 33, kind: 'rtf-html' }),
      );
      const preview = (body as { preview: Record<string, unknown> }).preview;
      expect(preview.kind).toBe('rich-html');
      expect(preview.html).toContain('<strong>bold</strong>');
      expect((preview.warnings as string[]).some((w) => w.includes('approximate'))).toBe(true);
    });
  });

  it('corrupt bytes come back as a friendly unsupported payload, never a 500', async () => {
    const att = attachment({ id: 34, filename: 'paper.docx', 'content-type': null });
    const { app } = makeApp({
      submission: submission({ attachments: [att] }),
      files: { [att.url!]: new Uint8Array([1, 2, 3]) },
    });

    await withServer(app, async (baseUrl) => {
      const { status, body } = await postJson(
        baseUrl,
        '/preview/convert',
        baseBody({ attachmentId: 34, kind: 'docx-html' }),
      );
      expect(status).toBe(200);
      const preview = (body as { preview: Record<string, unknown> }).preview;
      expect(preview.kind).toBe('unsupported');
      expect(String(preview.error)).toContain('could not be converted');
    });
  });

  it('a vanished attachment reports the C# not-found wording as a payload error', async () => {
    const { app } = makeApp({ submission: submission({ attachments: [] }) });
    await withServer(app, async (baseUrl) => {
      const { status, body } = await postJson(
        baseUrl,
        '/preview/convert',
        baseBody({ attachmentId: 999, kind: 'grid' }),
      );
      expect(status).toBe(200);
      const sheet = (body as { sheet: Record<string, unknown> }).sheet;
      expect(String(sheet.error)).toContain('no longer on the student');
    });
  });
});

describe('POST /preview/quiz-answer', () => {
  it('returns the sanitized full answer, and "" when nothing richer exists', async () => {
    const { app } = makeApp({
      submission: null,
      quizAnswers: [{ id: 5, answer: '<p style="x">full <script>a()</script>answer</p>' }],
    });

    await withServer(app, async (baseUrl) => {
      const hit = await postJson(baseUrl, '/preview/quiz-answer', {
        apiDomain: 'school.instructure.com',
        courseId: 42,
        quizSubmissionId: 77,
        questionId: 5,
      });
      expect((hit.body as { html: string }).html).toBe('<p>full answer</p>');

      const miss = await postJson(baseUrl, '/preview/quiz-answer', {
        apiDomain: 'school.instructure.com',
        courseId: 42,
        quizSubmissionId: 77,
        questionId: 6,
      });
      expect((miss.body as { html: string }).html).toBe('');
    });
  });
});

describe('effectiveName', () => {
  it('prefers display_name, then filename, then a synthetic name', () => {
    expect(effectiveName(attachment({ id: 1, display_name: 'Nice.pdf' }))).toBe('Nice.pdf');
    expect(effectiveName(attachment({ id: 2, display_name: null, filename: 'raw.pdf' }))).toBe(
      'raw.pdf',
    );
    expect(effectiveName(attachment({ id: 3, display_name: null, filename: null }))).toBe('file-3');
  });
});
