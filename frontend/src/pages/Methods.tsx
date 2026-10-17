import { Link } from 'react-router-dom';
import { useApi } from '../lib/api';
import { nf } from '../lib/format';
import type { Manifest, RepairSummary, Spf } from '../lib/types';
import '../styles/methods.css';

// MathML Core elements are not in @types/react's IntrinsicElements; declare the ones used here.
type MathEl = React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { display?: string; width?: string };
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      math: MathEl; mrow: MathEl; mi: MathEl; mo: MathEl; mn: MathEl; mfrac: MathEl; msup: MathEl;
      msub: MathEl; msqrt: MathEl; mspace: MathEl; mtext: MathEl;
    }
  }
}

const TOC: [string, string][] = [
  ['m-data', 'Data sources'],
  ['m-screen', 'Network screening'],
  ['m-spf', 'Safety performance functions'],
  ['m-ssm', 'Surrogate safety measures'],
  ['m-repair', 'Trajectory repair'],
  ['m-limits', 'Limitations'],
  ['m-refs', 'References'],
];
const SITES: [string, string][] = [['peachtree-10th', 'Peachtree St NE at 10th St NE'], ['lankershim-main', 'Lankershim Blvd at Main St']];
const METHOD_LABEL: Record<string, string> = { linear: 'Linear interpolation', kf_ca: 'CA Kalman + RTS', kf_ca_path: 'CA Kalman + RTS, path-constrained' };

const date = (s?: string) => (s ? s.slice(0, 10) : '—');

export default function Methods() {
  const meta = useApi<Manifest>('/meta');
  const spf = useApi<Spf & { se_b0?: number; se_b1?: number; crashes?: number; loglik?: number; estimation?: string; units?: string }>('/spf');
  const rp = useApi<{ summary: RepairSummary }>('/intersections/peachtree-10th/repair');
  const rl = useApi<{ summary: RepairSummary }>('/intersections/lankershim-main/repair');
  const repairs = [rp, rl];

  return (
    <div className="page methods">
      <header className="page-head">
        <h1>Methods</h1>
        <p>
          How every number in RoadScope is produced: sources and their provenance, the HSM Part B screening
          measures, the negative binomial safety performance functions, the surrogate safety measures computed on
          trajectories, and the occluded-track repair evaluation. Limitations are stated where they bind.
        </p>
      </header>

      <div className="methods-layout">
        <nav className="methods-toc" aria-label="On this page">
          <ol>{TOC.map(([id, t]) => <li key={id}><a href={`#${id}`}>{t}</a></li>)}</ol>
        </nav>

        <article className="methods-body">
          <section id="m-data" className="section" aria-labelledby="m-data-h">
            <div className="section-head"><h2 id="m-data-h">1. Data sources</h2>{meta.data && <p>Manifest generated <span className="num">{date(meta.data.generated_at)}</span></p>}</div>
            {meta.error && <div className="error-box">{meta.error}</div>}
            {meta.loading && <div className="skeleton m-skel" />}
            {meta.data && (
              <div className="m-scroll">
                <table className="data">
                  <thead><tr><th>Source</th><th>Licence</th><th className="r">Records</th><th>Fetched</th><th>SHA-256</th></tr></thead>
                  <tbody>
                    {meta.data.sources.map((s) => (
                      <tr key={s.id}>
                        <td><a href={s.url} rel="noopener noreferrer" target="_blank">{s.id}</a></td>
                        <td className="m-lic">{s.licence}</td>
                        <td className="r num">{nf(s.records)}</td>
                        <td className="num">{date(s.fetched_at)}</td>
                        <td className="num" title={s.sha256}>{s.sha256 ? s.sha256.slice(0, 12) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section id="m-screen" className="section" aria-labelledby="m-screen-h">
            <div className="section-head"><h2 id="m-screen-h">2. Network screening</h2></div>
            <p>State-system roadway in Lubbock County is divided into segments of about one mile by DFO. Each segment is
              assigned the length-weighted AADT of overlapping TxDOT count stations and its crash count over the record
              period <i>Y</i> = 9 years. Three HSM (2010) Part B performance measures are computed.</p>
            <h3>Crash rate</h3>
            <Eq label="Crash rate per 100 million vehicle-miles">
              <math display="block">
                <mrow><mi>R</mi><mo>=</mo><mfrac><mrow><mi>N</mi><mo>·</mo><msup><mn>10</mn><mn>8</mn></msup></mrow><mrow><mn>365</mn><mo>·</mo><mi>Y</mi><mo>·</mo><mi>AADT</mi><mo>·</mo><mi>L</mi></mrow></mfrac></mrow>
              </math>
            </Eq>
            <p><i>N</i> is observed crashes over <i>Y</i> years, <i>L</i> segment length in miles; <i>R</i> is in crashes per 100 MVMT.</p>
            <h3>Critical rate</h3>
            <Eq label="Critical crash rate">
              <math display="block">
                <mrow><msub><mi>R</mi><mi>c</mi></msub><mo>=</mo><msub><mi>R</mi><mi>a</mi></msub><mo>+</mo><mi>k</mi><msqrt><mfrac><msub><mi>R</mi><mi>a</mi></msub><mi>M</mi></mfrac></msqrt><mo>+</mo><mfrac><mn>1</mn><mrow><mn>2</mn><mi>M</mi></mrow></mfrac></mrow>
              </math>
            </Eq>
            <p><i>R<sub>a</sub></i> is the exposure-weighted average rate of the reference population (functional-class group),
              <i> M</i> the segment's exposure in 100 MVMT, and <i>k</i> = 1.645 for 95 % confidence. The critical-rate ratio
              <i> R</i>/<i>R<sub>c</sub></i> &gt; 1 flags a segment.</p>
            <h3>Empirical Bayes expected crashes</h3>
            <Eq label="Empirical Bayes weight and expected crashes">
              <math display="block">
                <mrow><mi>w</mi><mo>=</mo><mfrac><mn>1</mn><mrow><mn>1</mn><mo>+</mo><mi>k</mi><mo>·</mo><msub><mi>μ</mi><mi>SPF</mi></msub></mrow></mfrac>
                  <mspace width="2em" />
                  <msub><mi>N</mi><mi>exp</mi></msub><mo>=</mo><mi>w</mi><mo>·</mo><msub><mi>μ</mi><mi>SPF</mi></msub><mo>+</mo><mo>(</mo><mn>1</mn><mo>−</mo><mi>w</mi><mo>)</mo><mo>·</mo><msub><mi>N</mi><mi>obs</mi></msub></mrow>
              </math>
            </Eq>
            <p><i>μ</i><sub>SPF</sub> and <i>N</i><sub>obs</sub> are over the same period and <i>k</i> is the fitted NB
              overdispersion. Segments are ranked by excess expected crashes, <i>N</i><sub>exp</sub> − <i>μ</i><sub>SPF</sub>,
              reported per year (Hauer 1997; HSM 2010, Ch. 4).</p>
          </section>

          <section id="m-spf" className="section" aria-labelledby="m-spf-h">
            <div className="section-head"><h2 id="m-spf-h">3. Safety performance functions</h2></div>
            <Eq label="Segment SPF functional form">
              <math display="block">
                <mrow><mi>μ</mi><mo>=</mo><mi>exp</mi><mo>(</mo><msub><mi>β</mi><mn>0</mn></msub><mo>)</mo><mo>·</mo><msup><mi>AADT</mi><msub><mi>β</mi><mn>1</mn></msub></msup><mo>·</mo><mi>L</mi></mrow>
              </math>
            </Eq>
            <p>{spf.data?.estimation ?? 'NB2 maximum likelihood'}. Units: {spf.data?.units ?? 'crashes per year'}. Segments with
              no matched AADT are excluded from estimation. Classes with too few segments or crashes fall back to the pooled model.</p>
            {spf.error && <div className="error-box">{spf.error}</div>}
            {spf.loading && <div className="skeleton m-skel" />}
            {spf.data && (
              <div className="m-scroll">
                <table className="data">
                  <thead><tr><th>Model</th><th className="r">n</th><th className="r">Crashes</th><th className="r">β₀ ± SE</th><th className="r">β₁ ± SE</th><th className="r">k</th><th className="r">AIC</th></tr></thead>
                  <tbody>
                    <tr>
                      <td><strong>Pooled</strong></td>
                      <td className="r num">{spf.data.n}</td>
                      <td className="r num">{nf(spf.data.crashes)}</td>
                      <td className="r num">{nf(spf.data.b0, 3)} ± {nf(spf.data.se_b0, 3)}</td>
                      <td className="r num">{nf(spf.data.b1, 3)} ± {nf(spf.data.se_b1, 3)}</td>
                      <td className="r num">{nf(spf.data.k, 2)}</td>
                      <td className="r num">{nf(spf.data.aic, 1)}</td>
                    </tr>
                    {Object.entries(spf.data.by_class ?? {}).map(([c, v]: [string, any]) => (
                      <tr key={c}>
                        <td>{c}</td>
                        <td className="r num">{v.segments}</td>
                        <td className="r num">{nf(v.crashes)}</td>
                        {v.fitted ? (
                          <>
                            <td className="r num">{nf(v.b0, 3)} ± {nf(v.se_b0, 3)}</td>
                            <td className="r num">{nf(v.b1, 3)} ± {nf(v.se_b1, 3)}</td>
                            <td className="r num">{nf(v.k, 2)}</td>
                            <td className="r num">{nf(v.aic, 1)}</td>
                          </>
                        ) : <td colSpan={4} className="muted">Not fitted: {v.reason ?? 'insufficient data'}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted m-small">Class-level standard errors are wide (e.g. β₁ for principal arterials); the pooled
              model is the more stable basis for EB and is the one used in the published ranking.</p>
          </section>

          <section id="m-ssm" className="section" aria-labelledby="m-ssm-h">
            <div className="section-head"><h2 id="m-ssm-h">4. Surrogate safety measures</h2></div>
            <p>Computed on 10 Hz trajectories following the FHWA SSAM conventions (Gettman &amp; Head 2003; Gettman et al. 2008).</p>
            <dl className="m-defs">
              <dt>Time to collision (TTC)</dt>
              <dd>
                <Eq label="Time to collision"><math display="block"><mrow><mi>TTC</mi><mo>=</mo><mfrac><mrow><mi>Δ</mi><mi>x</mi></mrow><mrow><msub><mi>v</mi><mi>f</mi></msub><mo>−</mo><msub><mi>v</mi><mi>l</mi></msub></mrow></mfrac><mspace width="1em" /><mtext>for </mtext><msub><mi>v</mi><mi>f</mi></msub><mo>&gt;</mo><msub><mi>v</mi><mi>l</mi></msub></mrow></math></Eq>
                Rear-end interactions; Δ<i>x</i> is the bumper-to-bumper gap. A conflict is recorded when the minimum TTC
                is below <span className="num">1.5</span> s (Hayward 1972).
              </dd>
              <dt>Post-encroachment time (PET)</dt>
              <dd>
                Time between the first road user leaving a conflict zone and the second entering it, evaluated on a
                <span className="num"> 2</span> m grid over crossing paths. Threshold <span className="num">2.0</span> s (Allen et al. 1978).
              </dd>
              <dt>Deceleration rate to avoid crash (DRAC)</dt>
              <dd>
                <Eq label="Deceleration rate to avoid crash"><math display="block"><mrow><mi>DRAC</mi><mo>=</mo><mfrac><msup><mrow><mo>(</mo><msub><mi>v</mi><mi>f</mi></msub><mo>−</mo><msub><mi>v</mi><mi>l</mi></msub><mo>)</mo></mrow><mn>2</mn></msup><mrow><mn>2</mn><mo>·</mo><mi>Δ</mi><mi>x</mi></mrow></mfrac></mrow></math></Eq>
                Threshold <span className="num">3.4</span> m/s², the commonly used value for a hard but controlled stop.
              </dd>
            </dl>
          </section>

          <section id="m-repair" className="section" aria-labelledby="m-repair-h">
            <div className="section-head"><h2 id="m-repair-h">5. Trajectory repair</h2></div>
            <p>Roadside LiDAR loses tracks when vehicles are occluded by other vehicles. To evaluate repair methods
              without field ground truth, occlusion is injected synthetically into complete tracks and the repaired
              positions are scored against the held-out points.</p>
            <ol className="m-steps">
              <li>Eligible tracks (long enough to carry context either side of a gap) are sampled with a fixed seed;
                each receives one or more gaps of uniformly drawn length within the stated range, with a fixed context
                window before and after.</li>
              <li><strong>Baseline:</strong> linear interpolation of position between the last point before and the first
                point after the gap.</li>
              <li><strong>Kalman + RTS:</strong> a constant-acceleration state-space model (position, velocity,
                acceleration per axis) run forward through the context and gap (prediction only inside the gap), then a
                Rauch–Tung–Striebel backward smoother. A path-constrained variant adds a cross-track penalty. Process and
                measurement noise (<i>q</i>, <i>r</i>) are chosen by grid search on a separate validation set.</li>
              <li>Score: RMSE of position (m) and speed (m/s) on gap frames only. The method with lower validation RMSE is
                selected before test scoring.</li>
            </ol>
            <div className="m-repair-grid">
              {repairs.map((r, i) => <RepairCard key={SITES[i][0]} name={SITES[i][1]} r={r.data?.summary} err={r.error} />)}
            </div>
            <p className="muted m-small">Truth here is the Savitzky–Golay-smoothed NGSIM track, not raw sensor data, so RMSE
              measures agreement with a smoothed reference. Results are reported as measured, including where the
              Kalman smoother does not beat linear interpolation. See Luo et al. (2025) for the full-occlusion method.</p>
          </section>

          <section id="m-limits" className="section" aria-labelledby="m-limits-h">
            <div className="section-head"><h2 id="m-limits-h">6. Limitations</h2></div>
            <ul className="m-list">
              <li>The TxDOT roadway inventory crash field <code>SUM_CRASH_</code> is read as a nine-year mean annual count
                per segment and scaled to the record period; it is not a list of individual crashes.</li>
              <li>EPDO cannot be computed at segment level: the segment crash field carries no severity. Severity analysis
                is confined to the VRU and FARS layers.</li>
              <li>The trajectories are NGSIM (Los Angeles, California and Atlanta, Georgia; 2005–2006), used as a stand-in
                for roadside LiDAR trajectories. They are not Lubbock data and the conflict counts are not Lubbock findings.</li>
              <li>Repair accuracy is measured against smoothed NGSIM, which already removes some measurement noise.</li>
              <li>Screening ranks identify sites for investigation; they do not establish cause or countermeasure need.</li>
              <li>TxDOT data are provided for informational purposes; TxDOT makes no warranty of accuracy or completeness,
                and crash records are protected from discovery under 23 U.S.C. §407.</li>
            </ul>
          </section>

          <section id="m-refs" className="section" aria-labelledby="m-refs-h">
            <div className="section-head"><h2 id="m-refs-h">7. References</h2></div>
            <ol className="m-refs">
              <li>AASHTO (2010). <i>Highway Safety Manual</i>, 1st ed. American Association of State Highway and Transportation Officials, Washington, DC.</li>
              <li>Hauer, E. (1997). <i>Observational Before–After Studies in Road Safety</i>. Pergamon, Oxford. See also Hauer, E., Harwood, D. W., Council, F. M., Griffith, M. S. (2002), Estimating safety by the Empirical Bayes method, <i>Transportation Research Record</i> 1784.</li>
              <li>Gettman, D., Pu, L., Sayed, T., Shelby, S. (2008). <i>Surrogate Safety Assessment Model and Validation</i>. FHWA-HRT-08-051, Federal Highway Administration.</li>
              <li>Hayward, J. C. (1972). Near-miss determination through use of a scale of danger. <i>Highway Research Record</i> 384.</li>
              <li>Allen, B. L., Shin, B. T., Cooper, P. J. (1978). Analysis of traffic conflicts and collisions. <i>Transportation Research Record</i> 667.</li>
              <li>Igene, M., Luo, Q., et al. (2024). Integrating LiDAR sensor data into microsimulation model calibration for proactive safety analysis. <i>Sensors</i>.</li>
              <li>Luo, Q., et al. (2025). Vehicle trajectory repair under (full) occlusion and limited datapoints with roadside LiDAR. <i>Sensors</i>.</li>
              <li>Zhang, et al., Luo, Q. (2025). Anchor-free vehicle detection and tracking from roadside LiDAR. <i>PLOS ONE</i>.</li>
              <li>US DOT ITS JPO. Next Generation Simulation (NGSIM) Vehicle Trajectories and Supporting Data. ITS DataHub.</li>
            </ol>
            <p className="m-small"><Link to="/platform">How the data are refreshed</Link></p>
          </section>
        </article>
      </div>
    </div>
  );
}

function Eq({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="m-eq" role="math" aria-label={label}>{children}</div>;
}

function RepairCard({ name, r, err }: { name: string; r?: RepairSummary; err?: string }) {
  if (err) return <div className="error-box">{name}: {err}</div>;
  if (!r) return <div className="skeleton m-skel" />;
  const best = Math.min(...Object.values(r.methods).map((m) => m.rmse_m));
  return (
    <div className="panel m-repair">
      <h3>{name}</h3>
      <p className="muted m-small">
        <span className="num">{r.tracks_occluded}</span> of <span className="num">{r.tracks_eligible}</span> eligible tracks occluded ·
        <span className="num"> {r.gaps}</span> gaps, <span className="num">{nf(r.gap_frames)}</span> frames ·
        gap <span className="num">{r.gap_s[0]}–{r.gap_s[1]}</span> s · seed <span className="num">{r.seed}</span>
      </p>
      <table className="data">
        <thead><tr><th>Method</th><th className="r">Pos. RMSE (m)</th><th className="r">Speed RMSE (m/s)</th><th className="r">Val. RMSE (m)</th></tr></thead>
        <tbody>
          {Object.entries(r.methods).map(([k, m]) => (
            <tr key={k} data-active={k === r.selected_method}>
              <td>{METHOD_LABEL[k] ?? k}{k === r.selected_method ? ' (selected)' : ''}</td>
              <td className="r num">{m.rmse_m === best ? <strong>{nf(m.rmse_m, 3)}</strong> : nf(m.rmse_m, 3)}</td>
              <td className="r num">{nf(m.speed_rmse, 3)}</td>
              <td className="r num">{nf(r.validation?.rmse_m[k], 3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.better_than_linear_share && (
        <p className="m-small">Share of gaps where Kalman + RTS beats linear: <span className="num">{nf(100 * (r.better_than_linear_share.kf_ca ?? 0), 0)}%</span>.</p>
      )}
    </div>
  );
}
