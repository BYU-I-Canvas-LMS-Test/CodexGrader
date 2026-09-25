'use client';

// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\Shared\Viewer\DocxView.razor
// + viewer.js renderDocx. Word-document view: page-faithful rendering in the
// browser via docx-preview (real pages, fonts, images, headers/footers). The
// component fetches the bytes itself from the same-origin streaming URL (the
// session cookie rides along). On ANY failure — corrupt file, expired
// session, blocked chunk — falls back to the server-converted mammoth +
// sanitizer HTML (rendered by HtmlDocView with the same chrome), loaded
// lazily only then (the happy path never costs server CPU).
//
// docx-preview loads via dynamic import inside a client-only effect — the
// ssr:false requirement by construction (the import never evaluates on the
// server). SECURITY (pinned to the C# rule in viewer.js/VENDORED.md):
//   - renderAltChunks stays FALSE — altChunks embed raw HTML, the one real
//     XSS seam in the format. Any docx-preview upgrade must keep this.
//   - hyperlinks are scrubbed after render: http(s) links forced to
//     new-tab + noopener; every other scheme loses its href.

import * as React from 'react';
import type { PreviewPayload } from './types';
import {
  POPUP_BLOCKED_NOTICE,
  applyZoom,
  fitWidthPercent,
  printView,
  toggleFullscreen,
  zoomStepValue,
} from './viewer-lib';
import { HtmlDocView } from './HtmlDocView';
import { LoadingPane } from './LoadingPane';
import { ViewerToolbar } from './ViewerToolbar';

export function DocxView({
  fileUrl,
  loadFallback,
  printTitle,
  rootRef,
}: {
  /** Same-origin streaming URL for the DOCX bytes. */
  fileUrl: string;
  /** Builds the mammoth-sanitized HTML fallback — invoked ONLY when
   * client-side rendering fails. */
  loadFallback: () => Promise<PreviewPayload>;
  printTitle?: string | null;
  rootRef: React.RefObject<HTMLElement | null>;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [loading, setLoading] = React.useState(true);
  const [fallback, setFallback] = React.useState<PreviewPayload | null>(null);
  const [zoomPct, setZoomPct] = React.useState(100);
  const [notice, setNotice] = React.useState<string | null>(null);

  React.useEffect(() => {
    let disposed = false;
    const host = hostRef.current;

    async function renderClientSide(): Promise<boolean> {
      if (!host) return false;
      try {
        const docx = await import('docx-preview');
        const res = await fetch(fileUrl, { credentials: 'same-origin' });
        if (!res.ok) return false; // 401/404/413/502 → server fallback path
        const buf = await res.arrayBuffer();
        if (disposed || !host.isConnected) return false; // unmounted while fetching
        await docx.renderAsync(buf, host, undefined /* styles into host */, {
          className: 'docx',
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          experimental: true, // tab-stop layout — visibly better
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderComments: false,
          renderAltChunks: false, // SECURITY: altChunks embed raw HTML
          useBase64URL: true, // data URIs GC with the DOM (blob URLs would leak per render)
        });
        if (disposed || !host.isConnected) {
          host.innerHTML = '';
          return false;
        }
        // Link scrub: keep http(s) links but force new-tab + no opener;
        // strip every other scheme (file:, javascript:, relative junk).
        host.querySelectorAll('a[href]').forEach((a) => {
          if (/^https?:/i.test(a.getAttribute('href') ?? '')) {
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer');
          } else {
            a.removeAttribute('href');
          }
        });
        return true;
      } catch {
        return false;
      }
    }

    void (async () => {
      const ok = await renderClientSide();
      if (disposed) return;
      if (!ok) {
        try {
          setFallback(await loadFallback());
        } catch {
          setFallback({
            kind: 'unsupported',
            warnings: [],
            error: 'The document could not be previewed — use Download to view the original.',
          });
        }
      }
      if (!disposed) setLoading(false);
    })();

    return () => {
      disposed = true;
      if (host) host.innerHTML = '';
    };
    // Mounted once per file — the parent remounts via key on file change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileUrl]);

  if (fallback) {
    return (
      <HtmlDocView
        preview={fallback}
        leadNotice="Showing simplified preview — the page-faithful renderer could not open this file."
        printTitle={printTitle}
        rootRef={rootRef}
      />
    );
  }

  function zoom(dir: number): void {
    const next = dir === 0 ? 100 : zoomStepValue(zoomPct, dir);
    setZoomPct(applyZoom(wrapRef.current, hostRef.current, zoomPct, next));
  }

  function fitWidth(): void {
    const pct = fitWidthPercent(wrapRef.current, hostRef.current);
    if (pct !== null) setZoomPct(applyZoom(wrapRef.current, hostRef.current, zoomPct, pct));
  }

  function print(): void {
    setNotice(printView(hostRef.current, printTitle ?? 'Document') ? null : POPUP_BLOCKED_NOTICE);
  }

  return (
    <>
      <ViewerToolbar
        zoomPercent={zoomPct}
        showFitWidth
        showPrint
        onZoomIn={() => zoom(1)}
        onZoomOut={() => zoom(-1)}
        onZoomReset={() => zoom(0)}
        onFitWidth={fitWidth}
        onFullscreen={() => void toggleFullscreen(rootRef.current)}
        onPrint={print}
      />
      {notice ? <div className="sg-preview-warn">{notice}</div> : null}
      {loading ? <LoadingPane label="Rendering document…" /> : null}
      <div className="sg-zoomwrap" ref={wrapRef} style={loading ? { display: 'none' } : undefined}>
        <div ref={hostRef} className="sg-docxhost sg-zoomable" />
      </div>
    </>
  );
}
