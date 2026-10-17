import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import { Icon, type IconName } from '../components/Icon';
import { useReveal } from '../lib/motion';
import '../styles/roadmap.css';

type Status = 'done' | 'progress' | 'prototype' | 'planned';
interface Item { icon: IconName; t: string; line: string; status: Status; needs?: string; to?: string }

const STAGES: { s: Status; label: string; when: string; chip: string }[] = [
  { s: 'done', label: 'Done', when: 'Running on the portal today', chip: 'ok' },
  { s: 'progress', label: 'In progress', when: 'Being built now', chip: 'warn' },
  { s: 'prototype', label: 'Prototype', when: 'Built; waits on AWS verification', chip: 'warn' },
  { s: 'planned', label: 'Planned', when: 'Needs pilot data or new extracts', chip: 'idle' },
];

const ITEMS: Item[] = [
  { status: 'done', icon: 'rank', t: 'HSM network screening', line: 'Segments ranked by excess expected crashes, on-system CRIS ped/bike crashes 2021–2023.', to: '/screening' },
  { status: 'done', icon: 'trend', t: 'NB SPF + Empirical Bayes', line: 'Negative binomial SPF per site type with EB-weighted expected crash frequency.', to: '/methods' },
  { status: 'done', icon: 'target', t: 'SSAM-style conflicts', line: 'TTC ≤ 1.5 s and PET ≤ 5.0 s on NGSIM Peachtree and Lankershim, 10 Hz.', to: '/intersections' },
  { status: 'done', icon: 'path', t: 'Occlusion repair evaluation', line: 'Gap-filling methods scored by position and speed RMSE against held-out truth.', to: '/intersections' },
  { status: 'done', icon: 'ped', t: 'VRU crash profile', line: 'KABCO severity, mode and time of day for pedestrian, cyclist and e-scooter crashes.', to: '/vru' },
  { status: 'done', icon: 'platform', t: 'AWS pipeline', line: 'EventBridge → Lambda → S3 → API Gateway, self-stopping EC2 worker, CloudWatch alarms.', to: '/platform' },
  { status: 'done', icon: 'sheet', t: 'District brief', line: 'One printable page for county officials: verdict first, method one click below.', to: '/brief' },
  { status: 'done', icon: 'download', t: 'Light/dark, CSV/PNG export', line: 'Both themes, data and chart exports, and deep links to any view.' },

  { status: 'progress', icon: 'gauge', t: 'Craft pass on every page', line: 'Each page scored on hierarchy, accuracy, motion and accessibility until it reaches 9/10.', needs: 'Browser verification at 1440, 1024 and 390 px in both themes' },
  { status: 'progress', icon: 'lidar', t: '3D trajectory viewer', line: 'Fullscreen, free-fly, sensor POV and near-miss replay from three angles.', needs: 'Remaining camera modes, minimap and the 60 fps budget', to: '/intersections' },

  { status: 'prototype', icon: 'bedrock', t: 'Bedrock analyst', line: 'Claude Haiku 4.5 calling the API’s own tools; a deterministic analyst answers today.', needs: 'AWS account verification for Bedrock model access', to: '/ask' },
  { status: 'prototype', icon: 'edge', t: 'CloudFront edge', line: 'OAC-protected Function URL with a 300 s cache, defined in CDK.', needs: 'AWS account verification, then cdk deploy -c edge=cloudfront' },

  { status: 'planned', icon: 'sensor', t: 'Roadside LiDAR ingestion', line: 'Edge unit sends 10 Hz object lists to S3 under a pilot/ prefix.', needs: 'Pilot site, power and backhaul, data-sharing agreement' },
  { status: 'planned', icon: 'pedestrian', t: 'Failure-to-yield rate', line: 'Pedestrian detection and driver yielding rate per crosswalk and hour.', needs: 'Labelled pedestrian tracks from the pilot sensor' },
  { status: 'planned', icon: 'trend', t: 'Before/after with CIs', line: 'Treated-vs-control comparison of conflicts and yielding, with n and 95% intervals.', needs: '≥ 3 months before and after per treated site, matched controls' },
  { status: 'planned', icon: 'county', t: 'SPAG 15-county coverage', line: 'Screening and VRU views for every South Plains county, not only Lubbock.', needs: 'CRIS and AADT extracts for the other 14 counties' },
  { status: 'planned', icon: 'offline', t: 'Sensor health telemetry', line: 'Uptime, frame completeness and packet gaps per site, alarmed in CloudWatch.', needs: 'Edge-unit heartbeat as CloudWatch custom metrics' },
];

export default function Roadmap() {
  const count = (s: Status) => ITEMS.filter((i) => i.status === s).length;
  const boardRef = useReveal<HTMLDivElement>();
  return (
    <div className="page roadmap">
      <PageHeader
        icon="flag"
        title="Roadmap"
        lede="What runs today, what is built and waiting on AWS, and what the roadside-LiDAR pilot adds next. Nothing planned is shown as working."
        readouts={[
          { label: 'Done', value: count('done'), tone: 'accent' },
          { label: 'In progress', value: count('progress') },
          { label: 'Prototype', value: count('prototype') },
          { label: 'Planned', value: count('planned') },
        ]}
      />

      <div className="rm-board" ref={boardRef}>
        {STAGES.map((g, gi) => (
          <section key={g.s} className="rm-col" data-s={g.s} aria-labelledby={`rm-${g.s}`} data-r={gi + 1}>
            <header className="rm-stop">
              <span className="rm-node" aria-hidden="true" />
              <div>
                <h2 id={`rm-${g.s}`}>{g.label} <span className="measure">{count(g.s)}</span></h2>
                <p>{g.when}</p>
              </div>
            </header>
            <ul>
              {ITEMS.filter((i) => i.status === g.s).map((i) => (
                <li key={i.t} className="rm-card">
                  <div className="rm-ct">
                    <span className="rm-ico"><Icon name={i.icon} size={20} weight="duotone" /></span>
                    <h3>{i.t}</h3>
                    <span className="status" data-s={g.chip}><Icon name={g.s === 'done' ? 'check' : g.s === 'planned' ? 'dot' : 'clock'} size={12} weight="bold" />{g.label}</span>
                  </div>
                  <p>{i.line}</p>
                  {i.needs && <p className="rm-needs"><Icon name="flag" size={14} /><span><b>Needs</b> {i.needs}</span></p>}
                  {i.to && <Link className="rm-open" to={i.to} aria-label={`Open ${i.t}`} title="Open in the portal"><Icon name="arrow" size={16} /></Link>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
