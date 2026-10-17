import { Link, useLocation } from 'react-router-dom';

export default function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="page">
      <header className="page-head">
        <h1>No sheet at this address</h1>
        <p>
          Nothing is published at <code className="num">{pathname}</code>. The link may be out of date, or the
          intersection or corridor id may be misspelled.
        </p>
      </header>
      <ul style={{ margin: 0, paddingLeft: '1.2em', display: 'grid', gap: 8 }}>
        <li><Link to="/">County atlas</Link></li>
        <li><Link to="/screening">Network screening</Link></li>
        <li><Link to="/vru">Pedestrians and cyclists</Link></li>
        <li><Link to="/methods">Methods</Link></li>
      </ul>
    </div>
  );
}
