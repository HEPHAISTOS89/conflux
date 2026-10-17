import { useEffect, useRef } from 'react';

/**
 * Measurement reticle for a positioned parent: crosshair lines that follow the pointer and a readout
 * computed from the pointer's fractional position. Fine pointers only; touch keeps native behaviour.
 */
export default function Reticle({ read }: { read: (fx: number, fy: number) => string | null }) {
  const el = useRef<HTMLDivElement>(null);
  const fn = useRef(read);
  fn.current = read;
  useEffect(() => {
    const box = el.current, host = box?.parentElement;
    if (!box || !host || !matchMedia('(pointer: fine)').matches) return;
    const [rx, ry, rl] = Array.from(box.children) as HTMLElement[];
    const move = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const label = fn.current(x / r.width, y / r.height);
      if (label == null) { delete box.dataset.on; return; }
      box.dataset.on = '';
      rx.style.top = `${y}px`; ry.style.left = `${x}px`;
      rl.style.left = `${Math.min(x, r.width - 150)}px`; rl.style.top = `${y}px`;
      rl.textContent = label;
    };
    const leave = () => { delete box.dataset.on; };
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerleave', leave);
    return () => { host.removeEventListener('pointermove', move); host.removeEventListener('pointerleave', leave); };
  }, []);
  return (
    <div ref={el} className="reticle" aria-hidden="true">
      <i className="rx" /><i className="ry" /><span className="rl" />
    </div>
  );
}
