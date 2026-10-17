import { useCallback, useEffect, useState, type RefObject } from 'react';
import type { ConflictT, Selection } from '../traj';

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };

/**
 * Element fullscreen with the Fullscreen API (webkit prefix where needed). Where the API is missing
 * (iPhone Safari) the element is pinned over the viewport with a CSS class instead; Esc leaves both.
 * State lives in the component tree, so selection, clock and camera survive the switch.
 */
export function useFullscreen(ref: RefObject<HTMLElement | null>): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const d = document as FsDoc;
    const sync = () => {
      const cur = d.fullscreenElement ?? d.webkitFullscreenElement;
      if (cur && cur === ref.current) { ref.current.classList.remove('pseudo-fs'); document.body.style.overflow = ''; }
      setOn(!!cur && cur === ref.current);
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => { document.removeEventListener('fullscreenchange', sync); document.removeEventListener('webkitfullscreenchange', sync); };
  }, [ref]);
  // pseudo-fullscreen: Esc leaves it (the real API handles Esc natively)
  useEffect(() => {
    const el = ref.current;
    if (!on || !el?.classList.contains('pseudo-fs')) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); el.classList.remove('pseudo-fs'); document.body.style.overflow = ''; setOn(false); } };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [on, ref]);
  const toggle = useCallback(() => {
    const el = ref.current as FsEl | null, d = document as FsDoc;
    if (!el) return;
    if (el.classList.contains('pseudo-fs')) { el.classList.remove('pseudo-fs'); document.body.style.overflow = ''; setOn(false); return; }
    const cur = d.fullscreenElement ?? d.webkitFullscreenElement;
    if (cur) { (d.exitFullscreen?.bind(d) ?? d.webkitExitFullscreen?.bind(d))?.(); return; }
    const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
    const pseudo = () => { el.classList.add('pseudo-fs'); document.body.style.overflow = 'hidden'; setOn(true); };
    if (!req) return pseudo();
    req().catch(pseudo);
    // embedded browsers can leave the request pending behind a permission check: fall back after a beat
    window.setTimeout(() => { if (!(d.fullscreenElement ?? d.webkitFullscreenElement) && !el.classList.contains('pseudo-fs')) pseudo(); }, 1200);
  }, [ref]);
  return [on, toggle];
}

/** The conflict the reader is studying: the picked one, else the earliest conflict between exactly two selected road users. */
export function focusConflict(sel: Selection | null, conflicts: ConflictT[]): ConflictT | null {
  if (!sel) return null;
  if (sel.conflict != null) return conflicts.find((c) => c.id === sel.conflict) ?? null;
  if (sel.selected.size !== 2) return null;
  return [...conflicts].sort((a, b) => a.t - b.t).find((c) => sel.selected.has(String(c.a)) && sel.selected.has(String(c.b))) ?? null;
}

/**
 * PNG of the canvases inside `root` (never icons or DOM chrome), composited in DOM order on the sheet colour,
 * with a source caption. Runs synchronously up to toBlob so a WebGL canvas rendered just before is still intact.
 */
export function exportCanvases(filename: string, root: HTMLElement, caption: string) {
  const r = root.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const foot = 30;
  const out = document.createElement('canvas');
  out.width = Math.round(r.width * dpr); out.height = Math.round((r.height + foot) * dpr);
  const ctx = out.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue('--sheet').trim() || '#1d1e1d';
  ctx.fillRect(0, 0, r.width, r.height + foot);
  root.dispatchEvent(new CustomEvent('lab:render', { bubbles: false }));
  for (const c of Array.from(root.querySelectorAll('canvas'))) {
    const b = c.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    try { ctx.drawImage(c, b.left - r.left, b.top - r.top, b.width, b.height); } catch { /* tainted canvas: skip */ }
  }
  ctx.fillStyle = css.getPropertyValue('--ink-3').trim() || '#9a9b96';
  ctx.font = '12px Switzer, system-ui, sans-serif';
  ctx.fillText(caption, 12, r.height + 19);
  out.toBlob((b) => {
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
}

/** WebGL2 availability, checked once (Three r186 requires WebGL2). */
let glOk: boolean | null = null;
export function webglAvailable(): boolean {
  if (glOk != null) return glOk;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    glOk = !!gl;
    (gl?.getExtension('WEBGL_lose_context'))?.loseContext();
  } catch { glOk = false; }
  return glOk;
}

/** Replace one query parameter in place (no history entry); null removes it. */
export function writeParam(k: string, v: string | null) {
  const q = new URLSearchParams(location.search);
  if (v == null) q.delete(k); else q.set(k, v);
  const s = q.toString().replace(/%2C/g, ',');
  const url = `${location.pathname}${s ? `?${s}` : ''}${location.hash}`;
  if (url !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(history.state, '', url);
}
