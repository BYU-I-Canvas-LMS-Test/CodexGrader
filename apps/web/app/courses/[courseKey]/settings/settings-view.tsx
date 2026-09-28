'use client';

// Grader Settings: the model Codex grades with, how hard it thinks, and how
// many students it grades at once. Data flows through GET/PUT /api/settings;
// the local server saves them in ~/.aigrader/settings.json and applies them
// without a restart, so teachers never edit .env for these.

import * as React from 'react';
import type { GradingModelOption, GradingSettings, GradingSettingsView } from '@aigrader/shared';
import { I } from '../_components/icons';
import { ErrorBanner, InfoBanner, PageHead } from '../_components/ui';

const EFFORTS: Record<string, { label: string; help: string }> = {
  low: { label: 'Low', help: 'Fastest, and lightest on your Codex usage. Fine for short, clear-cut work.' },
  medium: { label: 'Medium', help: 'A good balance of care and speed for most assignments.' },
  high: { label: 'High', help: 'Thinks longer about long or complex work. Slower, and uses more of your Codex usage.' },
  xhigh: { label: 'Extra high', help: 'Very thorough. Much slower, and uses much more of your Codex usage.' },
  max: { label: 'Maximum', help: 'The most thorough the model allows. The slowest, and uses the most usage.' },
};

/** Levels offered when the model's own list is unknown. */
const FALLBACK_EFFORTS = ['low', 'medium', 'high'];

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; view: GradingSettingsView }
  | { kind: 'error'; message: string };

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? 'Something went wrong. Try again.';
}

function modelFor(view: GradingSettingsView, slug: string): GradingModelOption | undefined {
  return view.models.find((m) => m.slug === (slug || view.defaultModel));
}

/** Thinking levels the chosen model supports (the current one always included). */
function effortsFor(view: GradingSettingsView, draft: GradingSettings): string[] {
  const levels = modelFor(view, draft.model)?.reasoningLevels ?? [];
  const offered = levels.length > 0 ? levels : FALLBACK_EFFORTS;
  const ordered = view.reasoningEfforts.filter((e) => offered.includes(e) || e === draft.reasoningEffort);
  return ordered.length > 0 ? ordered : offered;
}

/** Keeps the thinking level valid when the model changes. */
function withModel(view: GradingSettingsView, draft: GradingSettings, model: string): GradingSettings {
  const next = { ...draft, model };
  const levels = modelFor(view, model)?.reasoningLevels ?? [];
  if (levels.length === 0 || levels.includes(next.reasoningEffort)) return next;
  const preferred = modelFor(view, model)?.defaultReasoning;
  next.reasoningEffort =
    preferred && levels.includes(preferred) ? preferred : levels.includes('medium') ? 'medium' : levels[0]!;
  return next;
}

function sameSettings(a: GradingSettings, b: GradingSettings): boolean {
  return a.model === b.model && a.reasoningEffort === b.reasoningEffort && a.maxWorkers === b.maxWorkers;
}

export function SettingsView({ courseKey }: { courseKey: string }) {
  const base = `/courses/${encodeURIComponent(courseKey)}`;
  const [load, setLoad] = React.useState<Load>({ kind: 'loading' });
  const [draft, setDraft] = React.useState<GradingSettings | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [savedAt, setSavedAt] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoad({ kind: 'loading' });
    const res = await fetch('/api/settings', { cache: 'no-store' }).catch(() => null);
    if (!res) {
      setLoad({ kind: 'error', message: 'Could not reach the local grader. Is it still running?' });
      return;
    }
    if (!res.ok) {
      setLoad({ kind: 'error', message: await readError(res) });
      return;
    }
    const view = (await res.json()) as GradingSettingsView;
    setLoad({ kind: 'ready', view });
    setDraft(view.settings);
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const view = (await res.json()) as GradingSettingsView;
      setLoad({ kind: 'ready', view });
      setDraft(view.settings);
      setSavedAt(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    } catch {
      setError('Could not reach the local grader. Is it still running?');
    } finally {
      setSaving(false);
    }
  }

  const view = load.kind === 'ready' ? load.view : null;
  const dirty = view !== null && draft !== null && !sameSettings(view.settings, draft);

  return (
    <div className="head-wrap settings-page">
      <PageHead
        crumbs={[{ label: 'Dashboard', href: base }, { label: 'Grader Settings' }]}
        title="Grader Settings"
        sub="Choose the model Codex grades with, how carefully it thinks, and how many students it grades at once."
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {savedAt && !dirty ? (
              <span style={{ fontSize: 12.5, color: 'var(--green-600)' }}>Saved {savedAt}</span>
            ) : null}
            <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? 'Saving…' : 'Save Settings'}
            </button>
          </div>
        }
      />

      <div className="settings-stack">
        <InfoBanner>
          <span>
            These settings apply to every course you grade on this computer. A grading run keeps the
            model and thinking level it started with, so changes apply to the next run you start.
            The number of students graded at once changes right away.
          </span>
        </InfoBanner>

        {error ? <ErrorBanner>{error}</ErrorBanner> : null}

        {load.kind === 'loading' ? <div className="card settings-loading">Loading your settings…</div> : null}

        {load.kind === 'error' ? <ErrorBanner>{load.message}</ErrorBanner> : null}

        {view && draft ? (
          <>
            <CodexNotice view={view} onRetry={() => void refresh()} />
            <ModelCard view={view} draft={draft} onChange={(model) => setDraft(withModel(view, draft, model))} />
            <EffortCard
              view={view}
              draft={draft}
              onChange={(reasoningEffort) => setDraft({ ...draft, reasoningEffort })}
            />
            <WorkersCard view={view} draft={draft} onChange={(maxWorkers) => setDraft({ ...draft, maxWorkers })} />
          </>
        ) : null}
      </div>
    </div>
  );
}

function CodexNotice({ view, onRetry }: { view: GradingSettingsView; onRetry: () => void }) {
  if (!view.codex || view.codex.state === 'ready') return null;
  const message =
    view.codex.state === 'starting'
      ? 'Codex is still starting, so the list of models is not available yet.'
      : `${view.codex.message ?? 'Codex is not available.'} The list of models appears once Codex is ready.`;
  return (
    <InfoBanner
      icon={<I.Warn w={18} h={18} />}
      action={
        <button className="btn btn-secondary" onClick={onRetry}>
          <I.Refresh w={15} h={15} /> Check again
        </button>
      }
    >
      <span>{message}</span>
    </InfoBanner>
  );
}

function ModelCard({
  view,
  draft,
  onChange,
}: {
  view: GradingSettingsView;
  draft: GradingSettings;
  onChange: (model: string) => void;
}) {
  const defaultName = view.models.find((m) => m.slug === view.defaultModel)?.displayName ?? view.defaultModel;
  const knownSaved = draft.model === '' || view.models.some((m) => m.slug === draft.model);
  return (
    <section className="card">
      <label className="lbl" htmlFor="grading-model">
        Model
      </label>
      <p className="lbl-sub">
        The Codex model that reads each submission and drafts the score and feedback. The list comes
        from your own Codex account.
      </p>
      <select
        id="grading-model"
        className="select"
        value={draft.model}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">
          {defaultName ? `Codex recommended (${defaultName})` : 'Codex recommended'}
        </option>
        {view.models.map((m) => (
          <option key={m.slug} value={m.slug}>
            {m.displayName}
          </option>
        ))}
        {knownSaved ? null : <option value={draft.model}>{draft.model} (not available right now)</option>}
      </select>
      {view.activeModel && view.settings.model === draft.model ? (
        <p className="settings-note">
          New grading runs use <strong>{view.models.find((m) => m.slug === view.activeModel)?.displayName ?? view.activeModel}</strong>.
        </p>
      ) : null}
    </section>
  );
}

function EffortCard({
  view,
  draft,
  onChange,
}: {
  view: GradingSettingsView;
  draft: GradingSettings;
  onChange: (effort: string) => void;
}) {
  const efforts = effortsFor(view, draft);
  return (
    <section className="card">
      <div className="lbl" id="thinking-level">
        Thinking level
      </div>
      <p className="lbl-sub">How long the model thinks about each student&apos;s work before drafting.</p>
      <div className="choice-list" role="radiogroup" aria-labelledby="thinking-level">
        {efforts.map((effort) => {
          const info = EFFORTS[effort] ?? { label: effort, help: '' };
          const checked = draft.reasoningEffort === effort;
          return (
            <label key={effort} className={'choice' + (checked ? ' selected' : '')}>
              <input
                type="radio"
                name="thinking-level"
                value={effort}
                checked={checked}
                onChange={() => onChange(effort)}
              />
              <span>
                <span className="choice-title">
                  {info.label}
                  {effort === 'medium' ? <span className="choice-tag">Recommended</span> : null}
                </span>
                <span className="choice-help">{info.help}</span>
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function WorkersCard({
  view,
  draft,
  onChange,
}: {
  view: GradingSettingsView;
  draft: GradingSettings;
  onChange: (workers: number) => void;
}) {
  const counts = Array.from({ length: view.workers.max - view.workers.min + 1 }, (_, i) => view.workers.min + i);
  return (
    <section className="card">
      <div className="lbl" id="workers-label">
        Students graded at once
      </div>
      <p className="lbl-sub">
        More finishes a grading run sooner but spends your Codex usage faster. {view.workers.recommended} is
        recommended.
      </p>
      <div className="seg" role="radiogroup" aria-labelledby="workers-label">
        {counts.map((n) => (
          <label key={n} className={draft.maxWorkers === n ? 'on' : undefined}>
            <input
              type="radio"
              name="workers"
              value={n}
              checked={draft.maxWorkers === n}
              onChange={() => onChange(n)}
            />
            {n}
          </label>
        ))}
      </div>
    </section>
  );
}
