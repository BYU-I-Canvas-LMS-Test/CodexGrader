// Ported from: C:\Devs\AIGrader-C#\tests\AiGrader.Tests\AssignmentBoardTests.cs
// — the assignments-page workload model: bucket classification (gradingBucket,
// which lives with the Canvas DTOs) and within-section ordering
// (sortAssignments).

import { describe, expect, it } from 'vitest';
import { gradingBucket } from '@aigrader/canvas';
import { sortAssignments } from '../src/grading/assignment-board.js';

function item(
  name = 'A',
  opts: { needsGrading?: number | null; submitted?: boolean; dueAt?: string | null } = {},
) {
  return {
    name,
    needs_grading_count: opts.needsGrading ?? null,
    has_submitted_submissions: opts.submitted ?? false,
    due_at: opts.dueAt ?? null,
  };
}

describe('gradingBucket (CanvasAssignment.Bucket port)', () => {
  it('Bucket_NeedsGradingPositive_IsReadyToGrade', () => {
    expect(gradingBucket(item('A', { needsGrading: 3, submitted: true }))).toBe('ready_to_grade');
  });

  it('Bucket_SubmittedAndNothingPending_IsPast', () => {
    expect(gradingBucket(item('A', { needsGrading: 0, submitted: true }))).toBe('past');
  });

  it('Bucket_NoSubmissions_IsUpcoming', () => {
    expect(gradingBucket(item('A', { needsGrading: 0, submitted: false }))).toBe('upcoming');
  });

  it('Bucket_NullCountNoSubmissions_IsUpcoming', () => {
    expect(gradingBucket(item('A', { needsGrading: null, submitted: false }))).toBe('upcoming');
  });
});

describe('sortAssignments (AssignmentBoard.Sort port)', () => {
  it('Sort_DueDate_OrdersAscendingWithNullsLast', () => {
    const items = [
      item('none'),
      item('late', { dueAt: '2026-03-01T00:00:00Z' }),
      item('early', { dueAt: '2026-01-01T00:00:00Z' }),
    ];
    const sorted = sortAssignments(items, 'dueDate');
    expect(sorted.map((a) => a.name)).toEqual(['early', 'late', 'none']);
  });

  it('Sort_DueDateDescending_MostRecentFirstNullsStillLast', () => {
    const items = [
      item('none'),
      item('early', { dueAt: '2026-01-01T00:00:00Z' }),
      item('late', { dueAt: '2026-03-01T00:00:00Z' }),
    ];
    const sorted = sortAssignments(items, 'dueDate', true);
    expect(sorted.map((a) => a.name)).toEqual(['late', 'early', 'none']);
  });

  it('Sort_Name_IsCaseInsensitive', () => {
    const items = [
      item('banana', { dueAt: '2026-01-01T00:00:00Z' }),
      item('Apple'),
      item('cherry', { dueAt: '2025-01-01T00:00:00Z' }),
    ];
    const sorted = sortAssignments(items, 'name');
    expect(sorted.map((a) => a.name)).toEqual(['Apple', 'banana', 'cherry']);
  });

  it('does not mutate the input array', () => {
    const items = [item('b'), item('a')];
    sortAssignments(items, 'name');
    expect(items.map((a) => a.name)).toEqual(['b', 'a']);
  });
});
