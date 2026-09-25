'use client';

// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\Shared\Viewer\HtmlDocView.razor
// Server-converted HTML view: the one renderer for every preview that arrives
// as sanitized HTML — RTF conversions and DocxView's mammoth fallback. One
// component so the chrome can't drift between those paths: all of them get
// the toolbar (zoom/print/fullscreen), the conversion warnings, and the error
// card. SECURITY: the HTML was sanitized WORKER-SIDE by @aigrader/extraction's
// allowlist sanitizer (the web never sanitizes; it renders what the worker
// vetted) — that contract is what makes dangerouslySetInnerHTML safe here.

import * as React from 'react';
import type { PreviewPayload } from './types';
import {
  POPUP_BLOCKED_NOTICE,
  applyZoom,
  printView,
  toggleFullscreen,
  zoomStepValue,
} from './viewer-lib';
import { ViewerToolbar } from './ViewerToolbar';

export function HtmlDocView({
  preview,
  leadNotice,
  printTitle,
  rootRef,
}: {
  /** The server-converted preview to render (html, warnings, error). */
  preview: PreviewPayload;
  /** Extra notice above the content (e.g. DocxView's "simplified preview"). */
  leadNotice?: string | null;
  printTitle?: string | null;
  rootRef: React.RefObject<HTMLElement | null>;
}) {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const zoomableRef = React.useRef<HTMLDivElement>(null);
  const [zoomPct, setZoomPct] = React.useState(100);
  const [notice, setNotice] = React.useState<string | null>(null);

  function zoom(dir: number): void {
    const next = dir === 0 ? 100 : zoomStepValue(zoomPct, dir);
    setZoomPct(applyZoom(wrapRef.current, zoomableRef.current, zoomPct, next));
  }

  function print(): void {
    setNotice(printView(zoomableRef.current, printTitle ?? 'Document') ? null : POPUP_BLOCKED_NOTICE);
  }

  return (
    <>
      <ViewerToolbar
        zoomPercent={zoomPct}
        showPrint={preview.html != null}
        onZoomIn={() => zoom(1)}
        onZoomOut={() => zoom(-1)}
        onZoomReset={() => zoom(0)}
        onFullscreen={() => void toggleFullscreen(rootRef.current)}
        onPrint={print}
      />
      {notice ? <div className="sg-preview-warn">{notice}</div> : null}
      {leadNotice ? <div className="sg-preview-warn">{leadNotice}</div> : null}
      {preview.html != null ? (
        <>
          {preview.warnings.length > 0 ? (
            <div className="sg-preview-warn">{preview.warnings.join(' ')}</div>
          ) : null}
          <div className="sg-zoomwrap" ref={wrapRef}>
            <div
              ref={zoomableRef}
              className="sg-doc sg-zoomable"
              // Sanitized worker-side (see module header) — never raw student HTML.
              dangerouslySetInnerHTML={{ __html: preview.html }}
            />
          </div>
        </>
      ) : (
        <div className="sg-empty">
          {preview.error ?? 'The document could not be previewed — use Download to view the original.'}
        </div>
      )}
    </>
  );
}
