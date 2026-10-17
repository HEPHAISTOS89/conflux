from fastapi.testclient import TestClient
from app.main import app
client=TestClient(app)
def test_health():
 r=client.get('/health'); assert r.status_code==200 and r.json()['status']=='ok'
def test_metadata_is_explicit_about_fixture_mode():
 r=client.get('/'); assert r.status_code==200 and r.json()['data_mode']=='synthetic_fixture'
def test_scenario_contract():
 r=client.get('/api/v1/scenarios/ngsim-i80-demo'); assert r.status_code==200
 body=r.json(); assert body['vehicle_count']==5 and len(body['vehicles'])==5 and len(body['events'])==3
def test_filter_events_and_not_found():
 assert len(client.get('/api/v1/scenarios/ngsim-i80-demo/events?severity=critical').json())==1
 assert client.get('/api/v1/scenarios/ngsim-i80-demo/events?severity=unknown').status_code==422
 assert client.get('/api/v1/scenarios/nope').status_code==404
