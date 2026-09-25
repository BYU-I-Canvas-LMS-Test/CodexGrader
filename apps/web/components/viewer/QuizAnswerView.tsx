'use client';

// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\Shared\Viewer\QuizAnswerView.razor
// One quiz answer on the per-question review: the stored plain-text excerpt
// (always available, ≤2000 chars) in a readable collapsed block, with a
// "view full formatted answer" action that asks the page to live-fetch the
// attempt's answers from Canvas (one call per attempt, page-cached) and swaps
// in the sanitized HTML. fullHtml semantics: null = not fetched yet (offer
// the action); '' = fetched but no richer version exists (excerpt stands);
// otherwise = sanitized HTML to render (sanitized WORKER-side — the web only
// renders vetted markup). Expand/Collapse applies to whichever body is
// showing — the full formatted answer needs it as much as a long excerpt.

import * as React from 'react';

export function QuizAnswerView({
  excerpt,
  fullHtml,
  loading,
  onRequestFull,
}: {
  /** Stored plain-text excerpt (≤2000 chars), always available. */
  excerpt?: string | null;
  /** Sanitized full answer HTML: null until requested, '' when the fetch
   * found nothing richer than the excerpt. */
  fullHtml: string | null;
  /** True while the attempt's answers are being fetched. */
  loading?: boolean;
  /** Raised when the user asks for the full formatted answer. */
  onRequestFull: () => void;
}) {
  const [expanded, setExpanded] = React.useState(false);

  // Length of whichever body is currently rendered — the collapsed box only
  // needs an Expand button when the content can overflow it.
  const bodyLength = fullHtml ? fullHtml.length : excerpt?.length ?? 0;

  return (
    <>
      <div className={`review-answer${expanded ? ' expanded' : ''}`}>
        {fullHtml ? (
          <div
            className="review-answer-full"
            // Sanitized worker-side (see module header).
            dangerouslySetInnerHTML={{ __html: fullHtml }}
          />
        ) : excerpt ? (
          <pre className="review-answer-pre">{excerpt}</pre>
        ) : null}
      </div>
      <div className="review-answer-actions">
        {fullHtml === null ? (
          <button type="button" className="btn-ghost" disabled={loading} onClick={onRequestFull}>
            {loading ? 'Loading…' : 'View full formatted answer'}
          </button>
        ) : null}
        {!expanded && bodyLength > 300 ? (
          <button type="button" className="btn-ghost" onClick={() => setExpanded(true)}>
            Expand
          </button>
        ) : expanded ? (
          <button type="button" className="btn-ghost" onClick={() => setExpanded(false)}>
            Collapse
          </button>
        ) : null}
      </div>
    </>
  );
}
