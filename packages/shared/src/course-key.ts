// courseKey — the tenancy unit: `${host}#${courseId}`.
// Canvas course ids are only unique per instance, so every course-scoped
// record is keyed by host + id together. The key must be CANONICAL (bare
// lowercase host, no scheme/port/path; plain decimal id) because it keys
// in-memory caches, run lookups, and the local active-runs index — two
// spellings of the same course must never produce two entries.

const COURSE_KEY_SEPARATOR = '#';

// Bare hostname: lowercase alphanumeric labels, optional hyphens inside a
// label, dot-separated. No scheme, no port, no path, no trailing dot.
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

const COURSE_ID_PATTERN = /^[0-9]+$/;

function assertValidHost(host: string): void {
  if (!HOST_PATTERN.test(host)) {
    throw new Error(
      `Invalid Canvas host "${host}": expected a bare lowercase hostname ` +
        '(no scheme, port, path, or uppercase), e.g. "byui.instructure.com".',
    );
  }
}

function normalizeCourseId(courseId: number | string): string {
  if (typeof courseId === 'number') {
    if (!Number.isSafeInteger(courseId) || courseId <= 0) {
      throw new Error(`Invalid Canvas course id ${courseId}: expected a positive integer.`);
    }
    return String(courseId);
  }
  if (!COURSE_ID_PATTERN.test(courseId) || Number(courseId) <= 0) {
    throw new Error(`Invalid Canvas course id "${courseId}": expected a positive integer.`);
  }
  if (!Number.isSafeInteger(Number(courseId))) {
    throw new Error(`Invalid Canvas course id "${courseId}": exceeds safe integer range.`);
  }
  return String(Number(courseId)); // canonical: strips leading zeros
}

/** Build the canonical course key, e.g. makeCourseKey("byui.instructure.com", 4409)
 * → "byui.instructure.com#4409". Throws on non-canonical input. */
export function makeCourseKey(host: string, courseId: number | string): string {
  assertValidHost(host);
  return `${host}${COURSE_KEY_SEPARATOR}${normalizeCourseId(courseId)}`;
}

export interface ParsedCourseKey {
  host: string;
  courseId: number;
}

/** Split and validate a course key produced by makeCourseKey. Throws on
 * malformed keys (wrong separator count, bad host, non-numeric id). */
export function parseCourseKey(key: string): ParsedCourseKey {
  const separatorIndex = key.indexOf(COURSE_KEY_SEPARATOR);
  if (separatorIndex < 0) {
    throw new Error(`Invalid course key "${key}": missing "${COURSE_KEY_SEPARATOR}" separator.`);
  }
  const host = key.slice(0, separatorIndex);
  const idPart = key.slice(separatorIndex + 1);
  assertValidHost(host);
  if (!COURSE_ID_PATTERN.test(idPart) || Number(idPart) <= 0) {
    throw new Error(`Invalid course key "${key}": course id must be a positive integer.`);
  }
  const courseId = Number(idPart);
  if (!Number.isSafeInteger(courseId)) {
    throw new Error(`Invalid course key "${key}": course id exceeds safe integer range.`);
  }
  return { host, courseId };
}
