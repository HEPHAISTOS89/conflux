/**
 * Art direction of the landing world. Night for the dark theme (charcoal ground, sage-grey massing, warm lamps);
 * dusk on paper for the light theme (pale massing, graphite road, lamps just lit). Values mirror base.css tokens
 * where a token exists; light colours are physical-ish (sodium/LED warm white, signal red/amber/green).
 */
import type { ThemeName } from '../../lib/lab/palette';

export interface WorldLook {
  dark: boolean;
  zenith: string; horizon: string; fogNear: number; fogFar: number;
  ground: string; lot: string; asphalt: string; kerb: string;
  lane: string; edge: string; centre: string; stop: string;
  building: string; roof: string; window: string; windowAmt: number;
  hemiSky: string; hemiGround: string; hemi: number; moon: string; moonI: number;
  bodies: string[]; glass: string;
  head: string; tail: string; brake: string; tailOff: string;
  beam: number; pool: number; lamp: string; lampGlow: number;
  sigRed: string; sigAmber: string; sigGreen: string; sigOff: string; housing: string; pole: string;
  conflict: string; critical: string;
  glowAdd: boolean; exposure: number; shadow: string; shadowA: number;
}

const DARK: WorldLook = {
  dark: true,
  zenith: '#070807', horizon: '#1b1e1c', fogNear: 120, fogFar: 420,
  ground: '#0e100f', lot: '#141615', asphalt: '#1c1e1d', kerb: '#2c2f2d',
  lane: '#6f726c', edge: '#4f524d', centre: '#8a7440', stop: '#b9bab4',
  building: '#363b38', roof: '#2a2e2c', window: '#ffc77d', windowAmt: 1,
  hemiSky: '#9aa7a1', hemiGround: '#161816', hemi: 1.15, moon: '#c3cfdc', moonI: 0.95,
  bodies: ['#5a5f63', '#767b7e', '#a3a6a8', '#cfd1d0', '#3f5468', '#61735f', '#7a3f3a', '#3a3e42'],
  glass: '#101315',
  head: '#fff1d2', tail: '#ff3b2c', brake: '#ff2412', tailOff: '#5a1712',
  beam: 0.32, pool: 0.2, lamp: '#ffd49a', lampGlow: 1,
  sigRed: '#ff3a26', sigAmber: '#ffb21e', sigGreen: '#2ee6a0', sigOff: '#1b1d1c', housing: '#121413', pole: '#3a3d3b',
  conflict: '#e0a83a', critical: '#f08159',
  glowAdd: true, exposure: 1.1, shadow: '#000000', shadowA: 0.55,
};

const LIGHT: WorldLook = {
  dark: false,
  zenith: '#d9dbd5', horizon: '#efebe2', fogNear: 140, fogFar: 460,
  ground: '#ecebe5', lot: '#e9e8e1', asphalt: '#b7b7af', kerb: '#9e9e96',
  lane: '#f4f4ef', edge: '#ecece6', centre: '#b08a2a', stop: '#fbfbf8',
  building: '#f2f1ec', roof: '#e8e7e0', window: '#ffcf86', windowAmt: 0.22,
  hemiSky: '#ffffff', hemiGround: '#b9b7ad', hemi: 1.45, moon: '#fff1de', moonI: 1.25,
  bodies: ['#43484c', '#6b7074', '#9a9d9f', '#d9dad7', '#3d556b', '#5d6f5c', '#7a3b35', '#2a2d30'],
  glass: '#2a3238',
  head: '#fff6dc', tail: '#e0281c', brake: '#ff1f0f', tailOff: '#8f3a33',
  beam: 0, pool: 0, lamp: '#ffcf8a', lampGlow: 0.55,
  sigRed: '#e5261a', sigAmber: '#e89a00', sigGreen: '#0fa36a', sigOff: '#3a3c3a', housing: '#4a4c49', pole: '#7d807a',
  conflict: '#b77800', critical: '#cf3f2b',
  glowAdd: false, exposure: 1.3, shadow: '#3a3a35', shadowA: 0.28,
};

export const worldLook = (t: ThemeName): WorldLook => (t === 'light' ? LIGHT : DARK);
