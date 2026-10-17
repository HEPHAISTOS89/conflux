import { useEffect, useId, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { useFloatFit } from './useFloatFit';

export interface Option<T extends string> { value: T; label: string; hint?: string; icon?: IconName }

/**
 * Listbox select: keyboard (↑ ↓ Home End Enter Esc, type-ahead), focus return, outside click,
 * optional per-option hint (counts, units). Renders a native-feeling trigger in the portal's style.
 */
export default function Select<T extends string>({ value, options, onChange, label, icon, compact }: {
  value: T; options: Option<T>[]; onChange: (v: T) => void; label: string; icon?: IconName; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ s: '', t: 0 });
  const current = options.find((o) => o.value === value) ?? options[0];
  useFloatFit(list, open);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    list.current?.focus();
    const away = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (i: number) => { const o = options[i]; if (o) onChange(o.value); setOpen(false); btn.current?.focus(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === 'Enter' || (e.key === ' ' && performance.now() - typed.current.t > 600)) { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape' || e.key === 'Tab') { setOpen(false); btn.current?.focus(); }
    else if (e.key.length === 1) {
      const now = performance.now();
      typed.current = { s: now - typed.current.t < 600 ? typed.current.s + e.key.toLowerCase() : e.key.toLowerCase(), t: now };
      const i = options.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.s));
      if (i >= 0) setActive(i);
    }
  };

  return (
    <div className={`sel ${compact ? 'sel-compact' : ''}`} data-open={open || undefined}>
      <button
        ref={btn}
        type="button"
        className="sel-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={`${label}: ${current?.label}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); } else if (e.key === 'Escape') setOpen(false); }}
      >
        {icon && <Icon name={icon} size={16} />}
        <span className="sel-k">{label}</span>
        <span className="sel-v">{current?.label}</span>
        <Icon name="caretUpDown" size={14} />
      </button>
      {open && (
        <ul ref={list} id={`${id}-list`} role="listbox" tabIndex={-1} className="sel-list" aria-label={label}
          aria-activedescendant={`${id}-${active}`} onKeyDown={onKey}>
          {options.map((o, i) => (
            <li key={o.value} id={`${id}-${i}`} role="option" aria-selected={o.value === value} data-active={i === active || undefined}
              onPointerEnter={() => setActive(i)} onClick={() => choose(i)}>
              {o.icon && <Icon name={o.icon} size={16} />}
              <span>{o.label}</span>
              {o.hint && <small className="num">{o.hint}</small>}
              {o.value === value && <Icon name="check" size={14} weight="bold" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
