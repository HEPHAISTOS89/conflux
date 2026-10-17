import { useEffect, useId, useRef, useState } from 'react';
import { useFloatFit } from './useFloatFit';
import { Link } from 'react-router-dom';

/** One-line definitions of the safety-analysis terms used across the portal. */
export const GLOSSARY: Record<string, { name: string; def: string; anchor?: string }> = {
  AADT: { name: 'Annual average daily traffic', def: 'Vehicles per day, averaged over a year; the exposure term of every rate and SPF.', anchor: 'm-screening' },
  SPF: { name: 'Safety performance function', def: 'Negative binomial model of expected crashes from AADT and length for a site type.', anchor: 'm-screening' },
  EB: { name: 'Empirical Bayes', def: 'Weighted blend of the SPF prediction and the observed count; corrects regression to the mean.', anchor: 'm-screening' },
  'EB excess': { name: 'Excess expected crashes', def: 'EB-expected minus SPF-predicted crashes per year; the HSM potential for safety improvement.', anchor: 'm-screening' },
  'Critical ratio': { name: 'Critical rate ratio', def: 'Observed crash rate over the 95% critical rate of its facility group; above 1 flags the site.', anchor: 'm-screening' },
  KABCO: { name: 'KABCO injury scale', def: 'K fatal, A suspected serious, B suspected minor, C possible, O no injury.' },
  PBCAT: { name: 'Pedestrian and Bicycle Crash Analysis Tool', def: 'FHWA crash-typing scheme describing the pre-crash manoeuvres of pedestrians and cyclists.' },
  TTC: { name: 'Time to collision', def: 'Time until two road users collide if both keep their speed and path. SSAM detects at ≤ 1.5 s.', anchor: 'm-ssm' },
  PET: { name: 'Post-encroachment time', def: 'Time between the first road user leaving a conflict zone and the second entering it. SSAM detects at ≤ 5 s.', anchor: 'm-ssm' },
  DRAC: { name: 'Deceleration rate to avoid crash', def: 'Braking the follower needs to avoid the leader; flagged at ≥ 11.2 ft/s² (3.4 m/s²).', anchor: 'm-ssm' },
  DFO: { name: 'Distance from origin', def: 'TxDOT linear reference along a route, in miles.' },
  SSAM: { name: 'Surrogate Safety Assessment Model', def: 'FHWA method and software for conflict detection from trajectories.', anchor: 'm-ssm' },
};

/** Inline term with a definition on hover, focus or tap; links to its Methods section. */
export default function Term({ k, children }: { k: keyof typeof GLOSSARY | string; children?: React.ReactNode }) {
  const g = GLOSSARY[k];
  const id = useId();
  const [open, setOpen] = useState(false);
  const tip = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  useFloatFit(tip, open);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', esc);
    document.addEventListener('pointerdown', away);
    return () => { document.removeEventListener('keydown', esc); document.removeEventListener('pointerdown', away); };
  }, [open]);
  if (!g) return <>{children ?? k}</>;
  return (
    <span ref={box} className="term" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="term-btn" aria-describedby={open ? id : undefined} aria-expanded={open}
        onFocus={() => setOpen(true)} onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node)) setOpen(false); }}
        onClick={() => setOpen(true)} /* hover/focus already opened it; a toggle here would close it under the pointer */>
        {children ?? k}
      </button>
      {open && (
        // mousedown inside the tip must not blur the term (which would unmount the Method link before its click lands)
        <span ref={tip} role="tooltip" id={id} className="term-tip" onMouseDown={(e) => e.preventDefault()}>
          <b>{g.name}</b>
          <span>{g.def}</span>
          {g.anchor && <Link to={`/methods#${g.anchor}`} tabIndex={-1}>Method</Link>}
        </span>
      )}
    </span>
  );
}
