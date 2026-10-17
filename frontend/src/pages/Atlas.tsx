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
          <span className="mask-line"><span>Read the road</span></span>
          <span className="mask-line"><span>before the crash.</span></span>
        </h1>
        <div className="lx-side after-mask">
          <p className="lx-lede">Network screening and surrogate safety measures for Lubbock County, computed from public crash, traffic and trajectory data.</p>
          <div className="lx-act">
            <Link to="/intersections/peachtree-10th" className="btn lx-btn">Open the intersection lab <Icon name="arrow" size={16} /></Link>
            <Link to="/screening" className="lx-link">Screen the network</Link>
          </div>
        </div>
      </div>
      <figure className="lx-stage">
        {ix.data && cf.data ? <LongExposure ix={ix.data} conflicts={cf.data} />
          : ix.error || cf.error ? <div className="lx-fallback">The trajectory replay could not load. <Link to="/intersections/peachtree-10th">Open the lab</Link></div>
            : <div className="lx-fallback" aria-busy="true">Exposing 90 seconds of trajectories…</div>}
        <figcaption className="lx-cap">
          <span>Every trail is one of {ix.data ? ix.data.tracks.length : '…'} real vehicles at Peachtree St & 10th St (NGSIM, 10 Hz), replayed at 4×. {theme === 'light' ? 'Ink' : 'White'}: headlights. Red: tail lights. Amber: SSAM conflicts.</span>
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
        <figcaption>Marsha Sharp Freeway, Lubbock, as a camera sees it. The exposure at the top of this page is the same picture, computed from trajectories. Photo: Ihavenoidea49, CC0, via Wikimedia Commons.</figcaption>
      </figure>
      <div className="cl-body">
        <h2 id="cl-h" className="cl-say" data-r="2">Replay the 90 seconds, conflict by conflict, from any angle.</h2>
        <div className="cl-act" data-r="3">
          <Link to="/intersections/peachtree-10th" className="btn lx-btn">Open the intersection lab <Icon name="arrow" size={16} /></Link>
          <form className="cl-corr" onSubmit={(e) => { e.preventDefault(); nav(`/corridors/${id}`); }}>
            <span>or read a corridor</span>
            <Select compact label="Corridor" icon="corridor" value={id} options={opts} onChange={setId} />
            <button type="submit" className="cl-go" aria-label="Open the corridor diagram"><Icon name="arrow" size={18} /></button>
          </form>
        </div>
        <p className="cl-src" data-r="4">Data: TxDOT CRIS, AADT, Roadway Inventory and Statewide Speed (© TxDOT, informational use) · NHTSA FARS (public domain) · FHWA NGSIM Peachtree St (CC BY-SA 3.0). NGSIM is from Atlanta and stands in for roadside LiDAR trajectories.</p>
      </div>
    </section>
  );
}
