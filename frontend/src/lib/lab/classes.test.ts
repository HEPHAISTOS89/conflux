import { describe, expect, it } from 'vitest';
import { bodyLength, classCounts, hasPedestrians, isPedestrianConflict, roadUser, typesPresent } from './classes';

describe('road-user classes', () => {
  it('pedestrians are centred points, vehicles front-bumper referenced', () => {
    expect(bodyLength({ cls: 'pedestrian', len_m: 0.5 })).toBe(0);
    expect(bodyLength({ cls: 'car', len_m: 4.6 })).toBe(4.6);
    expect(bodyLength({ cls: 'bicycle', len_m: 1.8 })).toBe(1.8);
  });
  it('maps classes to road users', () => {
    expect(roadUser({ cls: 'pedestrian' })).toBe('pedestrian');
    expect(roadUser({ cls: 'bicycle' })).toBe('bicycle');
    expect(roadUser({ cls: 'bus' })).toBe('vehicle');
  });
  it('counts classes in legend order', () => {
    const c = classCounts([{ cls: 'car' }, { cls: 'pedestrian' }, { cls: 'car' }, { cls: 'truck' }, { cls: 'bus' }]);
    expect(c).toEqual([{ cls: 'pedestrian', n: 1 }, { cls: 'car', n: 2 }, { cls: 'truck', n: 1 }, { cls: 'bus', n: 1 }]);
    expect(hasPedestrians({ tracks: [{ cls: 'car' } as never] })).toBe(false);
  });
  it('lists conflict types present in catalogue order', () => {
    expect(typesPresent([{ type: 'yield' }, { type: 'rear_end' }, { type: 'yield' }])).toEqual(['rear_end', 'yield']);
    expect(isPedestrianConflict({ type: 'pedestrian' })).toBe(true);
    expect(isPedestrianConflict({ type: 'crossing' })).toBe(false);
  });
});
