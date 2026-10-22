import { useEffect, useRef, useState } from 'react';
import type { SegmentProps } from '../../lib/types';

export type Seg = SegmentProps & {
  fc_group?: string; crashes_per_yr?: number; dfo_from?: number; dfo_to?: number; speed_all?: number;
  site_type?: string; spf_model?: string; crash_period?: string; crashes_ka?: number; county?: string; county_id?: string;
};

/** Element width in CSS pixels, tracked with a ResizeObserver (charts draw at true size, never scaled text). */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}
