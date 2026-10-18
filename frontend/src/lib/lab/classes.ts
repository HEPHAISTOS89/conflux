/**
 * Road-user classes shared by every lab view. A site feed (docs/SITE_TRAJECTORY_SCHEMA.md) carries pedestrians,
 * bicycles, motorcycles, cars, trucks and buses; NGSIM carries motorcycles, cars and trucks. Pedestrians are
 * served as a body-centre point (no length behind it), vehicles as a front-bumper point.
 */
import type { ConflictT, IntersectionT, TrackT } from '../traj';

export type RoadUser = 'pedestrian' | 'bicycle' | 'vehicle';

export const isPedestrian = (tr: Pick<TrackT, 'cls'>) => tr.cls === 'pedestrian';
export const isVru = (tr: Pick<TrackT, 'cls'>) => tr.cls === 'pedestrian' || tr.cls === 'bicycle';
export const roadUser = (tr: Pick<TrackT, 'cls'>): RoadUser => (tr.cls === 'pedestrian' ? 'pedestrian' : tr.cls === 'bicycle' ? 'bicycle' : 'vehicle');

/** Length to draw behind the served point: pedestrians are centred points, every vehicle is front-bumper referenced. */
export const bodyLength = (tr: Pick<TrackT, 'cls' | 'len_m'>) => (isPedestrian(tr) ? 0 : tr.len_m);

/** Counts by class in the order the legend shows them. */
export function classCounts(tracks: Pick<TrackT, 'cls'>[]): { cls: string; n: number }[] {
  const order = ['pedestrian', 'bicycle', 'motorcycle', 'car', 'truck', 'bus'];
  const m = new Map<string, number>();
  for (const t of tracks) m.set(t.cls, (m.get(t.cls) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => (order.indexOf(a[0]) + 99) % 99 - (order.indexOf(b[0]) + 99) % 99).map(([cls, n]) => ({ cls, n }));
}

export const hasPedestrians = (data: Pick<IntersectionT, 'tracks'>) => data.tracks.some(isPedestrian);

export const CONFLICT_TYPES = ['rear_end', 'crossing', 'lane_change', 'pedestrian', 'yield'] as const;
export const TYPE_LABEL: Record<ConflictT['type'], string> = {
  rear_end: 'Rear-end', crossing: 'Crossing', lane_change: 'Lane change', pedestrian: 'Pedestrian', yield: 'Failure to yield',
};
export const isPedestrianConflict = (c: Pick<ConflictT, 'type'>) => c.type === 'pedestrian' || c.type === 'yield';

/** Conflict types present in a site's conflict list, in catalogue order. */
export const typesPresent = (conflicts: Pick<ConflictT, 'type'>[]) => CONFLICT_TYPES.filter((k) => conflicts.some((c) => c.type === k));
