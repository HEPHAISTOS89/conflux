import { useState } from 'react';
import { useDocTheme } from '../components/landing/useDocTheme';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { ProvChip } from '../components/MetricInfo';
import Select from '../components/Select';
import LongExposure from '../components/landing/LongExposure';
import Verdict from '../components/landing/Verdict';
import TtcInstrument from '../components/landing/TtcInstrument';
import NetworkRank from '../components/landing/NetworkRank';
import EbWorked from '../components/landing/EbWorked';
import { useApi } from '../lib/api';
import { useReveal } from '../lib/motion';
import type { ConflictT, IntersectionT } from '../lib/traj';
import '../styles/atlas.css';

export default function Atlas() {
  return (
    <div className="atlas">
      <Hero />
      <Verdict />
      <TtcInstrument />
      <NetworkRank />
      <EbWorked />
      <Close />
    </div>
  );
}

function Hero() {
  const ix = useApi<IntersectionT>('/intersections/peachtree-10th');
  const cf = useApi<ConflictT[]>('/intersections/peachtree-10th/conflicts');
  const theme = useDocTheme();
  return (
    <section className="lx-hero" aria-labelledby="hero-h">
      <div className="lx-copy">
        <h1 id="hero-h" className="lx-h">
          <span className="mask-line"><span>Lubbock County</span></span>
          <span className="mask-line"><span>road safety</span></span>
        </h1>
        <div className="lx-side after-mask">
          <p className="lx-lede">HSM Part B network screening and SSAM conflict analysis on public TxDOT, NHTSA and FHWA data.</p>
          <div className="lx-act">
            <Link to="/intersections/peachtree-10th" className="btn lx-btn">Open intersection lab <Icon name="arrow" size={16} /></Link>
            <Link to="/screening" className="lx-link">Open network screening</Link>
          </div>
        </div>
      </div>
      <figure className="lx-stage">
        {ix.data && cf.data ? <LongExposure ix={ix.data} conflicts={cf.data} />
          : ix.error || cf.error ? <div className="lx-fallback">Trajectory replay unavailable. <Link to="/intersections/peachtree-10th">Open intersection lab</Link></div>
            : <div className="lx-fallback" aria-busy="true">Loading 90 s of trajectories…</div>}
        <figcaption className="lx-cap">
          <span>{ix.data ? ix.data.tracks.length : '…'} vehicle trajectories, Peachtree St & 10th St, Atlanta. NGSIM, 10 Hz, replayed at 4×. {theme === 'light' ? 'Ink' : 'White'}: headlights. Red: tail lights. Amber: SSAM conflicts.</span>
          <ProvChip kind="observed" />
        </figcaption>
      </figure>
    </section>
  );
}

const FALLBACK = [{ id: 'us-84', name: 'US 84 (Slaton Hwy / Clovis Rd)' }];

function Close() {
  const ref = useReveal<HTMLElement>();
  const list = useApi<{ id: string; name: string; len_mi: number }[]>('/corridors');
  const [id, setId] = useState('us-84');
  const nav = useNavigate();
  const opts = (list.data ?? FALLBACK).map((c) => ({ value: c.id, label: c.name.split(' (')[0], hint: 'len_mi' in c ? `${(c as { len_mi: number }).len_mi.toFixed(1)} mi` : undefined }));
  return (
    <section ref={ref} className="cl" aria-labelledby="cl-h">
      <figure className="cl-photo" data-r="1">
        <img src="/photos/marsha-sharp-freeway-light-trails.webp" width={1600} height={1067} loading="lazy" decoding="async"
          alt="Long exposure of night traffic on the Marsha Sharp Freeway in Lubbock: headlights and tail lights drawn as trails." />
        <figcaption>Marsha Sharp Freeway, Lubbock. Photo: Ihavenoidea49, CC0.</figcaption>
      </figure>
      <div className="cl-body">
        <h2 id="cl-h" className="cl-say" data-r="2">Conflict replay in plan view and 3D</h2>
        <div className="cl-act" data-r="3">
          <Link to="/intersections/peachtree-10th" className="btn lx-btn">Open intersection lab <Icon name="arrow" size={16} /></Link>
          <form className="cl-corr" onSubmit={(e) => { e.preventDefault(); nav(`/corridors/${id}`); }}>
            <span>or open a corridor</span>
            <Select compact label="Corridor" icon="corridor" value={id} options={opts} onChange={setId} />
            <button type="submit" className="cl-go" aria-label="Open corridor diagram"><Icon name="arrow" size={18} /></button>
          </form>
        </div>
      </div>
    </section>
  );
}
