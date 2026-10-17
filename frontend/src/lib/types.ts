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

export interface VruSummary {
  total: number; years: number[]; by_severity: Record<string, number>; by_mode: Record<string, number>;
  by_year: Record<string, number>; by_light: Record<string, number>; by_pbcat: Record<string, number>;
  top_streets: Record<string, number>; ka_total: number; hour_dow: number[][];
}
export interface AskToolCall { name: string; input: Record<string, unknown>; ok: boolean; output?: unknown }
export interface AskResponse { answer: string; citations: string[]; tool_calls: AskToolCall[]; model: string; fallback: boolean }
export interface PlatformRun { key: string; size: number; last_modified: string; detail: Record<string, any> | null }
export interface LambdaMetric { total?: number; max_daily?: number; daily: { t: string; v: number }[] }
export interface PlatformStatus {
  on_aws: boolean; data_source: string; manifest: Manifest | null; runs: PlatformRun[];
  metrics: { window_days: number; start: string; end: string; functions: Record<string, { name: string } & Record<string, any>> } | null;
  errors: string[];
}
export interface RepairMethodStats { gaps: number; gap_frames: number; rmse_m: number; speed_rmse: number }
export interface RepairSummary {
  tracks_occluded: number; tracks_eligible: number; seed: number; gap_s: [number, number]; gaps: number; gap_frames: number;
  context_s: number; selected_method: string; truth: string;
  validation?: { tracks: number; gap_frames: number; rmse_m: Record<string, number>; speed_rmse: Record<string, number>; selected: string };
  methods: Record<string, RepairMethodStats>;
  by_gap?: ({ gap_s: [number, number] } & Record<string, any>)[];
  better_than_linear_share?: Record<string, number>;
}
