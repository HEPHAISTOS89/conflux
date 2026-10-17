import { Link } from 'react-router-dom';
import { useApi } from '../lib/api';
import { nf } from '../lib/format';
import type { Manifest } from '../lib/types';
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

interface SpfGof { mad: number; pearson_chi2: number; df: number; chi2_df: number; cure?: { pct_outside?: number } }
interface SpfModel { spec: string[]; coef: Record<string, number>; se?: Record<string, number>; k: number; se_k?: number; n?: number; crashes?: number; aic?: number }
interface SpfSite { segments: number; crashes: number; fitted: boolean; model_used: string; model: SpfModel | null; gof?: SpfGof; cure?: { pct_outside?: number }; reason?: string }
interface SpfData {
  form: string; b0: number; b1: number; se_b0?: number; se_b1?: number; k: number; n: number; crashes?: number; aic: number;
  outcome?: string; crash_period?: string; crash_years?: number; estimation?: string; units?: string;
  site_types?: Record<string, SpfSite>; fallback?: SpfModel; pooled_gof?: SpfGof; system_gof?: SpfGof;
  diagnostics?: { crash_field?: { evidence?: { corr_with_matched_crashes?: number } } };
}
interface SsmRule { rule: string; citation?: string; note?: string }
interface SsmData {
  rules: { detection?: SsmRule; severity_ttc?: SsmRule; severity_pet?: SsmRule; drac?: SsmRule; ttc?: SsmRule; pet?: SsmRule; overlap?: SsmRule; citations?: string[] };
  counts?: { total: number; by_type_severity: Record<string, number>; drac_flag: number; overlap: number };
}
type RepairStat = { gaps?: number; gap_frames?: number; rmse_m: number; speed_rmse?: number | null };
type RepairBin = { gap_s: [number, number] } & Record<string, any>;
interface RepairSum {
  notes?: string[];
  protocols?: Record<string, {
    description?: string; occlusion?: { occluded_share: number; gaps: number; tracks_with_gaps: number; gap_len_mean_s: number };
    truth_variants?: Record<string, { selected_method?: string; methods?: Record<string, RepairStat>; by_gap?: RepairBin[] }>;
  }>;
}

const date = (s?: string) => (s ? s.slice(0, 10) : '—');

export default function Methods() {
  const meta = useApi<Manifest>('/meta');
  const spf = useApi<SpfData>('/spf');
  const rp = useApi<{ summary: RepairSum }>('/intersections/peachtree-10th/repair');
  const rl = useApi<{ summary: RepairSum }>('/intersections/lankershim-main/repair');
  const sp = useApi<SsmData>('/intersections/peachtree-10th/ssm');
  const sl = useApi<SsmData>('/intersections/lankershim-main/ssm');
  const repairs = [rp, rl];
  const ssm = [{ name: SITES[0][1], d: sp.data, err: sp.error }, { name: SITES[1][1], d: sl.data, err: sl.error }];

  return (
    <div className="page methods">
      <header className="page-head">
        <h1>Methods</h1>
        <p>
          How every number in RoadScope is produced: sources and their provenance, the HSM Part B screening of
          on-system pedestrian and cyclist crashes (2021–2023), the site-type negative binomial safety performance functions, the surrogate safety measures computed on
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
            <p>State-system roadway in Lubbock County is divided into <span className="num">443</span> segments of about one
              mile by DFO. The screened outcome is <strong>{spf.data?.outcome ?? 'on-system pedestrian, cyclist and e-scooter crashes (TxDOT CRIS via the Active Transportation Crashes layer), all KABCO severities'}</strong>,
              over <span className="num">{spf.data?.crash_period ?? '2021–2023'}</span>, so the record period is
              <i> Y</i> = <span className="num">{spf.data?.crash_years ?? 3}</span> years. Each crash point is snapped
              (≤ 5 m) to the nearest segment polyline; each segment receives the length-weighted AADT of the overlapping
              TxDOT count records and its site type from the Roadway Inventory (urban/rural × functional-class group).
              This is a vulnerable-road-user screening: vehicle-only crashes are not in the outcome. Three HSM (2010)
              Part B performance measures are computed.</p>
            <h3>Crash rate</h3>
            <Eq label="Crash rate per 100 million vehicle-miles">
              <math display="block">
                <mrow><mi>R</mi><mo>=</mo><mfrac><mrow><mi>N</mi><mo>·</mo><msup><mn>10</mn><mn>8</mn></msup></mrow><mrow><mn>365</mn><mo>·</mo><mi>Y</mi><mo>·</mo><mi>AADT</mi><mo>·</mo><mi>L</mi></mrow></mfrac></mrow>
              </math>
            </Eq>
            <p><i>N</i> is observed ped/bike crashes over <i>Y</i> years, <i>L</i> segment length in miles; <i>R</i> is in
              crashes per 100 MVMT.</p>
            <h3>Critical rate</h3>
            <Eq label="Critical crash rate">
              <math display="block">
                <mrow><msub><mi>R</mi><mi>c</mi></msub><mo>=</mo><msub><mi>R</mi><mi>a</mi></msub><mo>+</mo><mi>k</mi><msqrt><mfrac><msub><mi>R</mi><mi>a</mi></msub><mi>M</mi></mfrac></msqrt><mo>+</mo><mfrac><mn>1</mn><mrow><mn>2</mn><mi>M</mi></mrow></mfrac></mrow>
              </math>
            </Eq>
            <p><i>R<sub>a</sub></i> is the exposure-weighted average rate of the reference population (the segment's site
              type), <i> M</i> the segment's exposure in 100 MVMT, and <i>k</i> = 1.645 for 95 % confidence. The
              critical-rate ratio <i> R</i>/<i>R<sub>c</sub></i> &gt; 1 flags a segment.</p>
            <h3>Empirical Bayes expected crashes</h3>
            <Eq label="Empirical Bayes weight and expected crashes">
              <math display="block">
                <mrow><msub><mi>k</mi><mi>seg</mi></msub><mo>=</mo><mfrac><mi>k</mi><mi>L</mi></mfrac>
                  <mspace width="1.5em" />
                  <mi>w</mi><mo>=</mo><mfrac><mn>1</mn><mrow><mn>1</mn><mo>+</mo><msub><mi>k</mi><mi>seg</mi></msub><mo>·</mo><msub><mi>μ</mi><mi>Y</mi></msub></mrow></mfrac>
                  <mspace width="1.5em" />
                  <mi>E</mi><mo>=</mo><mi>w</mi><mo>·</mo><msub><mi>μ</mi><mi>Y</mi></msub><mo>+</mo><mo>(</mo><mn>1</mn><mo>−</mo><mi>w</mi><mo>)</mo><mo>·</mo><mi>N</mi></mrow>
              </math>
            </Eq>
            <p><i>μ</i><sub>Y</sub> is the site-type SPF prediction over the same <i>Y</i>-year period as <i>N</i>, and
              <i> k</i> is the fitted NB overdispersion per mile, converted to the segment as <i>k</i><sub>seg</sub> = <i>k</i>/<i>L</i>
              (HSM Part C segment convention). Segments are ranked by excess expected crashes,
              (<i>E</i> − <i>μ</i><sub>Y</sub>)/<i>Y</i>, reported in ped/bike crashes per year (Hauer 1997; Hauer et al.
              2002; HSM 2010, Ch. 4). EPDO is not computed: there are no sourced Texas severity cost weights in the data,
              so the <code>epdo</code> field is null.</p>
          </section>

          <section id="m-spf" className="section" aria-labelledby="m-spf-h">
            <div className="section-head"><h2 id="m-spf-h">3. Safety performance functions</h2></div>
            <Eq label="Site-type SPF with length and period offset">
              <math display="block">
                <mrow><mi>ln</mi><msub><mi>μ</mi><mi>Y</mi></msub><mo>=</mo><msub><mi>β</mi><mn>0</mn></msub><mo>+</mo><msub><mi>β</mi><mn>1</mn></msub><mi>ln</mi><mi>AADT</mi><mo>+</mo><mo>∑</mo><msub><mi>β</mi><mi>j</mi></msub><msub><mi>x</mi><mi>j</mi></msub><mo>+</mo><mi>ln</mi><mi>L</mi><mo>+</mo><mi>ln</mi><mi>Y</mi></mrow>
              </math>
            </Eq>
            <p>{spf.data?.estimation ?? 'NB2 maximum likelihood with offset ln L + ln Y'}. Candidate covariates
              <i> x<sub>j</sub></i> are lanes, divided and posted speed; each site type's specification is chosen by AIC
              with at most one covariate per 10 crashes. Site types with fewer than 30 segments or 20 crashes use a pooled
              site-type model (ln AADT, urban, lanes, speed) fitted on all screened segments. Goodness of fit is reported as
              the mean absolute deviation (MAD) of observed minus predicted crashes, the Pearson χ² per degree of freedom,
              and the share of the cumulative-residual (CURE) curve outside ±2σ* (Hauer and Bamfo 1997); the CURE plots
              themselves are drawn on the screening page. Segments without matched AADT or site type are excluded.</p>
            {spf.error && <div className="error-box">{spf.error}</div>}
            {spf.loading && <div className="skeleton m-skel" />}
            {spf.data && <SpfTable s={spf.data} />}
            <p className="muted m-small">Coefficients are on ln μ; speed is posted mph, lanes the through-lane count. With
              24–56 crashes per fitted site type, standard errors are wide and the urban minor arterial ln AADT
              coefficient is not distinguishable from zero; read the SPFs as screening baselines, not causal models.
              GOF on the fallback site types is shown for completeness: with 0–2 crashes it is not informative.</p>
          </section>

          <section id="m-ssm" className="section" aria-labelledby="m-ssm-h">
            <div className="section-head"><h2 id="m-ssm-h">4. Surrogate safety measures</h2></div>
            <p>Computed on 10 Hz trajectories following FHWA Surrogate Safety Assessment Model (SSAM) conventions and its
              default detection thresholds (Gettman et al. 2008). An event is a <em>traffic conflict</em> in the
              surrogate-safety sense: an interaction whose measures fall below threshold, not an observed crash.</p>
            <dl className="m-defs">
              <dt>Time to collision (TTC)</dt>
              <dd>
                <Eq label="Time to collision"><math display="block"><mrow><mi>TTC</mi><mo>=</mo><mfrac><mrow><mi>Δ</mi><mi>x</mi></mrow><mrow><msub><mi>v</mi><mi>f</mi></msub><mo>−</mo><msub><mi>v</mi><mi>l</mi></msub></mrow></mfrac><mspace width="1em" /><mtext>for </mtext><msub><mi>v</mi><mi>f</mi></msub><mo>&gt;</mo><msub><mi>v</mi><mi>l</mi></msub></mrow></math></Eq>
                Measure introduced by Hayward (1972). Rear-end and lane-change interactions; Δ<i>x</i> is the
                front-to-rear gap. Detection: TTC ≤ <span className="num">1.5</span> s held for at least 0.3 s, the SSAM
                default. Severity bins: ≤ 0.5 s critical, 0.5–1.0 s serious, 1.0–1.5 s moderate (study-specific bins
                within the SSAM detection range).
              </dd>
              <dt>Post-encroachment time (PET)</dt>
              <dd>
                Measure introduced by Allen, Shin and Cooper (1978): the time between the rear of the first road user
                leaving the shared conflict zone and the front of the second entering it. Each vehicle is a length × width
                bounding box swept along its path (0.5 m raster, 50 Hz); the conflict zone is the intersection of the two
                swept footprints, for conflicting approaches at ≥ 30°. Detection: PET ≤ <span className="num">5.0</span> s,
                the SSAM default. Severity bins: ≤ 1 s critical, 1–2.5 s serious, 2.5–5 s moderate (study-specific; there
                is no FHWA/SSAM PET severity standard). Simultaneous occupancy is kept with PET = 0 and flagged as overlap
                rather than discarded; at NGSIM position accuracy an overlap is most likely a data error (Punzo et al.
                2011), not an observed near-collision.
              </dd>
              <dt>Deceleration rate to avoid crash (DRAC)</dt>
              <dd>
                <Eq label="Deceleration rate to avoid crash"><math display="block"><mrow><mi>DRAC</mi><mo>=</mo><mfrac><msup><mrow><mo>(</mo><msub><mi>v</mi><mi>f</mi></msub><mo>−</mo><msub><mi>v</mi><mi>l</mi></msub><mo>)</mo></mrow><mn>2</mn></msup><mrow><mn>2</mn><mo>·</mo><mi>Δ</mi><mi>x</mi></mrow></mfrac></mrow></math></Eq>
                Reported as a flag alongside TTC events, not a detection criterion: DRAC ≥ <span className="num">11.2</span> ft/s²
                (3.4 m/s²), the AASHTO (2018) deceleration rate for stopping sight distance. Values above about
                26 ft/s² (8 m/s²) exceed tyre–road friction and indicate position error in the source data.
              </dd>
            </dl>
            <SsmRules sites={ssm} />
          </section>

          <section id="m-repair" className="section" aria-labelledby="m-repair-h">
            <div className="section-head"><h2 id="m-repair-h">5. Trajectory repair</h2></div>
            <p>Roadside LiDAR loses tracks when vehicles are occluded by other vehicles. To evaluate repair methods
              without field ground truth, gaps are cut into complete NGSIM tracks and the repaired positions are scored
              against the held-out points, under two gap protocols and against two truths.</p>
            <ol className="m-steps">
              <li><strong>Uniform protocol:</strong> seeded random gaps of 0.5–5.0 s, one or two per track, at least 1.0 s
                from the track ends.</li>
              <li><strong>Occluder protocol:</strong> gaps are the real line-of-sight occlusion intervals of each track
                from a virtual roadside sensor, in 2D: a track is hidden while a nearer vehicle's footprint lies on the
                sensor ray. Intervals of 0.5–5.0 s are kept; visible flickers of ≤ 2 frames are merged.</li>
              <li><strong>Truths:</strong> <em>smoothed</em> (Savitzky–Golay, 15 frames, order 2, as input and truth) and
                <em> raw</em> (unsmoothed NGSIM positions, NGSIM-interpolated frames excluded from scoring). Speed is
                scored against smoothed truth only.</li>
              <li><strong>Methods:</strong> linear interpolation; a constant-acceleration Kalman filter with a
                Rauch–Tung–Striebel smoother (prediction only inside the gap); and a path-constrained variant. Noise
                parameters (<i>q</i>, <i>r</i>) are chosen by grid search on a separate validation set, and the method with
                lower validation RMSE is selected before test scoring.</li>
            </ol>
            <div className="m-repair-grid">
              {repairs.map((r, i) => <RepairCard key={SITES[i][0]} name={SITES[i][1]} r={r.data?.summary} err={r.error} />)}
            </div>
            <p>Result: for gaps shorter than 2 s scored against raw truth, linear interpolation ties with or beats the
              Kalman smoother at Peachtree (pooled RMSE 0.23 vs 0.31 m uniform, 0.14 vs 0.16 m occluder), while Kalman
              stays ahead at Lankershim (0.31 vs 0.23 m, 0.24 vs 0.20 m). Against smoothed truth Kalman is lower for short
              gaps too, partly because the smoother spreads in-gap information into the context. For gaps of 2 s and
              longer, Kalman RMSE is lower in all eight site × protocol × truth cases, by a factor of 1.3–2.8 (1.8–2.8
              at Lankershim; 1.3–2.5 at Peachtree, where the uniform protocol has only 14 such gaps).</p>
            <RepairNotes notes={repairs.map((r) => r.data?.summary).find((s) => s?.notes)?.notes} />
            <p className="muted m-small">Reconstruction and validation of noisy NGSIM trajectories follow Punzo, Borzacchiello
              and Ciuffo (2011) and Montanino and Punzo (2015). This evaluation is a generic baseline; it does not
              reproduce or compare against the full-occlusion repair method of Luo et al. (2025).</p>
          </section>

          <section id="m-limits" className="section" aria-labelledby="m-limits-h">
            <div className="section-head"><h2 id="m-limits-h">6. Limitations</h2></div>
            <ul className="m-list">
              <li>The TxDOT segment layer's <code>SUM_CRASH_</code> field is undocumented (empty item description, aliases
                equal field names, no years). It is published only in the Statewide Active Transportation Plan web map and
                behaves as an injury-weighted pedestrian/cyclist score for 2021–2023: it correlates
                r = <span className="num">{nf(spf.data?.diagnostics?.crash_field?.evidence?.corr_with_matched_crashes ?? 0.945, 3)}</span> with
                the CRIS ped/bike crashes snapped to the same segments, and a least-squares fit weights K/A/B crashes about
                ten times C/O crashes. It is therefore not an all-crash count and is not used as the SPF outcome (kept as
                <code> satp_crash_score</code>). Screening covers ped/bike crashes only until full CRIS all-crash records
                are obtained.</li>
              <li><code>TxDOT_AADT.AADT_CUR</code> has no published count year. It differs from the Roadway Inventory 2024
                ADT on most on-system records, so it is presumably a later count than the 2021–2023 crash period.</li>
              <li>Only three urban site types have enough ped/bike crashes for their own SPF; the five others (including
                all rural types, with 0–2 crashes) use the pooled fallback model, and their EB estimates rest almost
                entirely on that model.</li>
              <li>EPDO is not computed: no sourced severity weights. Severity analysis is confined to the VRU and FARS layers.</li>
              <li>The trajectories are NGSIM (Los Angeles, California and Atlanta, Georgia; 2005–2006), used as a stand-in
                for roadside LiDAR trajectories. They are not Lubbock data and the conflict counts are not Lubbock findings.</li>
              <li>The occluder protocol is 2D (sensor height ignored), so it over-states occlusion by cars relative to a
                4.5 m pole; it is a realistic gap-placement protocol, not a LiDAR visibility model. Raw NGSIM truth carries
                measurement noise that bounds achievable RMSE from below.</li>
              <li>Screening ranks identify sites for investigation; they do not establish cause or countermeasure need.</li>
              <li>TxDOT data are provided for informational purposes; TxDOT makes no warranty of accuracy or completeness,
                and crash records are protected from discovery under 23 U.S.C. §407.</li>
            </ul>
          </section>

          <section id="m-refs" className="section" aria-labelledby="m-refs-h">
            <div className="section-head"><h2 id="m-refs-h">7. References</h2></div>
            <ol className="m-refs">
              <li>AASHTO (2010). <i>Highway Safety Manual</i>, 1st ed. American Association of State Highway and Transportation Officials, Washington, DC.</li>
              <li>Hauer, E., Bamfo, J. (1997). Two tools for finding what function links the dependent variable to the explanatory variables. <i>Proceedings of the ICTCT 1997 Workshop</i>, Lund, Sweden.</li>
              <li>Hauer, E. (1997). <i>Observational Before–After Studies in Road Safety</i>. Pergamon, Oxford. See also Hauer, E., Harwood, D. W., Council, F. M., Griffith, M. S. (2002), Estimating safety by the Empirical Bayes method, <i>Transportation Research Record</i> 1784.</li>
              <li>Gettman, D., Pu, L., Sayed, T., Shelby, S. (2008). <i>Surrogate Safety Assessment Model and Validation</i>. FHWA-HRT-08-051, Federal Highway Administration.</li>
              <li>Hayward, J. C. (1972). Near-miss determination through use of a scale of danger. <i>Highway Research Record</i> 384, 24–34.</li>
              <li>Allen, B. L., Shin, B. T., Cooper, P. J. (1978). Analysis of traffic conflicts and collisions. <i>Transportation Research Record</i> 667, 67–74.</li>
              <li>AASHTO (2018). <i>A Policy on Geometric Design of Highways and Streets</i>, 7th ed. (deceleration rate for stopping sight distance, 11.2 ft/s²).</li>
              <li>Igene, M., Luo, Q., Jimee, K., Soltanirad, M., Bataineh, T., Liu, H. (2024). Integrating LiDAR sensor data into microsimulation model calibration for proactive safety analysis. <i>Sensors</i> 24(13), 4393. <a href="https://doi.org/10.3390/s24134393">doi:10.3390/s24134393</a></li>
              <li>Luo, Q., Xu, Z., Zhang, Y., Igene, M., Bataineh, T., Soltanirad, M., Jimee, K., Liu, H. (2025). Vehicle trajectory repair under full occlusion and limited datapoints with roadside LiDAR. <i>Sensors</i> 25(4), 1114. <a href="https://doi.org/10.3390/s25041114">doi:10.3390/s25041114</a></li>
              <li>Zhang, Y., Luo, Q., Zhang, S., Liu, H., Xie, S. (2025). Anchor-free real-time vehicle tracking using LiDAR data. <i>PLOS ONE</i> 20(5), e0323287. <a href="https://doi.org/10.1371/journal.pone.0323287">doi:10.1371/journal.pone.0323287</a></li>
              <li>Punzo, V., Borzacchiello, M. T., Ciuffo, B. (2011). On the assessment of vehicle trajectory data accuracy and application to the Next Generation SIMulation (NGSIM) program data. <i>Transportation Research Part C</i> 19(6), 1243–1262. <a href="https://doi.org/10.1016/j.trc.2010.12.007">doi:10.1016/j.trc.2010.12.007</a></li>
              <li>Montanino, M., Punzo, V. (2015). Trajectory data reconstruction and simulation-based validation against macroscopic traffic patterns. <i>Transportation Research Part B</i> 80, 82–106. <a href="https://doi.org/10.1016/j.trb.2015.06.010">doi:10.1016/j.trb.2015.06.010</a></li>
              <li>U.S. DOT Federal Highway Administration (2016). Next Generation Simulation (NGSIM) Vehicle Trajectories and Supporting Data. ITS DataHub, CC BY-SA 3.0. <a href="https://doi.org/10.21949/1504477">doi:10.21949/1504477</a></li>
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

const COV_LABEL: Record<string, string> = { const: 'β₀', ln_aadt: 'ln AADT', urban: 'urban', lanes: 'lanes', speed: 'speed', divided: 'divided' };
const pm = (v?: number | null, se?: number | null, d = 3) => (v == null ? '—' : `${nf(v, d)} ± ${nf(se, d)}`);
const kfmt = (k?: number | null) => (k == null ? '—' : k < 0.01 ? k.toExponential(1) : nf(k, 3));

function Coefs({ m }: { m: SpfModel }) {
  return (
    <span className="num">
      {Object.keys(m.coef).map((c, i) => (
        <span key={c}>{i ? '; ' : ''}{COV_LABEL[c] ?? c} {pm(m.coef[c], m.se?.[c])}</span>
      ))}
    </span>
  );
}

function SpfTable({ s }: { s: SpfData }) {
  const st = Object.entries(s.site_types ?? {});
  if (!st.length) return null;
  const g = s.pooled_gof, sys = s.system_gof;
  return (
    <div className="m-scroll">
      <table className="data">
        <caption className="m-small" style={{ textAlign: 'left', captionSide: 'top', paddingBottom: 6 }}>
          NB2 SPFs by site type, outcome {s.crash_period ?? '2021–2023'} ped/bike crashes; k per mile (k<sub>seg</sub> = k/L).
        </caption>
        <thead>
          <tr><th>Site type</th><th className="r">Segs</th><th className="r">Crashes</th><th>Model · coefficients ± SE</th><th className="r">k ± SE</th><th className="r">MAD</th><th className="r">χ²/df</th><th className="r">CURE out ±2σ*</th></tr>
        </thead>
        <tbody>
          {st.map(([name, t]) => (
            <tr key={name}>
              <td>{name}</td>
              <td className="r num">{nf(t.segments)}</td>
              <td className="r num">{nf(t.crashes)}</td>
              <td>{t.fitted && t.model ? <Coefs m={t.model} /> : <span className="muted">pooled fallback</span>}</td>
              <td className="r num">{t.fitted && t.model ? `${kfmt(t.model.k)} ± ${nf(t.model.se_k, 3)}` : '—'}</td>
              <td className="r num">{nf(t.gof?.mad, 3)}</td>
              <td className="r num">{nf(t.gof?.chi2_df, 2)}</td>
              <td className="r num">{t.cure?.pct_outside != null ? `${nf(t.cure.pct_outside, 1)}%` : '—'}</td>
            </tr>
          ))}
          {s.fallback && (
            <tr>
              <td><strong>Fallback (pooled site-type)</strong></td>
              <td className="r num">{nf(s.fallback.n)}</td>
              <td className="r num">{nf(s.fallback.crashes)}</td>
              <td><Coefs m={s.fallback} /></td>
              <td className="r num">{kfmt(s.fallback.k)} ± {nf(s.fallback.se_k, 3)}</td>
              <td className="r num" colSpan={3}><span className="muted">applied to the {st.filter(([, t]) => !t.fitted).length} site types above marked fallback</span></td>
            </tr>
          )}
          <tr>
            <td><strong>Pooled ln AADT only</strong> <span className="muted">(reference)</span></td>
            <td className="r num">{nf(s.n)}</td>
            <td className="r num">{nf(s.crashes)}</td>
            <td><span className="num">β₀ {pm(s.b0, s.se_b0)}; ln AADT {pm(s.b1, s.se_b1)}</span></td>
            <td className="r num">{kfmt(s.k)}</td>
            <td className="r num">{nf(g?.mad, 3)}</td>
            <td className="r num">{nf(g?.chi2_df, 2)}</td>
            <td className="r num">{g?.cure?.pct_outside != null ? `${nf(g.cure.pct_outside, 1)}%` : '—'}</td>
          </tr>
          {sys && (
            <tr>
              <td><strong>System</strong> <span className="muted">(site-type SPFs as used)</span></td>
              <td className="r num" colSpan={4} />
              <td className="r num">{nf(sys.mad, 3)}</td>
              <td className="r num">{nf(sys.chi2_df, 2)}</td>
              <td className="r num">{sys.cure?.pct_outside != null ? `${nf(sys.cure.pct_outside, 1)}%` : '—'}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SsmRules({ sites }: { sites: { name: string; d?: SsmData; err?: string }[] }) {
  const first = sites.find((x) => x.d)?.d;
  if (!first) return sites.some((x) => x.err) ? <div className="error-box">{sites.map((x) => x.err).filter(Boolean).join(' · ')}</div> : <div className="skeleton m-skel" />;
  const r = first.rules;
  const rows: [string, string, string | undefined][] = [
    ['Detection', r.detection?.rule, r.detection?.citation],
    ['TTC severity', r.severity_ttc?.rule, r.severity_ttc?.note],
    ['PET severity', r.severity_pet?.rule, r.severity_pet?.note],
    ['DRAC flag', r.drac?.rule, r.drac?.citation],
    ['TTC', r.ttc?.rule, undefined],
    ['PET zone', r.pet?.rule, r.pet?.citation],
    ['Overlap', r.overlap?.rule, r.overlap?.note],
  ].filter(([, v]) => v) as [string, string, string | undefined][];
  return (
    <>
      <h3>Matching rules as run</h3>
      <div className="m-scroll">
        <table className="data">
          <thead><tr><th>Rule</th><th>Definition</th><th>Source / note</th></tr></thead>
          <tbody>{rows.map(([k, v, c]) => <tr key={k}><td>{k}</td><td className="m-small">{v}</td><td className="m-small muted">{c ?? '—'}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="m-scroll">
        <table className="data">
          <thead><tr><th>Site</th><th className="r">Conflicts</th><th className="r">Rear-end</th><th className="r">Lane change</th><th className="r">Crossing</th><th className="r">of which overlap</th><th className="r">DRAC flag</th></tr></thead>
          <tbody>
            {sites.map(({ name, d }) => {
              if (!d) return null;
              const by = d.counts?.by_type_severity ?? {};
              const n = (t: string) => Object.entries(by).filter(([k]) => k.startsWith(`${t}:`)).reduce((a, [, v]) => a + v, 0);
              return (
                <tr key={name}>
                  <td>{name}</td>
                  <td className="r num">{nf(d.counts?.total)}</td>
                  <td className="r num">{nf(n('rear_end'))}</td>
                  <td className="r num">{nf(n('lane_change'))}</td>
                  <td className="r num">{nf(n('crossing'))}</td>
                  <td className="r num">{nf(d.counts?.overlap)}</td>
                  <td className="r num">{nf(d.counts?.drac_flag)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {r.citations?.length ? <ul className="m-list m-small">{r.citations.map((c) => <li key={c} className="m-small">{c}</li>)}</ul> : null}
    </>
  );
}

const PROT_LABEL: Record<string, string> = { uniform: 'Uniform', occluder: 'Occluder' };

function RepairCard({ name, r, err }: { name: string; r?: RepairSum; err?: string }) {
  if (err) return <div className="error-box">{name}: {err}</div>;
  if (!r) return <div className="skeleton m-skel" />;
  const prot = Object.entries(r.protocols ?? {});
  const occ = r.protocols?.occluder?.occlusion;
  // short (< 2 s) vs long (>= 2 s) gaps, gap-frame-weighted RMSE pooled from the by-gap bins
  const pool = (bins: RepairBin[], m: string, long: boolean) => {
    const sel = bins.filter((b) => (b.gap_s[0] >= 2) === long && b[m]);
    const f = sel.reduce((a, b) => a + (b[m].gap_frames ?? 0), 0);
    if (!f) return null;
    return Math.sqrt(sel.reduce((a, b) => a + (b[m].gap_frames ?? 0) * b[m].rmse_m ** 2, 0) / f);
  };
  return (
    <div className="panel m-repair">
      <h3>{name}</h3>
      {occ && (
        <p className="muted m-small">
          Virtual sensor occludes <span className="num">{nf(100 * occ.occluded_share, 1)}%</span> of frames (2D) ·
          <span className="num"> {nf(occ.gaps)}</span> occlusion gaps of 0.5–5 s on <span className="num">{nf(occ.tracks_with_gaps)}</span> tracks,
          mean <span className="num">{nf(occ.gap_len_mean_s, 2)}</span> s
        </p>
      )}
      <table className="data">
        <thead>
          <tr><th>Protocol · truth</th><th className="r">Gaps</th><th className="r">Linear</th><th className="r">Kalman RTS</th><th className="r">Path-constr.</th><th className="r">&lt; 2 s lin / KF</th><th className="r">≥ 2 s lin / KF</th></tr>
        </thead>
        <tbody>
          {prot.flatMap(([pn, p]) => Object.entries(p.truth_variants ?? {}).map(([tn, t]) => {
            const ms = t.methods ?? {};
            const best = Math.min(...Object.values(ms).map((m) => m.rmse_m));
            const cell = (k: string) => {
              const v = ms[k]?.rmse_m;
              const txt = nf(v, 3) + (k === t.selected_method ? '*' : '');
              return <td className="r num">{v === best ? <strong>{txt}</strong> : txt}</td>;
            };
            const bins = t.by_gap ?? [];
            const sl = pool(bins, 'linear', false), sk = pool(bins, 'kf_ca', false), ll = pool(bins, 'linear', true), lk = pool(bins, 'kf_ca', true);
            return (
              <tr key={`${pn}-${tn}`}>
                <td>{PROT_LABEL[pn] ?? pn} · {tn}</td>
                <td className="r num">{nf(ms.linear?.gaps)}</td>
                {cell('linear')}{cell('kf_ca')}{cell('kf_ca_path')}
                <td className="r num">{nf(sl, 2)} / {nf(sk, 2)}</td>
                <td className="r num">{nf(ll, 2)} / {nf(lk, 2)}</td>
              </tr>
            );
          }))}
        </tbody>
      </table>
      <p className="muted m-small">Position RMSE in m on gap frames; bold is lowest, * the method selected on validation. Short/long columns pool the by-gap bins (frame-weighted).</p>
    </div>
  );
}

function RepairNotes({ notes }: { notes?: string[] }) {
  if (!notes?.length) return null;
  return <ul className="m-list m-small">{notes.map((n) => <li key={n} className="m-small">{n}</li>)}</ul>;
}
