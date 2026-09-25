// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Telemetry\AuditLogger.cs (actions)
// Ported from: C:\Devs\AIgrader\lib\audit\log.ts (metadata allowlist pattern)
//
// The audit trail. Compliance-relevant events (who ran grading on what, what
// posted to Canvas, configuration changes) emit one structured JSON line to
// the audit sink. The local server installs a sink that appends to
// ~/.aigrader/audit/audit-YYYY-MM.jsonl; the default sink is stdout.
//
// PII guardrail carried from both predecessors: event fields hold IDS AND
// COUNTS ONLY — never student names, never emails, never submission content,
// never feedback text. Canvas itself is the system of record for the grades;
// this trail records THAT things happened, not WHAT the content was.

/** The C# AuditAction enum values, verbatim (order preserved — pinned by
 * tests). 'LaunchDenied' now records a course the Canvas token cannot staff
 * (the local equivalent of a refused LTI launch). */
export const CSHARP_AUDIT_ACTIONS = [
  'RunCreated', // a grading run was created (faculty started AI grading)
  'RunResumed', // a run was resumed after an interruption
  'GradePosted', // a grade + comment posted to Canvas
  'QuizGradesPosted', // a batch of quiz question grades posted to Canvas
  'ProfileUpdated', // the course AI Profile was saved
  'ProfileImported', // a profile was imported from another course
  'AlignmentReviewed', // an AI alignment review ran
  'RubricUpdated', // an assignment rubric was edited and saved back to Canvas
  'OutcomeLinked', // an existing library outcome was linked into the course
  'OutcomeCreated', // a new outcome was created in (and linked to) the course
  'OutcomeUnlinked', // an outcome was unlinked from the course
  'LaunchDenied', // course access refused (the token is not course staff there)
] as const;

/** Every audit action the app records. */
export const AUDIT_ACTIONS = [...CSHARP_AUDIT_ACTIONS] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// Keys that are safe to land in an audit event. Audit lines are plaintext on
// the teacher's disk, so any PII written here would sit there unencrypted.
// Keep this list tight — adding a key here is a security review trigger.
export const ALLOWED_AUDIT_KEYS = new Set<string>([
  // identifiers (IDs and pointers only — never names, never emails)
  'runId',
  'courseKey',
  'canvasCourseId',
  'canvasAssignmentId',
  'canvasQuizId',
  'canvasDiscussionTopicId',
  'canvasSubmissionId',
  'canvasUserId',
  'actorCanvasUserId',
  'apiDomain',
  'questionId',
  'outcomeId',
  'criterionId',
  'rubricId', // Canvas rubric id (RubricUpdated — the C# event logged it)
  'enrollmentRole', // Canvas enrollment type (LaunchDenied) — never a display name
  'approvalChannel', // how an approval arrived: 'browser' (the only allowed channel)
  'reviewSeconds', // time the reviewer spent on a draft before approving
  // counts
  'totalCount',
  'completedCount',
  'errorCount',
  'postedCount',
  'gradeCount',
  'questionCount',
  'outcomeCount',
  'rubricCriterionCount',
  'issueCount',
  'resumeCount',
  'purgedCount',
  // operational metadata
  'gradingMode',
  'modelName',
  'durationMs',
  'errorCode',
  'draftOnly',
  'retentionDays',
  'alignmentScore',
  'method',
  'status', // run/row status enum values, never free-form
  // Add new keys here only after security review confirms they cannot
  // contain free-form student content (no extractedText, no AI drafts,
  // no faculty-edited feedback, no names, no emails).
]);

export type AuditFields = Record<string, string | number | boolean | null | undefined>;

/** Where audit lines go. Receives one serialized JSON line (newline
 * included). The local server swaps in a JSONL file appender. */
export type AuditSink = (line: string) => void;

const stdoutSink: AuditSink = (line) => {
  process.stdout.write(line);
};

let currentSink: AuditSink = stdoutSink;

/** Installs the audit sink (null restores the stdout default). */
export function setAuditSink(sink: AuditSink | null): void {
  currentSink = sink ?? stdoutSink;
}

/**
 * Record one audit event as a structured JSON line (severity INFO; fields
 * land as `audit.*`, mirroring the C# App Insights property names).
 *
 * `fields` is filtered against ALLOWED_AUDIT_KEYS — disallowed keys are
 * dropped (and warned). Best-effort by contract: an audit sink outage must
 * never block grading, so this never throws.
 */
export function audit(action: AuditAction, fields: AuditFields = {}): void {
  try {
    const entry: Record<string, unknown> = {
      severity: 'INFO',
      time: new Date().toISOString(),
      message: `AUDIT ${action}`,
      'audit.action': action,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value === null || value === undefined) continue;
      if (!ALLOWED_AUDIT_KEYS.has(key)) {
        console.warn(
          '[audit] dropping disallowed audit field %s — add to ALLOWED_AUDIT_KEYS only after security review',
          key,
        );
        continue;
      }
      entry[`audit.${key}`] = value;
    }
    currentSink(`${JSON.stringify(entry)}\n`);
  } catch {
    // Best-effort by contract — see the function docs.
  }
}
