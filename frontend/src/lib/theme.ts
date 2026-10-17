import { useEffect, useState } from 'react';
import { CHART, EB_STOPS, SEV_HEX } from './format';

export type Theme = 'dark' | 'light';

const DARK = { chart: { ...CHART }, sev: { ...SEV_HEX }, eb: EB_STOPS.map((s) => [...s] as [number, string]) };
const LIGHT = {
  chart: {
    graticule: '#e3e3de', rule: '#d3d3cd', axis: '#5f615b', ink: '#1d1e1c', ink2: '#3d3e3b',
    nb: '#1d1e1c', sb: '#2f6f99', eb: '#8a6d12', wb: '#2f7a45', accent: '#4d6a4c', caution: '#b07800',
    critical: '#cf3f2b', serious: '#cf7426', moderate: '#a8871f', ground: '#fbfbf9', areaFill: '#cfcfc8',
    truckFill: '#c9b98a', midday: '#5f7f2a', pm: '#a8466a',
  },
  sev: { K: '#a81d16', A: '#cf3f2b', B: '#cf7426', C: '#a8871f', O: '#8a8d88' },
  eb: [[-0.3, '#d6d6d0'], [0, '#c4c4bd'], [0.1, '#c9a227'], [0.4, '#cf7426'], [0.8, '#cf3f2b'], [1.5, '#8f1610']] as [number, string][],
};

function systemTheme(): Theme {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function storedTheme(): Theme | null {
  try { const v = localStorage.getItem('rs-theme'); return v === 'light' || v === 'dark' ? v : null; } catch { return null; }
}

/** Canvas and map paint cannot read CSS variables, so the shared palettes are swapped in place. */
export function applyTheme(t: Theme) {
  const p = t === 'light' ? LIGHT : DARK;
  Object.assign(CHART as Record<string, string>, p.chart);
  Object.assign(SEV_HEX, p.sev);
  EB_STOPS.splice(0, EB_STOPS.length, ...p.eb.map((s) => [...s] as [number, string]));
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#f2f2ef' : '#161716');
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? systemTheme());
  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => {
    if (storedTheme()) return;
    const mq = matchMedia('(prefers-color-scheme: light)');
    const on = () => setTheme(mq.matches ? 'light' : 'dark');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const toggle = () => setTheme((t) => {
    const n: Theme = t === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('rs-theme', n); } catch { /* private mode: theme still switches for this visit */ }
    return n;
  });
  return [theme, toggle];
}

// Apply before first paint of React content so canvases draw with the right palette.
applyTheme(storedTheme() ?? systemTheme());
