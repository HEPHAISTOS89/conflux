import { useEffect, useState } from 'react';

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Reveals `text` as if typed: word by word at a reading pace, capped so long answers finish in ~2 s.
 * Returns how many characters are visible and whether typing is done. Reduced motion shows it at once.
 */
export function useTyped(text: string, { cps = 90, maxMs = 2200 } = {}) {
  const [n, setN] = useState(() => (reduced() ? text.length : 0));
  useEffect(() => {
    if (reduced() || !text) { setN(text.length); return; }
    setN(0);
    const rate = Math.max(cps, text.length / (maxMs / 1000)); // characters per second
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      let k = Math.min(text.length, Math.floor(((now - t0) / 1000) * rate));
      while (k < text.length && !/\s/.test(text[k])) k++; // never cut a word
      setN(k);
      if (k < text.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, cps, maxMs]);
  return { n, done: n >= text.length };
}

/**
 * Placeholder that types and erases example questions in turn while `active` (empty, unfocused field).
 * Returns the static fallback under reduced motion or when inactive.
 */
export function useTypedPlaceholder(lines: string[], active: boolean, fallback: string) {
  const [s, setS] = useState(fallback);
  useEffect(() => {
    if (!active || reduced() || !lines.length) { setS(fallback); return; }
    let i = 0, k = 0, dir = 1, timer = 0;
    const tick = () => {
      const line = lines[i % lines.length];
      k += dir;
      setS(line.slice(0, k) || '​');
      let wait = dir > 0 ? 38 + Math.random() * 40 : 16;
      if (dir > 0 && k >= line.length) { dir = -1; wait = 1800; }
      else if (dir < 0 && k <= 0) { dir = 1; i++; wait = 380; }
      timer = window.setTimeout(tick, wait);
    };
    timer = window.setTimeout(tick, 600);
    return () => window.clearTimeout(timer);
  }, [lines, active, fallback]);
  return s;
}
