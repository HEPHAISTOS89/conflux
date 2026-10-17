from fastapi.testclient import TestClient
from app.main import app
client=TestClient(app)
def test_health():
 r=client.get('/health'); assert r.status_code==200 and r.json()['status']=='ok'
def test_metadata_is_explicit_about_fixture_mode():
 r=client.get('/'); assert r.status_code==200 and r.json()['data_mode']=='synthetic_fixture'
 body=r.json(); assert body['provenance_detail']['mode']=='synthetic_fixture'
 assert body['provenance_detail']['source_url'].startswith('https://')
 assert body['provenance_detail']['limitations']
def test_scenario_contract():
 r=client.get('/api/v1/scenarios/ngsim-i80-demo'); assert r.status_code==200
 body=r.json(); assert body['vehicle_count']==5 and len(body['vehicles'])==5 and len(body['events'])==3
 assert body['data_mode']=='synthetic_fixture' and body['speed_unit']=='mph'
def test_filter_events_and_not_found():
 assert len(client.get('/api/v1/scenarios/ngsim-i80-demo/events?severity=critical').json())==1
 assert client.get('/api/v1/scenarios/ngsim-i80-demo/events?severity=unknown').status_code==422
 assert client.get('/api/v1/scenarios/nope').status_code==404

def test_summary_is_derived_from_fixture():
 body=client.get('/api/v1/scenarios/ngsim-i80-demo/summary').json()
 assert body['event_count']==3 and body['high_risk_events']==2
 assert body['risk_index']==0.78 and body['data_quality']==0.98

def test_vehicle_stride_and_time_frame_contracts():
 full=client.get('/api/v1/scenarios/ngsim-i80-demo/vehicles').json()
 reduced=client.get('/api/v1/scenarios/ngsim-i80-demo/vehicles?stride=3').json()
 assert len(full)==5 and len(full[0]['trajectory'])==90
 assert len(reduced[0]['trajectory'])==30
 frame=client.get('/api/v1/scenarios/ngsim-i80-demo/frame?t=7.9').json()
 assert frame['t']==7.9 and len(frame['vehicles'])==5
 assert frame['active_events'][0]['id']=='E-003'
 clamped=client.get('/api/v1/scenarios/ngsim-i80-demo/frame?t=999').json()
 assert clamped['t']==8.9

def test_query_validation_rejects_invalid_values():
 assert client.get('/api/v1/scenarios/ngsim-i80-demo/vehicles?stride=0').status_code==422
 assert client.get('/api/v1/scenarios/ngsim-i80-demo/frame?t=-1').status_code==422
