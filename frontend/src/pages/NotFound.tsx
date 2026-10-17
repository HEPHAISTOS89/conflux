import { Link, useLocation } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import { Icon, type IconName } from '../components/Icon';
import '../styles/methods.css'; // hosts the .nf-* rules

const LINKS: [string, string, string, IconName][] = [
  ['/', 'County atlas', 'Lubbock County network, crashes and AADT', 'atlas'],
  ['/screening', 'Network screening', 'HSM crash rate, critical rate and EB ranks', 'rank'],
  ['/vru', 'Pedestrians and cyclists', 'CRIS VRU crashes by severity, light and speed', 'ped'],
  ['/intersections', 'Intersection lab', 'Trajectories, TTC / PET conflicts, repair', 'lidar'],
  ['/methods', 'Methods and data', 'Formulas, thresholds, sources and licences', 'methods'],
  ['/ask', 'Ask the data', 'Questions answered through named tools', 'ask'],
];

export default function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="page">
      <PageHeader icon="help" title="No sheet at this address" lede={<>Nothing is published at <code className="measure">{pathname}</code>. These are the sheets that are.</>} />
      <ul className="nf-links">
        {LINKS.map(([to, t, d, ic]) => (
          <li key={to}>
            <Link to={to} className="nf-link">
              <Icon name={ic} size={18} weight="duotone" />
              <span><b>{t}</b><small>{d}</small></span>
              <Icon name="arrow" size={16} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
