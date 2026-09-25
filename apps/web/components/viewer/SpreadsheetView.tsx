'use client';

// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\Shared\Viewer\SpreadsheetView.razor
// Spreadsheet view: an Excel-like grid rendered SERVER-side (the worker's
// grid conversion — @aigrader/extraction renderSheetGrid) with a bottom sheet-tab
// strip, lazy per-sheet loading, a show-formulas toggle, "show all rows" past
// the 500-row default (2,000 cap), CSS-transform zoom, and print. The parent
// supplies a loader closure so this component stays render-only. Sheet
// reloads recreate the grid DOM, so the zoom transform is re-applied after
// each load — otherwise the toolbar label and the actual scale drift apart.
// The grid HTML has every cell HTML-escaped server-side (workbook text is
// student-controlled) — that contract is what makes the injection safe.

import * as React from 'react';
import type { SheetGridPayload } from './types';
import { GRID_MAX_ROWS } from './types';
import {
  POPUP_BLOCKED_NOTICE,
  applyZoom,
  printView,
  toggleFullscreen,
  zoomStepValue,
} from './viewer-lib';
import { LoadingPane } from './LoadingPane';
import { ViewerToolbar } from './ViewerToolbar';

export function SpreadsheetView({
  sheetNames,
  shellWarnings,
  loadSheet,
  printTitle,
  rootRef,
}: {
  /** Worksheet names for the tab strip (single "Data" entry for CSV). */
  sheetNames: string[];
  /** Workbook-level notices from the shell (e.g. the sheet-count cap). */
  shellWarnings?: string[];
  /** Loads one sheet's grid: (sheetIndex, showFormulas, allRows). */
  loadSheet: (sheetIndex: number, showFormulas: boolean, allRows: boolean) => Promise<SheetGridPayload>;
  printTitle?: string | null;
  rootRef: React.RefObject<HTMLElement | null>;
}) {
  const [sheetIndex, setSheetIndex] = React.useState(0);
  const [showFormulas, setShowFormulas] = React.useState(false);
  const [allRows, setAllRows] = React.useState(false);
  const [sheet, setSheet] = React.useState<SheetGridPayload | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [zoomPct, setZoomPct] = React.useState(100);

  const wrapRef = React.useRef<HTMLDivElement>(null);
  const zoomableRef = React.useRef<HTMLDivElement>(null);
  const loadSeqRef = React.useRef(0);
  const zoomPctRef = React.useRef(100);
  zoomPctRef.current = zoomPct;

  // The loader rides in a ref so a parent re-render (the review screen
  // re-renders on every ~3s progress poll, recreating the closure) never
  // re-triggers a sheet load — only sheet/formulas/rows changes do.
  const loadSheetRef = React.useRef(loadSheet);
  loadSheetRef.current = loadSheet;

  React.useEffect(() => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    void (async () => {
      let result: SheetGridPayload;
      try {
        result = await loadSheetRef.current(sheetIndex, showFormulas, allRows);
      } catch {
        result = {
          html: null,
          warnings: [],
          error: 'The sheet could not be loaded — try again in a moment.',
          truncated: false,
          hasFormulas: false,
        };
      }
      if (seq !== loadSeqRef.current) return; // a newer load superseded this one
      setSheet(result);
      setLoading(false);
    })();
  }, [sheetIndex, showFormulas, allRows]);

  // Re-apply the CSS zoom after a reload replaced the grid DOM — the
  // transform lives on an element the reload just recreated.
  React.useEffect(() => {
    if (loading || sheet?.html == null) return;
    const pct = zoomPctRef.current;
    if (pct !== 100) {
      setZoomPct(applyZoom(wrapRef.current, zoomableRef.current, 100, pct));
    }
  }, [loading, sheet]);

  function zoom(dir: number): void {
    const next = dir === 0 ? 100 : zoomStepValue(zoomPct, dir);
    setZoomPct(applyZoom(wrapRef.current, zoomableRef.current, zoomPct, next));
  }

  function print(): void {
    setNotice(printView(zoomableRef.current, printTitle ?? 'Spreadsheet') ? null : POPUP_BLOCKED_NOTICE);
  }

  const notices = [...(shellWarnings ?? []), ...(sheet?.warnings ?? [])];
  if (notice) notices.push(notice);

  return (
    <>
      <ViewerToolbar
        zoomPercent={zoomPct}
        showPrint
        onZoomIn={() => zoom(1)}
        onZoomOut={() => zoom(-1)}
        onZoomReset={() => zoom(0)}
        onFullscreen={() => void toggleFullscreen(rootRef.current)}
        onPrint={print}
        extras={
          sheet?.hasFormulas || showFormulas ? (
            <button
              type="button"
              className={`sg-tbtn${showFormulas ? ' active' : ''}`}
              title="Show formulas instead of values"
              onClick={() => setShowFormulas((f) => !f)}
            >
              ƒx Formulas
            </button>
          ) : null
        }
      />

      {notices.length > 0 ? <div className="sg-preview-warn">{notices.join(' ')}</div> : null}

      {loading ? (
        <LoadingPane label="Loading sheet…" />
      ) : sheet?.error != null ? (
        <div className="sg-empty">{sheet.error}</div>
      ) : sheet?.html != null ? (
        <>
          <div className="sg-zoomwrap" ref={wrapRef}>
            <div
              ref={zoomableRef}
              className="sg-zoomable"
              // Server-rendered grid — every cell escaped worker-side.
              dangerouslySetInnerHTML={{ __html: sheet.html }}
            />
          </div>
          {sheet.truncated && !allRows ? (
            <div className="sg-loadmore">
              <button type="button" className="sg-tbtn" onClick={() => setAllRows(true)}>
                Show all rows (up to {GRID_MAX_ROWS})
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {sheetNames.length > 1 ? (
        <div className="sg-sheettabs" role="tablist">
          {sheetNames.map((name, i) => (
            <button
              key={`${i}-${name}`}
              type="button"
              role="tab"
              className={`sg-sheettab${i === sheetIndex ? ' active' : ''}`}
              title={name}
              onClick={() => setSheetIndex(i)}
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
