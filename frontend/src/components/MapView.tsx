import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { LayerSpecification, Map as MLMap, StyleSpecification, MapLayerMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import '../styles/mapview.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

maplibregl.setWorkerUrl(workerUrl);

export const LUBBOCK: [number, number] = [-101.855, 33.578];

const styleCache: Record<string, Promise<StyleSpecification> | undefined> = {};
const KEEP = /^(background|water|park|landuse_residential|building|highway_|road_|tunnel_motorway|railway$|boundary_|label_(city|town|village)|highway-name-major)/;
const PAINT = {
  dark: { bg: '#121312', water: '#1b2226', park: '#161a16', res: '#151615', bld: '#1a1b1a', road: '#2c2d2b', major: '#3a3b39', label: '#8b8d88' },
  light: { bg: '#ecece8', water: '#d3dde2', park: '#e2e6dd', res: '#e8e8e3', bld: '#e0e0da', road: '#ffffff', major: '#ffffff', label: '#5f615b' },
};

function baseStyle(): Promise<StyleSpecification> {
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const c = PAINT[theme];
  styleCache[theme] ??= fetch('https://tiles.openfreemap.org/styles/positron')
    .then((r) => { if (!r.ok) throw new Error(`basemap ${r.status}`); return r.json(); })
    .then((s: StyleSpecification) => {
      const layers = s.layers.filter((l) => KEEP.test(l.id)).map((l) => {
        const L = structuredClone(l) as any;
        L.paint ??= {};
        // Theme restyle of the OpenFreeMap positron layers
        if (l.id === 'background') L.paint['background-color'] = c.bg;
        if (l.id === 'water') L.paint['fill-color'] = c.water;
        if (l.id === 'park') L.paint['fill-color'] = c.park;
        if (l.id === 'landuse_residential') L.paint['fill-color'] = c.res;
        if (l.id === 'building') { L.paint['fill-color'] = c.bld; L.paint['fill-outline-color'] = c.bld; }
        if (l.type === 'line' && (l.id.startsWith('highway') || l.id.startsWith('road_') || l.id.startsWith('tunnel_'))) L.paint['line-color'] = l.id.includes('casing') ? (theme === 'light' ? '#d3d3cd' : c.road) : /motorway|major|trunk|primary/.test(l.id) ? c.major : c.road;
        if (l.type === 'line' && (l.id.startsWith('railway') || l.id.startsWith('boundary_'))) L.paint['line-color'] = theme === 'light' ? '#c9c9c3' : c.major;
        if (l.type === 'symbol') { L.paint['text-color'] = c.label; L.paint['text-halo-color'] = c.bg; }
        return L as LayerSpecification;
      });
      return { ...s, layers };
    })
    .catch((e) => { styleCache[theme] = undefined; throw e; });
  return styleCache[theme]!;
}

export interface MapLayer {
  id: string;
  data: { type: 'FeatureCollection'; features: any[] };
  layers: Omit<LayerSpecification, 'source'>[];
}

export interface MapViewProps {
  sources: MapLayer[];
  center?: [number, number];
  zoom?: number;
  bounds?: [[number, number], [number, number]];
  onClick?: (layerId: string, feature: maplibregl.MapGeoJSONFeature) => void;
  onHover?: (feature: maplibregl.MapGeoJSONFeature | null) => void;
  interactiveLayers?: string[];
  highlight?: { source: string; key: string; value: string | null };
  label: string;
  className?: string;
}

export default function MapView({ sources, center = LUBBOCK, zoom = 10.3, bounds, onClick, onHover, interactiveLayers = [], highlight, label, className }: MapViewProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const [failed, setFailed] = useState(false);
  const cb = useRef({ onClick, onHover });
  const latest = useRef({ sources, bounds, highlight });
  latest.current = { sources, bounds, highlight };
  cb.current = { onClick, onHover };

  useEffect(() => {
    let disposed = false;
    baseStyle().then((style) => {
      if (disposed || !el.current) return;
      const m = new maplibregl.Map({ container: el.current, style, center, zoom, attributionControl: { compact: true }, cooperativeGestures: true, maxPitch: 0, canvasContextAttributes: { preserveDrawingBuffer: true } }); // keeps the basemap in PNG exports
      m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      map.current = m;
      m.on('load', () => {
        ready.current = true;
        sync(m, latest.current.sources);
        const h = latest.current.highlight;
        if (h && m.getLayer(`${h.source}-hl`)) m.setFilter(`${h.source}-hl`, ['==', ['to-string', ['get', h.key]], h.value ?? '__none__']);
        if (latest.current.bounds) m.fitBounds(latest.current.bounds, { padding: 32, duration: 0 });
        for (const id of interactiveLayers) {
          m.on('click', id, (e: MapLayerMouseEvent) => e.features?.[0] && cb.current.onClick?.(id, e.features[0]));
          m.on('mousemove', id, (e: MapLayerMouseEvent) => { m.getCanvas().style.cursor = 'pointer'; e.features?.[0] && cb.current.onHover?.(e.features[0]); });
          m.on('mouseleave', id, () => { m.getCanvas().style.cursor = ''; cb.current.onHover?.(null); });
        }
      });
    }).catch(() => !disposed && setFailed(true));
    return () => { disposed = true; map.current?.remove(); map.current = null; ready.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (map.current && ready.current) sync(map.current, sources); }, [sources]);

  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current || !highlight) return;
    const hl = `${highlight.source}-hl`;
    if (m.getLayer(hl)) m.setFilter(hl, ['==', ['to-string', ['get', highlight.key]], highlight.value ?? '__none__']);
  }, [highlight]);

  useEffect(() => {
    const m = map.current;
    if (m && ready.current && bounds) m.fitBounds(bounds, { padding: 48, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1200, essential: false });
  }, [bounds?.flat().join(',')]);

  return <div ref={el} className={`mapview ${className ?? ''}`} role="region" aria-label={label}>
    {failed && <div className="error-box" style={{ position: 'absolute', top: 12, left: 12, right: 12 }}>Map could not load. Reload to retry.</div>}
  </div>;
}

function sync(m: MLMap, sources: MapLayer[]) {
  for (const s of sources) {
    const src = m.getSource(s.id) as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(s.data);
    else m.addSource(s.id, { type: 'geojson', data: s.data });
    for (const l of s.layers) {
      if (!m.getLayer(l.id)) m.addLayer({ ...l, source: s.id } as LayerSpecification);
      else {
        const paint = (l as any).paint ?? {};
        for (const k of Object.keys(paint)) m.setPaintProperty(l.id, k as any, paint[k]);
        if ((l as any).filter) m.setFilter(l.id, (l as any).filter);
      }
    }
  }
}
