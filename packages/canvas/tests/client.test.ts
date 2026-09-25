// CanvasClient behavior: HTML-login-page detection, Link-header pagination,
// transient retry, forDomain trust enforcement, grade/quiz passback
// encodings, and gradable-item filtering.
// Behaviors ported from: C:\Devs\AIgrader\lib\canvas\client.ts and
// C:\Devs\AIGrader-C#\src\AiGrader\Services\Canvas\CanvasApiClient.cs
// (trust cases from tests\AiGrader.Tests\CanvasDomainsTests.cs).

import { describe, expect, it } from 'vitest';
import { CanvasError } from '../src/errors.js';
import { createCanvasClient } from '../src/client.js';
import { jsonResponse, makeFetch, textResponse } from './helpers.js';

const BASE = 'https://school.instructure.com';

function client(fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>) {
  return createCanvasClient({ baseUrl: BASE, token: 'sekrit-token', fetch: fetchImpl, maxRetries: 2 });
}

describe('HTML login-page detection (silent auth failure)', () => {
  it('throws a descriptive CanvasError when Canvas answers 200 with an HTML login page', async () => {
    const { fetchImpl } = makeFetch([
      textResponse('<!DOCTYPE html><html><body>Log in to Canvas</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    ]);

    const err = await client(fetchImpl).getSelf().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CanvasError);
    expect((err as CanvasError).message).toMatch(/Expected JSON but received text\/html/);
    expect((err as CanvasError).message).toMatch(/token/i);
  });
});

describe('pagination', () => {
  it('follows Link rel="next" until exhausted and concatenates pages', async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse([{ id: 1, name: 'Ada' }], {
        headers: {
          link: `<${BASE}/api/v1/courses/9/users?page=2>; rel="next", <${BASE}/api/v1/courses/9/users?page=1>; rel="first"`,
        },
      }),
      jsonResponse([{ id: 2, name: 'Grace' }]),
    ]);

    const students = await client(fetchImpl).getCourseStudents(9);

    expect(students.map((s) => s.id)).toEqual([1, 2]);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(`${BASE}/api/v1/courses/9/users?page=2`);
    // Bearer goes to the Canvas host on every page.
    expect(calls[0].headers.get('authorization')).toBe('Bearer sekrit-token');
    expect(calls[1].headers.get('authorization')).toBe('Bearer sekrit-token');
  });
});

describe('transient retry', () => {
  it('retries a 429 (honoring retry-after) and then succeeds', async () => {
    const { fetchImpl, calls } = makeFetch([
      textResponse('Too many requests', { status: 429, headers: { 'retry-after': '0' } }),
      jsonResponse({ id: 42, name: 'Me' }),
    ]);

    const self = await client(fetchImpl).getSelf();
    expect(self.id).toBe(42);
    expect(calls).toHaveLength(2);
  });

  it('treats Canvas\'s 403 "Rate Limit Exceeded" body as transient', async () => {
    const { fetchImpl, calls } = makeFetch([
      textResponse('403 Forbidden (Rate Limit Exceeded)', {
        status: 403,
        headers: { 'retry-after': '0' },
      }),
      jsonResponse({ id: 42 }),
    ]);

    const self = await client(fetchImpl).getSelf();
    expect(self.id).toBe(42);
    expect(calls).toHaveLength(2);
  });

  it('times out a hung request and retries it (bug #12)', async () => {
    let attempts = 0;
    const fetchImpl = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
      attempts++;
      if (attempts === 1) {
        // Hang until the per-attempt timeout aborts us.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        });
      }
      return jsonResponse({ id: 42 });
    };
    const c = createCanvasClient({ baseUrl: BASE, token: 't', fetch: fetchImpl, maxRetries: 1, timeoutMs: 20 });
    const self = await c.getSelf();
    expect(self.id).toBe(42);
    expect(attempts).toBe(2);
  });

  it('gives up with an error once every attempt timed out', async () => {
    const fetchImpl = async (_input: string | URL, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
    const c = createCanvasClient({ baseUrl: BASE, token: 't', fetch: fetchImpl, maxRetries: 0, timeoutMs: 20 });
    await expect(c.getSelf()).rejects.toThrow();
  });

  it('does NOT retry a plain 403 — it throws immediately', async () => {
    const { fetchImpl, calls } = makeFetch([
      textResponse('{"message":"unauthorized"}', { status: 403 }),
    ]);

    const err = await client(fetchImpl).getSelf().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CanvasError);
    expect((err as CanvasError).status).toBe(403);
    expect((err as CanvasError).canvasMessage).toBe('unauthorized');
    expect(calls).toHaveLength(1);
  });
});

describe('forDomain trust enforcement', () => {
  it('returns the same client for null/empty/unsubstituted domains', async () => {
    const { fetchImpl } = makeFetch([]);
    const c = client(fetchImpl);
    expect(c.forDomain(null)).toBe(c);
    expect(c.forDomain('')).toBe(c);
    expect(c.forDomain('$Canvas.api.domain')).toBe(c);
  });

  it("returns the same client for the instance it's already bound to, even off-allowlist", () => {
    const { fetchImpl } = makeFetch([]);
    const pinned = createCanvasClient({
      baseUrl: 'https://canvas.byui.edu',
      token: 't',
      fetch: fetchImpl,
    });
    // The configured default instance is trusted even when its host matches
    // no suffix entry (C# IsTrusted_ConfiguredBaseUrlAlways).
    expect(pinned.forDomain('canvas.byui.edu')).toBe(pinned);
  });

  it('binds a trusted host to a sibling that shares the token and gate', async () => {
    const { fetchImpl, calls } = makeFetch([jsonResponse({ id: 7 })]);
    const c = client(fetchImpl);

    const sibling = c.forDomain('byupw.instructure.com');
    expect(sibling).not.toBe(c);
    expect(sibling.baseUrl).toBe('https://byupw.instructure.com');
    expect(sibling.gate).toBe(c.gate); // one token = one rate budget

    await sibling.getSelf();
    expect(calls[0].url).toBe('https://byupw.instructure.com/api/v1/users/self');
    expect(calls[0].headers.get('authorization')).toBe('Bearer sekrit-token');
  });

  it('THROWS for an untrusted host instead of carrying the token off-cluster', () => {
    const { fetchImpl } = makeFetch([]);
    const c = client(fetchImpl);
    expect(() => c.forDomain('canvas.evil.example')).toThrow(/Refusing to send the Canvas API token/);
    expect(() => c.forDomain('evilinstructure.com')).toThrow(/Refusing/);
  });

  it('an empty suffix list pins the client to its own instance (personal tokens)', () => {
    const { fetchImpl } = makeFetch([]);
    const c = client(fetchImpl);
    expect(() => c.forDomain('byupw.instructure.com', [])).toThrow(/Refusing/);
  });
});

describe('grade passback encoding', () => {
  it('form-encodes posted_grade (splitting "85/100"), comment, and raw-id rubric assessment', async () => {
    const { fetchImpl, calls } = makeFetch([jsonResponse({ id: 1, score: 85, grade: '85' })]);

    const result = await client(fetchImpl).postGrade(9, 101, 555, {
      postedGrade: '85/100',
      comment: 'Nice work',
      rubricAssessment: {
        _4692: { points: 20, comments: 'Clear thesis' },
        '1745118159974': { points: 5.5, comments: '' },
      },
    });

    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe(`${BASE}/api/v1/courses/9/assignments/101/submissions/555`);
    const form = new URLSearchParams(String(calls[0].body));
    expect(form.get('submission[posted_grade]')).toBe('85');
    expect(form.get('comment[text_comment]')).toBe('Nice work');
    expect(form.get('rubric_assessment[_4692][points]')).toBe('20');
    expect(form.get('rubric_assessment[_4692][comments]')).toBe('Clear thesis');
    expect(form.get('rubric_assessment[1745118159974][points]')).toBe('5.5');
    expect(result.score).toBe(85);
  });

  it('PUTs per-question quiz grades as the exact JSON shape Canvas expects', async () => {
    const { fetchImpl, calls } = makeFetch([jsonResponse({ quiz_submissions: [] })]);

    await client(fetchImpl).postQuizQuestionGrades(9, 33, 777, {
      attempt: 2,
      questions: { '77': { score: 3, comment: 'good' } },
    });

    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe(`${BASE}/api/v1/courses/9/quizzes/33/submissions/777`);
    expect(JSON.parse(String(calls[0].body))).toEqual({
      quiz_submissions: [{ attempt: 2, questions: { '77': { score: 3, comment: 'good' } } }],
    });
  });
});

describe('gradable-item filtering (C# GetGradableItemsAsync)', () => {
  it('drops not_graded and unsupported rows, keeps assignments/discussions/quizzes', async () => {
    const rows = [
      { id: 1, name: 'Essay', submission_types: ['online_upload'], grading_type: 'points' },
      { id: 2, name: 'Survey', submission_types: ['online_text_entry'], grading_type: 'not_graded' },
      { id: 3, name: 'Paper thing', submission_types: ['on_paper'], grading_type: 'points' },
      { id: 4, name: 'Quiz', submission_types: ['online_quiz'], grading_type: 'points', quiz_id: 9 },
      { id: 5, name: 'Discussion', submission_types: ['discussion_topic'], grading_type: 'points' },
      { id: 6, name: 'New Quiz (LTI)', submission_types: ['external_tool'], grading_type: 'points' },
    ];
    const { fetchImpl } = makeFetch([jsonResponse(rows)]);

    const items = await client(fetchImpl).getGradableItems(9);
    expect(items.map((i) => i.id)).toEqual([1, 4, 5]);
  });
});

describe('downloadUrl bearer-host guard', () => {
  it('never sends the bearer to a non-Canvas host', async () => {
    const { fetchImpl, calls } = makeFetch([textResponse('file-bytes')]);

    const bytes = await client(fetchImpl).downloadUrl('https://s3.example.com/blob?sig=abc');
    expect(bytes.toString('utf8')).toBe('file-bytes');
    expect(calls[0].headers.get('authorization')).toBeNull();
  });

  it('sends the bearer when the download URL is on the Canvas host', async () => {
    const { fetchImpl, calls } = makeFetch([textResponse('file-bytes')]);

    await client(fetchImpl).downloadUrl(`${BASE}/files/1/download?verifier=v`);
    expect(calls[0].headers.get('authorization')).toBe('Bearer sekrit-token');
  });
});

describe('getSelfEnrollments (PAT course-link verification)', () => {
  it('queries /users/self/enrollments with state/type filters and parses rows', async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse([
        { id: 11, course_id: 9, type: 'TeacherEnrollment', enrollment_state: 'active' },
        { id: 12, course_id: 10, type: 'StudentEnrollment', enrollment_state: 'active' },
      ]),
    ]);

    const enrollments = await client(fetchImpl).getSelfEnrollments({
      state: ['active'],
      types: ['TeacherEnrollment', 'TaEnrollment', 'DesignerEnrollment'],
    });

    expect(enrollments).toHaveLength(2);
    expect(enrollments[0]).toMatchObject({
      id: 11,
      course_id: 9,
      type: 'TeacherEnrollment',
      enrollment_state: 'active',
    });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/v1/users/self/enrollments');
    expect(url.searchParams.getAll('state[]')).toEqual(['active']);
    expect(url.searchParams.getAll('type[]')).toEqual([
      'TeacherEnrollment',
      'TaEnrollment',
      'DesignerEnrollment',
    ]);
    expect(calls[0].headers.get('authorization')).toBe('Bearer sekrit-token');
  });

  it('paginates and omits the filters when none are given', async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse([{ id: 1, course_id: 5, type: 'TaEnrollment' }], {
        headers: {
          link: `<${BASE}/api/v1/users/self/enrollments?page=2>; rel="next"`,
        },
      }),
      jsonResponse([{ id: 2, course_id: 6, type: 'DesignerEnrollment' }]),
    ]);

    const enrollments = await client(fetchImpl).getSelfEnrollments();
    expect(enrollments.map((e) => e.id)).toEqual([1, 2]);
    const url = new URL(calls[0].url);
    expect(url.searchParams.has('state[]')).toBe(false);
    expect(url.searchParams.has('type[]')).toBe(false);
  });
});
