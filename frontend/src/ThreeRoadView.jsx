import { useEffect, useRef } from 'react';
import * as THREE from 'three';

function currentPoint(vehicle, time) {
  const points = vehicle.trajectory || [];
  if (!points.length) return { x: 0, y: 0 };
  return points.reduce((best, point) => (
    Math.abs(point.t - time) < Math.abs(best.t - time) ? point : best
  ), points[0]);
}

function boundsFor(vehicles) {
  const points = vehicles.flatMap((vehicle) => vehicle.trajectory || []);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function roadPosition(point, bounds) {
  return {
    x: -39 + ((point.x - bounds.minX) / Math.max(1, bounds.maxX - bounds.minX)) * 78,
    z: -6 + ((point.y - bounds.minY) / Math.max(1, bounds.maxY - bounds.minY)) * 12,
  };
}

export default function ThreeRoadView({ vehicles, events, time, selected, onSelect }) {
  const hostRef = useRef(null);
  const sceneStateRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !vehicles.length) return undefined;
    const bounds = boundsFor(vehicles);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#f1f2f0');
    scene.fog = new THREE.Fog('#f1f2f0', 62, 105);

    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 180);
    camera.position.set(3, 22, 34);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.setAttribute('aria-hidden', 'true');
    host.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight('#ffffff', '#a9aaa5', 2.1));
    const key = new THREE.DirectionalLight('#ffffff', 2.8);
    key.position.set(-20, 34, 18);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    scene.add(key);

    const road = new THREE.Mesh(new THREE.PlaneGeometry(92, 19), new THREE.MeshStandardMaterial({ color: '#dedfda', roughness: 1 }));
    road.rotation.x = -Math.PI / 2;
    road.receiveShadow = true;
    scene.add(road);

    const shoulderMaterial = new THREE.MeshStandardMaterial({ color: '#c6c8c3', roughness: 1 });
    [-8.2, 8.2].forEach((z) => {
      const shoulder = new THREE.Mesh(new THREE.BoxGeometry(92, 0.14, 0.75), shoulderMaterial);
      shoulder.position.set(0, 0.08, z);
      shoulder.receiveShadow = true;
      scene.add(shoulder);
    });
    [-4, 0, 4].forEach((z) => {
      const lanePoints = [];
      for (let x = -44; x < 44; x += 6) lanePoints.push(new THREE.Vector3(x, 0.09, z), new THREE.Vector3(x + 3.2, 0.09, z));
      scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(lanePoints), new THREE.LineBasicMaterial({ color: '#aeb0ac' })));
    });

    const vehicleObjects = new Map();
    const selectable = [];
    vehicles.forEach((vehicle) => {
      const trajectory = (vehicle.trajectory || []).filter((_, index) => index % 3 === 0).map((point) => {
        const position = roadPosition(point, bounds);
        return new THREE.Vector3(position.x, 0.12, position.z);
      });
      const trajectoryMaterial = new THREE.LineBasicMaterial({ color: vehicle.color, transparent: true, opacity: 0.22 });
      if (trajectory.length > 1) scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(trajectory), trajectoryMaterial));

      const group = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(vehicle.type === 'truck' ? 3.5 : 2.7, 0.78, 1.42),
        new THREE.MeshStandardMaterial({ color: vehicle.color, roughness: 0.72, metalness: 0.04 }),
      );
      body.castShadow = true;
      body.userData.vehicleId = vehicle.id;
      group.add(body);
      const outline = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: '#111111' }));
      outline.scale.setScalar(1.08);
      outline.visible = false;
      group.add(outline);
      scene.add(group);
      selectable.push(body);
      vehicleObjects.set(vehicle.id, { group, outline, trajectoryMaterial });
    });

    const eventObjects = new Map();
    events.forEach((event) => {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.35, 0.13, 10, 34),
        new THREE.MeshBasicMaterial({ color: event.severity === 'medium' ? '#b26a00' : '#c13515' }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.visible = false;
      scene.add(ring);
      eventObjects.set(event.id, ring);
    });

    const render = () => renderer.render(scene, camera);
    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const handlePointer = (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(selectable, false)[0];
      if (hit?.object.userData.vehicleId) onSelect(hit.object.userData.vehicleId);
    };
    renderer.domElement.addEventListener('pointerup', handlePointer);
    sceneStateRef.current = { scene, renderer, camera, render, bounds, vehicleObjects, eventObjects };

    return () => {
      sceneStateRef.current = null;
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerup', handlePointer);
      scene.traverse((object) => {
        object.geometry?.dispose?.();
        if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
        else object.material?.dispose?.();
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [vehicles, events, onSelect]);

  useEffect(() => {
    const state = sceneStateRef.current;
    if (!state) return;
    vehicles.forEach((vehicle) => {
      const object = state.vehicleObjects.get(vehicle.id);
      if (!object) return;
      const position = roadPosition(currentPoint(vehicle, time), state.bounds);
      object.group.position.set(position.x, 0.57, position.z);
      object.outline.visible = vehicle.id === selected;
      object.trajectoryMaterial.color.set(vehicle.id === selected ? '#181818' : vehicle.color);
      object.trajectoryMaterial.opacity = vehicle.id === selected ? 0.58 : 0.22;
    });
    events.forEach((event) => {
      const ring = state.eventObjects.get(event.id);
      const vehicle = vehicles.find((item) => item.id === event.vehicle_ids[0]);
      if (!ring || !vehicle) return;
      const position = roadPosition(currentPoint(vehicle, event.t), state.bounds);
      ring.position.set(position.x, 0.15, position.z);
      ring.visible = Math.abs(event.t - time) < 0.8;
    });
    state.render();
  }, [vehicles, events, time, selected]);

  return (
    <div className="three-road-view" ref={hostRef} role="img" aria-label={`Three-dimensional road replay at ${time.toFixed(1)} seconds. ${vehicles.length} vehicles visible. Selected vehicle ${selected}.`}>
      <div className="three-caption"><span>Perspective replay</span><span>Click a vehicle to inspect</span></div>
    </div>
  );
}
