import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import { ProvChip, type Provenance } from '../components/MetricInfo';
import { Icon, type IconName } from '../components/Icon';
import { downloadCSV } from '../lib/export';
import { useApi } from '../lib/api';
import { useReveal } from '../lib/motion';
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
  ['m-catalogue', 'Metric catalogue'],
  ['m-data', 'Data sources'],
  ['m-screening', 'Network screening'],
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


/* ---------- Metric catalogue: one card per number the portal shows ---------- */

type Family = 'screening' | 'spf' | 'ssm' | 'trajectory' | 'vru';
const FAMILIES: [Family | 'all', string, IconName][] = [
  ['all', 'All', 'methods'], ['screening', 'Network screening', 'rank'], ['spf', 'SPF', 'trend'],
  ['ssm', 'Surrogate safety', 'crosshair'], ['trajectory', 'Trajectory', 'path'], ['vru', 'VRU crashes', 'ped'],
];
interface Metric {
  key: string; family: Family; icon: IconName; name: string; abbr?: string; formula: string; where?: string;
  threshold: ReactNode; unit: string; data: string; provenance: Provenance; cite: string; section: string; page: [string, string];
}
const METRICS: Metric[] = [
  { key: 'crash-rate', family: 'screening', icon: 'rank', name: 'Crash rate', abbr: 'R', formula: 'R = N · 10⁸ / (365 · Y · AADT · L)',
    where: 'N crashes over Y years; L segment length (mi)', threshold: 'None; ranking measure', unit: 'crashes / 100 MVMT',
    data: 'CRIS ped/bike crashes snapped ≤ 5 m; TxDOT AADT', provenance: 'derived', cite: 'HSM (2010) Part B, Ch. 4', section: 'm-screening', page: ['/screening', 'Network screening'] },
  { key: 'critical-rate', family: 'screening', icon: 'warning', name: 'Critical rate ratio', abbr: 'R / Rc', formula: 'Rc = Ra + k·√(Ra / M) + 1 / (2M)',
    where: 'Ra site-type average; M exposure (100 MVMT); k = 1.645', threshold: 'R / Rc > 1 flags the segment (95 %)', unit: 'ratio',
    data: 'Crash rate and exposure by Roadway Inventory site type', provenance: 'derived', cite: 'HSM (2010) Part B, Ch. 4', section: 'm-screening', page: ['/screening', 'Network screening'] },
  { key: 'eb-excess', family: 'screening', icon: 'target', name: 'EB excess expected crashes', abbr: 'EB', formula: 'w = 1 / (1 + (k / L) · μY)\nE = w · μY + (1 − w) · N\nexcess = (E − μY) / Y',
    where: 'μY site-type SPF prediction over Y years', threshold: 'excess > 0 ranks above SPF expectation', unit: 'crashes / yr',
    data: 'Observed crashes N and site-type SPF', provenance: 'derived', cite: 'Hauer (1997); Hauer et al. (2002), TRR 1784', section: 'm-screening', page: ['/screening', 'Network screening'] },
  { key: 'spf', family: 'spf', icon: 'trend', name: 'Safety performance function', abbr: 'SPF', formula: 'ln μY = β0 + β1·ln AADT + Σ βj·xj + ln L + ln Y',
    where: 'NB2 ML; covariates by AIC, ≤ 1 per 10 crashes', threshold: 'Own model if ≥ 30 segments and ≥ 20 crashes; else pooled', unit: 'crashes per Y years',
    data: 'Segments with AADT and site type', provenance: 'derived', cite: 'HSM (2010) Part C; Hauer & Bamfo (1997) CURE', section: 'm-spf', page: ['/screening', 'Network screening'] },
  { key: 'ttc', family: 'ssm', icon: 'clock', name: 'Time to collision', abbr: 'TTC', formula: 'TTC = Δx / (vf − vl),  vf > vl',
    where: 'Δx front-to-rear gap; f follower, l leader', threshold: '≤ 1.5 s for ≥ 0.3 s; ≤ 0.5 s critical', unit: 's',
    data: 'NGSIM 10 Hz trajectories', provenance: 'derived', cite: 'Hayward (1972); Gettman et al. (2008) SSAM', section: 'm-ssm', page: ['/intersections', 'Intersection lab'] },
  { key: 'pet', family: 'ssm', icon: 'intersection', name: 'Post-encroachment time', abbr: 'PET', formula: 'PET = t_enter(2) − t_exit(1)',
    where: 'Footprints swept on a 0.5 m raster at 50 Hz; paths ≥ 30° apart', threshold: '≤ 5.0 s; ≤ 1 s critical', unit: 's',
    data: 'NGSIM 10 Hz trajectories', provenance: 'derived', cite: 'Allen, Shin & Cooper (1978), TRR 667', section: 'm-ssm', page: ['/intersections', 'Intersection lab'] },
  { key: 'drac', family: 'ssm', icon: 'gauge', name: 'Deceleration rate to avoid crash', abbr: 'DRAC', formula: 'DRAC = (vf − vl)² / (2 · Δx)',
    where: 'Flag on TTC events, not a detection rule', threshold: '≥ 11.2 ft/s² (3.4 m/s²); > 26 ft/s² = position error', unit: 'ft/s²',
    data: 'NGSIM 10 Hz trajectories', provenance: 'derived', cite: 'AASHTO (2018) Green Book', section: 'm-ssm', page: ['/intersections', 'Intersection lab'] },
  { key: 'repair-rmse', family: 'trajectory', icon: 'path', name: 'Trajectory repair error', abbr: 'RMSE', formula: 'RMSE = √( Σ ‖p̂ − p‖² / n )',
    where: 'Over held-out gap frames; gaps 0.5–5.0 s', threshold: 'Method chosen on a separate validation set', unit: 'm (1 m = 3.28 ft)',
    data: 'NGSIM tracks with uniform and occluder gaps', provenance: 'derived', cite: 'Punzo et al. (2011); Montanino & Punzo (2015)', section: 'm-repair', page: ['/intersections', 'Intersection lab'] },
  { key: 'ka-share', family: 'vru', icon: 'ped', name: 'KA share', abbr: 'KA', formula: 'KA share = (K + A) / N\n95 % CI: Wilson score',
    where: 'K fatal, A suspected serious injury', threshold: 'None; compare intervals, not points', unit: '% of crashes',
    data: 'TxDOT CRIS crash severity (KABCO)', provenance: 'derived', cite: 'MMUCC 5th ed. KABCO; Wilson (1927)', section: 'm-limits', page: ['/vru', 'Pedestrians & cyclists'] },
  { key: 'peak-window', family: 'vru', icon: 'clock', name: 'Peak-risk window', formula: 'peak = argmax_s Σ_{h=s}^{s+2} N_h',
    where: 'N_h crashes in clock hour h, all days pooled, wraps midnight', threshold: 'Compared with the uniform 12.5 % share', unit: '3-hour window',
    data: 'CRIS crash time', provenance: 'derived', cite: 'Descriptive; this portal', section: 'm-limits', page: ['/vru', 'Pedestrians & cyclists'] },
];

/** Provenance of each manifest source: observed field records vs agency-published inventories and public data. */
const SRC_PROV: Record<string, Provenance> = { active_transportation_crashes: 'observed', segment_crash: 'observed' };
const srcProv = (id: string): Provenance => SRC_PROV[id] ?? 'public';

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
  const active = useSpy();
  const { hash } = useLocation();
  // Deep links (#m-ssm, #metric-ttc) land after the async sections have laid out.
  useEffect(() => {
    if (!hash) return;
    const t = setTimeout(() => document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: 'start' }), 350);
    return () => clearTimeout(t);
  }, [hash, meta.loading, spf.loading]);

  return (
    <div className="page methods">
      <PageHeader
        icon="methods"
        title="Methods and data"
        lede="What each number measures, its formula and threshold, where the inputs come from, and where each method stops."
        source={meta.data ? `Manifest built ${date(meta.data.generated_at)} · Lubbock County roadway and crashes; NGSIM Los Angeles and Atlanta trajectories` : 'Loading manifest…'}
        readouts={[
          { label: 'Metrics', value: METRICS.length },
          { label: 'Sources', value: meta.data?.sources.length ?? null },
          { label: 'Segments, ≈ 1 mi', value: (meta.data?.metrics?.segments as number | undefined) ?? null },
          { label: 'Conflict sites', value: SITES.length },
        ]}
      />

      <div className="methods-layout">
        <nav className="methods-toc" aria-label="On this page">
          <ol>{TOC.map(([id, t]) => <li key={id}><a href={`#${id}`} aria-current={active === id ? 'location' : undefined}>{t}</a></li>)}</ol>
        </nav>

        <article className="methods-body">
          <Sec id="m-catalogue">
            <h2 id="m-catalogue-h">Metric catalogue</h2>
            <Catalogue />
          </Sec>

          <Sec id="m-data">
            <h2 id="m-data-h">Data sources</h2>
            {meta.error && <div className="error-box">{meta.error}</div>}
            {meta.loading && <div className="skeleton m-skel" />}
            {meta.data && (
              <div className="m-scroll" data-ui>
                <table className="data">
                  <thead><tr><th>Source</th><th>Provenance</th><th>Licence</th><th className="r">Records</th><th>Fetched</th><th>SHA-256</th></tr></thead>
                  <tbody>
                    {meta.data.sources.map((s) => (
                      <tr key={s.id}>
                        <td><a href={s.url} rel="noopener noreferrer" target="_blank">{s.id}<Icon name="external" size={12} /></a></td>
                        <td><ProvChip kind={srcProv(s.id)} /></td>
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
            {meta.data && (
              <div className="m-row-actions">
                <button type="button" className="btn ghost" onClick={() => downloadCSV('roadscope-data-manifest.csv', meta.data!.sources.map((x) => ({ source: x.id, provenance: srcProv(x.id), licence: x.licence, records: x.records, fetched_at: x.fetched_at, sha256: x.sha256 ?? '', url: x.url })))}>
                  <Icon name="download" size={16} />Manifest CSV
                </button>
              </div>
            )}
            {meta.data && <p className="m-small">Manifest generated <span className="num">{date(meta.data.generated_at)}</span>; SHA-256 truncated, full hash on hover.</p>}
          </Sec>

          <Sec id="m-screening">
            <h2 id="m-screening-h">Network screening</h2>
            <p>Lubbock County state-system roadway, split by DFO into <span className="num">443</span> segments of about one mile.
              Outcome: <strong>{spf.data?.outcome ?? 'on-system pedestrian, cyclist and e-scooter crashes (TxDOT CRIS via the Active Transportation Crashes layer), all KABCO severities'}</strong>,
              <span className="num"> {spf.data?.crash_period ?? '2021–2023'}</span> (<i>Y</i> = <span className="num">{spf.data?.crash_years ?? 3}</span> years).
              Crashes snap (≤ 5 m) to the nearest segment, which carries length-weighted AADT and a Roadway Inventory site type
              (urban/rural × functional class). Three HSM (2010) Part B measures follow.</p>
            <h3>Crash rate</h3>
            <Eq label="Crash rate per 100 million vehicle-miles">
              <math display="block">
                <mrow><mi>R</mi><mo>=</mo><mfrac><mrow><mi>N</mi><mo>·</mo><msup><mn>10</mn><mn>8</mn></msup></mrow><mrow><mn>365</mn><mo>·</mo><mi>Y</mi><mo>·</mo><mi>AADT</mi><mo>·</mo><mi>L</mi></mrow></mfrac></mrow>
              </math>
            </Eq>
            <p><i>N</i>: observed crashes over <i>Y</i> years; <i>L</i>: length (mi); <i>R</i> in crashes per 100 MVMT.</p>
            <h3>Critical rate</h3>
            <Eq label="Critical crash rate">
              <math display="block">
                <mrow><msub><mi>R</mi><mi>c</mi></msub><mo>=</mo><msub><mi>R</mi><mi>a</mi></msub><mo>+</mo><mi>k</mi><msqrt><mfrac><msub><mi>R</mi><mi>a</mi></msub><mi>M</mi></mfrac></msqrt><mo>+</mo><mfrac><mn>1</mn><mrow><mn>2</mn><mi>M</mi></mrow></mfrac></mrow>
              </math>
            </Eq>
            <p><i>R<sub>a</sub></i>: exposure-weighted site-type average; <i>M</i>: exposure (100 MVMT); <i>k</i> = 1.645 (95 %). <i>R</i>/<i>R<sub>c</sub></i> &gt; 1 flags a segment.</p>
            <h3>Empirical Bayes expected crashes</h3>
            <Eq label="Empirical Bayes weight and expected crashes">
              <math><mrow><msub><mi>k</mi><mi>seg</mi></msub><mo>=</mo><mfrac><mi>k</mi><mi>L</mi></mfrac></mrow></math>
              <math><mrow><mi>w</mi><mo>=</mo><mfrac><mn>1</mn><mrow><mn>1</mn><mo>+</mo><msub><mi>k</mi><mi>seg</mi></msub><mo>·</mo><msub><mi>μ</mi><mi>Y</mi></msub></mrow></mfrac></mrow></math>
              <math><mrow><mi>E</mi><mo>=</mo><mi>w</mi><mo>·</mo><msub><mi>μ</mi><mi>Y</mi></msub><mo>+</mo><mo>(</mo><mn>1</mn><mo>−</mo><mi>w</mi><mo>)</mo><mo>·</mo><mi>N</mi></mrow></math>
            </Eq>
            <p><i>μ</i><sub>Y</sub>: site-type SPF prediction over the same <i>Y</i> years; <i>k</i>: NB overdispersion per mile,
              <i> k</i><sub>seg</sub> = <i>k</i>/<i>L</i> (HSM Part C). Ranking is by excess expected crashes,
              (<i>E</i> − <i>μ</i><sub>Y</sub>)/<i>Y</i>, per year (Hauer 1997; Hauer et al. 2002; HSM 2010, Ch. 4).</p>
          </Sec>

          <Sec id="m-spf">
            <h2 id="m-spf-h">Safety performance functions</h2>
            <Eq label="Site-type SPF with length and period offset">
              <math display="block">
                <mrow><mi>ln</mi><msub><mi>μ</mi><mi>Y</mi></msub><mo>=</mo><msub><mi>β</mi><mn>0</mn></msub><mo>+</mo><msub><mi>β</mi><mn>1</mn></msub><mi>ln</mi><mi>AADT</mi><mo>+</mo><mo>∑</mo><msub><mi>β</mi><mi>j</mi></msub><msub><mi>x</mi><mi>j</mi></msub><mo>+</mo><mi>ln</mi><mi>L</mi><mo>+</mo><mi>ln</mi><mi>Y</mi></mrow>
              </math>
            </Eq>
            <p>{spf.data?.estimation ?? 'NB2 maximum likelihood with offset ln L + ln Y'}. Covariates <i>x<sub>j</sub></i> (lanes, divided,
              posted speed) are chosen by AIC, at most one per 10 crashes. Site types under 30 segments or 20 crashes use a pooled model
              (ln AADT, urban, lanes, speed). Fit: MAD, Pearson χ²/df and CURE share outside ±2σ* (Hauer and Bamfo 1997).
              Segments without AADT or site type are excluded.</p>
            {spf.error && <div className="error-box">{spf.error}</div>}
            {spf.loading && <div className="skeleton m-skel" />}
            {spf.data && <SpfTable s={spf.data} />}
            <p className="muted m-small">Coefficients on ln μ; speed in posted mph. With 24–56 crashes per site type, standard errors are wide
              and the urban minor arterial ln AADT term is not distinguishable from zero: screening baselines, not causal models.
              Fallback GOF (0–2 crashes) is not informative.</p>
          </Sec>

          <Sec id="m-ssm">
            <h2 id="m-ssm-h">Surrogate safety measures</h2>
            <p>10 Hz trajectories with FHWA SSAM conventions and default thresholds (Gettman et al. 2008). A <em>traffic conflict</em> is an
              interaction below threshold, not an observed crash.</p>
            <dl className="m-defs">
              <dt>Time to collision (TTC)</dt>
              <dd>
                <Eq label="Time to collision"><math display="block"><mrow><mi>TTC</mi><mo>=</mo><mfrac><mrow><mi>Δ</mi><mi>x</mi></mrow><mrow><msub><mi>v</mi><mi>f</mi></msub><mo>−</mo><msub><mi>v</mi><mi>l</mi></msub></mrow></mfrac><mspace width="1em" /><mtext>for </mtext><msub><mi>v</mi><mi>f</mi></msub><mo>&gt;</mo><msub><mi>v</mi><mi>l</mi></msub></mrow></math></Eq>
                Hayward (1972). Rear-end and lane-change; Δ<i>x</i> is the front-to-rear gap. Detection: TTC ≤ <span className="num">1.5</span> s
                for ≥ 0.3 s (SSAM default). Severity: ≤ 0.5 s critical, 0.5–1.0 s serious, 1.0–1.5 s moderate (study-specific).
              </dd>
              <dt>Post-encroachment time (PET)</dt>
              <dd>
                Allen, Shin and Cooper (1978): time from the first road user leaving the conflict zone to the second entering it. Footprints
                are length × width boxes swept along each path (0.5 m raster, 50 Hz); approaches conflict at ≥ 30°. Detection:
                PET ≤ <span className="num">5.0</span> s (SSAM default). Severity: ≤ 1 s critical, 1–2.5 s serious, 2.5–5 s moderate
                (study-specific; no SSAM standard). Simultaneous occupancy is kept as PET = 0 and flagged as overlap, most likely
                NGSIM position error (Punzo et al. 2011).
              </dd>
              <dt>Deceleration rate to avoid crash (DRAC)</dt>
              <dd>
                <Eq label="Deceleration rate to avoid crash"><math display="block"><mrow><mi>DRAC</mi><mo>=</mo><mfrac><msup><mrow><mo>(</mo><msub><mi>v</mi><mi>f</mi></msub><mo>−</mo><msub><mi>v</mi><mi>l</mi></msub><mo>)</mo></mrow><mn>2</mn></msup><mrow><mn>2</mn><mo>·</mo><mi>Δ</mi><mi>x</mi></mrow></mfrac></mrow></math></Eq>
                A flag on TTC events, not a detection criterion: DRAC ≥ <span className="num">11.2</span> ft/s² (3.4 m/s²), the AASHTO (2018)
                stopping-sight-distance rate. Above about 26 ft/s² (8 m/s²) exceeds tyre–road friction: position error.
              </dd>
            </dl>
            <SsmRules sites={ssm} />
          </Sec>

          <Sec id="m-repair">
            <h2 id="m-repair-h">Trajectory repair</h2>
            <p>Gaps are cut into complete NGSIM tracks and repairs scored on the held-out points, under two gap protocols and two truths.</p>
            <ol className="m-steps">
              <li><strong>Uniform:</strong> seeded random gaps of 0.5–5.0 s, one or two per track, ≥ 1.0 s from the ends.</li>
              <li><strong>Occluder:</strong> real 2D line-of-sight occlusion intervals from a virtual roadside sensor, 0.5–5.0 s, flickers of ≤ 2 frames merged.</li>
              <li><strong>Truths:</strong> <em>smoothed</em> (Savitzky–Golay, 15 frames, order 2) and <em>raw</em> (NGSIM-interpolated frames excluded). Speed scored on smoothed only.</li>
              <li><strong>Methods:</strong> linear interpolation; constant-acceleration Kalman with RTS smoother; a path-constrained variant. <i>q</i>, <i>r</i> and the method are chosen on a separate validation set.</li>
            </ol>
            <div className="m-repair-grid">
              {repairs.map((r, i) => <RepairCard key={SITES[i][0]} name={SITES[i][1]} r={r.data?.summary} err={r.error} />)}
            </div>
            <p>Result: under 2 s against raw truth, linear ties or beats Kalman at Peachtree (0.23 vs 0.31 m uniform, 0.14 vs 0.16 m occluder)
              while Kalman leads at Lankershim (0.31 vs 0.23 m, 0.24 vs 0.20 m). For gaps ≥ 2 s Kalman is lower in all eight
              site × protocol × truth cases, by 1.3–2.8× (Peachtree uniform has only 14 such gaps).</p>
            <RepairNotes notes={repairs.map((r) => r.data?.summary).find((s) => s?.notes)?.notes} />
            <p className="muted m-small">Follows Punzo, Borzacchiello and Ciuffo (2011) and Montanino and Punzo (2015); a generic baseline,
              not a comparison with Luo et al. (2025).</p>
          </Sec>

          <Sec id="m-limits">
            <h2 id="m-limits-h">Limitations</h2>
            <ul className="m-list">
              <li>The TxDOT segment field <code>SUM_CRASH_</code> is undocumented and behaves as an injury-weighted ped/bike score for 2021–2023
                (r = <span className="num">{nf(spf.data?.diagnostics?.crash_field?.evidence?.corr_with_matched_crashes ?? 0.945, 3)}</span> with
                snapped CRIS crashes; K/A/B weighted about 10× C/O). It is not an all-crash count and not the SPF outcome
                (kept as <code>satp_crash_score</code>).</li>
              <li><code>TxDOT_AADT.AADT_CUR</code> has no published count year and differs from Roadway Inventory 2024 ADT; presumably later than 2021–2023.</li>
              <li>Only three urban site types support their own SPF; the other five (all rural, 0–2 crashes) rest on the pooled fallback.</li>
              <li>EPDO is not computed: no sourced severity weights. Severity analysis is confined to the VRU and FARS layers.</li>
              <li>Trajectories are NGSIM (Los Angeles and Atlanta, 2005–2006), a stand-in for roadside LiDAR; conflict counts are not Lubbock findings.</li>
              <li>The 2D occluder protocol ignores sensor height and over-states occlusion versus a 4.5 m pole. Raw truth noise bounds RMSE from below.</li>
              <li>Screening ranks identify sites for investigation; they do not establish cause or countermeasure need.</li>
              <li>TxDOT data are informational, without warranty; crash records are protected under 23 U.S.C. §407.</li>
            </ul>
          </Sec>

          <Sec id="m-refs">
            <h2 id="m-refs-h">References</h2>
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
          </Sec>
        </article>
      </div>
    </div>
  );
}


function Catalogue() {
  const [fam, setFam] = useState<Family | 'all'>('all');
  const [copied, setCopied] = useState<string | null>(null);
  const shown = useMemo(() => METRICS.filter((m) => fam === 'all' || m.family === fam), [fam]);
  const copy = async (key: string) => {
    const url = `${location.origin}/methods#metric-${key}`;
    try { await navigator.clipboard.writeText(url); setCopied(key); setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600); } catch { /* clipboard blocked */ }
  };
  return (
    <>
      <div className="m-cat-bar">
        <div className="seg m-fams" role="group" aria-label="Metric family">
          {FAMILIES.map(([k, l, ic]) => (
            <button key={k} type="button" aria-pressed={fam === k} onClick={() => setFam(k)}>
              <Icon name={ic} size={15} />{l}<span className="num">{k === 'all' ? METRICS.length : METRICS.filter((m) => m.family === k).length}</span>
            </button>
          ))}
        </div>
        <button type="button" className="btn ghost" onClick={() => downloadCSV('roadscope-metric-catalogue.csv', METRICS.map((m) => ({ metric: m.name, abbr: m.abbr ?? '', family: m.family, formula: m.formula.replace(/\n/g, '; '), threshold: typeof m.threshold === 'string' ? m.threshold : '', unit: m.unit, data: m.data, provenance: m.provenance, reference: m.cite })))}>
          <Icon name="download" size={16} />Catalogue CSV
        </button>
      </div>
      <ul className="m-cat" aria-live="polite">
        {shown.map((m) => (
          <li key={m.key} id={`metric-${m.key}`} className="m-card">
            <div className="m-card-h">
              <span className="m-card-i"><Icon name={m.icon} size={18} weight="duotone" /></span>
              <h3>{m.name}{m.abbr && <span className="m-abbr">{m.abbr}</span>}</h3>
              <ProvChip kind={m.provenance} />
            </div>
            <pre className="m-formula measure" aria-label={`Formula: ${m.formula}`}>{m.formula}</pre>
            {m.where && <p className="m-where">{m.where}</p>}
            <dl className="m-card-dl">
              <dt>Threshold</dt><dd>{m.threshold}</dd>
              <dt>Unit</dt><dd className="measure">{m.unit}</dd>
              <dt>Data</dt><dd>{m.data}</dd>
              <dt>Reference</dt><dd>{m.cite}</dd>
            </dl>
            <div className="m-card-f">
              <a href={`#${m.section}`}><Icon name="methods" size={14} />Derivation</a>
              <Link to={m.page[0]}><Icon name="arrow" size={14} />{m.page[1]}</Link>
              <button type="button" onClick={() => void copy(m.key)} aria-label={`Copy link to ${m.name}`}>
                <Icon name={copied === m.key ? 'check' : 'link'} size={14} />{copied === m.key ? 'Copied' : 'Link'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** A section whose direct children rise in sequence as it enters the viewport. */
function Sec({ id, children }: { id: string; children: React.ReactNode }) {
  const ref = useReveal<HTMLElement>();
  return <section id={id} ref={ref} className="section m-sec" aria-labelledby={`${id}-h`}>{children}</section>;
}

/** Id of the section currently under the upper third of the viewport. */
function useSpy() {
  const [active, setActive] = useState(TOC[0][0]);
  useEffect(() => {
    const els = TOC.map(([id]) => document.getElementById(id)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver((es) => {
      const hit = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (hit) setActive(hit.target.id);
    }, { rootMargin: '-20% 0px -70% 0px' });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return active;
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
    <div className="m-scroll" data-ui>
      <table className="data">
        <caption className="m-cap">
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
      <div className="m-scroll" data-ui>
        <table className="data m-rules">
          <thead><tr><th>Rule</th><th>Definition</th><th>Source / note</th></tr></thead>
          <tbody>{rows.map(([k, v, c]) => <tr key={k}><td>{k}</td><td className="m-small">{v}</td><td className="m-small muted">{c ?? '—'}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="m-scroll" data-ui>
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
    <div className="m-repair">
      <h3>{name}</h3>
      {occ && (
        <p className="muted m-small">
          Virtual sensor occludes <span className="num">{nf(100 * occ.occluded_share, 1)}%</span> of frames (2D) ·
          <span className="num"> {nf(occ.gaps)}</span> occlusion gaps of 0.5–5 s on <span className="num">{nf(occ.tracks_with_gaps)}</span> tracks,
          mean <span className="num">{nf(occ.gap_len_mean_s, 2)}</span> s
        </p>
      )}
      <div className="m-scroll" data-ui>
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
      </div>
      <p className="muted m-small">Position RMSE in m on gap frames; bold is lowest, * the method selected on validation. Short/long columns pool the by-gap bins (frame-weighted).</p>
    </div>
  );
}

function RepairNotes({ notes }: { notes?: string[] }) {
  if (!notes?.length) return null;
  return <ul className="m-list m-small">{notes.map((n) => <li key={n} className="m-small">{n}</li>)}</ul>;
}
