import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from './api';
import type { FC } from './types';

/**
 * Study region: the fifteen counties of the South Plains Association of Governments (SPAG).
 * The selected county lives in the URL (`?county=<slug>`) so every sheet, link and copied URL carries it;
 * no county means the whole region.
 */
export const COUNTY_KEY = 'county';
export const REGION_NAME = 'South Plains region';
export const REGION_COUNT = 15;
export const REGION_SHORT = `SPAG · ${REGION_COUNT} counties`;

export interface CountyProps {
  id: string; name: string; county_nbr: number; fips: string; district: number; bbox: [number, number, number, number];
  segments: number; segments_screened: number; segments_flagged: number; segment_crashes: number; segment_crashes_ka: number; segment_miles: number;
  vru_crashes: number; vru_ka: number; vru_on_system: number; vru_on_system_ka: number; vru_by_mode: Record<string, number>; fatal_crashes: number | null;
}

/** A county slug from a query string: lower-case letters and hyphens only; anything else (or "all") is the region. */
export function parseCounty(search: string | URLSearchParams | null | undefined): string | null {
  const p = typeof search === 'string' ? new URLSearchParams(search) : search;
  const v = p?.get(COUNTY_KEY)?.trim().toLowerCase() ?? '';
  return /^[a-z][a-z-]{1,30}$/.test(v) && v !== 'all' ? v : null;
}

/** Query fragment for an API call: `&county=hale` (or `?county=hale` when it is the first parameter); empty for the region. */
export function countyQuery(county: string | null, first = false): string {
  return county ? `${first ? '?' : '&'}${COUNTY_KEY}=${encodeURIComponent(county)}` : '';
}

/** A route path carrying the current county, keeping any query it already has. */
export function withCounty(path: string, county: string | null): string {
  const [base, q = ''] = path.split('?');
  const p = new URLSearchParams(q);
  if (county) p.set(COUNTY_KEY, county); else p.delete(COUNTY_KEY);
  const s = p.toString();
  return s ? `${base}?${s}` : base;
}

/** "Hale County" for a county, "South Plains region" for the whole SPAG region. */
export function regionLabel(county: string | null, counties?: CountyProps[] | null, long = false): string {
  if (!county) return long ? `${REGION_NAME} (${REGION_COUNT} counties)` : REGION_NAME;
  const c = counties?.find((x) => x.id === county);
  return `${c?.name ?? county.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())} County`;
}

/** Union of county extents as MapLibre bounds; one county's bbox when selected. */
export function regionBounds(county: string | null, counties?: CountyProps[] | null): [[number, number], [number, number]] | undefined {
  const list = counties?.filter((c) => !county || c.id === county) ?? [];
  if (!list.length) return undefined;
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const x of list) { a = Math.min(a, x.bbox[0]); b = Math.min(b, x.bbox[1]); c = Math.max(c, x.bbox[2]); d = Math.max(d, x.bbox[3]); }
  return [[a, b], [c, d]];
}

/** The selected county (URL state) and a setter that rewrites only that parameter. */
export function useCounty(): [string | null, (c: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const county = parseCounty(params);
  const set = useCallback((c: string | null) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    if (c) p.set(COUNTY_KEY, c); else p.delete(COUNTY_KEY);
    // a county change invalidates a selected segment or crash, which may lie outside the new scope
    p.delete('seg'); p.delete('crash');
    return p;
  }), [setParams]);
  return [county, set];
}

/** County polygons and roll-ups from /counties (one fetch, cached by the API client). */
export function useCounties() {
  const res = useApi<FC<CountyProps>>('/counties');
  const list = useMemo(() => res.data?.features.map((f) => f.properties) ?? null, [res.data]);
  return { ...res, list };
}
