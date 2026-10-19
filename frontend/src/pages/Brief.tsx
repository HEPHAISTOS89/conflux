import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/api';
import { nf, SEV_COLOR, SEV_LABEL } from '../lib/format';
import { useReveal } from '../lib/motion';
import { copyLink, downloadCSV } from '../lib/export';
import Term from '../components/Term';
import PageHeader from '../components/PageHeader';
import MetricInfo, { type MetricSpec } from '../components/MetricInfo';
import Info from '../components/Info';
import { Icon, type IconName } from '../components/Icon';
import type { Manifest, SegmentProps } from '../lib/types';
import '../styles/brief.css';

type Row = SegmentProps & { fc_group?: string; crashes_per_yr?: number; crashes_ka?: number; dfo_from?: number; dfo_to?: number; speed_all?: number; site_type?: string };
interface Screening { total: number; items: Row[]; unscreened?: { segments: number; crashes: number } }
interface Cond { key: string; label: string; n: number; ka: number }
interface VruSum { on_system?: { total: number; ka: number }; severity_by_condition?: Cond[]; total: number; years: number[]; by_severity: Record<string, number>; by_pbcat: Record<string, number>; by_light: Record<string, number>; by_mode?: Record<string, number> }
interface SpfLite { crash_years?: number; site_types?: Record<string, { segments: number; crashes: number; fitted: boolean; model_used: string; model?: { k: number; spec: string[] }; gof?: { mad: number; chi2_df: number } }> }

const HSM = <>AASHTO <i>Highway Safety Manual</i> (2010), Part B ch. 4</>;
const SPECS: Record<'eb' | 'cr', MetricSpec> = {
  eb: {
    name: 'Excess expected crashes (EB)', provenance: 'derived', unit: 'ped/bike crashes per year',
    formula: <>E = w·μ + (1−w)·N, w = 1/(1 + k·μ); excess = E − μ</>, threshold: <>&gt; 0 flags a site</>,
    source: 'TxDOT CRIS on-system ped/bike crashes 2021–2023', citation: <>{HSM}; Hauer (1997)</>,
  },
  cr: {
    name: 'Critical rate ratio', provenance: 'derived', unit: 'ratio (R / Rc)',
    formula: <>Rc = Ra + 1.645·√(Ra/M) + 1/(2M)</>, threshold: <>&gt; 1 is high at 95% confidence</>,
    source: 'TxDOT CRIS; TxDOT AADT', citation: HSM,
  },
};

/** Diagnostic prompts derived from segment attributes; they point to what to examine, not to a CMF value. */
function prompts(r: Row): { icon: IconName; t: string }[] {
  const out: { icon: IconName; t: string }[] = [];
  if (r.speed_limit && r.speed_all && r.speed_all < r.speed_limit - 15) out.push({ icon: 'signal', t: `Operating ${op(r.speed_all)} mph vs ${nf(r.speed_limit)} posted: signal spacing, access density, queue spillback` });
  if (r.speed_limit && r.speed_all && r.speed_all > r.speed_limit + 3) out.push({ icon: 'gauge', t: `Operating ${op(r.speed_all)} mph above ${nf(r.speed_limit)} posted: speed management, sight distance` });
  if ((r.lanes ?? 0) >= 6 && (r.fc_group ?? '').toLowerCase().includes('arterial')) out.push({ icon: 'ped', t: `${nf(r.lanes)}-lane arterial: crossing exposure, refuge islands, access management` });
  if ((r.truck_pct ?? 0) >= 12) out.push({ icon: 'truck', t: `Trucks ${nf(r.truck_pct, 0)}%: lane widths, shoulders, turning radii` });
  if ((r.crit_ratio ?? 0) > 1) out.push({ icon: 'warning', t: `Rate ${nf(r.crit_ratio, 2)}× the critical rate at 95% confidence` });
  return out.length ? out : [{ icon: 'search', t: 'No attribute flag: pull CRIS crash-level records for collision types' }];
}

/** Wilson score interval (95 %) for a KA share. */
function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 0];
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const COND_SHOWN = ['dark_unlit', 'dark_lit', 'day', 'speed_ge50', 'speed_le35', 'dark_ge50'];
const op = (v?: number | null) => (v != null && v >= 65 ? '≥ 65' : nf(v));

const FIELDS = ['eb_excess', 'crit_ratio', 'rate_100mvmt', 'crashes_total'] as const;
/** Sites ranked in the top 25 under all four HSM Part B measures (competition ranks, ties share). */
function robustSet(rows: Row[]) {
  const ok = new Map<string, number>();
  for (const f of FIELDS) {
    const sorted = rows.filter((r) => r[f] != null).sort((a, b) => (b[f] as number) - (a[f] as number));
    let rank = 0;
    sorted.forEach((r, i) => { if (i === 0 || sorted[i - 1][f] !== r[f]) rank = i + 1; if (rank <= 25) ok.set(r.seg_id, (ok.get(r.seg_id) ?? 0) + 1); });
  }
  return new Set([...ok].filter(([, n]) => n === FIELDS.length).map(([id]) => id));
}

const LIGHT: [string, (k: string) => boolean][] = [
  ['Daylight', (k) => k.includes('DAYLIGHT')],
  ['Dark, lighted', (k) => k.includes('DARK, LIGHTED')],
  ['Dark, not lighted', (k) => k.includes('NOT LIGHTED')],
  ['Dawn, dusk, unknown', (k) => !k.includes('DAYLIGHT') && !k.includes('DARK, LIGHTED') && !k.includes('NOT LIGHTED')],
];

export default function Brief() {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(t); }, [copied]);
  const [retry, setRetry] = useState(0);
  const [appendix, setAppendix] = useState(false);
  const rq = retry ? `?retry=${retry}` : '';
  const scr = useApi<Screening>(`/screening?method=eb_excess&limit=1000${retry ? `&retry=${retry}` : ''}`);
  const vru = useApi<VruSum>(`/vru/summary${rq}`);
  const meta = useApi<Manifest>(`/meta${rq}`);
  const spf = useApi<SpfLite>(`/spf${rq}`);
  const reveal = useReveal<HTMLDivElement>();
  const date = meta.data?.generated_at?.slice(0, 10);
  const items = useMemo(() => scr.data?.items ?? [], [scr.data]);
  const top = items.slice(0, 10);
  const v = useMemo(() => {
    const flagged = items.filter((r) => (r.eb_excess ?? 0) > 0);
    const confirmed = flagged.filter((r) => (r.crit_ratio ?? 0) > 1);
    return { flagged, confirmed, crashes: items.reduce((s, r) => s + r.crashes_total, 0), excessSum: flagged.reduce((s, r) => s + (r.eb_excess ?? 0), 0) };
  }, [items]);
  const robust = useMemo(() => robustSet(items), [items]);
  const ka = vru.data ? (vru.data.by_severity.K ?? 0) + (vru.data.by_severity.A ?? 0) : null;
  const lead = items[0];
  const maxEx = Math.max(0.01, ...top.map((r) => r.eb_excess ?? 0));
  const pbcat = vru.data ? Object.entries(vru.data.by_pbcat).sort((a, b) => b[1] - a[1]).slice(0, 3) : [];
  const light = vru.data ? LIGHT.map(([l, f]) => [l, Object.entries(vru.data!.by_light).filter(([k]) => f(k)).reduce((s, [, n]) => s + n, 0)] as const) : [];
  const cond = useMemo(() => {
    const m = new Map((vru.data?.severity_by_condition ?? []).map((c) => [c.key, c]));
    return COND_SHOWN.map((k) => m.get(k)).filter((c): c is Cond => !!c && c.n > 0);
  }, [vru.data]);
  const condBy = (k: string) => cond.find((c) => c.key === k);
  const kaPct = (c?: Cond) => (c && c.n ? `${Math.round((100 * c.ka) / c.n)}%` : '—');
  const errs = [scr, vru, meta, spf].map((r) => r.error).filter(Boolean);
  const share = async () => setCopied(await copyLink());
  const exportCsv = () => downloadCSV('sightpole-lubbock-county-flagged-sites.csv', v.flagged.map((r, i) => ({
    rank: i + 1, route: r.name, seg_id: r.seg_id, dfo_from: r.dfo_from, dfo_to: r.dfo_to, site_type: r.site_type, lanes: r.lanes, speed_limit_mph: r.speed_limit,
    aadt: r.aadt, crashes_3yr: r.crashes_total, crashes_ka_3yr: r.crashes_ka, spf_pred_per_yr: r.spf_pred, eb_expected_per_yr: r.eb_expected, eb_excess_per_yr: r.eb_excess, crit_ratio: r.crit_ratio,
  })));

  const diag = (
    <ol className="sheet-diag">
      {top.slice(0, 5).map((r, i) => (
        <li key={r.seg_id} style={{ '--i': i } as React.CSSProperties}>
          <b>{r.name} <span className="measure">DFO {nf(r.dfo_from, 1)}</span></b>
          <ul>{prompts(r).map((p) => <li key={p.t}><Icon name={p.icon} size={15} /><span>{p.t}</span></li>)}</ul>
        </li>
      ))}
    </ol>
  );
  const next = (
    <ul className="sheet-next">
      {condBy('dark_unlit') && condBy('day') && <li><Icon name="moon" size={16} /><span>Lighting: {kaPct(condBy('dark_unlit'))} of crashes on dark, unlit roads were KA against {kaPct(condBy('day'))} in daylight. Audit lighting at flagged segments (FHWA Proven Safety Countermeasure).</span></li>}
      {condBy('speed_ge50') && condBy('speed_le35') && <li><Icon name="gauge" size={16} /><span>Speed: {kaPct(condBy('speed_ge50'))} KA where posted 50 mph or more against {kaPct(condBy('speed_le35'))} at 35 mph or less. Review crossings and speed management on high-speed flagged segments.</span></li>}
      <li><Icon name="db" size={16} /><span>Request CRIS all-crash records for the ranked sites; re-screen against all-crash SPFs.</span></li>
      <li><Icon name="clock" size={16} /><span>Confirm the count year of TxDOT_AADT.AADT_CUR for the flagged segments.</span></li>
      <li><Icon name="methods" size={16} /><span>Select countermeasures from the FHWA CMF Clearinghouse by PBCAT type, site type and AADT range.</span></li>
      <li><Icon name="lidar" size={16} /><span>Deploy roadside LiDAR at confirmed sites to measure PET, TTC and yielding before and after treatment.</span></li>
    </ul>
  );

  return (
    <div className="page brief" ref={reveal}>
      {errs.length > 0 && <div className="error-box no-print" role="alert">Some data could not be loaded: {errs.join(' · ')} <button type="button" className="btn ghost" onClick={() => setRetry((n) => n + 1)}><Icon name="reset" size={16} /><span>Retry</span></button></div>}
      <article className="sheet-page" aria-labelledby="brief-h">
        <div className="sheet-ph">
          <PageHeader
            icon="county"
            title="Lubbock County ped/bike safety brief"
            lede={<>{v.flagged.length} of {nf(items.length)} screened one-mile state-system segments have expected ped/bike crashes above the SPF prediction (EB excess &gt; 0); {v.confirmed.length} also exceed the critical rate at 95% confidence.</>}
            source={<>Derived from TxDOT CRIS 2021–2023, TxDOT District 05, County 152, by HSM Part B empirical Bayes screening; build {date ?? '…'}. Screening flags sites for investigation and does not establish cause. Not an official TxDOT product.</>}
            readouts={[
              { label: <span className="rd-l">Sites flagged <MetricInfo spec={SPECS.eb} align="right" /></span>, value: scr.data ? v.flagged.length : null, unit: `of ${nf(items.length)}`, tone: 'alert' },
              { label: <span className="rd-l">Confirmed <MetricInfo spec={SPECS.cr} align="right" /></span>, value: scr.data ? v.confirmed.length : null, unit: 'EB + R/Rc' },
              { label: 'EB excess, flagged', value: scr.data ? v.excessSum : null, unit: 'crashes/yr', digits: 1 },
              { label: 'KA, all roads', value: ka, unit: '3 yr', tone: 'alert' },
            ]}
            actions={<span className="no-print brief-actions">
              <button type="button" className="btn" onClick={() => window.print()}><Icon name="sheet" size={16} /><span>Print brief</span></button>
              <button type="button" className="btn ghost" onClick={exportCsv} disabled={!v.flagged.length}><Icon name="download" size={16} /><span>Download CSV</span></button>
              <button type="button" className="btn ghost" onClick={share} aria-live="polite"><Icon name={copied ? 'check' : 'link'} size={16} /><span>{copied ? 'Copied' : 'Copy link'}</span></button>
              <Link to="/screening" className="btn ghost"><Icon name="rank" size={16} /><span>Open screening</span></Link>
            </span>}
          />
          {scr.data && lead && <p className="verdict"><b>{v.flagged.length}</b> sites flagged, <b>{v.confirmed.length}</b> confirmed; worst: <b>{lead.name}, DFO {nf(lead.dfo_from, 1)}–{nf(lead.dfo_to, 1)}</b>.</p>}
        </div>

        <section data-r="2" aria-labelledby="top-h">
          <h2 id="top-h"><Icon name="target" size={20} />Top 10 sites by EB excess</h2>
          <div className="sheet-table t-scroll" role="region" aria-label="Top 10 sites table" tabIndex={0}>
            <table className="data">
              <thead><tr><th className="r">#</th><th>Route · DFO, mi</th><th className="opt site-c">Site</th><th className="r opt"><Term k="AADT" /></th><th className="r">Obs./yr</th><th className="r opt"><Term k="SPF">SPF/yr</Term></th><th className="bar-h"><Term k="EB excess">Excess/yr</Term></th><th className="r"><Term k="Critical ratio">R/Rc</Term></th><th className="r" title="Top 25 under EB excess, R/Rc, crash rate and crash frequency">Robust</th><th className="no-print">Prompts</th></tr></thead>
              <tbody>
                {scr.loading && Array.from({ length: 10 }, (_, i) => <tr key={i} aria-hidden="true"><td colSpan={10}><div className="skeleton" style={{ height: 18 }} /></td></tr>)}
                {scr.data && !top.length && <tr><td colSpan={10} className="muted">No ranked segments.</td></tr>}
                {top.map((r, i) => (
                  <tr key={r.seg_id} style={{ '--i': i } as React.CSSProperties}>
                    <td className="r measure">{i + 1}</td>
                    <td><Link to={`/screening?seg=${encodeURIComponent(r.seg_id)}`} className="site-l"><b>{r.name}</b></Link> <span className="measure muted">{nf(r.dfo_from, 2)}–{nf(r.dfo_to, 2)}</span></td>
                    <td className="opt site-c">{r.site_type ?? r.fc_group} · <span className="measure">{nf(r.lanes)} ln · {nf(r.speed_limit)} mph</span></td>
                    <td className="r measure opt">{nf(r.aadt)}</td>
                    <td className="r measure">{nf(r.crashes_per_yr, 2)}</td>
                    <td className="r measure opt">{nf(r.spf_pred, 2)}</td>
                    <td className="bar-c"><span className="bar-w"><span className="bar" style={{ '--w': `${Math.max(0, (r.eb_excess ?? 0) / maxEx) * 100}%` } as React.CSSProperties} /><b className="measure">{nf(r.eb_excess, 2)}</b></span></td>
                    <td className="r measure" data-hi={(r.crit_ratio ?? 0) > 1 || undefined}>{nf(r.crit_ratio, 2)}</td>
                    <td className="r robust-c">{robust.has(r.seg_id) ? <span title="Top 25 under all four measures"><Icon name="ok" size={17} title="Robust under all four measures" /></span> : <span className="muted" title="Drops out of the top 25 under at least one measure">—</span>}</td>
                    <td className="no-print prompt-c">{prompts(r).map((p) => <span key={p.t} title={p.t} role="img" aria-label={p.t}><Icon name={p.icon} size={16} /></span>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sheet-more no-print">
            <Info label="Diagnostic prompts, top 5 sites" text="Diagnostic prompts" title="Diagnostic prompts, top 5 sites">{diag}</Info>
            <Info label="Next steps" text="Next steps" title="Next steps">{next}</Info>
          </div>
        </section>

        <section className="sheet-two" data-r="3">
          <div className="print-only">
            <div>
              <h2><Icon name="search" size={20} />Diagnostic prompts, top 5 sites</h2>
              {diag}
              <div className="sheet-next-s">
                <h2><Icon name="arrow" size={20} />Next steps</h2>
                {next}
              </div>
            </div>
          </div>
          <div className="sheet-vru">
            <h2><Icon name="ped" size={20} />Countywide VRU crashes</h2>
            {vru.data ? (
              <>
                <div className="vru-cols"><div>
                <dl className="vru-figs">
                  <div><dt>Crashes, {vru.data.years[0]}–{vru.data.years[vru.data.years.length - 1]}</dt><dd className="measure">{nf(vru.data.total)}</dd></div>
                  <div><dt>KA</dt><dd className="measure">{nf(ka)}</dd></div>
                  {vru.data.on_system && <div><dt>State system</dt><dd className="measure">{nf(vru.data.on_system.total)} <small>· {nf(vru.data.on_system.ka)} KA</small></dd></div>}
                </dl>
                <div className="kabco" role="img" aria-label={`KABCO severity: ${['K', 'A', 'B', 'C', 'O'].map((k) => `${k} ${vru.data!.by_severity[k] ?? 0}`).join(', ')}`}>
                  {['K', 'A', 'B', 'C', 'O'].map((k) => <span key={k} style={{ flex: vru.data!.by_severity[k] ?? 0, background: SEV_COLOR[k] }} title={`${SEV_LABEL[k]}: ${vru.data!.by_severity[k] ?? 0}`} />)}
                </div>
                <ul className="kabco-k">
                  {['K', 'A', 'B', 'C', 'O'].map((k) => <li key={k}><i style={{ background: SEV_COLOR[k] }} />{SEV_LABEL[k].split(' · ')[1]} <b className="measure">{vru.data!.by_severity[k] ?? 0}</b></li>)}
                </ul>
                <h3><Icon name="moon" size={16} />Light condition</h3>
                <ul className="light">
                  {light.map(([l, n]) => <li key={l}><span>{l}</span><span className="light-bar"><i style={{ width: `${(n / vru.data!.total) * 100}%` }} /></span><b className="measure">{Math.round((n / vru.data!.total) * 100)}%</b></li>)}
                </ul>
                </div><div>
                {cond.length > 0 && <>
                  <h3><Icon name="warning" size={16} />KA share by condition</h3>
                  <div className="t-scroll" role="region" aria-label="KA share by condition table" tabIndex={0}><table className="data app-t cond-t">
                    <caption className="sr-only">KA share of VRU crashes by light condition and posted speed, with 95% Wilson intervals</caption>
                    <thead><tr><th>Condition</th><th className="r">Crashes</th><th className="r">KA</th><th className="r">KA share · 95% CI</th></tr></thead>
                    <tbody>
                      {cond.map((c) => { const [lo, hi] = wilson(c.ka, c.n); return (
                        <tr key={c.key}><td>{c.label}</td><td className="r measure">{c.n}</td><td className="r measure">{c.ka}</td><td className="r measure">{kaPct(c)} <span className="muted">{Math.round(100 * lo)}–{Math.round(100 * hi)}</span></td></tr>
                      ); })}
                    </tbody>
                  </table></div>
                </>}
                <h3><Icon name="flag" size={16} />Top <Term k="PBCAT" /> types</h3>
                <ol className="pbcat">{pbcat.map(([t, n]) => <li key={t}><span>{t}</span><b className="measure">{n}</b></li>)}</ol>
                </div></div>
              </>
            ) : <div className="skeleton" style={{ height: 240 }} />}
          </div>
        </section>


        <footer className="sheet-foot print-only">Screening flags sites for investigation and does not establish cause. Not an official TxDOT product.</footer>

        <section className="appendix" aria-labelledby="app-h" data-open={appendix || undefined}>
          <h2 id="app-h" className="print-only"><Icon name="methods" size={20} />Technical appendix</h2>
          <button type="button" className="btn ghost app-toggle no-print" aria-expanded={appendix} aria-controls="app-body" onClick={() => setAppendix((o) => !o)}>
            <Icon name="methods" size={16} /><span>Technical appendix</span><Icon name="caret" size={16} />
          </button>
          <div className="app-body" id="app-body">
          <div className="app-grid">
            <div>
              <h3>Screening method</h3>
              <dl className="app-dl">
                <dt>Unit</dt><dd>One-mile on-system segments (TxDOT SATP), n = {nf(items.length)} screened{scr.data?.unscreened?.segments ? `; ${scr.data.unscreened.segments} without an inventory/AADT match (${scr.data.unscreened.crashes} crashes) not ranked` : ''}</dd>
                <dt>Outcome</dt><dd>CRIS ped/bike crashes, {spf.data?.crash_years ?? 3} years (2021–2023), all KABCO levels; {nf(v.crashes)} on screened segments</dd>
                <dt>SPF</dt><dd className="measure">μ = L·Y·exp(β₀ + β₁ ln AADT + …), NB2</dd>
                <dt>EB</dt><dd className="measure">w = 1/(1 + k·μ); E = w·μ + (1−w)·N</dd>
                <dt>Critical rate</dt><dd className="measure">Rc = Ra + 1.645√(Ra/M) + 1/(2M)</dd>
                <dt>Flag</dt><dd>EB excess &gt; 0; confirmed when R/Rc &gt; 1 as well</dd>
                <dt>Robust</dt><dd>Top 25 under all four measures (EB excess, R/Rc, rate, frequency); ties share rank</dd>
                <dt>References</dt><dd>{HSM}; Hauer (1997); Hauer &amp; Bamfo (1997)</dd>
              </dl>
            </div>
            <div>
              <h3>Models by site type</h3>
              <div className="t-scroll" role="region" aria-label="Safety performance models table" tabIndex={0}><table className="data app-t">
                <thead><tr><th>Site type</th><th className="r">Segs</th><th className="r">Crashes</th><th className="r">k/mi</th><th className="r">MAD</th></tr></thead>
                <tbody>
                  {Object.entries(spf.data?.site_types ?? {}).map(([t, s]) => (
                    <tr key={t}><td>{t}{!s.fitted && <span className="muted"> (pooled)</span>}</td><td className="r measure">{s.segments}</td><td className="r measure">{s.crashes}</td><td className="r measure">{s.model ? (s.model.k < 0.005 ? '< 0.01' : s.model.k.toFixed(2)) : '—'}</td><td className="r measure">{s.gof ? s.gof.mad.toFixed(2) : '—'}</td></tr>
                  ))}
                </tbody>
              </table></div>
            </div>
          </div>
          <h3>Data sources and licences</h3>
          <div className="t-scroll" role="region" aria-label="Data sources table" tabIndex={0}><table className="data app-t">
            <thead><tr><th>Source</th><th className="r">Records</th><th>Fetched</th><th>Licence</th></tr></thead>
            <tbody>
              {(meta.data?.sources ?? []).filter((s) => !s.id.startsWith('ngsim')).map((s) => (
                <tr key={s.id}><td><a href={s.url} target="_blank" rel="noreferrer">{s.id.replace(/_/g, ' ')}</a></td><td className="r measure">{nf(s.records)}</td><td className="measure">{s.fetched_at.slice(0, 10)}</td><td className="app-lic">{s.licence}</td></tr>
              ))}
            </tbody>
          </table></div>
          </div>
        </section>
      </article>
    </div>
  );
}
