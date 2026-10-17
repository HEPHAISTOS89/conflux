import { useEffect, useRef, useState } from 'react';

export const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Marks the element `data-in` once it enters the viewport; CSS staggers its `[data-r]` children.
 * Content is visible by default: the hidden start state only applies once this hook has armed the element,
 * so a script failure never hides anything.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion()) return;
    el.dataset.armed = '';
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { el.dataset.in = ''; io.disconnect(); }
    }, { threshold: 0.06, rootMargin: '0px 0px -6% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

/** Tweens a displayed number toward `target` (ease-out, 420 ms); returns the current value. */
export function useTween(target: number, ms = 420) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (reducedMotion()) { setV(target); from.current = target; return; }
    const a = from.current, t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      const cur = a + (target - a) * e;
      setV(cur); from.current = cur;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}
