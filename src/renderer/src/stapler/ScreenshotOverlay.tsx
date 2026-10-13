/**
 * The screenshot overlay (stapler.html#overlay): a frameless window over the
 * whole display showing the screen as it was the moment Screenshot was
 * clicked. Drag a region and it is cropped and added to the tray; Enter or a
 * double-click takes the region used last time on this display ("the region
 * is remembered"); Esc cancels. Owned by the `stapler` unit.
 *
 * Coordinates here are CSS pixels of the overlay, which covers exactly the
 * captured display; main maps them onto the physical-pixel image
 * (regionToPixels) and cuts from the original, not from what is drawn here.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { isUsableRegion, MAX_SHOTS, regionFromPoints, type OverlayInit, type Region } from '@shared/features/stapler';
import { stapler } from './bridge';
import './stapler.css';

type Point = { x: number; y: number };

export function ScreenshotOverlay() {
  const { t } = useTranslation();
  const [init, setInit] = useState<OverlayInit | null>(null);
  const [drag, setDrag] = useState<{ a: Point; b: Point } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  // The overlay is drawn over the user's screen, not the app: pin it to the
  // light tokens whatever the app theme is, so it reads the same everywhere.
  useEffect(() => {
    document.documentElement.dataset.cthTheme = 'light';
  }, []);

  useEffect(() => {
    let alive = true;
    stapler().overlayInit().then((r) => {
      if (!alive) return;
      if (!r.ok) { void stapler().overlayCancel(); return; }
      setInit(r);
    }, () => { void stapler().overlayCancel(); });
    return () => { alive = false; };
  }, []);

  const view = { width: init?.width ?? window.innerWidth, height: init?.height ?? window.innerHeight };
  const remembered = init?.remembered ?? null;
  const region: Region | null = drag ? regionFromPoints(drag.a, drag.b, view) : null;

  const commit = async (r: Region | null) => {
    if (!r || !isUsableRegion(r) || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const res = await stapler().overlayCommit(r);
      if (!res.ok) { setError(res.error ?? 'failed'); savingRef.current = false; setSaving(false); }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
      savingRef.current = false;
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); void stapler().overlayCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); void commit(region && isUsableRegion(region) ? region : remembered); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const point = (e: ReactPointerEvent): Point => ({ x: e.clientX, y: e.clientY });

  if (!init) return <div className="cth-stapler-overlay" />;

  // The four shade rects around the selection (or one over everything).
  const sel = region && isUsableRegion(region) ? region : null;
  const shades = sel
    ? [
        { left: 0, top: 0, width: view.width, height: sel.y },
        { left: 0, top: sel.y + sel.height, width: view.width, height: Math.max(0, view.height - sel.y - sel.height) },
        { left: 0, top: sel.y, width: sel.x, height: sel.height },
        { left: sel.x + sel.width, top: sel.y, width: Math.max(0, view.width - sel.x - sel.width), height: sel.height }
      ]
    : [{ left: 0, top: 0, width: view.width, height: view.height }];

  const count = init.shotCount ?? 0;
  return (
    <div
      className="cth-stapler-overlay"
      onPointerDown={(e) => {
        if (e.button !== 0 || saving) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ a: point(e), b: point(e) });
      }}
      onPointerMove={(e) => { if (drag) setDrag({ a: drag.a, b: point(e) }); }}
      onPointerUp={(e) => {
        if (!drag) return;
        const r = regionFromPoints(drag.a, point(e), view);
        if (isUsableRegion(r)) { setDrag({ a: drag.a, b: point(e) }); void commit(r); }
        else setDrag(null);
      }}
      onDoubleClick={() => { if (remembered) void commit(remembered); }}
      onContextMenu={(e) => { e.preventDefault(); void stapler().overlayCancel(); }}
    >
      <img src={init.image} alt="" draggable={false} />
      {shades.map((s, i) => <div key={i} className="cth-stapler-shade" style={s} />)}
      {!sel && remembered && (
        <div className="cth-stapler-sel cth-stapler-sel--ghost" style={{ left: remembered.x, top: remembered.y, width: remembered.width, height: remembered.height }} />
      )}
      {sel && (
        <>
          <div className="cth-stapler-sel" style={{ left: sel.x, top: sel.y, width: sel.width, height: sel.height }} />
          <span
            className="cth-stapler-sel-size"
            style={{ left: sel.x, top: sel.y >= 20 ? sel.y - 20 : sel.y + sel.height + 4 }}
          >
            {sel.width} × {sel.height}
          </span>
        </>
      )}
      <div className="cth-stapler-hint">
        <span role="status">
          {error
            ? t('stapler.overlay.failed', { error })
            : saving
              ? t('stapler.overlay.saving')
              : remembered
                ? t('stapler.overlay.hintRemembered', { count: count + 1, max: MAX_SHOTS })
                : t('stapler.overlay.hint', { count: count + 1, max: MAX_SHOTS })}
        </span>
      </div>
    </div>
  );
}
