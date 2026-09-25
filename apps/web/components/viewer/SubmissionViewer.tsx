'use client';

// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\Shared\SubmissionViewer.razor
// In-app submission viewer for the review screen: renders student work
// same-origin instead of a Canvas doc-previewer iframe. File submissions get
// a tab strip (one tab per attachment) with a per-file header + Download
// link; rendering is per kind — PDF via the browser's native viewer in an
// iframe, images via the pan/zoom stage (both stream from
// /api/submission-file), DOCX page-faithful client-side with a sanitized
// server fallback, XLSX/CSV as Excel-like grids, PPTX client-side, text/code
// as highlighted source (.html files ALWAYS as source), RTF via the server
// converter. Text-entry bodies arrive sanitized from the worker; online_url
// submissions link out instead of iframing arbitrary sites.
//
// Adaptation note: the C# component received a live CanvasSubmission from
// its page; here the engine owns Canvas, so the
// viewer fetches its submission descriptor through the same-origin
// /api/submission-preview proxy and re-fetches per student. Views remount
// per (userId, attachmentId) via key — the React analog of Blazor's @key.

import * as React from 'react';
import { classifyPreview, MAX_PREVIEW_BYTES, type PreviewKind } from '../../lib/viewing/classify';
import type { AttachmentInfo, PreviewPayload, SheetGridPayload, SubmissionDescriptor } from './types';
import { sizeLabel, toggleFullscreen } from './viewer-lib';
import { CodeView } from './CodeView';
import { DocxView } from './DocxView';
import { HtmlDocView } from './HtmlDocView';
import { ImageView } from './ImageView';
import { LoadingPane } from './LoadingPane';
import { PptxView } from './PptxView';
import { SpreadsheetView } from './SpreadsheetView';
import { ViewerToolbar } from './ViewerToolbar';

/** Kinds whose content is built server-side before rendering (the C#
 * BuildPreviewAsync set — everything except the stream-direct kinds). */
function needsServerPreview(kind: PreviewKind): boolean {
  return kind === 'table' || kind === 'text' || kind === 'unsupported';
}

export function SubmissionViewer({
  courseKey,
  assignmentId,
  userId,
  fallbackExcerpt,
  fallbackTruncated,
}: {
  courseKey: string;
  assignmentId: number;
  userId: number;
  /** Stored extracted-text excerpt, shown when no live render is possible. */
  fallbackExcerpt?: string | null;
  /** True when the stored excerpt was truncated at persistence time. */
  fallbackTruncated?: boolean;
}) {
  const rootRef = React.useRef<HTMLDivElement>(null);

  const [descriptor, setDescriptor] = React.useState<SubmissionDescriptor | null>(null);
  const [descState, setDescState] = React.useState<'loading' | 'ready' | 'missing' | 'error'>(
    'loading',
  );
  const [tabIndex, setTabIndex] = React.useState(0);
  const [preview, setPreview] = React.useState<PreviewPayload | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [retryNonce, setRetryNonce] = React.useState(0);

  const post = React.useCallback(
    async (body: Record<string, unknown>): Promise<unknown> => {
      const res = await fetch('/api/submission-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courseKey, assignmentId, userId, ...body }),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    [courseKey, assignmentId, userId],
  );

  // ---- submission descriptor (per student) ----
  React.useEffect(() => {
    let cancelled = false;
    setDescState('loading');
    setDescriptor(null);
    setTabIndex(0);
    void (async () => {
      try {
        const body = (await post({ kind: 'submission' })) as {
          submission?: SubmissionDescriptor;
        } | null;
        if (cancelled) return;
        if (!body?.submission) {
          setDescState('missing');
          return;
        }
        setDescriptor(body.submission);
        setDescState('ready');
      } catch {
        if (!cancelled) setDescState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [post]);

  const attachments = descriptor?.attachments ?? [];
  const current: AttachmentInfo | undefined =
    attachments.length > 0
      ? attachments[Math.min(Math.max(tabIndex, 0), attachments.length - 1)]
      : undefined;
  // Classify off the raw FILENAME first (C# behavior); displayName carries
  // the extension when Canvas omitted filename.
  const kind: PreviewKind | null = current
    ? classifyPreview(current.contentType, current.filename ?? current.displayName)
    : null;

  // ---- server-built preview for table/text/unsupported kinds ----
  const currentId = current?.id ?? 0;
  const needsBuild = kind !== null && needsServerPreview(kind);
  React.useEffect(() => {
    if (!needsBuild || currentId === 0) {
      setPreview(null);
      setPreviewLoading(false);
      setLoadFailed(false);
      return;
    }
    let cancelled = false;
    setPreview(null);
    setLoadFailed(false);
    setPreviewLoading(true);
    void (async () => {
      try {
        const body = (await post({ kind: 'preview', attachmentId: currentId })) as {
          preview?: PreviewPayload;
        } | null;
        if (cancelled) return;
        setPreview(
          body?.preview ?? {
            kind: 'unsupported',
            warnings: [],
            error:
              "This file is no longer on the student's latest submission — reopen the run to refresh.",
          },
        );
      } catch {
        if (cancelled) return;
        setLoadFailed(true);
        setPreview({
          kind: 'unsupported',
          warnings: [],
          error: 'The preview could not be loaded — try again in a moment or download the file.',
        });
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [post, needsBuild, currentId, userId, retryNonce]);

  function fileUrl(att: AttachmentInfo, download = false): string {
    let url = `/api/submission-file/${assignmentId}/${userId}/${att.id}?courseKey=${encodeURIComponent(courseKey)}`;
    if (download) url += '&download=true';
    return url;
  }

  const viewKey = `${userId}:${currentId}`;

  const excerptBlock = fallbackExcerpt ? (
    <div className="sg-excerpt">
      <div className="sub" style={{ marginBottom: 6 }}>
        Extracted submission text{fallbackTruncated ? ' (truncated)' : ''}
      </div>
      <pre className="review-pre" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
        {fallbackExcerpt}
      </pre>
    </div>
  ) : null;

  function renderAttachment(att: AttachmentInfo, attKind: PreviewKind): React.ReactNode {
    if ((attKind === 'pdf' || attKind === 'image') && (att.size ?? 0) > MAX_PREVIEW_BYTES) {
      // The streaming endpoint would refuse with 413 — a blank error iframe
      // or broken <img> — so say why up front, like every other kind does.
      return (
        <div className="sg-unsupported">
          <strong>{att.displayName}</strong>
          <p className="sub">This file is too large to preview — download it instead.</p>
          <a className="btn btn-outline" href={fileUrl(att, true)}>
            Download file
          </a>
        </div>
      );
    }
    if (attKind === 'pdf') {
      // Same-origin stream → the browser's built-in PDF viewer (zoom/search/
      // print for free — the toolbar only adds fullscreen + new tab).
      // NO sandbox attribute — Chrome disables its PDF plugin inside
      // sandboxed frames; safety is the streaming endpoint's content-type
      // allowlist + nosniff (SubmissionFileController parity rule).
      return (
        <React.Fragment key={viewKey}>
          <ViewerToolbar
            openInNewTabUrl={fileUrl(att)}
            onFullscreen={() => void toggleFullscreen(rootRef.current)}
          />
          <iframe className="sg-frame" src={fileUrl(att)} title="Submission preview" />
        </React.Fragment>
      );
    }
    if (attKind === 'image') {
      return (
        <ImageView key={viewKey} fileUrl={fileUrl(att)} altText={att.displayName} rootRef={rootRef} />
      );
    }
    if (attKind === 'rich-html') {
      return (
        <DocxView
          key={viewKey}
          fileUrl={fileUrl(att)}
          loadFallback={async () => {
            const body = (await post({ kind: 'docx-html', attachmentId: att.id })) as {
              preview?: PreviewPayload;
            } | null;
            return (
              body?.preview ?? {
                kind: 'unsupported',
                warnings: [],
                error:
                  'The document could not be previewed — use Download to view the original.',
              }
            );
          }}
          printTitle={att.displayName}
          rootRef={rootRef}
        />
      );
    }
    if (attKind === 'slides') {
      return (
        <PptxView key={viewKey} fileUrl={fileUrl(att)} fileName={att.displayName} rootRef={rootRef} />
      );
    }
    if (previewLoading) {
      return (
        <div className="sg-empty" key={viewKey}>
          <LoadingPane label="Loading preview…" />
        </div>
      );
    }
    if (preview?.kind === 'rich-html' && preview.html != null) {
      // Converter output (RTF): server-converted, sanitized HTML — same
      // toolbar/warning chrome as the DOCX fallback path.
      return (
        <HtmlDocView key={viewKey} preview={preview} printTitle={att.displayName} rootRef={rootRef} />
      );
    }
    if (preview?.kind === 'table') {
      return (
        <SpreadsheetView
          key={viewKey}
          sheetNames={preview.sheetNames?.length ? preview.sheetNames : ['Data']}
          shellWarnings={preview.warnings}
          loadSheet={async (sheetIndex, showFormulas, allRows): Promise<SheetGridPayload> => {
            const body = (await post({
              kind: 'grid',
              attachmentId: att.id,
              sheetIndex,
              showFormulas,
              allRows,
            })) as { sheet?: SheetGridPayload } | null;
            return (
              body?.sheet ?? {
                html: null,
                warnings: [],
                error: 'The sheet could not be loaded — try again in a moment.',
                truncated: false,
                hasFormulas: false,
              }
            );
          }}
          printTitle={att.displayName}
          rootRef={rootRef}
        />
      );
    }
    if (preview?.kind === 'text') {
      return (
        <React.Fragment key={viewKey}>
          {preview.warnings.length > 0 ? (
            <div className="sg-preview-warn">{preview.warnings.join(' ')}</div>
          ) : null}
          <CodeView text={preview.plainText ?? ''} fileName={att.filename} rootRef={rootRef} />
        </React.Fragment>
      );
    }
    return (
      <div className="sg-unsupported" key={viewKey}>
        <strong>{att.displayName}</strong>
        <p className="sub">{preview?.error ?? "This file type can't be previewed in the app."}</p>
        <div>
          <a className="btn btn-outline" href={fileUrl(att, true)}>
            Download file
          </a>
          {loadFailed ? (
            <button
              type="button"
              className="btn btn-outline"
              style={{ marginLeft: 8 }}
              onClick={() => setRetryNonce((n) => n + 1)}
            >
              Try again
            </button>
          ) : null}
        </div>
        {excerptBlock}
      </div>
    );
  }

  let content: React.ReactNode;
  if (descState === 'loading') {
    content = (
      <div className="sg-empty">
        <LoadingPane label="Loading submission from Canvas…" />
      </div>
    );
  } else if (descState === 'error') {
    content = (
      <div className="sg-unsupported">
        <strong>The submission could not be loaded.</strong>
        <p className="sub">Check your connection and try again in a moment.</p>
        {excerptBlock}
      </div>
    );
  } else if (descriptor && current && kind) {
    content = (
      <>
        {attachments.length > 1 ? (
          <div className="sg-filetabs" role="tablist">
            {attachments.map((att, i) => (
              <button
                key={att.id}
                type="button"
                role="tab"
                className={`sg-filetab${i === tabIndex ? ' active' : ''}`}
                title={att.displayName}
                onClick={() => {
                  setTabIndex(i);
                  // A tab click always retries — a transient failure must be
                  // recoverable by clicking the tab again (C# SelectTabAsync).
                  setRetryNonce((n) => n + 1);
                }}
              >
                {att.displayName}
              </button>
            ))}
          </div>
        ) : null}
        <div className="sg-viewhead">
          <span className="sg-viewname" title={current.displayName}>
            {current.displayName}
            {sizeLabel(current.size)}
          </span>
          <a className="sg-viewaction" href={fileUrl(current, true)}>
            Download
          </a>
        </div>
        {renderAttachment(current, kind)}
      </>
    );
  } else if (descriptor?.bodyHtml) {
    content = (
      <div className="sg-doc">
        <div className="sub" style={{ marginBottom: 10 }}>
          {descriptor.submissionType === 'discussion_topic' ? 'Discussion posts' : 'Text submission'}
          {descriptor.late ? ' · Late' : ''}
        </div>
        {/* Sanitized worker-side before it ever reaches the browser. */}
        <div dangerouslySetInnerHTML={{ __html: descriptor.bodyHtml }} />
      </div>
    );
  } else if (descriptor?.url) {
    content = (
      <div className="sg-linkout">
        <strong>Website submission</strong>
        <p className="sub" style={{ margin: '8px 0 12px' }}>
          External sites can&apos;t be embedded here — open the student&apos;s link in a new tab.
        </p>
        <a className="btn btn-outline" href={descriptor.url} target="_blank" rel="noopener noreferrer">
          {descriptor.url}
        </a>
      </div>
    );
  } else if (fallbackExcerpt) {
    content = (
      <div className="sg-doc">
        <div className="sub" style={{ marginBottom: 10 }}>
          Extracted submission text{fallbackTruncated ? ' (truncated)' : ''}
        </div>
        <pre className="review-pre" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
          {fallbackExcerpt}
        </pre>
      </div>
    );
  } else {
    content = <div className="sg-empty">No submission content found.</div>;
  }

  return (
    <div className="sg-viewroot" ref={rootRef}>
      {content}
    </div>
  );
}
