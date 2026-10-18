import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useApi } from '../lib/api';
import type { Manifest } from '../lib/types';
import { Icon, type IconName } from './Icon';
import { useTheme } from '../lib/theme';
import { reducedMotion } from '../lib/motion';
import CommandPalette from './CommandPalette';
import Select from './Select';
import { REGION_COUNT, REGION_NAME, regionLabel, useCounties, useCounty, withCounty } from '../lib/region';

const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: '/', label: 'Atlas', icon: 'atlas' },
  { to: '/screening', label: 'Network screening', icon: 'rank' },
  { to: '/corridors', label: 'Corridors', icon: 'corridor' },
  { to: '/vru', label: 'Pedestrians & cyclists', icon: 'ped' },
  { to: '/intersections', label: 'Intersection lab', icon: 'lidar' },
  { to: '/brief', label: 'District brief', icon: 'sheet' },
  { to: '/methods', label: 'Methods & data', icon: 'methods' },
  { to: '/platform', label: 'Platform', icon: 'platform' },
  { to: '/ask', label: 'Ask the data', icon: 'ask' },
];

const RAIL_KEY = 'rs-rail';
const readRail = () => { try { return localStorage.getItem(RAIL_KEY) === 'collapsed'; } catch { return false; } };
const writeRail = (c: boolean) => { try { localStorage.setItem(RAIL_KEY, c ? 'collapsed' : 'expanded'); } catch { /* storage blocked: state lives for this visit only */ } };
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName));

export default function Shell() {
  const meta = useApi<Manifest>('/meta');
  const [county, setCounty] = useCounty();
  const counties = useCounties();
  // A slug that names no SPAG county (an old or mistyped link) falls back to the whole region once the list is known.
  useEffect(() => { if (county && counties.list && !counties.list.some((c) => c.id === county)) setCounty(null); }, [county, counties.list, setCounty]);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readRail);
  // Peek: hovering the expand button opens the collapsed rail over the page; a click pins it open.
  const [peek, setPeek] = useState(false);
  const peekOff = useRef(0);
  const startPeek = (e: React.PointerEvent) => { if (e.pointerType !== 'mouse' || !collapsed || window.innerWidth <= 1100) return; window.clearTimeout(peekOff.current); setPeek(true); };
  const endPeek = () => { window.clearTimeout(peekOff.current); peekOff.current = window.setTimeout(() => setPeek(false), 220); };
  const [about, setAbout] = useState(false);
  const [tip, setTip] = useState<{ text: string; kbd?: string; y: number } | null>(null);
  const [theme, toggleTheme] = useTheme();
  const loc = useLocation();
  const menuBtn = useRef<HTMLButtonElement>(null);
  const rail = useRef<HTMLElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const ind = useRef<HTMLLIElement>(null);
  const outlet = useRef<HTMLDivElement>(null);
  const aboutBtn = useRef<HTMLButtonElement>(null);
  const aboutPop = useRef<HTMLDivElement>(null);

  const toggleRail = useCallback(() => { setPeek(false); setCollapsed((c) => { writeRail(!c); return !c; }); }, []);

  // "[" collapses or expands the rail. Pages that bind "[" themselves (the intersection lab steps risk events)
  // call preventDefault; the check runs after dispatch so listener order does not matter.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || window.innerWidth <= 1100) return;
      setTimeout(() => { if (!e.defaultPrevented) toggleRail(); }, 0);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [toggleRail]);

  // Maps and canvases size themselves from resize events; tell them once the rail has finished moving.
  const first = useRef(true);
  useEffect(() => {
    setTip(null);
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => window.dispatchEvent(new Event('resize')), reducedMotion() ? 0 : 260);
    return () => clearTimeout(t);
  }, [collapsed, peek]);

  // Sliding active indicator: one fill that travels between items instead of each item lighting up.
  const place = useCallback(() => {
    const ul = list.current, el = ind.current;
    if (!ul || !el) return;
    const a = ul.querySelector<HTMLElement>('.rail-link.active');
    if (!a) { el.style.opacity = '0'; return; }
    el.style.opacity = '1';
    el.style.transform = `translateY(${a.offsetTop}px)`;
    el.style.height = `${a.offsetHeight}px`;
  }, []);
  useLayoutEffect(() => { place(); }, [loc.pathname, collapsed, peek, place]);
  useEffect(() => {
    const ul = list.current;
    if (!ul) return;
    const ro = new ResizeObserver(place);
    ro.observe(ul);
    rail.current?.setAttribute('data-ind', '');
    // enable the slide only after the first placement, so the indicator does not fly in from the top on load
    requestAnimationFrame(() => ind.current?.setAttribute('data-ready', ''));
    return () => ro.disconnect();
  }, [place]);

  // Route change: close the drawer, return to the top, fade the new sheet in (not on query-only changes).
  const section = loc.pathname.split('/')[1] ?? '';
  useEffect(() => {
    setOpen(false); setAbout(false); window.scrollTo(0, 0);
    if (!reducedMotion()) outlet.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
  }, [section]);
  useEffect(() => { setOpen(false); }, [loc.pathname]);

  // Disclosure (≤ 1100 px): Esc closes and returns focus, the page behind does not scroll, focus moves into the menu.
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); menuBtn.current?.focus(); } };
    const wide = () => { if (window.innerWidth > 1100) setOpen(false); };
    document.addEventListener('keydown', esc);
    window.addEventListener('resize', wide);
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    requestAnimationFrame(() => (rail.current?.querySelector<HTMLElement>('.rail-link.active') ?? rail.current?.querySelector<HTMLElement>('.rail-link'))?.focus());
    return () => { document.removeEventListener('keydown', esc); window.removeEventListener('resize', wide); document.documentElement.style.overflow = prev; };
  }, [open]);

  // "About data" panel: outside click or Esc closes it.
  useEffect(() => {
    if (!about) return;
    const away = (e: PointerEvent) => { if (!aboutPop.current?.contains(e.target as Node) && !aboutBtn.current?.contains(e.target as Node)) setAbout(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setAbout(false); aboutBtn.current?.focus(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [about]);

  // Labels for the icon rail: one floating tip, shown on hover or keyboard focus while collapsed.
  const showTip = (e: React.SyntheticEvent) => {
    if (!collapsed || peek || window.innerWidth <= 1100) return;
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
    if (!t) { setTip(null); return; }
    const r = t.getBoundingClientRect();
    setTip({ text: t.dataset.tip!, kbd: t.dataset.kbd, y: r.top + r.height / 2 });
  };

  const asOf = meta.data?.generated_at ? new Date(meta.data.generated_at) : null;
  const scope = regionLabel(county, counties.list);
  const regionSelect = (
    <Select<string> label="Region" icon="county" value={county ?? 'all'} compact portal onChange={(v) => setCounty(v === 'all' ? null : v)}
      options={[
        { value: 'all', label: REGION_NAME, hint: `${REGION_COUNT} counties` },
        ...(counties.list ?? []).map((c) => ({ value: c.id, label: `${c.name} County`, hint: `${c.segments_screened.toLocaleString('en-US')} seg · ${c.vru_crashes} VRU` })),
      ]} />
  );
  const themeLabel = `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`;
  const railLabel = collapsed ? (peek ? 'Keep sidebar open' : 'Expand sidebar') : 'Collapse sidebar';

  return (
    <div className="shell" data-open={open} data-rail={collapsed && !peek ? 'collapsed' : 'expanded'} data-peek={(collapsed && peek) || undefined}>
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <NavLink to={withCounty('/', county)} className="brand" aria-label="Conflux home">
          <Mark /> <span>Conflux</span>
        </NavLink>
        <div className="topbar-act">
          <div className="topbar-region">{regionSelect}</div>
          <button type="button" className="icon-btn" aria-label="Jump to a sheet, corridor, segment or intersection" title="Jump to (⌘K)"
            onClick={() => window.dispatchEvent(new Event('rs:palette'))}>
            <Icon name="search" size={16} />
          </button>
          <button type="button" className="theme-btn" onClick={toggleTheme} aria-label={themeLabel} title={themeLabel}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
          </button>
          <button ref={menuBtn} type="button" className="menu-btn" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} aria-controls="rail" onClick={() => setOpen((o) => !o)}>
            <Icon name={open ? 'close' : 'menu'} size={16} /><span className="menu-btn-label">{open ? 'Close' : 'Menu'}</span>
          </button>
        </div>
      </header>

      <nav id="rail" ref={rail} className="rail" aria-label="Main navigation"
        onPointerOver={showTip} onPointerEnter={() => window.clearTimeout(peekOff.current)} onPointerLeave={() => { setTip(null); if (peek) endPeek(); }} onFocus={showTip} onBlur={() => setTip(null)}>
        <div className="rail-in">
          <div className="rail-head">
            <NavLink to={withCounty('/', county)} className="brand rail-brand" aria-label="Conflux home" tabIndex={collapsed && !peek ? -1 : undefined}>
              <Mark /> <span>Conflux</span>
            </NavLink>
            <button type="button" className="rail-toggle" onClick={toggleRail} onPointerEnter={startPeek} aria-label={railLabel} aria-expanded={!collapsed} aria-controls="rail-list"
              aria-keyshortcuts="[">
              <Icon name="sidebar" size={16} />
            </button>
          </div>

          {/* Region: the one filter every sheet shares. Collapsed rail: the county icon expands the rail to reach it. */}
          <div className="rail-region" data-scope={county ? 'county' : 'region'}>
            {collapsed && !peek
              ? <button type="button" className="rail-link rail-tool" data-tip={`Region: ${scope}`} onClick={toggleRail} aria-label={`Region: ${scope}. Expand the sidebar to change it`}><Icon name="county" size={16} /><span className="rail-text">{scope}</span></button>
              : regionSelect}
          </div>

          <ul id="rail-list" ref={list}>
            <li ref={ind} className="rail-ind" aria-hidden="true" />
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink to={withCounty(n.to, county)} end={n.to === '/'} className="rail-link" data-tip={n.label}>
                  <Icon name={n.icon} size={16} />
                  <span className="rail-text">{n.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>

          <div className="rail-tools">
            <button type="button" className="rail-link rail-tool" data-tip="Jump to" data-kbd="⌘K" onClick={() => window.dispatchEvent(new Event('rs:palette'))}>
              <Icon name="search" size={16} /><span className="rail-text">Jump to</span><kbd>⌘K</kbd>
            </button>
            <button type="button" className="rail-link rail-tool rail-theme" data-tip={themeLabel} onClick={toggleTheme} aria-label={themeLabel}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} /><span className="rail-text">{theme === 'dark' ? 'Light' : 'Dark'} mode</span>
            </button>
            <button ref={aboutBtn} type="button" className="rail-link rail-tool" data-tip="About the data" aria-expanded={about} aria-controls="rail-about" onClick={() => setAbout((a) => !a)}>
              <Icon name="db" size={16} /><span className="rail-text">About the data</span>
            </button>
          </div>
        </div>
      </nav>

      {about && (
        <div ref={aboutPop} id="rail-about" role="dialog" aria-label="About the data" className="mi-pop rail-about">
          <span className="mi-head"><b>About the data</b></span>
          <span className="mi-row"><span>Region</span><span>South Plains (SPAG), {REGION_COUNT} counties</span></span>
          <span className="mi-row"><span>Districts</span><span>TxDOT Lubbock (05), Childress (25)</span></span>
          <span className="mi-row"><span>Showing</span><span>{scope}</span></span>
          <span className="mi-row"><span>Data build</span><span className="num">{meta.loading ? '…' : asOf ? asOf.toISOString().slice(0, 10) : <span className="status-bad">offline</span>}</span></span>
          <span className="mi-row"><span>Sources</span><span>TxDOT CRIS, Roadway Inventory, AADT · NHTSA FARS · FHWA NGSIM</span></span>
          <span className="mi-note">TxDOT data for informational use; not an official TxDOT product. FARS public domain. NGSIM CC BY-SA 3.0.</span>
        </div>
      )}
      {tip && <div className="rail-tip" aria-hidden="true" style={{ top: tip.y }}>{tip.text}{tip.kbd && <kbd>{tip.kbd}</kbd>}</div>}

      <main id="main" className="main" tabIndex={-1}>
        <div key={theme} ref={outlet} className="outlet"><Outlet /></div>
        <CommandPalette />
        <footer className="colophon">
          <p>
            Roadway, traffic and crash data © TxDOT, informational use; not an official TxDOT product.
            FARS: NHTSA, public domain. NGSIM: FHWA, CC BY-SA 3.0.
          </p>
          <p><a href="https://github.com/HEPHAISTOS89/conflux">Source on GitHub</a></p>
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
