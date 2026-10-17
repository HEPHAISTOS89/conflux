import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useApi } from '../lib/api';
import type { Manifest } from '../lib/types';
import { Icon, type IconName } from './Icon';

const NAV: { to: string; label: string; hint: string; icon: IconName }[] = [
  { to: '/', label: 'Atlas', hint: 'County overview', icon: 'atlas' },
  { to: '/screening', label: 'Network screening', hint: 'HSM Part B', icon: 'rank' },
  { to: '/corridors', label: 'Corridors', hint: 'Straight-line diagrams', icon: 'corridor' },
  { to: '/vru', label: 'Pedestrians & cyclists', hint: 'VRU crashes', icon: 'ped' },
  { to: '/intersections', label: 'Intersection lab', hint: 'Conflicts · repair', icon: 'lidar' },
  { to: '/brief', label: 'District brief', hint: 'One-page summary', icon: 'sheet' },
  { to: '/methods', label: 'Methods & data', hint: 'Equations · provenance', icon: 'methods' },
  { to: '/platform', label: 'Platform', hint: 'AWS pipeline', icon: 'platform' },
  { to: '/ask', label: 'Ask the data', hint: 'Bedrock analyst', icon: 'ask' },
];

export default function Shell() {
  const meta = useApi<Manifest>('/meta');
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => { setOpen(false); window.scrollTo(0, 0); }, [loc.pathname]);

  const asOf = meta.data?.generated_at ? new Date(meta.data.generated_at) : null;

  return (
    <div className="shell" data-open={open}>
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <NavLink to="/" className="brand" aria-label="RoadScope home">
          <Mark /> <span>RoadScope</span>
        </NavLink>
        <button className="menu-btn" aria-expanded={open} aria-controls="rail" onClick={() => setOpen((o) => !o)}>
          <Icon name={open ? 'close' : 'menu'} /> <span className="sr-only">Menu</span>
        </button>
      </header>

      <nav id="rail" className="rail" aria-label="Sheets">
        <NavLink to="/" className="brand rail-brand" aria-label="RoadScope home">
          <Mark /> <span>RoadScope</span>
        </NavLink>
        <ul>
          {NAV.map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} end={n.to === '/'} className="rail-link">
                <Icon name={n.icon} />
                <span className="rail-text">
                  <span>{n.label}</span>
                </span>
              </NavLink>
            </li>
          ))}
        </ul>
        <dl className="titleblock">
          <div><dt>District</dt><dd>TxDOT Lubbock</dd></div>
          <div><dt>County</dt><dd className="num">152 · Lubbock</dd></div>
          <div>
            <dt>Data build</dt>
            <dd className="num">
              {meta.loading ? '…' : asOf ? asOf.toISOString().slice(0, 10) : <span className="status-bad">offline</span>}
            </dd>
          </div>
          <div><dt>Sources</dt><dd>TxDOT · NHTSA FARS · FHWA NGSIM</dd></div>
        </dl>
      </nav>

      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
        <footer className="colophon">
          <p>
            Roadway, traffic and crash layers © Texas Department of Transportation, used for informational purposes; not an official TxDOT product.
            FARS: NHTSA, public domain. NGSIM: FHWA, CC BY-SA 3.0. Built as part of an application to the TransTech Lab Graduate Assistant position.
          </p>
          <p><a href="https://github.com/HEPHAISTOS89/roadscope-ai">Source on GitHub</a></p>
        </footer>
      </main>
    </div>
  );
}

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="currentColor" />
      <path d="M6 26 L14 6 M12 26 L20 6 M18 26 L26 6" stroke="var(--paper)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="17.2" cy="13" r="2.6" fill="var(--accent)" />
    </svg>
  );
}
