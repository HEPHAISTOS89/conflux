import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { useTween } from '../lib/motion';

export interface Readout { label: ReactNode; value: number | null | undefined; unit?: string; digits?: number; tone?: 'alert' | 'accent' }

/**
 * Page header that states the reading at a glance: what this sheet is, on which data,
 * and the two to four figures that matter, each with its unit. Actions sit at the right.
 */
export default function PageHeader({ icon, title, lede, source, readouts = [], actions }: {
  icon: IconName; title: string; lede?: ReactNode; source?: ReactNode; readouts?: Readout[]; actions?: ReactNode;
}) {
  return (
    <header className="ph" data-r="1">
      <div className="ph-main">
        <div className="ph-title">
          <span className="ph-icon"><Icon name={icon} size={22} weight="duotone" /></span>
          <h1>{title}</h1>
        </div>
        {lede && <p className="ph-lede">{lede}</p>}
        {source && <p className="ph-source"><Icon name="db" size={14} />{source}</p>}
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

function Figure({ r }: { r: Readout }) {
  const v = useTween(r.value ?? 0);
  const shown = r.value == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: r.digits ?? 0, maximumFractionDigits: r.digits ?? 0 });
  return (
    <div className="ph-fig" data-tone={r.tone}>
      <dt>{r.label}</dt>
      <dd><span className="num">{shown}</span>{r.unit && <small>{r.unit}</small>}</dd>
    </div>
  );
}
