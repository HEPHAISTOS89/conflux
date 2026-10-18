import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../Icon';
import Info from '../Info';

const COLS: [string, string, string][] = [
  ['site_id', 'string', 'equals site.json → id'],
  ['track_id', 'string | int', 'one road user, whole recording'],
  ['class', 'enum', 'pedestrian · bicycle · motorcycle · car · truck · bus'],
  ['t', 's', 'on the 10 Hz grid (± 0.02 s)'],
  ['x, y', 'm | ft', 'local plane, +y along the main road'],
  ['length, width', 'm | ft', 'vehicles; class defaults when blank'],
  ['heading', '°', 'optional, clockwise from +y'],
  ['lane', 'int', 'optional; else 3.5 m lateral bins'],
];
const STEPS: [string, string][] = [
  ['S3', 'sites/<site_id>/site.json, then tracks.csv'],
  ['EventBridge', 'Object Created · sites/*/tracks.csv'],
  ['Lambda · ingest', 'validate → convert → TTC · PET · DRAC · ped PET · yield'],
  ['curated/', 'intersections/<site_id>*.json · index · manifest'],
  ['CloudWatch', 'roadscope-site-ingest-failed alarm · DLQ'],
];

/** How a lab drops its own trajectory feed: the S3 path, the two-file schema and what the pipeline does with it. */
export default function AddSite({ bucket, sources }: { bucket: string | null; sources: { id: string; records: number; licence: string }[] }) {
  const [open, setOpen] = useState(false);
  const sites = sources.filter((s) => s.id.startsWith('site_'));
  const b = bucket ?? '<bucket>';
  return (
    <section className="section pf-site" aria-labelledby="pf-site-h">
      <div className="pf-h">
        <h2 id="pf-site-h">Add a site</h2>
        <Info label="About adding a site" title="Add a site">
          <p>Any 10 Hz trajectory feed (roadside LiDAR, drone, video tracker) dropped as two files under <span className="measure">sites/&lt;site_id&gt;/</span> is converted to the curated intersection format and appears in the <Link to="/intersections">Intersection lab</Link> with its own conflicts, pedestrian PET and failure-to-yield events.</p>
          <p>The S3 event rule, the Lambda path and the <span className="measure">roadscope-site-ingest-failed</span> alarm are defined in CDK and unit-tested; the stack change is described in docs/DEPLOY.md and has not been deployed. The same converter runs locally: <span className="measure">python -m roadscope_pipeline.trajectory.site --site data/sites/&lt;site_id&gt;</span>.</p>
          <p>Schema reference: docs/SITE_TRAJECTORY_SCHEMA.md. Validation failures (units, off-grid timestamps, unknown classes, pedestrians without crosswalk polygons) stop the run and name the row; nothing is published.</p>
        </Info>
        <span className="status" data-s="warn" title="S3 drop rule, Lambda path and alarm are defined in CDK and tested; awaiting deploy"><Icon name="clock" size={14} weight="fill" />Defined, not deployed</span>
      </div>
      <div className="pf-site-grid">
        <div className="panel pf-site-drop">
          <small>Drop path</small>
          <code className="measure">s3://{b}/sites/&lt;site_id&gt;/</code>
          <ol className="pf-site-flow" aria-label="What happens after the drop">
            {STEPS.map(([k, v], i) => (
              <li key={k}><span className="pf-site-n measure">{i + 1}</span><b>{k}</b><span>{v}</span></li>
            ))}
          </ol>
          <p className="pf-site-fine">Site feeds in the manifest: {sites.length ? sites.map((s) => <span key={s.id} className="measure" title={s.licence}>{s.id.slice(5)} · {s.records.toLocaleString()} rows</span>) : 'none'}. None has come through S3 yet; the SinD site was converted locally with the same converter.</p>
        </div>
        <div className="panel pf-site-schema">
          <div className="pf-site-sh">
            <small>tracks.csv</small>
            <button type="button" className="btn ghost sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'Hide site.json' : 'site.json keys'}</button>
          </div>
          <table className="data pf-site-cols">
            <thead><tr><th>Column</th><th>Unit</th><th>Rule</th></tr></thead>
            <tbody>{COLS.map(([c, u, r]) => <tr key={c}><td className="measure">{c}</td><td className="measure">{u}</td><td>{r}</td></tr>)}</tbody>
          </table>
          {open && (
            <dl className="pf-site-keys">
              <div><dt className="measure">id · name · city · recorded</dt><dd>identity shown on the lab tabs</dd></div>
              <div><dt className="measure">hz · units · reference</dt><dd>10 · m | ft · front_bumper | centre (output is always front-bumper)</dd></div>
              <div><dt className="measure">origin · rotate_deg</dt><dd>put the intersection at (0, 0), main road along +y</dd></div>
              <div><dt className="measure">box</dt><dd>intersection box: lane 0 inside, crossing-conflict zone</dd></div>
              <div><dt className="measure">crosswalks[]</dt><dd>id + polygon; required when the feed has pedestrians</dd></div>
              <div><dt className="measure">source</dt><dd>dataset · url · licence · citation, shown with every number</dd></div>
            </dl>
          )}
        </div>
      </div>
    </section>
  );
}
