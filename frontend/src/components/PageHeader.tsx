import { useEffect, useRef, useState, type ReactNode } from 'react';
import { reducedMotion } from '../lib/motion';
import { Icon, type IconName } from './Icon';
import Info from './Info';

export interface Readout { label: ReactNode; value: number | null | undefined; unit?: string; digits?: number; tone?: 'alert' | 'accent' }

/**
 * Page header: icon, title and the two to four figures that matter, actions at the right.
 * The explanation (`lede`) and data line (`source`) are not printed on the page; they open from the
 * info button beside the title, so the sheet leads with its figures.
 */
export default function PageHeader({ icon, title, scope, lede, source, readouts = [], actions }: {
  icon: IconName; title: string; scope?: string; lede?: ReactNode; source?: ReactNode; readouts?: Readout[]; actions?: ReactNode;
}) {
  return (
    <header className="ph" data-r="1">
      <div className="ph-title">
        <span className="ph-icon"><Icon name={icon} size={20} weight="duotone" /></span>
        <h1>{title}</h1>
        {scope && <span className="ph-scope"><Icon name="county" size={14} />{scope}</span>}
        {(lede || source) && (
          <Info label={`About ${title}`} title={title}>
            {lede && <p>{lede}</p>}
            {source && <span className="ph-source"><Icon name="db" size={14} /><span>{source}</span></span>}
          </Info>
        )}
      </div>
      {(readouts.length > 0 || actions) && (
        <div className="ph-side">
          {readouts.length > 0 && (
            <dl className="ph-readouts">
              {readouts.map((r, i) => <Figure key={i} r={r} />)}
            </dl>
          )}
          {actions && <div className="ph-actions">{actions}</div>}
        </div>
      )}
    </header>
  );
}

/** The first value lands as is; later changes (a filter, a new query) tween to the new figure in 420 ms. */
function useSettle(target: number | null | undefined) {
  const [v, setV] = useState(target);
  const prev = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const from = prev.current;
    prev.current = target;
    if (target == null || from == null || from === target || reducedMotion()) { setV(target); return; }
    const t0 = performance.now(), ms = 420;
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      setV(from + (target - from) * e);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}

function Figure({ r }: { r: Readout }) {
  const v = useSettle(r.value);
  const shown = v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: r.digits ?? 0, maximumFractionDigits: r.digits ?? 0 });
  return (
    <div className="ph-fig" data-tone={r.tone}>
      <dt>{r.label}</dt>
      <dd><span className="num">{shown}</span>{r.unit && <small>{r.unit}</small>}</dd>
    </div>
  );
}
