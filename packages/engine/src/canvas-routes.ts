// Canvas identity + course endpoints for the local UI and the MCP tools
// (the engine owns every Canvas API call — the web tier only relays).
// Mounted at /canvas on the in-process engine app.
//
//   GET  /canvas/instances      → the configured Canvas instances
//                                 [{host, baseUrl}] (never tokens)
//   POST /canvas/whoami         {apiDomain?}
//     → SSRF policy → GET /users/self → {canvasUserId, canvasUserName, host}.
//       Canvas 401/403 → 422 {error:'invalid_token'} (the PAT is bad).
//   POST /canvas/courses/list   {apiDomain?}
//     → courses the token holder can grade in (enrollment types teacher, ta,
//       designer — merged + deduped) → {courses:[{id,name,courseCode,enrollmentRole}]}.
//   POST /canvas/courses/verify {apiDomain?, courseId}
//     → the caller's OWN enrollments filtered to the course; active staff
//       seat required → {ok:true, enrollmentRole, courseName} | 403.
//
// Credentials come from the teacher's ~/.aigrader/.env via the credential
// provider; every configured base URL is SSRF-re-checked here so a typo'd or
// hostile .env value can never aim the token at a private address. Requests
// share per-token gates through one CanvasGateRegistry. Never log tokens.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  CanvasError,
  CanvasGateRegistry,
  createCanvasClient,
  STAFF_ENROLLMENT_TYPES,
  type CanvasClient,
  type FetchLike,
} from '@aigrader/canvas';
import { CredentialError, type CanvasCredentialProvider } from './credentials.js';
import { assertSafeCanvasBaseUrl, type SsrfOptions } from './ssrf.js';

// ------------------------------------------------------------- body schemas --

const hostBody = z.object({
  /** Canvas host to use; null/absent = the teacher's primary instance. */
  apiDomain: z.string().nullish(),
});

const coursesVerifyBody = hostBody.extend({
  courseId: z.union([z.number().int().positive(), z.string().regex(/^[0-9]+$/)]),
});

// ------------------------------------------------------------------ plumbing --

/** Internal error → HTTP mapping carrier (never contains token bytes). */
class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.message ?? body.error ?? 'route error'));
  }
}

export interface CanvasRoutesDeps {
  /** The teacher's configured Canvas instances. */
  credentials: CanvasCredentialProvider;
  /** Shared per-token gate registry (pass the app-wide singleton). */
  gates?: CanvasGateRegistry;
  /** fetch injection for tests. */
  fetchImpl?: FetchLike;
  /** SSRF options injection for tests (e.g. a fake DNS lookup). */
  ssrfOptions?: SsrfOptions;
}

export function createCanvasRouter(deps: CanvasRoutesDeps): Router {
  const gates = deps.gates ?? new CanvasGateRegistry();

  /** SSRF-check a configured Canvas base URL → https origin. */
  async function safeOrigin(baseUrl: string): Promise<string> {
    try {
      return await assertSafeCanvasBaseUrl(baseUrl, deps.ssrfOptions);
    } catch (err) {
      throw new RouteError(400, {
        error: 'unsafe_canvas_url',
        message:
          err instanceof Error
            ? `CANVAS_BASE_URL failed the safety check: ${err.message}`
            : 'CANVAS_BASE_URL failed the safety check.',
      });
    }
  }

  /** host → gated CanvasClient for the configured credential. */
  async function clientFor(apiDomain: string | null | undefined): Promise<{
    client: CanvasClient;
    host: string;
  }> {
    let credential;
    try {
      credential = deps.credentials.forHost(apiDomain);
    } catch (err) {
      if (err instanceof CredentialError) {
        throw new RouteError(409, { error: err.code, message: err.message });
      }
      throw err;
    }
    const baseUrl = await safeOrigin(credential.baseUrl);
    const client = createCanvasClient({
      baseUrl,
      token: credential.token,
      gate: gates.gateFor(credential.tokenSha256),
      // Tokens are pinned to their own instance: no forDomain hops from these
      // endpoints, so no suffix allowlist is granted.
      trustedSuffixes: [],
      ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}),
    });
    return { client, host: credential.host };
  }

  /** Uniform error → response mapping (no token material ever). */
  function sendError(res: Response, err: unknown): void {
    if (err instanceof RouteError) {
      res.status(err.status).json(err.body);
      return;
    }
    if (err instanceof CanvasError) {
      if (err.status === 401 || err.status === 403) {
        // Canvas refused the bearer — the PAT is invalid/revoked/insufficient.
        res.status(422).json({
          error: 'invalid_token',
          message:
            'Canvas did not accept this access token. Create a new one in Canvas (Account → Settings → New Access Token) and update CANVAS_API_TOKEN in ~/.aigrader/.env.',
        });
        return;
      }
      if (err.status === 404) {
        res.status(404).json({ error: 'not_found', message: 'Canvas resource not found.' });
        return;
      }
      res.status(502).json({
        error: 'canvas_error',
        message: `Canvas request failed with status ${err.status}.`,
      });
      return;
    }
    console.error(
      JSON.stringify({
        severity: 'ERROR',
        message: `canvas-routes failure: ${err instanceof Error ? err.message : 'unknown'}`,
      }),
    );
    res.status(500).json({ error: 'internal', message: 'Unexpected engine error.' });
  }

  function parseBody<S extends z.ZodTypeAny>(schema: S, req: Request): z.infer<S> {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new RouteError(400, {
        error: 'invalid_request',
        message: issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body.',
      });
    }
    return result.data as z.infer<S>;
  }

  // ------------------------------------------------------------------ routes --

  const router = Router();

  router.get('/instances', (_req, res) => {
    res.json({
      instances: deps.credentials.list().map((c) => ({ host: c.host, baseUrl: c.baseUrl })),
    });
  });

  router.post('/whoami', (req, res) => {
    void (async () => {
      const body = parseBody(hostBody, req);
      const { client, host } = await clientFor(body.apiDomain);
      const self = await client.getSelf();
      res.json({
        canvasUserId: String(self.id),
        canvasUserName: self.name ?? self.login_id ?? `Canvas user ${self.id}`,
        host,
      });
    })().catch((err: unknown) => sendError(res, err));
  });

  router.post('/courses/list', (req, res) => {
    void (async () => {
      const body = parseBody(hostBody, req);
      const { client, host } = await clientFor(body.apiDomain);

      // Canvas accepts one enrollment_type per request; merge + dedupe.
      // Iteration order sets role precedence: teacher > ta > designer.
      const byId = new Map<
        number,
        { id: number; name: string; courseCode: string | null; enrollmentRole: string }
      >();
      for (const enrollmentType of ['teacher', 'ta', 'designer'] as const) {
        const courses = await client.listCourses({ enrollmentType });
        for (const course of courses) {
          if (byId.has(course.id)) continue;
          byId.set(course.id, {
            id: course.id,
            name: course.name ?? course.course_code ?? `Course ${course.id}`,
            courseCode: course.course_code ?? null,
            enrollmentRole: enrollmentType,
          });
        }
      }
      const courses = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
      res.json({ host, courses });
    })().catch((err: unknown) => sendError(res, err));
  });

  router.post('/courses/verify', (req, res) => {
    void (async () => {
      const body = parseBody(coursesVerifyBody, req);
      const { client } = await clientFor(body.apiDomain);
      const courseId = Number(body.courseId);

      const enrollments = await client.getSelfEnrollments({
        state: ['active'],
        types: Object.keys(STAFF_ENROLLMENT_TYPES),
      });
      const staffRoles = enrollments
        .filter((e) => e.course_id === courseId && e.enrollment_state === 'active')
        .map((e) => STAFF_ENROLLMENT_TYPES[e.type ?? ''])
        .filter((r): r is 'teacher' | 'ta' | 'designer' => r !== undefined);

      if (staffRoles.length === 0) {
        res.status(403).json({
          ok: false,
          error: 'not_course_staff',
          message:
            'This Canvas account has no active teacher, TA, or designer enrollment in that course.',
        });
        return;
      }
      const precedence = ['teacher', 'ta', 'designer'] as const;
      const enrollmentRole = precedence.find((r) => staffRoles.includes(r))!;

      const info = await client.getCourseInfo(courseId);
      res.json({
        ok: true,
        enrollmentRole,
        courseName: info.name ?? `Course ${courseId}`,
      });
    })().catch((err: unknown) => sendError(res, err));
  });

  return router;
}
