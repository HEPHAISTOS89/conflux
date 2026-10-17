import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { useFloatFit } from './useFloatFit';

/**
 * Progressive disclosure for secondary text: an "i" button (or a labelled button) that opens a panel.
 * Explanations, sources, licences and method notes live here instead of on the page.
 */
export default function Info({ label, title, children, align = 'left', text }: {
  /** Accessible name of the button, e.g. "About this view". */
  label: string;
  /** Optional heading inside the panel. */
  title?: ReactNode;
  children: ReactNode;
  align?: 'left' | 'right';
  /** Show a visible text label next to the icon. */
  text?: string;
}) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const hide = useRef(0);
  // Hover (mouse) previews the panel; a click pins it open until a click outside or Esc.
  const enter = (e: React.PointerEvent) => { if (e.pointerType !== 'mouse') return; window.clearTimeout(hide.current); setOpen(true); };
  const leave = (e: React.PointerEvent) => { if (e.pointerType !== 'mouse' || pinned.current) return; hide.current = window.setTimeout(() => setOpen(false), 160); };
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useFloatFit(pop, open);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) { pinned.current = false; setOpen(false); } };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { pinned.current = false; setOpen(false); btn.current?.focus(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <span className="mi" ref={box} onPointerEnter={enter} onPointerLeave={leave}>
      <button ref={btn} type="button" className={text ? 'btn ghost info-btn' : 'mi-btn'} aria-expanded={open} aria-controls={id}
        aria-label={text ? undefined : label} title={text ? undefined : label} onClick={() => { if (open && pinned.current) { pinned.current = false; setOpen(false); } else { pinned.current = true; setOpen(true); } }}>
        <Icon name="info" size={16} />{text && <span>{text}</span>}
      </button>
      {open && (
        <span ref={pop} id={id} role="dialog" aria-label={label} className="mi-pop info-pop" data-align={align}>
          {title && <span className="mi-head"><b>{title}</b></span>}
          {children}
        </span>
      )}
    </span>
  );
}
