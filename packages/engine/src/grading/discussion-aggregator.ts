// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Services\Grading\DiscussionAggregator.cs
// (itself promoted from AIGrading\Components\Pages\GradingDashboard.razor:1313-1360).
//
// Turns a graded discussion into per-student "submissions": every post and
// reply a student made, in chronological order, as one text document the
// standard grading path can score. Cached briefly per (host, course, topic)
// so a 30-student run fetches the thread once, not 30 times.

import type { DiscussionEntry } from '@aigrader/canvas';
import { stripHtml } from './prompts/strip-html.js';

/** Cache lifetime for one topic's aggregated texts (C#: 5 minutes). */
export const DISCUSSION_CACHE_TTL_MS = 5 * 60 * 1000;

/** The one Canvas call the aggregator makes (structural — tests fake it; the
 * real CanvasClient satisfies it as-is, already flattening the thread). */
export interface DiscussionCanvasPort {
  getDiscussionEntries(courseId: number, topicId: number): Promise<DiscussionEntry[]>;
}

/** C# "MMM d, yyyy h:mm tt" (invariant culture), e.g. "Jun 5, 2026 3:04 PM". */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown time';
  const hours24 = d.getUTCHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  const tt = hours24 < 12 ? 'AM' : 'PM';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${hours12}:${minutes} ${tt}`;
}

/** Builds per-student aggregated discussion texts. */
export class DiscussionAggregator {
  private readonly cache = new Map<string, { value: Map<number, string>; expiresAt: number }>();
  private readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Returns userId → aggregated post text for everyone who posted in the
   * topic. Replies count toward the author's participation (same rule the
   * base app applied); posts are ordered chronologically and labeled
   * "[Post|Reply {n} — {when}]".
   */
  async getStudentTexts(
    canvas: DiscussionCanvasPort,
    courseId: number,
    topicId: number,
    apiDomain: string | null | undefined,
  ): Promise<Map<number, string>> {
    const cacheKey = `aigrader:discussion:${apiDomain ?? 'default'}:${courseId}:${topicId}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > this.now().getTime()) return hit.value;

    // getDiscussionEntries flattens the thread (top-level + nested replies).
    const entries = await canvas.getDiscussionEntries(courseId, topicId);

    const byStudent = new Map<number, DiscussionEntry[]>();
    for (const entry of entries) {
      if (entry.user_id == null) continue;
      if (entry.message == null || entry.message.trim() === '') continue;
      const list = byStudent.get(entry.user_id) ?? [];
      list.push(entry);
      byStudent.set(entry.user_id, list);
    }

    const result = new Map<number, string>();
    for (const [userId, posts] of byStudent) {
      const ordered = [...posts].sort(
        (a, b) => (a.created_at ? Date.parse(a.created_at) : 0) - (b.created_at ? Date.parse(b.created_at) : 0),
      );
      const text = ordered
        .map((e, i) => {
          const kind = e.parent_id != null ? 'Reply' : 'Post';
          const when = e.created_at ? formatWhen(e.created_at) : 'unknown time';
          return `[${kind} ${i + 1} — ${when}]\n${stripHtml(e.message ?? '')}`;
        })
        .join('\n\n');
      result.set(userId, text);
    }

    this.cache.set(cacheKey, {
      value: result,
      expiresAt: this.now().getTime() + DISCUSSION_CACHE_TTL_MS,
    });
    return result;
  }
}
