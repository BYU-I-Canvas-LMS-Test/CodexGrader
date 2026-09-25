'use client';

// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\Shared\Viewer\PptxView.razor
// + viewer.js renderPptx. PowerPoint deck view: slides rendered client-side
// by @aiden0z/pptx-renderer — lazy-imported the FIRST time a deck is actually
// opened (the module is ~1.5MB; it must never ride on page load). Fidelity is
// best-effort: text, images, shapes, SmartArt, and charts render; animations,
// 3D effects, and speaker notes don't, and PowerPoint-only fonts substitute —
// hence the standing "approximate" notice. Any failure shows the download card.

import * as React from 'react';
import {
  POPUP_BLOCKED_NOTICE,
  applyZoom,
  printView,
  toggleFullscreen,
  zoomStepValue,
} from './viewer-lib';
import { LoadingPane } from './LoadingPane';
import { ViewerToolbar } from './ViewerToolbar';

export function PptxView({
  fileUrl,
  fileName,
  rootRef,
}: {
  /** Same-origin streaming URL for the PPTX bytes. */
  fileUrl: string;
  /** Display name shown on the failure card and print popup. */
  fileName?: string | null;
  rootRef: React.RefObject<HTMLElement | null>;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const [zoomPct, setZoomPct] = React.useState(100);
  const [notice, setNotice] = React.useState<string | null>(null);

  React.useEffect(() => {
    let disposed = false;
    const host = hostRef.current;
    let viewer: { destroy?: () => void } | null = null;

    void (async () => {
      let ok = false;
      try {
        if (host) {
          const mod = await import('@aiden0z/pptx-renderer');
          const res = await fetch(fileUrl, { credentials: 'same-origin' });
          if (res.ok) {
            const buf = await res.arrayBuffer();
            if (!disposed && host.isConnected) {
              const options: Record<string, unknown> = {};
              if (mod.RECOMMENDED_ZIP_LIMITS) options.zipLimits = mod.RECOMMENDED_ZIP_LIMITS;
              viewer = (await mod.PptxViewer.open(buf, host, options)) as { destroy?: () => void };
              ok = !disposed && host.isConnected;
              if (!ok) {
                try {
                  viewer?.destroy?.();
                } catch {
                  /* teardown must never throw */
                }
                host.innerHTML = '';
              }
            }
          }
        }
      } catch {
        ok = false;
      }
      if (!disposed) {
        setFailed(!ok);
        setLoading(false);
      }
    })();

    return () => {
      disposed = true;
      try {
        viewer?.destroy?.();
      } catch {
        /* teardown must never throw */
      }
      if (host) host.innerHTML = '';
    };
    // Mounted once per file — the parent remounts via key on file change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileUrl]);

  function zoom(dir: number): void {
    const next = dir === 0 ? 100 : zoomStepValue(zoomPct, dir);
    setZoomPct(applyZoom(wrapRef.current, hostRef.current, zoomPct, next));
  }

  function print(): void {
    setNotice(printView(hostRef.current, fileName ?? 'Slides') ? null : POPUP_BLOCKED_NOTICE);
  }

  return (
    <>
      <ViewerToolbar
        zoomPercent={zoomPct}
        showPrint={!failed}
        onZoomIn={() => zoom(1)}
        onZoomOut={() => zoom(-1)}
        onZoomReset={() => zoom(0)}
        onFullscreen={() => void toggleFullscreen(rootRef.current)}
        onPrint={print}
      />
      {notice ? <div className="sg-preview-warn">{notice}</div> : null}
      {failed ? (
        <div className="sg-unsupported">
          <strong>{fileName}</strong>
          <p className="sub">
            The slides could not be rendered in the app — use Download to view the original.
          </p>
        </div>
      ) : (
        <>
          {loading ? (
            <LoadingPane label="Rendering slides…" />
          ) : (
            <div className="sg-preview-warn">
              Approximate preview — animations, notes, and some effects don&apos;t render. Use
              Download for the original.
            </div>
          )}
          <div className="sg-zoomwrap" ref={wrapRef} style={loading ? { display: 'none' } : undefined}>
            <div ref={hostRef} className="sg-pptxhost sg-zoomable" />
          </div>
        </>
      )}
    </>
  );
}
