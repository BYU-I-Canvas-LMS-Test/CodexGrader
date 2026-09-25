// /canvas endpoints over the teacher's configured credentials: instances
// (never tokens), whoami (SSRF re-check + invalid-token mapping),
// courses/list (3-enrollment-type merge + dedupe), courses/verify (active
// staff seat required), and the not-configured / unknown-host errors.
// Canvas HTTP is faked with the queue fetch mock.

import { describe, expect, it } from 'vitest';
import express from 'express';
import { CanvasGateRegistry } from '@aigrader/canvas';
import { createCanvasRouter, type CanvasRoutesDeps } from '../src/canvas-routes.js';
import { StaticCredentialProvider, type CredentialEntry } from '../src/credentials.js';
import { jsonResponse, makeFetch, postJson, textResponse, withServer, type MockResponder } from './helpers.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

const PRIMARY: CredentialEntry = { baseUrl: 'https://school.instructure.com', token: 'stored-pat' };

function buildApp(
  responses: MockResponder[],
  opts: { entries?: CredentialEntry[]; deps?: Partial<CanvasRoutesDeps> } = {},
) {
  const { fetchImpl, calls } = makeFetch(responses);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(
    '/canvas',
    createCanvasRouter({
      credentials: new StaticCredentialProvider(opts.entries ?? [PRIMARY]),
      fetchImpl,
      gates: new CanvasGateRegistry(),
      ssrfOptions: { lookup: publicLookup },
      ...opts.deps,
    }),
  );
  return { app, calls };
}

async function getJson(base: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

describe('GET /canvas/instances', () => {
  it('lists configured hosts + base URLs and NEVER the tokens', async () => {
    const { app } = buildApp([], {
      entries: [PRIMARY, { baseUrl: 'https://byupw.instructure.com/', token: 'second-pat' }],
    });
    await withServer(app, async (base) => {
      const res = await getJson(base, '/canvas/instances');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        instances: [
          { host: 'school.instructure.com', baseUrl: 'https://school.instructure.com' },
          { host: 'byupw.instructure.com', baseUrl: 'https://byupw.instructure.com' },
        ],
      });
      expect(JSON.stringify(res.body)).not.toContain('pat');
    });
  });
});

describe('POST /canvas/whoami', () => {
  it('checks the configured token against /users/self and returns the identity', async () => {
    const { app, calls } = buildApp([jsonResponse({ id: 4242, name: 'Prof. Ada' })]);
    await withServer(app, async (base) => {
      const res = await postJson(base, '/canvas/whoami', {});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        canvasUserId: '4242',
        canvasUserName: 'Prof. Ada',
        host: 'school.instructure.com',
      });
    });
    expect(calls[0]!.url).toBe('https://school.instructure.com/api/v1/users/self');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer stored-pat');
  });

  it('routes to a second configured instance by host', async () => {
    const { app, calls } = buildApp([jsonResponse({ id: 7, name: 'Prof. Ada' })], {
      entries: [PRIMARY, { baseUrl: 'https://byupw.instructure.com', token: 'second-pat' }],
    });
    await withServer(app, async (base) => {
      const res = await postJson(base, '/canvas/whoami', { apiDomain: 'byupw.instructure.com' });
      expect(res.status).toBe(200);
    });
    expect(calls[0]!.url).toBe('https://byupw.instructure.com/api/v1/users/self');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer second-pat');
  });

  it('maps Canvas 401 to 422 invalid_token without echoing the token', async () => {
    const { app } = buildApp([textResponse('{"errors":[{"message":"Invalid access token."}]}', { status: 401 })]);
    await withServer(app, async (base) => {
      const res = await postJson(base, '/canvas/whoami', {});
      expect(res.status).toBe(422);
      expect((res.body as { error: string }).error).toBe('invalid_token');
      expect(JSON.stringify(res.body)).not.toContain('stored-pat');
    });
  });

  it('refuses a configured base URL that resolves to a private address (SSRF)', async () => {
    const { app, calls } = buildApp([], {
      entries: [{ baseUrl: 'https://canvas.example.edu', token: 'pat' }],
      deps: { ssrfOptions: { lookup: async () => [{ address: '10.0.0.5', family: 4 }] } },
    });
    await withServer(app, async (base) => {
      const res = await postJson(base, '/canvas/whoami', {});
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe('unsafe_canvas_url');
    });
    expect(calls).toHaveLength(0);
  });

  it('answers 409 not_configured when the .env has no token', async () => {
    const { app, calls } = buildApp([], { entries: [] });
    await withServer(app, async (base) => {
      const res = await postJson(base, '/canvas/whoami', {});
      expect(res.status).toBe(409);
      expect((res.body as { error: string }).error).toBe('not_configured');
      expect((res.body as { message: string }).message).toContain('~/.aigrader/.env');
    });
    expect(calls).toHaveLength(0);
  });

  it('answers 409 unknown_host for an instance the teacher never configured', async () => {
    const { app } = buildApp([]);
    await withServer(app, async (base) => {
      const res = await postJson(base, '/canvas/whoami', { apiDomain: 'other.instructure.com' });
      expect(res.status).toBe(409);
      expect((res.body as { error: string }).error).toBe('unknown_host');
    });
  });
});

describe('POST /canvas/courses/list', () => {
  it('merges teacher/ta/designer enrollments, deduping by course id', async () => {
    const { app, calls } = buildApp([
      jsonResponse([
        { id: 1, name: 'Biology 101', course_code: 'BIO-101' },
        { id: 2, name: 'Chemistry 201', course_code: 'CHEM-201' },
      ]),
      jsonResponse([
        { id: 2, name: 'Chemistry 201', course_code: 'CHEM-201' }, // dupe → keeps teacher-first role
        { id: 3, name: 'Algebra', course_code: 'MATH-1' },
      ]),
      jsonResponse([{ id: 4, name: 'Design Studio', course_code: 'DES-9' }]),
    ]);

    await withServer(app, async (base) => {
      const res = await postJson(base, '/canvas/courses/list', {});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        host: 'school.instructure.com',
        courses: [
          { id: 3, name: 'Algebra', courseCode: 'MATH-1', enrollmentRole: 'ta' },
          { id: 1, name: 'Biology 101', courseCode: 'BIO-101', enrollmentRole: 'teacher' },
          { id: 2, name: 'Chemistry 201', courseCode: 'CHEM-201', enrollmentRole: 'teacher' },
          { id: 4, name: 'Design Studio', courseCode: 'DES-9', enrollmentRole: 'designer' },
        ],
      });
    });

    const types = calls.map((c) => new URL(c.url).searchParams.get('enrollment_type'));
    expect(types).toEqual(['teacher', 'ta', 'designer']);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer stored-pat');
  });

  it('rejects malformed bodies with 400', async () => {
    const { app } = buildApp([]);
    await withServer(app, async (base) => {
      const res = await postJson(base, '/canvas/courses/list', { apiDomain: 42 });
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toBe('invalid_request');
    });
  });
});

describe('POST /canvas/courses/verify', () => {
  const enrollments = [
    { id: 1, course_id: 42, type: 'TaEnrollment', enrollment_state: 'active' },
    { id: 2, course_id: 42, type: 'TeacherEnrollment', enrollment_state: 'active' },
    { id: 3, course_id: 99, type: 'TeacherEnrollment', enrollment_state: 'active' },
  ];

  it('confirms an active staff seat and returns role (teacher precedence) + course name', async () => {
    const { app, calls } = buildApp([
      jsonResponse(enrollments),
      jsonResponse({ id: 42, name: 'Biology 101', account_id: 5 }),
    ]);
    await withServer(app, async (base) => {
      const res = await postJson(base, '/canvas/courses/verify', { courseId: 42 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, enrollmentRole: 'teacher', courseName: 'Biology 101' });
    });
    const enrollUrl = new URL(calls[0]!.url);
    expect(enrollUrl.pathname).toBe('/api/v1/users/self/enrollments');
    expect(enrollUrl.searchParams.getAll('state[]')).toEqual(['active']);
    expect(calls[1]!.url).toBe('https://school.instructure.com/api/v1/courses/42');
  });

  it('refuses when the caller has no staff enrollment in that course', async () => {
    const { app } = buildApp([jsonResponse(enrollments)]);
    await withServer(app, async (base) => {
      const res = await postJson(base, '/canvas/courses/verify', { courseId: 777 });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ ok: false, error: 'not_course_staff' });
    });
  });

  it('an inactive (completed) staff enrollment does not count', async () => {
    const { app } = buildApp([
      jsonResponse([
        { id: 9, course_id: 55, type: 'TeacherEnrollment', enrollment_state: 'completed' },
      ]),
    ]);
    await withServer(app, async (base) => {
      const res = await postJson(base, '/canvas/courses/verify', { courseId: 55 });
      expect(res.status).toBe(403);
    });
  });

  it('maps Canvas 401 during verification to 422 invalid_token', async () => {
    const { app } = buildApp([textResponse('unauthorized', { status: 401 })]);
    await withServer(app, async (base) => {
      const res = await postJson(base, '/canvas/courses/verify', { courseId: 42 });
      expect(res.status).toBe(422);
      expect((res.body as { error: string }).error).toBe('invalid_token');
    });
  });
});
