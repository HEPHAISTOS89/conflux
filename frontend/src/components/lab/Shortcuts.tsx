import { useEffect, useRef } from 'react';
import { Icon } from '../Icon';

const GROUPS: [string, [string[], string][]][] = [
  ['Timeline', [
    [['Space'], 'Play / pause'],
    [[',', '.'], 'Step one 10 Hz frame (0.1 s)'],
    [['←', '→'], 'Step 0.1 s · Shift: 1 s'],
    [['[', ']'], 'Previous / next risk event'],
  ]],
  ['View', [
    [['2', '3'], 'Plan view / 3D view'],
    [['F'], 'Fullscreen'],
    [['Esc'], 'Clear selection · leave fullscreen'],
    [['?'], 'This sheet'],
  ]],
  ['3D camera', [
    [['C'], 'Next camera mode · Shift: previous'],
    [['P'], 'Next preset'],
    [['R'], 'Replay the conflict from 3 angles'],
    [['W', 'A', 'S', 'D'], 'Fly (or arrows) · Q / E down / up'],
    [['Shift'], 'Fly faster'],
    [['Drag'], 'Look (fly, sensor) · orbit · pan (top)'],
  ]],
];

/** Keyboard sheet: modal dialog inside the lab panel so it also shows in fullscreen; focus moves in and returns. */
export default function Shortcuts({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('button')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (e.key === 'Tab') { e.preventDefault(); box.current?.querySelector<HTMLElement>('button')?.focus(); }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="kbd-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} className="kbd-sheet" role="dialog" aria-modal="true" aria-labelledby="kbd-h">
        <div className="kbd-head">
          <h3 id="kbd-h"><Icon name="keyboard" size={18} /> Keyboard</h3>
          <button className="btn ghost ic" onClick={onClose} aria-label="Close shortcuts"><Icon name="close" size={16} /></button>
        </div>
        <div className="kbd-groups">
          {GROUPS.map(([g, rows]) => (
            <section key={g}>
              <h4>{g}</h4>
              <dl>
                {rows.map(([k, d]) => (
                  <div key={d}><dt>{k.map((x) => <kbd key={x}>{x}</kbd>)}</dt><dd>{d}</dd></div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
