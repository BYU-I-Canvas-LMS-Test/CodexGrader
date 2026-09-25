// GradingContext — the per-request object everything course-scoped in the
// web tier hangs off. In the local tool there is ONE signed-in teacher (the
// owner of the Canvas token in ~/.aigrader/.env); the context names the
// course being viewed and whether that teacher is staff there.
//
// No token material ever rides in a context — the engine resolves the
// teacher's token from the course host on its own side.

export interface GradingContextUser {
  displayName: string;
  /** Canvas numeric user id (string), when known. */
  canvasUserId?: string;
}

export interface GradingContext {
  authSource: 'local';
  user: GradingContextUser;
  /** e.g. https://byui.instructure.com */
  canvasBaseUrl: string;
  /** Canvas numeric course id (string end-to-end — raw-string discipline). */
  courseId: string;
  /** The course address: `${host}#${courseId}` (see @aigrader/shared course-key). */
  courseKey: string;
  /** The course's Canvas name (from the staff check). */
  courseName: string;
  /** The teacher's enrollment role in this course ('teacher' | 'ta' | 'designer'). */
  roles: string[];
  isCourseStaff: boolean;
}

/** Error shape thrown by requireGradingContext / requireCourseStaff — route
 * handlers map `status` straight onto the HTTP response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
