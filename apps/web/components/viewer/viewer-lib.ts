// Shared helpers for the submission viewer's "JS island" components — the
// React port of the C# app's window.aigViewer interop layer.
//
// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\wwwroot\viewer.js. The
// instance map + Blazor lifecycle plumbing is gone (React refs/effects own
// mount/teardown), but the behavior contracts carry over verbatim: the zoom
// ladder, fit-width math, per-line highlight splitting, language table, and
// the PRINT-VIA-POPUP rule (never iframe.print(); must be called from a click
// gesture so popup blockers allow it).

export const ZOOM_STEPS = [50, 67, 75, 90, 100, 110, 125, 150, 175, 200] as const;

export const MAX_HIGHLIGHT_CHARS = 400_000;
export const MAX_HIGHLIGHT_LINES = 10_000;
export const CODE_FONT_STEPS = [11, 12, 13, 14, 16, 18] as const;

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** CSS-transform zoom on a .sg-zoomable inside a scrolling .sg-zoomwrap.
 * Transform overflow contributes to the wrapper's scrollable area (origin
 * 0 0 grows right/down), so no width compensation is needed. Returns the
 * clamped percent actually applied. */
export function applyZoom(
  wrap: HTMLElement | null,
  zoomable: HTMLElement | null,
  oldPercent: number,
  percent: number,
): number {
  if (!zoomable) return oldPercent;
  const p = Math.max(25, Math.min(200, Math.round(percent)));
  zoomable.style.transform = p === 100 ? '' : `scale(${p / 100})`;
  zoomable.style.transformOrigin = '0 0';
  if (wrap) {
    // Keep the viewport roughly centered on the same content.
    wrap.scrollLeft = (wrap.scrollLeft + wrap.clientWidth / 2) * (p / oldPercent) - wrap.clientWidth / 2;
    wrap.scrollTop = (wrap.scrollTop + wrap.clientHeight / 2) * (p / oldPercent) - wrap.clientHeight / 2;
  }
  return p;
}

/** The next zoom-ladder stop from `current` in direction `dir` (+1/-1). */
export function zoomStepValue(current: number, dir: number): number {
  let idx = ZOOM_STEPS.findIndex((s) => s >= current);
  if (idx < 0) idx = ZOOM_STEPS.length - 1;
  idx = Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx + (dir > 0 ? 1 : -1)));
  return ZOOM_STEPS[idx]!;
}

/** The percent that fits the zoomable's layout width into the wrapper. */
export function fitWidthPercent(wrap: HTMLElement | null, zoomable: HTMLElement | null): number | null {
  if (!wrap || !zoomable || zoomable.scrollWidth === 0) return null;
  return ((wrap.clientWidth - 24) / zoomable.scrollWidth) * 100;
}

/** Fullscreen toggle on the viewer ROOT (tabs + toolbar + content carry into
 * fullscreen together). Denial (e.g. framed launches without
 * allowfullscreen) is a silent no-op. */
export async function toggleFullscreen(el: HTMLElement | null): Promise<void> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    if (el) await el.requestFullscreen();
  } catch {
    // denied — no-op
  }
}

/** Opens a print popup with the host's rendered HTML plus the app styles.
 * MUST be called from a click gesture (popup blockers). Returns false when
 * the popup was blocked so the UI can show a notice.
 *
 * Deviation from viewer.js: the C# app linked its static app.css into the
 * popup; Next bundles CSS with hashed URLs, so the live document's
 * <link rel="stylesheet">/<style> tags are cloned instead — same result. */
export function printView(host: HTMLElement | null, title: string): boolean {
  if (!host) return false;
  const w = window.open('', '_blank');
  if (!w) return false;

  const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
    .map((el) => el.outerHTML)
    .join('');

  // Print at 100%: the on-screen CSS zoom must not ride into the popup (a
  // spreadsheet zoomed to 50% would print half-size), so clear transforms on
  // a detached clone before copying its markup.
  const copy = host.cloneNode(true) as HTMLElement;
  copy.querySelectorAll<HTMLElement>('.sg-zoomable').forEach((el) => {
    el.style.transform = '';
  });
  // Canvas pixels don't survive cloneNode (the clone is blank) — swap each
  // cloned canvas for a snapshot image of the live one. Matters for
  // pptx-renderer output, which draws some fragments on canvas.
  const liveCanvases = host.querySelectorAll('canvas');
  copy.querySelectorAll('canvas').forEach((c, i) => {
    try {
      const live = liveCanvases[i]!;
      const img = document.createElement('img');
      img.src = live.toDataURL('image/png');
      img.width = live.width;
      img.height = live.height;
      if (c.style.cssText) img.style.cssText = c.style.cssText;
      c.replaceWith(img);
    } catch {
      // tainted canvas — leave the blank clone
    }
  });

  w.document.write(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title || 'Print')}</title>${styles}</head><body class="sg-print">${copy.innerHTML}</body></html>`,
  );
  w.document.close();
  // In some engines the popup's load event fires synchronously inside
  // close() — check readyState so the print dialog can't be skipped.
  let printed = false;
  const doPrint = (): void => {
    if (printed) return;
    printed = true;
    setTimeout(() => w.print(), 150);
  };
  if (w.document.readyState === 'complete') doPrint();
  else w.addEventListener('load', doPrint);
  return true;
}

export const POPUP_BLOCKED_NOTICE =
  'The print window was blocked — allow pop-ups for this site and try again.';

// -------------------------------------------------------------- code view --

export const LANG_BY_EXT: Record<string, string> = {
  py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', cs: 'csharp', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  css: 'css', scss: 'scss', less: 'less', html: 'xml', htm: 'xml', xml: 'xml',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', ini: 'ini', toml: 'ini',
  md: 'markdown', markdown: 'markdown', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
  ps1: 'powershell', rb: 'ruby', go: 'go', rs: 'rust', php: 'php', swift: 'swift',
  r: 'r', pl: 'perl', lua: 'lua', diff: 'diff', patch: 'diff', txt: 'plaintext',
  log: 'plaintext', csv: 'plaintext', tsv: 'plaintext',
};

export function langFromFilename(name: string | null | undefined): string {
  const ext = (name ?? '').toLowerCase().split('.').pop() ?? '';
  return LANG_BY_EXT[ext] ?? 'plaintext';
}

/** Splits highlighted HTML into per-line spans, re-opening any spans that
 * cross line boundaries so each .sg-cl is self-contained (the standard
 * open-tag-stack walk). Input is highlight.js OUTPUT (hljs escapes all
 * non-token text) or explicitly escaped text — never raw student HTML. */
export function splitHighlightedLines(html: string): string[] {
  const tagRe = /<span[^>]*>|<\/span>/g;
  const open: string[] = [];
  return html.split('\n').map((line) => {
    const prefix = open.join('');
    let m: RegExpExecArray | null;
    tagRe.lastIndex = 0;
    while ((m = tagRe.exec(line)) !== null) {
      if (m[0] === '</span>') open.pop();
      else open.push(m[0]);
    }
    return `<span class="sg-cl">${prefix}${line}${'</span>'.repeat(open.length)}\n</span>`;
  });
}

// ------------------------------------------------------------------- misc --

/** " · 1.2 MB" style size suffix (C# SizeLabel — "0.#" formatting). */
export function sizeLabel(size: number | null | undefined): string {
  if (!size || size <= 0) return '';
  const fmt = (n: number): string => String(Math.round(n * 10) / 10);
  if (size < 1024) return ` · ${size} B`;
  if (size < 1024 * 1024) return ` · ${fmt(size / 1024)} KB`;
  return ` · ${fmt(size / (1024 * 1024))} MB`;
}
