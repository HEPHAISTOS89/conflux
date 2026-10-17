/**
 * Scene palette for the intersection lab (plan canvas, 3D scene, minimap). Canvas and WebGL cannot read CSS
 * variables, so the values mirror base.css: charcoal ground and sage accent in dark mode; a drafting-sheet
 * look in light mode (pale asphalt, graphite markings). Status colours match the KABCO / severity ramp.
 */
import { useEffect, useState } from 'react';

export interface LabPalette {
  dark: boolean;
  ground: string; grid: string; gridMajor: string;
  asphalt: string; kerb: string; lane: string; edge: string; centre: string; stop: string;
  car: string; truck: string; hot: string; partner: string; sel: string; hov: string;
  trail: string; label: string; labelBg: string; shadow: string; brake: string; lampOff: string; head: string;
  ink: string; ink2: string; ink3: string; critical: string; serious: string; caution: string; accent: string;
}

const DARK: LabPalette = {
  dark: true,
  ground: '#131413', grid: '#1b1c1b', gridMajor: '#232423',
  asphalt: '#222422', kerb: '#30322f', lane: '#8e908a', edge: '#6c6e69', centre: '#a8904c', stop: '#d9dad5',
  car: '#a7b6c0', truck: '#c9b98a', hot: '#f08159', partner: '#e0a83a', sel: '#b4d0a6', hov: '#f1f1ef',
  trail: '#c8c9c4', label: '#f1f1ef', labelBg: '#161716', shadow: '#000000', brake: '#ff4a3d', lampOff: '#5a2420', head: '#f3ead2',
  ink: '#f1f1ef', ink2: '#c8c9c4', ink3: '#9a9b96', critical: '#f08159', serious: '#e9a35f', caution: '#e0a83a', accent: '#8fa68e',
};
const LIGHT: LabPalette = {
  dark: false,
  ground: '#ecece7', grid: '#e2e2dc', gridMajor: '#d8d8d1',
  asphalt: '#d8d8d2', kerb: '#c2c2bb', lane: '#8a8b86', edge: '#6f716b', centre: '#a07c1c', stop: '#2a2b29',
  car: '#41596a', truck: '#86702a', hot: '#cf3f2b', partner: '#a86f00', sel: '#3f6a3e', hov: '#161716',
  trail: '#3d3e3b', label: '#161716', labelBg: '#fbfbf9', shadow: '#2a2b29', brake: '#e0281c', lampOff: '#b9a9a5', head: '#fff8e0',
  ink: '#161716', ink2: '#3d3e3b', ink3: '#5f615b', critical: '#cf3f2b', serious: '#cf7426', caution: '#a86f00', accent: '#4d6a4c',
};

export type ThemeName = 'dark' | 'light';
export function themeName(): ThemeName {
  if (typeof document === 'undefined') return 'dark';
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
export const labPalette = (t: ThemeName = themeName()): LabPalette => (t === 'light' ? LIGHT : DARK);

/** The active theme, updated when the shell switches it (data-theme on <html>) or the OS preference changes. */
export function useThemeName(): ThemeName {
  const [t, setT] = useState<ThemeName>(themeName);
  useEffect(() => {
    const sync = () => setT(themeName());
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', sync);
    return () => { mo.disconnect(); mq.removeEventListener('change', sync); };
  }, []);
  return t;
}
