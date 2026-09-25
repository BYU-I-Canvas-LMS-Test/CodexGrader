'use client';

// Ported from: C:\Devs\AIGrader-C#\src\AiGrader\Components\Shared\Viewer\ImageView.razor
// + viewer.js initImage/imageCmd. Image view: wheel zoom around the cursor,
// drag pan, rotate, fit/100%, double-click toggle — all one CSS transform on
// a JS-built <img> inside the empty stage div (island rule). Falls back to a
// plain <img> when the stage can't mount.

import * as React from 'react';
import { toggleFullscreen } from './viewer-lib';
import { ViewerToolbar } from './ViewerToolbar';

type Stage = {
  st: { scale: number; tx: number; ty: number; rotation: number; mode: 'fit' | 'manual' };
  fit: () => void;
  apply: () => void;
};

export function ImageView({
  fileUrl,
  altText,
  rootRef,
}: {
  /** Same-origin streaming URL for the image bytes. */
  fileUrl: string;
  /** Alt text (the attachment's display name). */
  altText?: string | null;
  rootRef: React.RefObject<HTMLElement | null>;
}) {
  const stageRef = React.useRef<HTMLDivElement>(null);
  const apiRef = React.useRef<Stage | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [zoomPct, setZoomPct] = React.useState(100);

  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let disposed = false;

    const img = document.createElement('img');
    img.className = 'sg-img';
    img.alt = altText ?? '';
    img.draggable = false;
    img.style.position = 'absolute';
    img.style.left = '50%';
    img.style.top = '50%';
    img.src = fileUrl;

    const st: Stage['st'] = { scale: 1, tx: 0, ty: 0, rotation: 0, mode: 'fit' };
    const listeners: Array<[EventTarget, string, EventListener, AddEventListenerOptions?]> = [];
    function on(
      target: EventTarget,
      type: string,
      fn: EventListener,
      opts?: AddEventListenerOptions,
    ): void {
      target.addEventListener(type, fn, opts);
      listeners.push([target, type, fn, opts]);
    }

    function apply(): void {
      img.style.transform =
        `translate(-50%, -50%) translate(${st.tx}px,${st.ty}px) scale(${st.scale}) rotate(${st.rotation}deg)`;
    }

    function rotatedSize(): { w: number; h: number } {
      const odd = (st.rotation / 90) % 2 !== 0;
      return odd
        ? { w: img.naturalHeight, h: img.naturalWidth }
        : { w: img.naturalWidth, h: img.naturalHeight };
    }

    function fit(): void {
      const s = rotatedSize();
      if (!s.w || !s.h || !stage) return;
      st.scale = Math.min((stage.clientWidth - 16) / s.w, (stage.clientHeight - 16) / s.h);
      st.scale = Math.max(0.05, Math.min(8, st.scale));
      st.tx = 0;
      st.ty = 0;
      st.mode = 'fit';
      apply();
      setZoomPct(Math.round(st.scale * 100));
    }

    function zoomAt(clientX: number, clientY: number, factor: number): void {
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const cx = rect.left + rect.width / 2 + st.tx; // image center on screen
      const cy = rect.top + rect.height / 2 + st.ty;
      const s2 = Math.max(0.05, Math.min(8, st.scale * factor));
      const k = s2 / st.scale;
      st.tx = clientX + (cx - clientX) * k - (rect.left + rect.width / 2);
      st.ty = clientY + (cy - clientY) * k - (rect.top + rect.height / 2);
      st.scale = s2;
      st.mode = 'manual';
      apply();
      setZoomPct(Math.round(st.scale * 100));
    }

    on(
      stage,
      'wheel',
      ((e: WheelEvent) => {
        e.preventDefault();
        zoomAt(e.clientX, e.clientY, Math.pow(1.0015, -e.deltaY));
      }) as EventListener,
      { passive: false },
    );

    let dragging: { x: number; y: number } | null = null;
    const endDrag = (): void => {
      dragging = null;
      stage.classList.remove('sg-grabbing');
    };
    on(stage, 'pointerdown', ((e: PointerEvent) => {
      if (e.button !== 0) return; // primary button only — right-drag is the context menu
      dragging = { x: e.clientX, y: e.clientY };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('sg-grabbing');
    }) as EventListener);
    on(stage, 'pointermove', ((e: PointerEvent) => {
      if (!dragging) return;
      st.tx += e.clientX - dragging.x;
      st.ty += e.clientY - dragging.y;
      dragging = { x: e.clientX, y: e.clientY };
      st.mode = 'manual';
      apply();
    }) as EventListener);
    on(stage, 'pointerup', endDrag);
    // Touch/pen gestures the browser takes over (edge swipe, scroll) fire
    // pointercancel, never pointerup — without this the stage keeps panning
    // on hover with the grab cursor stuck on.
    on(stage, 'pointercancel', endDrag);
    on(stage, 'dblclick', ((e: MouseEvent) => {
      if (st.mode === 'fit') zoomAt(e.clientX, e.clientY, 1 / st.scale); // → 100% at cursor
      else fit();
    }) as EventListener);

    const observer = new ResizeObserver(() => {
      if (st.mode === 'fit') fit();
    });
    observer.observe(stage);

    apiRef.current = { st, fit, apply };
    stage.appendChild(img);
    void img
      .decode()
      .then(() => {
        if (!disposed) fit();
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });

    return () => {
      disposed = true;
      observer.disconnect();
      listeners.forEach(([target, type, fn, opts]) => target.removeEventListener(type, fn, opts));
      stage.innerHTML = '';
      apiRef.current = null;
    };
    // Mounted once per file — the parent remounts via key on file change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileUrl]);

  /** Toolbar command dispatch — drives the SAME fit/apply math the gestures
   * use (a second copy of the transform formulas would drift). */
  function cmd(command: 'in' | 'out' | 'fit' | 'actual' | 'rotate'): void {
    const api = apiRef.current;
    if (!api) return;
    const { st } = api;

    const zoomCenter = (factor: number): void => {
      const s2 = Math.max(0.05, Math.min(8, st.scale * factor));
      st.tx *= s2 / st.scale;
      st.ty *= s2 / st.scale;
      st.scale = s2;
      st.mode = 'manual';
    };

    switch (command) {
      case 'in':
        zoomCenter(1.25);
        break;
      case 'out':
        zoomCenter(1 / 1.25);
        break;
      case 'actual':
        st.scale = 1;
        st.tx = 0;
        st.ty = 0;
        st.mode = 'manual';
        break;
      case 'rotate':
        st.rotation = (st.rotation + 90) % 360;
        break;
      case 'fit':
        st.mode = 'fit';
        break;
    }
    if (st.mode === 'fit') api.fit(); // recomputes for the current rotation
    else api.apply();
    setZoomPct(Math.round(st.scale * 100));
  }

  return (
    <>
      <ViewerToolbar
        zoomPercent={zoomPct}
        showFitWidth
        openInNewTabUrl={fileUrl}
        onZoomIn={() => cmd('in')}
        onZoomOut={() => cmd('out')}
        onZoomReset={() => cmd('actual')}
        onFitWidth={() => cmd('fit')}
        onFullscreen={() => void toggleFullscreen(rootRef.current)}
        extras={
          <button type="button" className="sg-tbtn" title="Rotate 90°" onClick={() => cmd('rotate')}>
            ⟳ Rotate
          </button>
        }
      />
      {failed ? (
        <div className="sg-img-wrap">
          <img className="sg-img" src={fileUrl} alt={altText ?? ''} />
        </div>
      ) : (
        <div ref={stageRef} className="sg-imgstage" />
      )}
    </>
  );
}
