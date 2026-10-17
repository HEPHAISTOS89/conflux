import HeroWorld from '../components/world/HeroWorld';
import Verdict from '../components/landing/Verdict';
import TtcInstrument from '../components/landing/TtcInstrument';
import NetworkRank from '../components/landing/NetworkRank';
import '../styles/atlas.css';

/** Landing: the replayed street, four findings, then two instruments a reader can operate. */
export default function Atlas() {
  return (
    <div className="atlas">
      <HeroWorld />
      <Verdict />
      <TtcInstrument />
      <NetworkRank />
    </div>
  );
}
