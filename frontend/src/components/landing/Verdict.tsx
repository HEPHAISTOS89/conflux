import { Link } from 'react-router-dom';
import { Icon, type IconName } from '../Icon';
import Info from '../Info';
import { ProvChip, type Provenance } from '../MetricInfo';
import { useApi } from '../../lib/api';
import { useReveal } from '../../lib/motion';
import type { ConflictT } from '../../lib/traj';
import { nf } from '../../lib/format';
import type { Seg } from './types';

interface Fig { icon: IconName; value: string | null; unit?: string; label: string; to: string; basis: string; prov: Provenance }

/** Four findings, each one link away from its evidence; the basis of every figure sits behind one Info button. */
export default function Verdict() {
  const ref = useReveal<HTMLElement>();
  const scr = useApi<{ items: Seg[]; total: number }>('/screening?method=eb_excess&limit=1000');
  const vru = useApi<{ by_severity: Record<string, number>; years: number[]; on_system?: { total: number; ka: number } }>('/vru/summary');
  const cf = useApi<(ConflictT & { overlap?: boolean })[]>('/intersections/peachtree-10th/conflicts');

  // project-wide rule: flagged = EB excess > 0; confirmed = flagged and critical rate ratio > 1
  const items = scr.data?.items ?? [];
  const flaggedSegs = items.filter((s) => (s.eb_excess ?? 0) > 0);
  const confirmed = flaggedSegs.filter((s) => (s.crit_ratio ?? 0) > 1).length;
  const t = items[0];
  // state roads = on-system crashes only (the screened network); all-roads KA would overstate the claim
  const ka = vru.data?.on_system ? vru.data.on_system.ka : null;
  const yrs = vru.data?.years.join('–') ?? '2021–2023';
  const crit = (cf.data ?? []).filter((c) => c.severity === 'critical' && !c.overlap).length;
  const total = scr.data?.total ?? items.length;

  const figs: Fig[] = [
    { icon: 'alert', value: scr.data ? String(flaggedSegs.length) : null, unit: `of ${nf(total)}`, label: 'Segments with excess crashes', to: '/screening',
      basis: `Lubbock County state-system segments with pedestrian and cyclist EB excess > 0 (HSM Part B, Empirical Bayes; CRIS ${yrs}); ${confirmed} also have a critical rate ratio R/Rc > 1.`, prov: 'derived' },
    { icon: 'target', value: t ? t.name.split(' (')[0] : null, unit: t ? `${nf(t.eb_excess, 2)} / yr` : undefined, label: 'Ranked first for treatment', to: t ? `/screening?seg=${encodeURIComponent(t.seg_id)}` : '/screening',
      basis: t ? `${t.name}, DFO ${nf(t.dfo_from, 1)}–${nf(t.dfo_to, 1)}: ${nf(t.eb_excess, 2)} excess expected crashes per year at AADT ${nf(t.aadt)} (${t.site_type ?? 'site-type'} SPF, TxDOT AADT).` : 'Rank 1 by EB excess.', prov: 'derived' },
    { icon: 'pedestrian', value: ka == null ? null : String(ka), unit: 'K + A', label: 'Walking and cycling deaths, serious injuries', to: '/vru',
      basis: `Pedestrians and cyclists killed (K) or seriously injured (A), Lubbock County state roads, ${yrs}; TxDOT CRIS crash reports, on-system, KABCO.`, prov: 'observed' },
    { icon: 'intersection', value: cf.data ? String(crit) : null, unit: 'in 90 s', label: 'Critical conflicts at one intersection', to: '/intersections/peachtree-10th',
      basis: 'Critical SSAM conflicts at Peachtree St & 10th St in 90 s of NGSIM trajectories (FHWA SSAM thresholds); position-overlap flags excluded as likely data error.', prov: 'derived' },
  ];

  return (
    <section ref={ref} className="vd" aria-label="Findings">
      <ul className="vd-figs">
        {figs.map((f, i) => (
          <li key={f.label} data-r={i + 1}>
            <Link to={f.to} className="vd-fig">
              <span className="vd-val">
                {f.value == null ? <span className="skeleton vd-sk" /> : <b data-long={f.value.length > 5 || undefined}>{f.value}</b>}
                {f.unit && <small className="measure">{f.unit}</small>}
              </span>
              <span className="vd-label"><Icon name={f.icon} size={16} />{f.label}<Icon name="arrow" size={16} /></span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="vd-info" data-r="5">
        <Info label="How these figures are computed" title="Basis of each figure" text="Basis and sources">
          {figs.map((f) => <p key={f.label}><ProvChip kind={f.prov} /> {f.basis}</p>)}
        </Info>
      </div>
    </section>
  );
}
