import { useLayoutEffect, type RefObject } from 'react';

/**
 * Keeps a floating panel (popover, listbox, tooltip) inside the viewport: shifts it horizontally with the
 * CSS `translate` property (so entrance animations on `transform` still run) and flips it above its anchor
 * when there is no room below. Re-measures on resize and scroll while open.
 */
export function useFloatFit(ref: RefObject<HTMLElement | null>, open: boolean, margin = 12) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const fit = () => {
      el.style.setProperty('--dx', '0px');
      el.removeAttribute('data-up');
      const r = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth, vh = window.innerHeight;
      // Keep clear of the fixed side rail: the usable area starts at the main column, not the viewport edge.
      const main = document.getElementById('main')?.getBoundingClientRect();
      const minL = Math.max(margin, (main?.left ?? 0) + margin);
      let dx = 0;
      if (r.right > vw - margin) dx = vw - margin - r.right;
      if (r.left + dx < minL) dx = minL - r.left;
      el.style.setProperty('--dx', `${Math.round(dx)}px`);
      const anchor = el.parentElement?.getBoundingClientRect();
      if (r.bottom > vh - margin && anchor && anchor.top - r.height - 8 > margin) el.setAttribute('data-up', '');
    };
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('scroll', fit, true);
    return () => { window.removeEventListener('resize', fit); window.removeEventListener('scroll', fit, true); };
  }, [ref, open, margin]);
}
