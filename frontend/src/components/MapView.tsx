import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { LayerSpecification, Map as MLMap, StyleSpecification, MapLayerMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

maplibregl.setWorkerUrl(workerUrl);

export const LUBBOCK: [number, number] = [-101.855, 33.578];

let styleCache: Promise<StyleSpecification> | null = null;
const KEEP = /^(background|water|park|landuse_residential|building|highway_|road_|tunnel_motorway|railway$|boundary_|label_(city|town|village)|highway-name-major)/;

function baseStyle(): Promise<StyleSpecification> {
  styleCache ??= fetch('https://tiles.openfreemap.org/styles/positron')
    .then((r) => { if (!r.ok) throw new Error(`basemap ${r.status}`); return r.json(); })
    .then((s: StyleSpecification) => {
      const layers = s.layers.filter((l) => KEEP.test(l.id)).map((l) => {
        const L = structuredClone(l) as any;
        L.paint ??= {};
        if (l.id === 'background') L.paint['background-color'] = '#eef0ec';
        if (l.id === 'water') L.paint['fill-color'] = '#d9e1e4';
        if (l.id === 'park') L.paint['fill-color'] = '#e3e8df';
        if (l.id === 'building') L.paint['fill-color'] = '#e4e6e1';
        if (l.type === 'line' && l.id.startsWith('highway')) L.paint['line-color'] = l.id.includes('casing') ? '#d3d7d0' : '#fbfbf9';
        if (l.type === 'symbol') { L.paint['text-color'] = '#5a636b'; L.paint['text-halo-color'] = '#eef0ec'; }
        return L as LayerSpecification;
      });
      return { ...s, layers };
    })
    .catch((e) => { styleCache = null; throw e; });
  return styleCache;
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
  const latest = useRef({ sources, bounds });
  latest.current = { sources, bounds };
  cb.current = { onClick, onHover };

  useEffect(() => {
    let disposed = false;
    baseStyle().then((style) => {
      if (disposed || !el.current) return;
      const m = new maplibregl.Map({ container: el.current, style, center, zoom, attributionControl: { compact: true }, cooperativeGestures: true, maxPitch: 0 });
      m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      map.current = m;
      m.on('load', () => {
        ready.current = true;
        sync(m, latest.current.sources);
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
