export type Severity = 'K' | 'A' | 'B' | 'C' | 'O';

export interface Manifest {
  generated_at: string;
  sources: { id: string; url: string; licence: string; records: number; fetched_at: string; sha256?: string }[];
  metrics?: Record<string, unknown>;
}

export interface SegmentProps {
  seg_id: string; route: string; name: string; f_system: string | number; lanes: number | null;
  speed_limit: number | null; aadt: number | null; truck_pct: number | null; len_mi: number;
  crashes_total: number; crash_years: number; rate_100mvmt: number | null; crit_rate: number | null;
  crit_ratio: number | null; epdo: number | null; spf_pred: number | null; eb_expected: number | null;
  eb_excess: number | null; rank: number | null;
}
export interface Feature<P, G = { type: string; coordinates: any }> { type: 'Feature'; properties: P; geometry: G }
export interface FC<P> { type: 'FeatureCollection'; features: Feature<P>[] }

export interface Station {
  dfo: number; lanes: number | null; speed_limit: number | null; aadt: number | null; truck_pct: number | null;
  speed_all: number | null; speed_am: number | null; speed_md: number | null; speed_pm: number | null; crashes_per_mi: number | null;
}
export interface Corridor { id: string; name: string; routes: string[]; len_mi: number; stations: Station[]; summary: Record<string, any> }

export interface VruProps {
  id: string; date: string; hour: number | null; dow: number | null; year: number; severity: Severity;
  mode: 'ped' | 'bike'; pbcat: string | null; light: string | null; speed_limit: number | null; street: string | null; on_system: boolean | null;
}
export interface Spf { form: string; b0: number; b1: number; k: number; n: number; aic: number; by_class?: Record<string, any> }

export interface Track { id: string; cls: string; len_m: number; w_m: number; pts: [number, number, number, number, number, number][] }
export interface IntersectionData { id: string; name: string; source: string; hz: number; bbox: [number, number, number, number]; lanes_geom: any; tracks: Track[] }
export interface Conflict { id: string; t: number; a: string; b: string; type: 'rear_end' | 'crossing' | 'lane_change'; ttc_min: number | null; pet: number | null; drac_max: number | null; severity: string }
