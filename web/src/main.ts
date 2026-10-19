import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Cloud, type Node } from './cloud';
import { Lod } from './lod';
import { CLASSES, COLOR_MODES, EyeDome, pointMaterial, setHiddenClasses, type ColorMode } from './material';
import { fmtLatLon, utmToLatLon } from './geo';
import './style.css';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const cloudName = params.get('cloud') ?? 'autzen';

// ---------- scene ----------
const canvas = $<HTMLCanvasElement>('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 20000);
camera.up.set(0, 0, 1); // LiDAR is Z-up
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.screenSpacePanning = false; // pan across the ground, like a map
controls.maxPolarAngle = Math.PI * 0.495;

const material = pointMaterial();
const edl = new EyeDome(1, 1);
let cloud: Cloud;
let lod: Lod;

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const pr = renderer.getPixelRatio();
  renderer.setSize(w, h, false);
  edl.setSize(Math.floor(w * pr), Math.floor(h * pr));
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  material.uniforms.focal.value = (h * pr) / 2 / Math.tan((camera.fov * Math.PI) / 360);
}
addEventListener('resize', resize);

// ---------- measuring ----------
const measure = { on: false, points: [] as THREE.Vector3[] };
const markerGeo = new THREE.SphereGeometry(1, 12, 8);
const markerMat = new THREE.MeshBasicMaterial({ color: '#ffd166', depthTest: false });
const lineMat = new THREE.LineBasicMaterial({ color: '#ffd166', depthTest: false });
const measureGroup = new THREE.Group();
measureGroup.renderOrder = 10;
scene.add(measureGroup);

function redrawMeasure() {
  measureGroup.clear();
  const [a, b] = measure.points;
  const r = camera.position.distanceTo(controls.target) * 0.006;
  for (const p of measure.points) {
    const m = new THREE.Mesh(markerGeo, markerMat);
    m.position.copy(p);
    m.scale.setScalar(r);
    m.renderOrder = 10;
    measureGroup.add(m);
  }
  const out = $('measureOut');
  if (a && b) {
    const corner = new THREE.Vector3(b.x, b.y, a.z);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), lineMat);
    const guide = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, corner, b]),
      new THREE.LineDashedMaterial({ color: '#ffd166', dashSize: r * 3, gapSize: r * 2, depthTest: false, transparent: true, opacity: 0.6 }));
    guide.computeLineDistances();
    line.renderOrder = guide.renderOrder = 10;
    measureGroup.add(line, guide);
    const flat = Math.hypot(b.x - a.x, b.y - a.y);
    out.innerHTML = `<b>${fmt(a.distanceTo(b))}</b> straight line<br>${fmt(flat)} across the ground<br>${fmt(Math.abs(b.z - a.z))} ${b.z >= a.z ? 'up' : 'down'}`
      + `<br><br>A ${where(a)}<br>B ${where(b)}`;
  } else {
    out.innerHTML = a ? `A ${where(a)}<br><br>Now click a second point.` : 'Click a point to start.';
  }
}
// A point's real-world position: latitude/longitude when the cloud's grid zone is known, and height.
function where(p: THREE.Vector3): string {
  const [ox, oy, oz] = cloud.meta.origin;
  const h = `${(p.z + oz).toFixed(1)} m`;
  const utm = cloud.meta.utm;
  return utm ? `${fmtLatLon(utmToLatLon(p.x + ox, p.y + oy, utm.zone, utm.south))} · ${h}` : `height ${h}`;
}

const fmt = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : m >= 10 ? `${m.toFixed(1)} m` : `${m.toFixed(2)} m`);

// The distance label floats over the midpoint of the measuring line.
const mid = new THREE.Vector3();
function placeMeasureLabel() {
  const label = $('measureLabel');
  const [a, b] = measure.points;
  if (!a || !b) { label.hidden = true; return; }
  mid.addVectors(a, b).multiplyScalar(0.5).project(camera);
  if (mid.z > 1) { label.hidden = true; return; }
  label.hidden = false;
  label.textContent = fmt(a.distanceTo(b));
  label.style.left = `${((mid.x + 1) / 2) * canvas.clientWidth}px`;
  label.style.top = `${((1 - mid.y) / 2) * canvas.clientHeight}px`;
}

// Finds the visible point nearest the cursor: cheap ray-vs-box tests first, then a
// distance-to-ray check on the points of the few nodes the ray passes through.
const raycaster = new THREE.Raycaster();
const tmp = new THREE.Vector3();
function pick(clientX: number, clientY: number): THREE.Vector3 | null {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const { origin, direction } = raycaster.ray;
  const pxAngle = (2 * Math.tan((camera.fov * Math.PI) / 360)) / rect.height; // metres per pixel at 1 m
  const tolerancePx = 7;
  let best: THREE.Vector3 | null = null, bestT = Infinity;
  for (const node of cloud.all) {
    if (!node.points?.visible || !raycaster.ray.intersectsBox(node.box)) continue;
    const pos = node.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const cls = node.points.geometry.getAttribute('classification') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < pos.count; i++) {
      if (hidden.has(cls.getX(i))) continue;
      tmp.set(arr[i * 3] - origin.x, arr[i * 3 + 1] - origin.y, arr[i * 3 + 2] - origin.z);
      const t = tmp.dot(direction);
      if (t <= 0 || t >= bestT) continue;
      const d2 = tmp.lengthSq() - t * t;
      const tol = t * pxAngle * tolerancePx;
      if (d2 < tol * tol) { bestT = t; best = new THREE.Vector3(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]); }
    }
  }
  return best;
}

let down: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
canvas.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // that was a drag
  if (!measure.on) return;
  const p = pick(e.clientX, e.clientY);
  if (!p) return;
  if (measure.points.length >= 2) measure.points = [];
  measure.points.push(p);
  redrawMeasure();
});
canvas.addEventListener('dblclick', (e) => {
  const p = pick(e.clientX, e.clientY);
  if (p) controls.target.copy(p); // double-click flies the orbit centre to that spot
});

// ---------- UI ----------
let colorMode: ColorMode = 'height';
const hidden = new Set<number>();

function setColorMode(m: ColorMode) {
  colorMode = m;
  material.uniforms.colorMode.value = COLOR_MODES.indexOf(m);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#modes button')) b.classList.toggle('on', b.dataset.mode === m);
  $('legend').hidden = m !== 'classification';
}

function buildUi() {
  const modes = $('modes');
  const labels: Record<ColorMode, string> = { height: 'Height', classification: 'What it hit', intensity: 'Intensity', rgb: 'Photo colour' };
  for (const m of COLOR_MODES) {
    if (m === 'rgb' && !cloud.hasRgb) continue;
    const b = document.createElement('button');
    b.textContent = labels[m];
    b.dataset.mode = m;
    b.onclick = () => setColorMode(m);
    modes.append(b);
  }
  const legend = $('legend');
  for (const c of cloud.meta.classes) {
    const info = CLASSES[c] ?? { name: `Class ${c}`, color: '#9aa1ab' };
    const row = document.createElement('label');
    row.innerHTML = `<input type="checkbox" checked><i style="background:${info.color}"></i>${info.name}`;
    const box = row.querySelector('input')!;
    // noise is hidden by default: it's birds, reflections and sensor glitches
    if (c === 7 || c === 18) { box.checked = false; hidden.add(c); }
    box.onchange = () => {
      box.checked ? hidden.delete(c) : hidden.add(c);
      setHiddenClasses(material, hidden);
    };
    legend.append(row);
  }
  setHiddenClasses(material, hidden);
  setColorMode(cloud.hasRgb && params.get('mode') === 'rgb' ? 'rgb' : 'height');

  $<HTMLInputElement>('edl').onchange = (e) => (edl.enabled = (e.target as HTMLInputElement).checked);
  $<HTMLInputElement>('budget').oninput = (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    lod.budget = v * 1_000_000;
    $('budgetOut').textContent = `${v}M`;
  };
  $<HTMLInputElement>('size').oninput = (e) => (material.uniforms.sizeScale.value = Number((e.target as HTMLInputElement).value));
  $('measureBtn').onclick = () => {
    measure.on = !measure.on;
    measure.points = [];
    $('measureBtn').classList.toggle('on', measure.on);
    $('measureOut').hidden = !measure.on;
    canvas.style.cursor = measure.on ? 'crosshair' : '';
    redrawMeasure();
  };
  $('home').onclick = home;
  $('sweepBtn').onclick = () => {
    material.uniforms.sweepOn.value = !material.uniforms.sweepOn.value;
    $('sweepBtn').classList.toggle('on', material.uniforms.sweepOn.value);
  };
  $('title').textContent = cloud.meta.title ?? cloudName;
  $('place').textContent = `${cloud.meta.place ?? ''}${cloud.meta.place ? ' · ' : ''}${(cloud.meta.points / 1e6).toFixed(1)}M points`;
  $('credit').textContent = cloud.meta.credit ?? '';
  document.title = `${cloud.meta.title ?? cloudName} · Night Flight`;
  const ticks = document.querySelector('#compass .ticks')!;
  for (let d = 0; d < 360; d += 15) {
    const r = (d * Math.PI) / 180, major = d % 90 === 0;
    const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('x1', String(Math.sin(r) * 52)); l.setAttribute('y1', String(-Math.cos(r) * 52));
    l.setAttribute('x2', String(Math.sin(r) * (major ? 44 : 48))); l.setAttribute('y2', String(-Math.cos(r) * (major ? 44 : 48)));
    if (major) l.setAttribute('class', 'major');
    ticks.append(l);
  }
}

function home() {
  const s = cloud.meta.size;
  const z = (cloud.meta.zRange[0] + cloud.meta.zRange[1]) / 2;
  controls.target.set(s / 2, s / 2, z - cloud.meta.origin[2]);
  // open low and from the south-west, like coming in on approach
  camera.position.set(s * 0.12, -s * 0.18, z - cloud.meta.origin[2] + s * 0.32);
}

// ---------- go ----------
async function start() {
  cloud = await Cloud.open(`${import.meta.env.BASE_URL}clouds/${cloudName}`, material);
  scene.add(cloud.group);
  lod = new Lod(cloud);
  const [z0, z1] = cloud.meta.zRange;
  material.uniforms.zRange.value.set(z0 - cloud.meta.origin[2], z1 - cloud.meta.origin[2]);
  material.uniforms.intensityRange.value.set(...cloud.meta.intensityRange);
  material.uniforms.hasRgb.value = cloud.hasRgb;
  camera.far = cloud.meta.size * 6;
  camera.near = cloud.meta.size / 20000;
  camera.updateProjectionMatrix();
  buildUi();
  resize();
  home();

  // a faint survey grid at ground level, 100 m squares
  const s = cloud.meta.size;
  const grid = new THREE.GridHelper(s * 1.6, Math.round((s * 1.6) / 100), 0x4de1ff, 0x1b2a55);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(s / 2, s / 2, z0 - cloud.meta.origin[2] - 1);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.35;
  scene.add(grid);

  let last = performance.now(), frames = 0;
  // per-frame cost, readable from the console as __timing (handy when tuning on big clouds)
  const timing = { lod: 0, render: 0, frames: 0 };
  (window as unknown as { __timing: typeof timing }).__timing = timing;
  const fwd = new THREE.Vector3();
  const t0 = performance.now() / 1000;
  renderer.setAnimationLoop(() => {
    controls.update();
    const now = performance.now() / 1000;
    material.uniforms.time.value = now;
    // the radar band crosses the whole scan diagonally every 7 seconds
    const span = cloud.meta.size * 1.5;
    const dir = new THREE.Vector2(1, 0.45).normalize();
    material.uniforms.sweep.value.set(dir.x, dir.y, cloud.meta.size * 0.025, (((now - t0) / 7) % 1) * span - span * 0.15);
    const tLod = performance.now();
    const stats = lod.update(camera, canvas.clientHeight * renderer.getPixelRatio());
    timing.lod += performance.now() - tLod;
    if (measure.points.length) redrawMeasure();
    const tR = performance.now();
    edl.render(renderer, scene, camera);
    timing.render += performance.now() - tR;
    timing.frames++;
    placeMeasureLabel();
    frames++;
    const ms = performance.now();
    if (ms - last > 250) {
      camera.getWorldDirection(fwd);
      const hdg = ((Math.atan2(fwd.x, fwd.y) * 180) / Math.PI + 360) % 360; // 0 = north (+Y), 90 = east (+X)
      $('dial').setAttribute('transform', `rotate(${-hdg})`);
      $('hdg').textContent = `${String(Math.round(hdg) % 360).padStart(3, '0')}°`;
      $('alt').textContent = `${Math.round(camera.position.z + cloud.meta.origin[2])} m`;
      $('pts').textContent = `${(stats.points / 1e6).toFixed(2)}M`;
      if (ms - last > 1000 || frames > 30) {
        $('stats').textContent = `${Math.round((frames * 1000) / (ms - last))} fps${stats.loading ? ' · streaming' : ''}`;
        last = ms; frames = 0;
      }
    }
  });
}

start().catch((e) => {
  $('stats').textContent = `Couldn't load the scan: ${e.message}`;
  console.error(e);
});

export type { Node };
