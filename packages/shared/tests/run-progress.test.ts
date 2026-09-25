import { describe, it, expect } from 'vitest';
import { RunProgressDocSchema } from '../src/index.js';

describe('RunProgressDocSchema', () => {
  it('parses a full progress record with ISO-string timestamps', () => {
    const doc = RunProgressDocSchema.parse({
      runId: '0f8fad5bd9cb469fa1656ea4d17fadf1',
      canvasCourseId: 4409,
      canvasAssignmentId: 11824,
      apiDomain: 'byupw.instructure.com',
      courseKey: 'byupw.instructure.com#4409',
      status: 'RUNNING',
      counts: {
        total: 30, pending: 10, extracting: 2, scoring: 3,
        drafted: 12, edited: 1, approved: 1, posted: 0, errors: 1,
      },
      cancelRequested: false,
      worker: { owner: 'laptop-1:abc', heartbeatAt: '2026-07-27T10:00:00Z', resumeCount: 1 },
      checkpoint: { lastSavedAt: '2026-07-27T09:59:45Z' },
      createdAt: '2026-07-27T09:00:00Z',
      updatedAt: '2026-07-27T10:00:00Z',
    });
    expect(doc.status).toBe('RUNNING');
    expect(doc.counts.drafted).toBe(12);
    expect(doc.worker.resumeCount).toBe(1);
    expect(doc.checkpoint.lastSavedAt).toBe('2026-07-27T09:59:45Z');
    expect(doc.courseKey).toBe('byupw.instructure.com#4409');
  });

  it('defaults counts/worker/checkpoint/flags for a freshly seeded record', () => {
    const doc = RunProgressDocSchema.parse({
      runId: 'r1',
      canvasCourseId: 1,
      canvasAssignmentId: 2,
      createdAt: '2026-07-27T09:00:00Z',
      updatedAt: '2026-07-27T09:00:00Z',
    });
    expect(doc.status).toBe('PENDING');
    expect(doc.counts.total).toBe(0);
    expect(doc.counts.errors).toBe(0);
    expect(doc.cancelRequested).toBe(false);
    expect(doc.worker).toEqual({ owner: '', heartbeatAt: null, resumeCount: 0 });
    expect(doc.checkpoint.lastSavedAt).toBeNull();
    expect(doc.apiDomain).toBeNull();
    expect(doc.courseKey).toBe('');
  });

  it('uses the same RunStatus SNAKE_UPPER enum as the Canvas run document', () => {
    expect(
      RunProgressDocSchema.safeParse({
        runId: 'r1', canvasCourseId: 1, canvasAssignmentId: 2,
        status: 'running',
        createdAt: '2026-07-27T09:00:00Z', updatedAt: '2026-07-27T09:00:00Z',
      }).success,
    ).toBe(false);
  });

  it('rejects negative counts', () => {
    expect(
      RunProgressDocSchema.safeParse({
        runId: 'r1', canvasCourseId: 1, canvasAssignmentId: 2,
        counts: { total: -1 },
        createdAt: '2026-07-27T09:00:00Z', updatedAt: '2026-07-27T09:00:00Z',
      }).success,
    ).toBe(false);
  });
});
