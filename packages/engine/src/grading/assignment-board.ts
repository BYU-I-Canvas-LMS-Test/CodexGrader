// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Grading\AssignmentBoard.cs
// (pinned by tests\AiGrader.Tests\AssignmentBoardTests.cs — TS port in
// ../tests/assignment-board.test.ts).
//
// Ordering logic for the faculty assignments page, kept pure and engine-side
// (the engine owns Canvas, so the assignment list itself is fetched here
// too — the UI and MCP tools read it via /course/assignments). Bucketing lives
// with the Canvas DTOs (@aigrader/canvas gradingBucket); this file only sorts
// within a bucket. BYU-I usability enhancement — no TS-predecessor
// equivalent.

import type { CanvasAssignment } from '@aigrader/canvas';

/** How the faculty assignments list is ordered within each section. */
export type AssignmentSortKey =
  /** By due date — the default; the grading cadence faculty work to. */
  | 'dueDate'
  /** Alphabetically by assignment name. */
  | 'name';

/** The fields sorting reads (structural so tests build minimal rows). */
export type SortableAssignment = Pick<CanvasAssignment, 'name' | 'due_at'>;

function byNameCaseInsensitive(a: SortableAssignment, b: SortableAssignment): number {
  const an = (a.name ?? '').toLowerCase();
  const bn = (b.name ?? '').toLowerCase();
  return an < bn ? -1 : an > bn ? 1 : 0;
}

/**
 * Returns `items` ordered by the chosen key; the input array is not mutated.
 * Under 'dueDate', assignments with no due date always sort LAST (regardless
 * of direction) so dated work stays on top; `dueDateDescending` flips dated
 * items to most-recent first (used for the Past section). 'name' sorts
 * case-insensitively and ignores the direction flag.
 */
export function sortAssignments<T extends SortableAssignment>(
  items: readonly T[],
  key: AssignmentSortKey,
  dueDateDescending = false,
): T[] {
  if (key === 'name') {
    return [...items].sort(byNameCaseInsensitive);
  }

  // Due date: undated items last in both directions, then by date.
  const dated = items
    .filter((a) => a.due_at != null)
    .sort((a, b) => {
      const at = Date.parse(a.due_at!);
      const bt = Date.parse(b.due_at!);
      return dueDateDescending ? bt - at : at - bt;
    });
  const undated = items.filter((a) => a.due_at == null).sort(byNameCaseInsensitive);
  return [...dated, ...undated];
}
