import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getJSON } from '../lib/api';
import { nf } from '../lib/format';

interface Item { id: string; label: string; hint: string; to: string; kind: 'Sheet' | 'Corridor' | 'Segment' | 'Intersection' }

const SHEETS: Item[] = [
  ['/', 'Atlas'], ['/screening', 'Network screening'], ['/corridors', 'Corridors'], ['/vru', 'Pedestrians & cyclists'],
  ['/intersections', 'Intersection lab'], ['/brief', 'District brief'], ['/methods', 'Methods & data'], ['/platform', 'Platform'], ['/ask', 'Ask the data'],
].map(([to, label]) => ({ id: to, label, hint: '', to, kind: 'Sheet' as const }));

/** ⌘K / Ctrl-K jump to any sheet, corridor, ranked segment or intersection; arrow keys and Enter. */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const [items, setItems] = useState<Item[]>(SHEETS);
  const nav = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName ?? '');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
      else if (e.key === '/' && !typing) { e.preventDefault(); setOpen(true); }
    };
    const ext = () => setOpen(true);
    window.addEventListener('keydown', key);
    window.addEventListener('rs:palette', ext);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('rs:palette', ext); };
  }, []);

  useEffect(() => {
    if (!open) { back.current?.focus?.(); return; }
    back.current = document.activeElement as HTMLElement;
    setQ(''); setI(0);
    requestAnimationFrame(() => input.current?.focus());
    // Load searchable records once; the API responses are cached client-side.
    Promise.allSettled([
      getJSON<{ id: string; name: string; len_mi: number }[]>('/corridors'),
      getJSON<{ items: { seg_id: string; name: string; dfo_from?: number; eb_excess: number | null; screen_rank?: number }[] }>('/screening?method=eb_excess&limit=40'),
      getJSON<{ id: string; name: string; n_conflicts: number }[]>('/intersections'),
    ]).then(([c, s, x]) => {
      const out = [...SHEETS];
      if (c.status === 'fulfilled') out.push(...c.value.map((v) => ({ id: v.id, label: v.name, hint: `${nf(v.len_mi, 1)} mi`, to: `/corridors/${v.id}`, kind: 'Corridor' as const })));
      if (s.status === 'fulfilled') out.push(...s.value.items.map((v, k) => ({ id: v.seg_id, label: `${v.name} · DFO ${nf(v.dfo_from, 1)}`, hint: `rank ${k + 1} · EB ${nf(v.eb_excess, 2)}`, to: `/screening?seg=${encodeURIComponent(v.seg_id)}`, kind: 'Segment' as const })));
      if (x.status === 'fulfilled') out.push(...x.value.map((v) => ({ id: v.id, label: v.name, hint: `${v.n_conflicts} conflicts`, to: `/intersections/${v.id}`, kind: 'Intersection' as const })));
      setItems(out);
    });
  }, [open]);

  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items.slice(0, 12);
    const words = t.split(/\s+/);
    return items.filter((it) => words.every((w) => `${it.label} ${it.hint} ${it.kind}`.toLowerCase().includes(w))).slice(0, 12);
  }, [q, items]);

  if (!open) return null;
  const go = (it?: Item) => { if (!it) return; setOpen(false); nav(it.to); };

  return (
    <div className="cmdk-scrim" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Jump to">
        <input
          ref={input}
          value={q}
          placeholder="Jump to a sheet, corridor, segment or intersection"
          aria-label="Search"
          aria-controls="cmdk-list"
          aria-activedescendant={hits[i] ? `cmdk-${i}` : undefined}
          onChange={(e) => { setQ(e.target.value); setI(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((v) => Math.min(hits.length - 1, v + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setI((v) => Math.max(0, v - 1)); }
            if (e.key === 'Enter') go(hits[i]);
          }}
        />
        <ul id="cmdk-list" role="listbox">
          {hits.map((it, k) => (
            <li key={`${it.kind}-${it.id}`} id={`cmdk-${k}`} role="option" aria-selected={k === i} onMouseEnter={() => setI(k)} onMouseDown={(e) => { e.preventDefault(); go(it); }}>
              <span className="cmdk-kind">{it.kind}</span>
              <span className="cmdk-label">{it.label}</span>
              <span className="cmdk-hint num">{it.hint}</span>
            </li>
          ))}
          {!hits.length && <li className="cmdk-empty">Nothing matches “{q}”.</li>}
        </ul>
        <div className="cmdk-foot"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close</div>
      </div>
    </div>
  );
}
