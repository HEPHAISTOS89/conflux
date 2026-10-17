import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'https://6zwr3ongsqiy22oiefyn3wwtva0gunpt.lambda-url.us-east-2.on.aws';
const FALLBACK = {
  id: 'ngsim-i80-demo', name: 'I-80 merge / evidence replay', location: 'Emeryville, CA',
  duration_s: 8.9, sample_rate_hz: 10, provenance: 'Synthetic demonstration fixture inspired by FHWA NGSIM.',
  vehicles: [
    { id:'V-01', type:'car', lane:1, color:'#1f6feb', trajectory:Array.from({length:90},(_,i)=>({t:i/10,x:38+i*.55,y:.2,speed:30,heading:0})) },
    { id:'V-02', type:'car', lane:2, color:'#e5484d', trajectory:Array.from({length:90},(_,i)=>({t:i/10,x:17+i*.62,y:3.7,speed:i>48&&i<62?20:32,heading:0})) },
    { id:'V-03', type:'car', lane:3, color:'#147d64', trajectory:Array.from({length:90},(_,i)=>({t:i/10,x:57+i*.5,y:7.1,speed:28,heading:0})) },
    { id:'V-04', type:'truck', lane:1, color:'#7c66dc', trajectory:Array.from({length:90},(_,i)=>({t:i/10,x:5+i*.45,y:.1,speed:25,heading:0})) },
    { id:'V-05', type:'car', lane:2, color:'#d97706', trajectory:Array.from({length:90},(_,i)=>({t:i/10,x:72+i*.5,y:3.8,speed:29,heading:0})) }
  ],
  events: [
    {id:'E-001',severity:'high',kind:'hard_brake',t:5.4,vehicle_ids:['V-02','V-03'],score:.86,description:'Abrupt deceleration with short following gap'},
    {id:'E-002',severity:'medium',kind:'lane_change',t:6.8,vehicle_ids:['V-04'],score:.54,description:'Unsignalled lane transition'},
    {id:'E-003',severity:'critical',kind:'near_miss',t:7.9,vehicle_ids:['V-02','V-05'],score:.94,description:'Predicted time-to-collision below threshold'}
  ]
};
const FALLBACK_SUMMARY={vehicle_count:5,event_count:3,risk_index:.71,avg_speed_mph:27.2,max_speed_mph:32,high_risk_events:2,data_quality:1};
const severityLabel={critical:'Critical',high:'High',medium:'Review',low:'Low'};
const kindLabel={hard_brake:'Hard braking',lane_change:'Lane transition',near_miss:'Near miss',speeding:'Speeding'};

function useScenario(){
  const [scenario,setScenario]=useState(FALLBACK), [summary,setSummary]=useState(FALLBACK_SUMMARY);
  const [source,setSource]=useState(API_BASE?'Connecting':'Local fixture');
  useEffect(()=>{ if(!API_BASE)return; let alive=true; Promise.all([
    fetch(`${API_BASE}/api/v1/scenarios/ngsim-i80-demo`).then(r=>{if(!r.ok)throw Error();return r.json()}),
    fetch(`${API_BASE}/api/v1/scenarios/ngsim-i80-demo/summary`).then(r=>{if(!r.ok)throw Error();return r.json()}),
    fetch(`${API_BASE}/api/v1/scenarios/ngsim-i80-demo/events`).then(r=>{if(!r.ok)throw Error();return r.json()}),
    fetch(`${API_BASE}/api/v1/scenarios/ngsim-i80-demo/vehicles?stride=1`).then(r=>{if(!r.ok)throw Error();return r.json()})
  ]).then(([s,m,events,vehicles])=>{if(alive){setScenario({...s,events,vehicles});setSummary(m);setSource('AWS live')}}).catch(()=>alive&&setSource('Local fallback')); return()=>{alive=false}; },[]);
  return {scenario,summary,source};
}
function normalizedPoint(vehicle,time,all){const pts=vehicle.trajectory||[]; if(!pts.length)return{x:50,y:50,speed:0}; const p=pts.reduce((best,x)=>Math.abs(x.t-time)<Math.abs(best.t-time)?x:best,pts[0]); const xs=all.flatMap(v=>(v.trajectory||[]).map(q=>q.x)); const ys=all.flatMap(v=>(v.trajectory||[]).map(q=>q.y)); const [minX,maxX]=[Math.min(...xs),Math.max(...xs)]; const [minY,maxY]=[Math.min(...ys),Math.max(...ys)]; return {...p,x:7+86*(p.x-minX)/Math.max(1,maxX-minX),y:20+58*(p.y-minY)/Math.max(1,maxY-minY)};}

function App(){
  const {scenario,summary,source}=useScenario();
  const [selected,setSelected]=useState('V-02'),[playing,setPlaying]=useState(true),[time,setTime]=useState(4.2),[filter,setFilter]=useState('all'),[tab,setTab]=useState('Replay');
  useEffect(()=>{if(!playing)return;const id=setInterval(()=>setTime(v=>v>=scenario.duration_s?0:+(v+.1).toFixed(1)),100);return()=>clearInterval(id)},[playing,scenario.duration_s]);
  useEffect(()=>{if(!scenario.vehicles.some(v=>v.id===selected))setSelected(scenario.vehicles[0]?.id)},[scenario]);
  const active=scenario.vehicles.find(v=>v.id===selected)||scenario.vehicles[0];
  const visible=filter==='risk'?scenario.vehicles.filter(v=>scenario.events.some(e=>e.vehicle_ids.includes(v.id))):filter==='selected'?scenario.vehicles.filter(v=>v.id===selected):scenario.vehicles;
  const pos=active?normalizedPoint(active,time,scenario.vehicles):{speed:0};
  const firstCritical=scenario.events.find(event=>event.severity==='critical')||scenario.events[0];
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand" aria-label="RoadScope"><span className="brand-symbol">R</span><span>RoadScope</span></div>
      <nav aria-label="Primary navigation">{[['Replay','replay'],['Events','events'],['Vehicles','vehicle'],['Evidence','evidence']].map(([item,target])=><button key={item} className={tab===item?'active':''} onClick={()=>{setTab(item);document.getElementById(target)?.scrollIntoView({behavior:'smooth',block:'start'})}}>{item}</button>)}</nav>
      <div className="top-actions"><span className={`connection ${source==='AWS live'?'live':''}`}><i/>{source}</span><span className="avatar" aria-label="Safety Lab workspace">SL</span></div>
    </header>
    <main className="page">
      <section className="page-heading">
        <div><p className="kicker">Road safety intelligence</p><h1>{tab==='Replay'?'Trajectory replay':tab}</h1><p className="lede">Inspect vehicle movement, conflict timing and model evidence in one shared view.</p></div>
        <div className="scenario-select"><span>Scenario</span><strong>{scenario.name}</strong><small>{scenario.location} / {scenario.duration_s}s</small></div>
      </section>
      <section className="stats" aria-label="Scenario summary">
        <Metric label="Risk index" value={summary.risk_index?.toFixed(2)} note="Model score / 1.00" emphasis/>
        <Metric label="Tracked vehicles" value={summary.vehicle_count} note={`${scenario.sample_rate_hz} Hz trajectories`}/>
        <Metric label="High-risk events" value={summary.high_risk_events} note={`${summary.event_count} events total`}/>
        <Metric label="Fixture completeness" value={`${Math.round(summary.data_quality*100)}%`} note="Required fields present"/>
      </section>
      <section className="workbench">
        <div className="canvas-panel" id="replay">
          <div className="section-head"><div><p className="section-label">Spatial replay</p><h2>{scenario.location}</h2></div><div className="segmented" aria-label="Vehicle display filter">{[['all','All'],['risk','At risk'],['selected','Selected']].map(([v,l])=><button key={v} onClick={()=>setFilter(v)} className={filter===v?'active':''}>{l}</button>)}</div></div>
          <div className="road-view" aria-label="Top-down trajectory visualization">
            <div className="road-meta"><span>Westbound</span><span>Road-aligned synthetic layout</span><span>Eastbound</span></div>
            <div className="lane-line one"/><div className="lane-line two"/><div className="lane-line three"/>
            {visible.map(v=>{const p=normalizedPoint(v,time,scenario.vehicles);return <button key={v.id} className={`vehicle ${selected===v.id?'selected':''}`} style={{left:`${p.x}%`,top:`${p.y}%`}} onClick={()=>setSelected(v.id)} aria-label={`Inspect ${v.id}`}><span className="vehicle-body" style={{borderColor:v.color}}/><span className="vehicle-id">{v.id}</span></button>})}
            {scenario.events.filter(e=>Math.abs(e.t-time)<.8).map(e=>{const v=scenario.vehicles.find(x=>x.id===e.vehicle_ids[0]);const p=v?normalizedPoint(v,e.t,scenario.vehicles):{x:50,y:50};return <span key={e.id} className={`risk-marker ${e.severity}`} style={{left:`${p.x}%`,top:`${p.y}%`}} aria-label={`${severityLabel[e.severity]} event`}/>} )}
            <div className="scale">20 m</div>
          </div>
          <div className="transport">
            <button className="play-button" onClick={()=>setPlaying(!playing)}>{playing?'Pause':'Play'}</button>
            <span className="timecode">{time.toFixed(1)}s</span>
            <input type="range" min="0" max={scenario.duration_s} step="0.1" value={time} aria-label="Replay time" onChange={e=>{setPlaying(false);setTime(+e.target.value)}}/>
            <span className="duration">{scenario.duration_s}s</span>
            <button className="text-button" onClick={()=>{setPlaying(false);setTime(0)}}>Reset</button>
          </div>
        </div>
        <aside className="analysis-panel" id="vehicle">
          <div className="analysis-head"><div><p className="section-label">Selected vehicle</p><h2>{active?.id||'-'}</h2></div><span className="vehicle-type">{active?.type}</span></div>
          <div className="vehicle-data"><Data label="Speed" value={`${pos.speed?.toFixed(1)||'-'} mph`}/><Data label="Lane" value={`0${active?.lane||'-'}`}/><Data label="Position" value={`${pos.x?.toFixed(0)||'-'} / ${pos.y?.toFixed(0)||'-'}`}/></div>
          <div className="micro-chart"><div className="chart-title"><span>Speed profile</span><strong>{summary.avg_speed_mph} mph avg.</strong></div><svg viewBox="0 0 320 90" role="img" aria-label="Selected vehicle speed over time"><polyline points={(active?.trajectory||[]).filter((_,i)=>i%5===0).map((p,i)=>`${i*18},${78-Math.min(60,p.speed*1.5)}`).join(' ')} fill="none" stroke="#222" strokeWidth="2"/><line x1="0" y1="72" x2="320" y2="72" stroke="#ddd"/></svg></div>
          <p className="evidence-note"><strong>Evidence boundary.</strong> This demonstration uses a deterministic synthetic fixture inspired by NGSIM. It does not represent a live roadway decision.</p>
        </aside>
      </section>
      <section className="event-section" id="events">
        <div className="section-head"><div><p className="section-label">Review queue</p><h2>Detected interactions</h2></div>{firstCritical&&<button className="text-button" onClick={()=>{setSelected(firstCritical.vehicle_ids[0]);setTime(firstCritical.t);setPlaying(false)}}>Jump to highest risk</button>}</div>
        <div className="event-table" role="table"><div className="table-row table-header" role="row"><span>Event</span><span>Vehicles</span><span>Time</span><span>Score</span><span>Status</span></div>{scenario.events.map(e=><button className="table-row" role="row" key={e.id} onClick={()=>{setSelected(e.vehicle_ids[0]);setTime(e.t);setPlaying(false)}}><span><b>{kindLabel[e.kind]||e.kind}</b><small>{e.description}</small></span><span>{e.vehicle_ids.join(' / ')}</span><span>{e.t.toFixed(1)}s</span><span>{Math.round(e.score*100)}</span><span><i className={`severity ${e.severity}`}/>{severityLabel[e.severity]}</span></button>)}</div>
      </section>
      <footer id="evidence"><span>{scenario.provenance}</span><span>API {source} / RoadScope prototype</span></footer>
    </main>
  </div>
}
function Metric({label,value,note,emphasis}) {return <div className={`metric ${emphasis?'emphasis':''}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>}
function Data({label,value}){return <div><span>{label}</span><strong>{value}</strong></div>}
createRoot(document.getElementById('root')).render(<App/>);
