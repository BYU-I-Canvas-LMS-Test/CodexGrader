'use client';

// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\Shared\LoadingPane.razor
// The viewer's loading indicator: a brand-accent wheel with a label. Say the
// thing being loaded, not just "Loading…" — a bare spinner reads as a hang.

export function LoadingPane({ label, compact }: { label: string; compact?: boolean }) {
  return (
    <div className={`loading-pane${compact ? ' compact' : ''}`} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="loading-label">{label}</span>
    </div>
  );
}
