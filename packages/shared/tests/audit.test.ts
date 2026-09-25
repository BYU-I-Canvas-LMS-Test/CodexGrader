import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { audit, setAuditSink, ALLOWED_AUDIT_KEYS, AUDIT_ACTIONS } from '../src/index.js';

let lines: string[];
let stdoutSpy: MockInstance;
let warnSpy: MockInstance;

beforeEach(() => {
  lines = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  stdoutSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('audit', () => {
  it('emits one structured line with severity INFO and audit.action', () => {
    audit('GradePosted', { runId: 'run-1', canvasCourseId: 4409, postedCount: 3 });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith('\n')).toBe(true);
    const entry = JSON.parse(lines[0]!);
    expect(entry.severity).toBe('INFO');
    expect(entry['audit.action']).toBe('GradePosted');
    expect(entry['audit.runId']).toBe('run-1');
    expect(entry['audit.canvasCourseId']).toBe(4409);
    expect(entry['audit.postedCount']).toBe(3);
    expect(typeof entry.time).toBe('string');
  });

  it('writes to an installed sink instead of stdout, and null restores stdout', () => {
    const captured: string[] = [];
    setAuditSink((line) => captured.push(line));
    try {
      audit('RunCreated', { runId: 'run-sink' });
      expect(lines).toHaveLength(0);
      expect(captured).toHaveLength(1);
      expect(JSON.parse(captured[0]!)['audit.runId']).toBe('run-sink');
    } finally {
      setAuditSink(null);
    }
    audit('RunCreated', { runId: 'run-back' });
    expect(lines).toHaveLength(1);
  });

  it('DROPS non-allowlisted keys (never names/emails/content) and warns', () => {
    audit('RunCreated', {
      runId: 'run-2',
      studentName: 'Ada Lovelace', // PII — must never land in the log
      email: 'ada@example.edu',
      assignmentFeedback: 'free-form content',
    });
    const entry = JSON.parse(lines[0]!);
    expect(entry['audit.runId']).toBe('run-2');
    expect(JSON.stringify(entry)).not.toContain('Ada Lovelace');
    expect(JSON.stringify(entry)).not.toContain('ada@example.edu');
    expect(JSON.stringify(entry)).not.toContain('free-form content');
    expect(entry['audit.studentName']).toBeUndefined();
    expect(entry['audit.email']).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it('skips null/undefined values and works with no fields at all', () => {
    audit('LaunchDenied', { enrollmentRole: undefined, canvasUserId: null });
    const entry = JSON.parse(lines[0]!);
    expect('audit.enrollmentRole' in entry).toBe(false);
    expect('audit.canvasUserId' in entry).toBe(false);
    audit('RunResumed');
    expect(JSON.parse(lines[1]!)['audit.action']).toBe('RunResumed');
  });

  it('is best-effort: a broken stdout never throws into the caller', () => {
    stdoutSpy.mockImplementation(() => {
      throw new Error('sink down');
    });
    expect(() => audit('ProfileUpdated', { runId: 'x' })).not.toThrow();
  });

  it('ports the C# AuditAction enum values verbatim (and nothing else)', () => {
    expect([...AUDIT_ACTIONS]).toEqual([
      'RunCreated',
      'RunResumed',
      'GradePosted',
      'QuizGradesPosted',
      'ProfileUpdated',
      'ProfileImported',
      'AlignmentReviewed',
      'RubricUpdated',
      'OutcomeLinked',
      'OutcomeCreated',
      'OutcomeUnlinked',
      'LaunchDenied',
    ]);
    // spot-check the allowlist stays IDs/counts-only
    expect(ALLOWED_AUDIT_KEYS.has('runId')).toBe(true);
    expect(ALLOWED_AUDIT_KEYS.has('approvalChannel')).toBe(true);
    expect(ALLOWED_AUDIT_KEYS.has('tokenId')).toBe(false);
    expect(ALLOWED_AUDIT_KEYS.has('studentName')).toBe(false);
    expect(ALLOWED_AUDIT_KEYS.has('email')).toBe(false);
  });
});
