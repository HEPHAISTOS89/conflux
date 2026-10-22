import { describe, expect, it } from 'vitest';
import { countyQuery, parseCounty, regionBounds, regionLabel, withCounty, type CountyProps } from './region';

const C = (id: string, name: string, bbox: [number, number, number, number]) => ({ id, name, bbox } as CountyProps);
const counties = [C('hale', 'Hale', [-102.1, 33.8, -101.5, 34.3]), C('lubbock', 'Lubbock', [-102.1, 33.4, -101.5, 33.8])];

describe('county URL state', () => {
  it('parses only a safe slug and treats "all" as the region', () => {
    expect(parseCounty('?county=hale')).toBe('hale');
    expect(parseCounty('?county=Hale')).toBe('hale');
    expect(parseCounty('?county=all')).toBeNull();
    expect(parseCounty('?county=96')).toBeNull();
    expect(parseCounty('?county=x;drop')).toBeNull();
    expect(parseCounty('')).toBeNull();
    expect(parseCounty(new URLSearchParams('method=rate&county=terry'))).toBe('terry');
  });
  it('builds API query fragments', () => {
    expect(countyQuery(null)).toBe('');
    expect(countyQuery('hale')).toBe('&county=hale');
    expect(countyQuery('hale', true)).toBe('?county=hale');
  });
  it('carries the county on route paths without losing other parameters', () => {
    expect(withCounty('/screening', 'hale')).toBe('/screening?county=hale');
    expect(withCounty('/screening?method=rate', 'hale')).toBe('/screening?method=rate&county=hale');
    expect(withCounty('/screening?county=hale&seg=S1', null)).toBe('/screening?seg=S1');
    expect(withCounty('/vru', null)).toBe('/vru');
  });
  it('labels the scope', () => {
    expect(regionLabel(null)).toBe('South Plains region');
    expect(regionLabel(null, counties, true)).toBe('South Plains region (15 counties)');
    expect(regionLabel('hale', counties)).toBe('Hale County');
    expect(regionLabel('king', null)).toBe('King County');
  });
  it('bounds the region or one county', () => {
    expect(regionBounds(null, counties)).toEqual([[-102.1, 33.4], [-101.5, 34.3]]);
    expect(regionBounds('hale', counties)).toEqual([[-102.1, 33.8], [-101.5, 34.3]]);
    expect(regionBounds('hale', null)).toBeUndefined();
  });
});
