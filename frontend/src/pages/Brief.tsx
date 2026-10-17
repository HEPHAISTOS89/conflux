import { Link } from 'react-router-dom';
import { useApi } from '../lib/api';
import { nf } from '../lib/format';
import type { Manifest, SegmentProps } from '../lib/types';
import '../styles/brief.css';

type Row = SegmentProps & { fc_group?: string; crashes_per_yr?: number; dfo_from?: number; dfo_to?: number; speed_all?: number; site_type?: string };
interface Screening { total: number; items: Row[] }
interface VruSum { total: number; years: number[]; by_severity: Record<string, number>; by_pbcat: Record<string, number>; by_light: Record<string, number> }

/** Diagnostic prompts derived from segment attributes; they point to what to examine, not to a CMF value. */
function prompts(r: Row): string[] {
  const out: string[] = [];
  if (r.speed_limit && r.speed_all && r.speed_all < r.speed_limit - 15) out.push('Operating speed far below the limit: check signal spacing, access density and queue spillback.');
  if (r.speed_limit && r.speed_all && r.speed_all > r.speed_limit + 3) out.push('Operating speed above the posted limit: review speed management and sight distance.');
  if ((r.lanes ?? 0) >= 6 && (r.fc_group ?? '').includes('arterial')) out.push('Multilane arterial: examine access management and pedestrian crossing exposure.');
  if ((r.truck_pct ?? 0) >= 12) out.push('High heavy-vehicle share: review lane widths, shoulders and turning radii.');
  if ((r.crit_ratio ?? 0) > 1) out.push('Observed rate exceeds the critical rate at 95% confidence.');
  return out.length ? out : ['No attribute flag; pull CRIS crash-level records for collision-type diagnosis.'];
}

export default function Brief() {
  const scr = useApi<Screening>('/screening?method=eb_excess&limit=10');
  const vru = useApi<VruSum>('/vru/summary');
  const meta = useApi<Manifest>('/meta');
  const date = meta.data?.generated_at?.slice(0, 10);
  const ka = vru.data ? (vru.data.by_severity.K ?? 0) + (vru.data.by_severity.A ?? 0) : null;
  const ftyCount = vru.data?.by_pbcat?.['Pedestrian Failed To Yield'];

  return (
    <div className="page brief">
      <div className="brief-actions no-print">
        <Link to="/screening" className="btn ghost">Back to the screening</Link>
        <button className="btn" onClick={() => window.print()}>Print or save as PDF</button>
      </div>
      <article className="sheet-page" aria-labelledby="brief-h">
        <header className="sheet-head">
          <div>
            <h1 id="brief-h">Lubbock County state system: sites for detailed safety diagnosis</h1>
            <p className="muted">Network screening summary prepared in the format of a district safety brief. Data build {date ?? '…'}.</p>
          </div>
          <dl className="sheet-tb num">
            <div><dt>District</dt><dd>Lubbock (05)</dd></div>
            <div><dt>County</dt><dd>152 Lubbock</dd></div>
            <div><dt>Method</dt><dd>HSM Part B, EB</dd></div>
            <div><dt>Sheet</dt><dd>1 of 1</dd></div>
          </dl>
        </header>

        <section>
          <h2>1. Ranked by excess expected average crash frequency</h2>
          <table className="data">
            <thead><tr><th className="r">Rank</th><th>Route · DFO</th><th>Facility</th><th className="r">AADT</th><th className="r">Obs./yr</th><th className="r">SPF/yr</th><th className="r">EB/yr</th><th className="r">Excess</th><th className="r">R/Rc</th></tr></thead>
            <tbody>
              {(scr.data?.items ?? []).map((r, i) => (
                <tr key={r.seg_id}>
                  <td className="r num">{i + 1}</td>
                  <td><b>{r.name}</b> <span className="num muted">{nf(r.dfo_from, 2)}–{nf(r.dfo_to, 2)}</span></td>
                  <td>{r.site_type ?? r.fc_group} · {nf(r.lanes)} ln · {nf(r.speed_limit)} mph</td>
                  <td className="r num">{nf(r.aadt)}</td>
                  <td className="r num">{nf(r.crashes_per_yr, 2)}</td>
                  <td className="r num">{nf(r.spf_pred, 2)}</td>
                  <td className="r num">{nf(r.eb_expected, 2)}</td>
                  <td className="r num"><b>{nf(r.eb_excess, 2)}</b></td>
                  <td className="r num">{nf(r.crit_ratio, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="sheet-two">
          <div>
            <h2>2. What to examine first</h2>
            <ol className="sheet-diag">
              {(scr.data?.items ?? []).slice(0, 5).map((r) => (
                <li key={r.seg_id}><b>{r.name}, DFO {nf(r.dfo_from, 1)}</b><ul>{prompts(r).map((t) => <li key={t}>{t}</li>)}</ul></li>
              ))}
            </ol>
          </div>
          <div>
            <h2>3. Vulnerable road users</h2>
            <p>
              {nf(vru.data?.total)} pedestrian and cyclist crashes in {vru.data?.years.join('–')}, of which <b className="num">{nf(ka)}</b> were fatal or suspected serious (KA).
              {ftyCount ? <> The most frequent PBCAT type is pedestrian failed to yield (<b className="num">{ftyCount}</b>), the population that warning and crossing-control countermeasures target.</> : null}
            </p>
            <h2>4. Next steps</h2>
            <ul className="sheet-next">
              <li>Pull crash-level CRIS records for the ranked sites to obtain KABCO severity, collision type and intersection relation.</li>
              <li>Select countermeasures from the FHWA CMF Clearinghouse using those collision types, with CMFs matched to site type and AADT range.</li>
              <li>Where conflicts are observable, add a short roadside-LiDAR or video collection to compare surrogate measures before and after treatment.</li>
            </ul>
          </div>
        </section>

        <footer className="sheet-foot muted">
          Sources: TxDOT Roadway Inventory 2024, TxDOT AADT, TxDOT Statewide Speed 2024, TxDOT one-mile segment crash results, TxDOT Active Transportation crashes. Informational use only; not an official TxDOT product. Screening flags sites for investigation and does not establish cause.
        </footer>
      </article>
    </div>
  );
}
