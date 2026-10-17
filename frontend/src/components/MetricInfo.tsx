import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { useFloatFit } from './useFloatFit';

export type Provenance = 'observed' | 'derived' | 'simulated' | 'public';

const PROV: Record<Provenance, { label: string; tip: string }> = {
  observed: { label: 'Observed', tip: 'Field record as reported: crash reports, counts, trajectories.' },
  derived: { label: 'Derived', tip: 'Computed from observed data; method in the info panel.' },
  simulated: { label: 'Simulated', tip: 'Modelled, not a field observation.' },
  public: { label: 'Public', tip: 'Agency publication, used as released.' },
};

/** Provenance mark: a quiet coloured dot and one word, the same everywhere (observed, derived, simulated, public). */
export function ProvChip({ kind }: { kind: Provenance }) {
  return <span className="prov" data-kind={kind} title={PROV[kind].tip}><i aria-hidden="true" />{PROV[kind].label}</span>;
}

export interface MetricSpec {
  name: string;
  formula?: ReactNode;
  threshold?: ReactNode;
  unit?: string;
  provenance: Provenance;
  source?: ReactNode;
  citation?: ReactNode;
  note?: ReactNode;
}

/** "i" button next to a metric that opens its methodology: formula, threshold, unit, provenance, source, citation. */
export default function MetricInfo({ spec, align = 'left' }: { spec: MetricSpec; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useFloatFit(pop, open);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <span className="mi" ref={box}>
      <button ref={btn} type="button" className="mi-btn" aria-expanded={open} aria-controls={id} aria-label={`How ${spec.name} is computed`} onClick={() => setOpen((o) => !o)}>
        <Icon name="info" size={16} />
      </button>
      {open && (
        <span ref={pop} id={id} role="dialog" aria-label={`${spec.name} methodology`} className="mi-pop" data-align={align}>
          <span className="mi-head"><b>{spec.name}</b></span>
          {spec.formula && <span className="mi-row"><span>Formula</span><span className="mi-formula">{spec.formula}</span></span>}
          {spec.threshold && <span className="mi-row"><span>Threshold</span><span>{spec.threshold}</span></span>}
          {spec.unit && <span className="mi-row"><span>Unit</span><span className="measure">{spec.unit}</span></span>}
          {spec.source && <span className="mi-row"><span>Data</span><span>{spec.source}</span></span>}
          {spec.citation && <span className="mi-row"><span>Reference</span><span>{spec.citation}</span></span>}
          <span className="mi-row"><span>Provenance</span><span><ProvChip kind={spec.provenance} /></span></span>
          {spec.note && <span className="mi-note">{spec.note}</span>}
        </span>
      )}
    </span>
  );
}
