import { Link } from 'react-router-dom';
import { Icon, type IconName } from '../Icon';
import { ProvChip, type Provenance } from '../MetricInfo';
import { useApi } from '../../lib/api';
import { useReveal } from '../../lib/motion';
import type { ConflictT } from '../../lib/traj';
import { nf } from '../../lib/format';
import type { Seg } from './types';

interface Row { icon: IconName; value: string | null; unit?: string; text: string; basis: string; prov: Provenance; to: string; cta: string }

/** Four findings a county engineer can act on, each one link away from its evidence. */
export default function Verdict() {
  const ref = useReveal<HTMLElement>();
  const scr = useApi<{ items: Seg[]; total: number }>('/screening?method=eb_excess&limit=1000');
  const vru = useApi<{ by_severity: Record<string, number>; years: number[] }>('/vru/summary');
  const cf = useApi<(ConflictT & { overlap?: boolean })[]>('/intersections/peachtree-10th/conflicts');

  // project-wide rule: flagged = EB excess > 0; confirmed = flagged and critical rate ratio > 1
  const items = scr.data?.items ?? [];
  const flaggedSegs = items.filter((s) => (s.eb_excess ?? 0) > 0);
  const flagged = flaggedSegs.length;
  const confirmed = flaggedSegs.filter((s) => (s.crit_ratio ?? 0) > 1).length;
  const t = items[0];
  const ka = vru.data ? (vru.data.by_severity.K ?? 0) + (vru.data.by_severity.A ?? 0) : null;
  const yrs = vru.data?.years.join('–') ?? '2021–2023';
  const crit = (cf.data ?? []).filter((c) => c.severity === 'critical' && !c.overlap).length;

  const rows: Row[] = [
    { icon: 'alert', value: scr.data ? String(flagged) : null, unit: `of ${nf(scr.data?.total ?? items.length)}`, text: `segments flagged for pedestrian and cyclist crashes above their SPF (EB excess > 0); ${confirmed} confirmed by a critical rate ratio above 1`, basis: `HSM Part B, Empirical Bayes · CRIS ${yrs}`, prov: 'derived', to: '/screening', cta: 'Screening' },
    { icon: 'target', value: t ? t.name : null, unit: t ? `DFO ${nf(t.dfo_from, 1)}–${nf(t.dfo_to, 1)}` : undefined, text: t ? `ranks first, with ${nf(t.eb_excess, 2)} excess crashes a year on ${nf(t.aadt)} vehicles a day` : 'ranks first', basis: `${t?.site_type ?? 'Site-type'} SPF · TxDOT AADT`, prov: 'derived', to: t ? `/screening?seg=${encodeURIComponent(t.seg_id)}` : '/screening', cta: 'Segment' },
    { icon: 'pedestrian', value: ka == null ? null : String(ka), unit: 'K + A', text: `pedestrians and cyclists killed or seriously injured on Lubbock County state roads, ${yrs}`, basis: 'TxDOT CRIS crash reports, KABCO', prov: 'observed', to: '/vru', cta: 'Crashes' },
    { icon: 'intersection', value: cf.data ? String(crit) : null, unit: 'in 90 s', text: 'critical conflicts at Peachtree St & 10th St, with position-overlap flags set aside as likely data error', basis: 'NGSIM trajectories · FHWA SSAM thresholds', prov: 'derived', to: '/intersections/peachtree-10th', cta: 'Conflicts' },
  ];

  return (
    <section ref={ref} className="vd" aria-labelledby="vd-h">
      <h2 id="vd-h" data-r="1">The verdict</h2>
      <table className="vd-table" data-r="2">
        <caption className="sr-only">Four findings, each linked to the page with its evidence</caption>
        <tbody>
          {rows.map((r) => (
            <tr key={r.cta}>
              <th scope="row" className="vd-fig">
                <Icon name={r.icon} size={22} weight="duotone" />
                {r.value == null ? <span className="skeleton vd-sk" /> : <b>{r.value}</b>}
                {r.unit && <small className="measure">{r.unit}</small>}
              </th>
              <td className="vd-text"><span className="vd-chip-m"><ProvChip kind={r.prov} /></span>{r.text}</td>
              <td className="vd-basis"><ProvChip kind={r.prov} /><span>{r.basis}</span></td>
              <td className="vd-go"><Link to={r.to}>{r.cta}<Icon name="arrow" size={16} /></Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
