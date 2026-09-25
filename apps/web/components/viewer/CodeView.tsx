'use client';

// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\Shared\Viewer\CodeView.razor
// + viewer.js renderCode/setCodeWrap/codeFontStep. Code/text file view:
// syntax highlighting (highlight.js "common" build, lazy-imported on first
// use), line numbers, wrap toggle, font-size zoom, print. The highlighted
// markup is injected into a host div React never diffs (the JS-island rule —
// the parent remounts this component via key when the file changes).
// SECURITY: the host only ever receives highlight.js OUTPUT (hljs escapes all
// non-token text) or explicitly escaped text. .html files arrive HERE — as
// highlighted SOURCE — never as rendered HTML.

import * as React from 'react';
import 'highlight.js/styles/github.css';
import {
  CODE_FONT_STEPS,
  MAX_HIGHLIGHT_CHARS,
  MAX_HIGHLIGHT_LINES,
  POPUP_BLOCKED_NOTICE,
  escapeHtml,
  langFromFilename,
  printView,
  splitHighlightedLines,
  toggleFullscreen,
} from './viewer-lib';
import { ViewerToolbar } from './ViewerToolbar';

export function CodeView({
  text,
  fileName,
  rootRef,
}: {
  /** The file's full text (already decoded server-side). */
  text: string;
  /** Filename whose extension picks the highlight language. */
  fileName?: string | null;
  /** The viewer root — the fullscreen target. */
  rootRef: React.RefObject<HTMLElement | null>;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [jsFailed, setJsFailed] = React.useState(false);
  const [wrap, setWrap] = React.useState(false);
  const [fontPx, setFontPx] = React.useState(13);
  const [notice, setNotice] = React.useState<string | null>(null);

  React.useEffect(() => {
    let disposed = false;
    const host = hostRef.current;
    void (async () => {
      try {
        // The "common" build (~40 languages) mirrors the vendored cdn-assets
        // bundle; PowerShell rides as an extra because BYU-I courses submit .ps1.
        const hljs = (await import('highlight.js/lib/common')).default;
        if (!hljs.getLanguage('powershell')) {
          const powershell = (await import('highlight.js/lib/languages/powershell')).default;
          hljs.registerLanguage('powershell', powershell);
        }
        if (disposed || !host || !host.isConnected) return;

        const tooBig =
          text.length > MAX_HIGHLIGHT_CHARS ||
          (text.match(/\n/g) ?? []).length + 1 > MAX_HIGHLIGHT_LINES;
        const html = tooBig
          ? escapeHtml(text)
          : hljs.highlight(text, { language: langFromFilename(fileName), ignoreIllegals: true })
              .value;
        const lines = splitHighlightedLines(html);
        host.innerHTML =
          (tooBig
            ? '<div class="sg-preview-warn">Large file — syntax highlighting disabled.</div>'
            : '') + `<pre class="sg-codepre"><code class="hljs">${lines.join('')}</code></pre>`;
      } catch {
        if (!disposed) setJsFailed(true);
      }
    })();
    return () => {
      disposed = true;
      if (host) host.innerHTML = '';
    };
    // Re-highlights when the content itself changes (idempotent innerHTML
    // replacement); the parent remounts via key on file change.
  }, [text, fileName]);

  /** Font-size step (the code view's zoom); dir 0 resets to 13px. */
  function fontStep(dir: number): void {
    let idx = CODE_FONT_STEPS.indexOf(fontPx as (typeof CODE_FONT_STEPS)[number]);
    if (idx < 0) idx = 2;
    idx = dir === 0 ? 2 : Math.max(0, Math.min(CODE_FONT_STEPS.length - 1, idx + (dir > 0 ? 1 : -1)));
    const px = CODE_FONT_STEPS[idx]!;
    setFontPx(px);
    const pre = hostRef.current?.querySelector<HTMLElement>('.sg-codepre');
    if (pre) pre.style.fontSize = `${px}px`;
  }

  function print(): void {
    setNotice(printView(hostRef.current, fileName ?? 'Code') ? null : POPUP_BLOCKED_NOTICE);
  }

  return (
    <>
      <ViewerToolbar
        zoomPercent={Math.round((fontPx / 13) * 100)}
        showPrint={!jsFailed}
        onZoomIn={() => fontStep(1)}
        onZoomOut={() => fontStep(-1)}
        onZoomReset={() => fontStep(0)}
        onFullscreen={() => void toggleFullscreen(rootRef.current)}
        onPrint={print}
        extras={
          <button
            type="button"
            className={`sg-tbtn${wrap ? ' active' : ''}`}
            title="Toggle line wrap"
            onClick={() => setWrap((w) => !w)}
          >
            ⏎ Wrap
          </button>
        }
      />
      {notice ? <div className="sg-preview-warn">{notice}</div> : null}
      {jsFailed ? (
        // highlight.js unavailable → the original escaped-pre rendering
        // (React escapes `text`), with Print hidden above.
        <pre className="sg-code">{text}</pre>
      ) : (
        <div ref={hostRef} className={`sg-codehost${wrap ? ' sg-wrap' : ''}`} />
      )}
    </>
  );
}
