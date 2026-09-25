'use client';

// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\Shared\Viewer\ViewerToolbar.razor
// The viewer's control strip — presentational only. Each view component
// decides which controls apply to its format and passes callbacks;
// format-specific controls (wrap toggle, formulas toggle, rotate) ride in via
// `extras`. Rendered as a flex-shrink:0 row because the preview container is
// a fixed-height flex column — a toolbar that flexed would steal content space.

import * as React from 'react';

export function ViewerToolbar({
  zoomPercent,
  showFitWidth,
  showPrint,
  openInNewTabUrl,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onFitWidth,
  onFullscreen,
  onPrint,
  extras,
}: {
  /** Current zoom percent to display; null/undefined hides the zoom cluster. */
  zoomPercent?: number | null;
  showFitWidth?: boolean;
  showPrint?: boolean;
  /** Only kinds the browser renders inline get one — PDF and images. */
  openInNewTabUrl?: string;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
  onFitWidth?: () => void;
  onFullscreen?: () => void;
  onPrint?: () => void;
  extras?: React.ReactNode;
}) {
  return (
    <div className="sg-viewtoolbar">
      {zoomPercent != null ? (
        <>
          <button type="button" className="sg-tbtn" title="Zoom out" onClick={onZoomOut}>
            −
          </button>
          <span className="sg-tblabel" title="Zoom level">
            {zoomPercent}%
          </span>
          <button type="button" className="sg-tbtn" title="Zoom in" onClick={onZoomIn}>
            +
          </button>
          <button type="button" className="sg-tbtn" title="Reset zoom" onClick={onZoomReset}>
            100%
          </button>
          {showFitWidth ? (
            <button type="button" className="sg-tbtn" title="Fit width" onClick={onFitWidth}>
              ⇔ Fit
            </button>
          ) : null}
          <span className="sg-tbsep" />
        </>
      ) : null}
      {extras}
      <span style={{ flex: 1 }} />
      {showPrint ? (
        <button type="button" className="sg-tbtn" title="Print" onClick={onPrint}>
          🖶 Print
        </button>
      ) : null}
      {openInNewTabUrl ? (
        <a
          className="sg-tbtn"
          title="Open in new tab"
          href={openInNewTabUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          ↗ Open
        </a>
      ) : null}
      <button
        type="button"
        className="sg-tbtn"
        title="Toggle fullscreen (Esc exits)"
        onClick={onFullscreen}
      >
        ⛶
      </button>
    </div>
  );
}
