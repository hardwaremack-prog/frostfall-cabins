// Frostfall Cabins — LAN multiplayer client
import * as THREE from './three.module.min.js';

// ------------------------------------------------------------------ layout
// (must match server.py)
const CABIN_W = 10, CABIN_D = 8;
const STOVE = [-3.2, -2.7], WOODBOX = [-4.0, 0.6], PANTRY = [3.9, -2.9], RADIO = [4.75, -0.9];
const CANDLES = [[1.5, 0.55, 1.27], [2.5, 0.55, 1.27], [4.62, 1.6, 1.63]];
const WORLD = 640, SEGS = 192, CELL = WORLD / SEGS;
const LAKE = { x: -222, z: -8, r: 40 };
const SPAWN = { x: 0, z: 30 };
const REGION_COL = { summit: '#b8c7dc', lake: '#8fd0ff', birch: '#e9e1c8', mill: '#d6a46a', hollow: '#9b8cd8' };

const qs = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

// ------------------------------------------------------------------- noise
let SEED = 1;
function hash(ix, iz) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(SEED, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return (a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz) * 2 - 1;
}
function fbm(x, z, o) { let s = 0, a = 1, f = 1, n = 0; for (let i = 0; i < o; i++) { s += a * vnoise(x * f, z * f); n += a; a *= 0.5; f *= 2.03; } return s / n; }
function mulberry(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

let cabins = [];        // world info + live state + meshes
let ICE_Y = 0;
function H0(x, z) {
  let h = fbm(x * 0.0055, z * 0.0055, 4) * 24 + fbm(x * 0.022 + 7.3, z * 0.022 - 3.1, 2) * 3.5;
  h += 95 * Math.exp(-(x * x + (z + 275) ** 2) / (2 * 85 * 85));                 // summit
  h -= 12 * Math.exp(-((x - 146) ** 2 + (z - 158) ** 2) / (2 * 55 * 55));        // the hollow
  h += 10 * Math.exp(-((x - 200) ** 2 + (z + 160) ** 2) / (2 * 60 * 60));        // birch ridge
  const r = Math.hypot(x, z); if (r > 262) h += Math.min((r - 262) ** 2 * 0.04, 70);           // valley walls
  return h;
}
function H1(x, z) {
  let h = H0(x, z);
  const d = Math.hypot(x - LAKE.x, z - LAKE.z);
  return lerp(h, ICE_Y - 2.2, smooth(LAKE.r + 24, LAKE.r - 4, d));
}
function heightFn(x, z) {
  let h = H1(x, z);
  for (const c of cabins) { const d = Math.hypot(x - c.x, z - c.z); if (d < 18) h = lerp(h, c.base, smooth(18, 9.5, d)); }
  const ds = Math.hypot(x - SPAWN.x, z - SPAWN.z); if (ds < 16) h = lerp(h, spawnBase, smooth(16, 6, ds));
  for (const f of FLATS) { const d = Math.hypot(x - f.x, z - f.z); if (d < f.r) h = lerp(h, f.base, smooth(f.r, f.r * 0.55, d)); }
  return h;
}
let spawnBase = 0;
let FLATS = [];   // helipad + bunker sites

// mesh-exact ground sampling
let grid = null;
function terrainAt(x, z) {
  const gx = (x + WORLD / 2) / CELL, gz = (z + WORLD / 2) / CELL;
  const ix = clamp(Math.floor(gx), 0, SEGS - 1), iz = clamp(Math.floor(gz), 0, SEGS - 1);
  const fx = clamp(gx - ix, 0, 1), fz = clamp(gz - iz, 0, 1), W = SEGS + 1;
  const a = grid[iz * W + ix], b = grid[(iz + 1) * W + ix], c = grid[(iz + 1) * W + ix + 1], d = grid[iz * W + ix + 1];
  return fx + fz <= 1 ? a + (d - a) * fx + (b - a) * fz : c + (b - c) * (1 - fx) + (d - c) * (1 - fz);
}
function onIce(x, z) { return Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r + 3; }
function groundAt(x, z) {
  let h = terrainAt(x, z);
  if (onIce(x, z)) h = Math.max(h, ICE_Y);
  for (const c of cabins) {
    const [lx, lz] = toLocal(c, x, z);
    if (Math.abs(lx) < CABIN_W / 2 + 0.35 && Math.abs(lz) < CABIN_D / 2 + 0.35) return c.base + 0.3;
  }
  return h;
}
function toWorld(c, lx, lz) { const co = Math.cos(c.rot), s = Math.sin(c.rot); return [c.x + lx * co + lz * s, c.z - lx * s + lz * co]; }
function toLocal(c, x, z) { const dx = x - c.x, dz = z - c.z, co = Math.cos(c.rot), s = Math.sin(c.rot); return [dx * co - dz * s, dx * s + dz * co]; }

// ---------------------------------------------------------------- renderer
let quality = store('ffc.quality') || (/aarch64|arm|linux arm/i.test(navigator.platform) ? 'pi' : 'pc');
const canvas = $('view');
let renderer, scene, camera;
const frostU = { value: 0.3 };
const clockU = { value: 0 };

function makeRenderer() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 'pc', powerPreference: 'high-performance' });
  renderer.setPixelRatio(quality === 'pi' ? 0.85 : Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight, false);
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0b1424, 0.006);
  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 4200);
  scene.add(camera);
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight, false); });
}

function frostMaterial(opts) {
  const m = new THREE.MeshLambertMaterial(opts);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uFrost = frostU;
    sh.vertexShader = 'varying float vUp;\n' + sh.vertexShader.replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n vUp = objectNormal.y;');
    sh.fragmentShader = 'uniform float uFrost; varying float vUp;\n' + sh.fragmentShader.replace('#include <color_fragment>',
      '#include <color_fragment>\n diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88,0.93,1.0), clamp(uFrost*(0.2+0.95*max(vUp,0.0)),0.0,1.0));');
  };
  return m;
}

function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = 4;
  return t;
}
function glowTex(inner, outer) {
  return canvasTex(128, 128, (g, w) => {
    const gr = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gr.addColorStop(0, inner); gr.addColorStop(0.35, outer); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, w);
  });
}

function mergeColored(parts) {
  // parts: [{geo, color:THREE.Color | fn(vertexIndex,pos)}]
  const pos = [], nor = [], col = [];
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    const P = g.attributes.position, N = g.attributes.normal;
    for (let i = 0; i < P.count; i++) {
      pos.push(P.getX(i), P.getY(i), P.getZ(i)); nor.push(N.getX(i), N.getY(i), N.getZ(i));
      const c = typeof p.color === 'function' ? p.color(i, P.getX(i), P.getY(i), P.getZ(i)) : p.color;
      col.push(c.r, c.g, c.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// ------------------------------------------------------------------- world
let sky, stars, moon, hemi, moonLight, lantern, terrainMat, iceMat, snow, mast;
const treeCells = new Map();
const cabinTags = [];

function buildWorld(world) {
  SEED = world.seed;
  cabins = world.cabins.map((c) => ({ ...c, state: null }));
  ICE_Y = H0(LAKE.x, LAKE.z) - 4;
  for (const c of cabins) c.base = H1(c.x, c.z);
  spawnBase = H1(SPAWN.x, SPAWN.z);
  FLATS = [{ x: world.helipad[0], z: world.helipad[1], r: 16 }, ...world.bunkers.map(([x, z]) => ({ x, z, r: 9 }))];
  for (const f of FLATS) f.base = H1(f.x, f.z);

  // sky dome
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color() }, bot: { value: new THREE.Color() } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bot; varying vec3 vP; void main(){ float t = smoothstep(-0.05, 0.45, vP.y); gl_FragColor = vec4(mix(bot, top, t), 1.0); }',
  });
  sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 24, 12), skyMat); sky.renderOrder = -2; scene.add(sky);

  const sp = [], rnd = mulberry(7);
  for (let i = 0; i < 1600; i++) {
    const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, y = Math.abs(u) * 0.95 + 0.05, r = Math.sqrt(1 - y * y);
    sp.push(Math.cos(th) * r * 900, y * 900, Math.sin(th) * r * 900);
  }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xdfe8ff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, depthWrite: false }));
  scene.add(stars);
  moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex('rgba(255,255,245,1)', 'rgba(200,215,255,0.35)'), fog: false, depthWrite: false, transparent: true }));
  moon.scale.set(110, 110, 1); scene.add(moon);

  hemi = new THREE.HemisphereLight(0x8aa4d6, 0xe8eefa, 0.5); scene.add(hemi);
  moonLight = new THREE.DirectionalLight(0xbcd0ff, 0.4); moonLight.position.set(-300, 400, -200); scene.add(moonLight);
  lantern = new THREE.PointLight(0xffc98a, 3.2, 26, 1); lantern.position.set(0.25, -0.35, -0.3); camera.add(lantern);

  // terrain
  const geo = new THREE.PlaneGeometry(WORLD, WORLD, SEGS, SEGS); geo.rotateX(-Math.PI / 2);
  const P = geo.attributes.position; grid = new Float32Array(P.count);
  for (let i = 0; i < P.count; i++) { const h = heightFn(P.getX(i), P.getZ(i)); P.setY(i, h); grid[i] = h; }
  geo.computeVertexNormals();
  const N = geo.attributes.normal, cols = new Float32Array(P.count * 3);
  const snowC = new THREE.Color(0xeef3fb), shadeC = new THREE.Color(0xc9d6ec), rockC = new THREE.Color(0x5b5f6a), tmp = new THREE.Color();
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i), z = P.getZ(i), y = P.getY(i), ny = N.getY(i);
    tmp.copy(snowC).lerp(shadeC, clamp(vnoise(x * 0.08, z * 0.08) * 0.5 + 0.35, 0, 1));
    const rock = smooth(0.86, 0.72, ny) + (y > 70 ? smooth(70, 95, y) * 0.35 * (vnoise(x * 0.2, z * 0.2) > 0.1 ? 1 : 0) : 0);
    tmp.lerp(rockC, clamp(rock, 0, 0.85));
    const hol = Math.exp(-((x - 146) ** 2 + (z - 158) ** 2) / (2 * 60 * 60)); tmp.multiplyScalar(1 - hol * 0.25);
    cols[i * 3] = tmp.r; cols[i * 3 + 1] = tmp.g; cols[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  terrainMat = ashMat(new THREE.MeshLambertMaterial({ vertexColors: true }), 0x77726c);
  scene.add(new THREE.Mesh(geo, terrainMat));

  // frozen lake + dock
  iceMat = ashMat(new THREE.MeshPhongMaterial({ color: 0x9cc8e8, specular: 0xffffff, shininess: 90, transparent: true, opacity: 0.92 }), 0x66625e);
  const ice = new THREE.Mesh(new THREE.CircleGeometry(LAKE.r + 4, 64), iceMat);
  ice.rotation.x = -Math.PI / 2; ice.position.set(LAKE.x, ICE_Y + 0.02, LAKE.z); scene.add(ice);
  const lc = cabins.find((c) => c.region === 'lake');
  if (lc) {
    const dir = new THREE.Vector2(lc.x - LAKE.x, lc.z - LAKE.z).normalize();
    const plank = new THREE.MeshLambertMaterial({ color: 0x6b4a32 });
    const dock = new THREE.Group();
    // run the dock from out on the ice right up onto the bank
    let shore = LAKE.r + 4;
    for (let d = LAKE.r - 6; d < LAKE.r + 40; d += 0.25) { if (heightFn(LAKE.x + dir.x * d, LAKE.z + dir.y * d) >= ICE_Y + 0.3) { shore = d; break; } }
    const d0 = LAKE.r - 9, d1 = Math.max(shore + 1.5, LAKE.r + 5), len = d1 - d0, mid = (d0 + d1) / 2;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.2, len), plank); deck.position.y = 0.45; dock.add(deck);
    for (let z = -len / 2 + 0.5; z <= len / 2 - 0.5; z += 3) for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.6), plank); post.position.set(s * 1.1, -0.4, z); dock.add(post);
    }
    for (let z = -len / 2 + 0.6; z < len / 2; z += 0.6) { const gap = new THREE.Mesh(new THREE.BoxGeometry(2.42, 0.02, 0.03), new THREE.MeshLambertMaterial({ color: 0x3a281a })); gap.position.set(0, 0.56, z); dock.add(gap); }
    const sx = LAKE.x + dir.x * mid, sz = LAKE.z + dir.y * mid;
    dock.position.set(sx, ICE_Y, sz); dock.rotation.y = Math.atan2(dir.x, dir.y); scene.add(dock);
  }

  buildTrees();
  buildRocks();
  for (const c of cabins) buildCabin(c);
  buildLandmarks();
  buildStory(world);
  buildSnow();

  // floating cabin tags
  for (const c of cabins) {
    const el = document.createElement('div'); el.className = 'ctag'; $('tags').appendChild(el); cabinTags.push(el);
  }
}

function regionAt(x, z) {
  let best = null, bd = 1e9;
  for (const c of cabins) {
    const cx = c.region === 'summit' ? 0 : c.region === 'lake' ? -200 : c.x, cz = c.region === 'summit' ? -235 : c.region === 'lake' ? -25 : c.z;
    const d = Math.hypot(x - cx, z - cz);
    if (d < bd) { bd = d; best = c.region; }
  }
  return bd < 120 ? best : 'meadow';
}

function buildTrees() {
  const rnd = mulberry(SEED * 13 + 5);
  const pines = [], birches = [];
  for (let gx = -WORLD / 2 + 4; gx < WORLD / 2; gx += 6.5) for (let gz = -WORLD / 2 + 4; gz < WORLD / 2; gz += 6.5) {
    const x = gx + (rnd() - 0.5) * 5.5, z = gz + (rnd() - 0.5) * 5.5;
    const r = Math.hypot(x, z); if (r > 305) continue;
    if (cabins.some((c) => Math.hypot(x - c.x, z - c.z) < 15)) continue;
    if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < 15) continue;
    if (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r + 7) continue;
    if (FLATS.some((f) => Math.hypot(x - f.x, z - f.z) < f.r + 2)) continue;
    const reg = regionAt(x, z), h = heightFn(x, z), n = vnoise(x * 0.03 + 11, z * 0.03);
    let p = { summit: 0.28, lake: 0.36, birch: 0.5, mill: 0.42, hollow: 0.9, meadow: 0.2 }[reg] + n * 0.25;
    if (h > 62) p *= 0.25;
    if (rnd() > p) continue;
    const s = 0.75 + rnd() * 0.65 * (reg === 'hollow' ? 1.3 : 1) * (h > 55 ? 0.6 : 1);
    const t = { x, z, y: heightFn(x, z) - 0.2, s, ry: rnd() * 6.28 };
    const birch = reg === 'birch' ? rnd() < 0.8 : reg === 'mill' ? rnd() < 0.25 : false;
    (birch ? birches : pines).push(t);
    const key = Math.floor(x / 10) + ',' + Math.floor(z / 10);
    if (!treeCells.has(key)) treeCells.set(key, []);
    treeCells.get(key).push([x, z, birch ? 0.35 : 0.55 * s]);
  }
  const darkG = new THREE.Color(0x1f3a2c), midG = new THREE.Color(0x2c4a35), bark = new THREE.Color(0x4a3426);
  const pineGeo = mergeColored([
    { geo: new THREE.CylinderGeometry(0.22, 0.32, 2.2, 6).translate(0, 1.1, 0), color: bark },
    { geo: new THREE.ConeGeometry(2.3, 3.2, 7).translate(0, 3.0, 0), color: darkG },
    { geo: new THREE.ConeGeometry(1.8, 2.8, 7).translate(0, 4.7, 0), color: midG },
    { geo: new THREE.ConeGeometry(1.15, 2.4, 7).translate(0, 6.3, 0), color: darkG },
  ]);
  const white = new THREE.Color(0xe8e4dc), mark = new THREE.Color(0x2b2622), leaf = new THREE.Color(0x8a7a4e);
  const birchGeo = mergeColored([
    { geo: new THREE.CylinderGeometry(0.16, 0.22, 7, 7, 10).translate(0, 3.5, 0), color: (i, x, y) => (Math.sin(y * 9.1 + x * 40) > 0.75 ? mark : white) },
    { geo: new THREE.IcosahedronGeometry(1.5, 0).translate(0.2, 6.6, 0), color: leaf },
    { geo: new THREE.IcosahedronGeometry(1.1, 0).translate(-0.6, 5.6, 0.4), color: leaf },
    { geo: new THREE.IcosahedronGeometry(1.0, 0).translate(0.5, 7.6, -0.3), color: leaf },
  ]);
  const mat = TREE_MAT = ashMat(frostMaterial({ vertexColors: true }), 0x2e2a27);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
  for (const [list, g] of [[pines, pineGeo], [birches, birchGeo]]) {
    const im = new THREE.InstancedMesh(g, mat, list.length);
    list.forEach((t, i) => { q.setFromEuler(e.set(0, t.ry, 0)); m4.compose(v.set(t.x, t.y, t.z), q, sc.set(t.s, t.s * (0.9 + (i % 7) * 0.04), t.s)); im.setMatrixAt(i, m4); });
    im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); scene.add(im);
  }
}

function buildRocks() {
  const rnd = mulberry(SEED + 99), list = [];
  for (let i = 0; i < 260; i++) {
    const x = (rnd() - 0.5) * 560, z = (rnd() - 0.5) * 560, h = heightFn(x, z);
    if (Math.hypot(x, z) > 300 || cabins.some((c) => Math.hypot(x - c.x, z - c.z) < 14) || FLATS.some((f) => Math.hypot(x - f.x, z - f.z) < f.r + 2)) continue;
    if (h < 45 && rnd() > 0.15) continue;
    list.push([x, h, z, 0.6 + rnd() * 2.2, rnd() * 6]);
  }
  const im = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), ashMat(frostMaterial({ color: 0x6d717c }), 0x3a3734), list.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  list.forEach(([x, y, z, s, r], i) => { q.setFromEuler(e.set(r, r * 2, r * 0.5)); m4.compose(new THREE.Vector3(x, y - s * 0.3, z), q, new THREE.Vector3(s * 1.3, s * 0.8, s)); im.setMatrixAt(i, m4); });
  scene.add(im);
}

// ------------------------------------------------------------------ cabins
const logTex = () => canvasTex(256, 256, (g, w, h) => {
  const n = 8, lh = h / n;
  for (let i = 0; i < n; i++) {
    const gr = g.createLinearGradient(0, i * lh, 0, (i + 1) * lh);
    gr.addColorStop(0, '#3a2516'); gr.addColorStop(0.18, '#7a5233'); gr.addColorStop(0.55, '#8b6040'); gr.addColorStop(0.9, '#4a2f1c'); gr.addColorStop(1, '#24170d');
    g.fillStyle = gr; g.fillRect(0, i * lh, w, lh);
    g.strokeStyle = 'rgba(30,18,10,.35)'; g.lineWidth = 1;
    for (let k = 0; k < 5; k++) { g.beginPath(); const y = i * lh + 6 + Math.random() * (lh - 12); g.moveTo(0, y); g.bezierCurveTo(w * .3, y + 2, w * .6, y - 2, w, y + 1); g.stroke(); }
  }
}, true);
let LOGTEX = null;
const winOff = new THREE.MeshBasicMaterial({ color: 0x1a2232 });
const winOn = new THREE.MeshBasicMaterial({ color: 0xffb455, fog: false });
const glowSprite = () => glowTex('rgba(255,200,120,0.95)', 'rgba(255,140,50,0.35)');
let GLOWTEX = null;

// ---------------------------------------------------------- canned food
const CAN_INFO = {
  stew: { name: 'Beef Stew', band: '#8a3d1c', bg: '#f3e6c8', ink: '#5a2410', art: 'pot' },
  spam: { name: 'Spam', band: '#b8262b', bg: '#f6f1e4', ink: '#ffffff', art: 'ham' },
  sausage: { name: 'Sausage Soup', band: '#2f6b3a', bg: '#f4ecd2', ink: '#1f3d24', art: 'links' },
  beans: { name: 'Pork & Beans', band: '#c9862a', bg: '#fbf3dc', ink: '#5a2f0a', art: 'beans' },
  veg: { name: 'Mixed Vegetables', band: '#3c8a3a', bg: '#fbf8ea', ink: '#215a1f', art: 'veg' },
};
const canMats = {}, CAN_TOP = new THREE.MeshLambertMaterial({ color: 0xc7ccd3, emissive: 0x202226 });
function canLabelTex(kind) {
  const k = CAN_INFO[kind];
  return canvasTex(512, 256, (g, w, h) => {
    g.fillStyle = k.bg; g.fillRect(0, 0, w, h);
    g.fillStyle = k.band; g.fillRect(0, 0, w, 62); g.fillRect(0, h - 40, w, 40);
    g.fillStyle = kind === 'spam' ? k.ink : '#fff'; g.font = 'bold 44px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(k.name.toUpperCase(), w / 2, 33);
    g.fillStyle = '#fff'; g.font = 'bold 20px sans-serif'; g.fillText('NET WT 15 OZ', w / 2, h - 20);
    // a little picture of what's inside
    const cx = w / 2, cy = 150;
    if (k.art === 'pot') { g.fillStyle = '#7a4a2a'; g.beginPath(); g.ellipse(cx, cy, 90, 46, 0, 0, 7); g.fill(); g.fillStyle = '#d07a3a'; for (let i = 0; i < 9; i++) { g.beginPath(); g.arc(cx - 60 + (i * 37) % 120, cy - 15 + (i * 23) % 34, 12, 0, 7); g.fill(); } }
    if (k.art === 'ham') { g.fillStyle = '#e88a8a'; g.fillRect(cx - 90, cy - 40, 180, 80); g.fillStyle = '#d06a6a'; g.fillRect(cx - 90, cy + 10, 180, 30); g.fillStyle = k.band; g.font = 'bold 30px sans-serif'; g.fillText('SPICED HAM', cx, cy - 6); }
    if (k.art === 'links') { g.fillStyle = '#a0522d'; for (let i = 0; i < 4; i++) { g.beginPath(); g.ellipse(cx - 75 + i * 50, cy, 24, 14, 0.3, 0, 7); g.fill(); } g.fillStyle = '#3a8a3a'; for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(cx - 80 + i * 32, cy + 30, 6, 0, 7); g.fill(); } }
    if (k.art === 'beans') { g.fillStyle = '#b5532a'; for (let i = 0; i < 16; i++) { g.beginPath(); g.ellipse(cx - 90 + (i * 47) % 180, cy - 25 + (i * 19) % 55, 13, 8, i, 0, 7); g.fill(); } g.fillStyle = '#e8b0a0'; g.fillRect(cx - 18, cy - 10, 36, 26); }
    if (k.art === 'veg') { const cs = ['#f08a24', '#3cae3c', '#f4d23a', '#e04a3a']; for (let i = 0; i < 18; i++) { g.fillStyle = cs[i % 4]; g.fillRect(cx - 95 + (i * 41) % 190, cy - 30 + (i * 17) % 60, 16, 16); } }
    g.fillStyle = k.ink; g.font = 'bold 22px sans-serif'; g.fillText('READY TO HEAT', cx, cy + 62);
  });
}
function canMaterial(kind) {
  if (!canMats[kind]) { const t = canLabelTex(kind); canMats[kind] = new THREE.MeshLambertMaterial({ map: t }); }
  return canMats[kind];
}
// a can sitting on y=0 (its bottom), about 22 cm tall; Spam comes in a flat rectangular tin
function makeCan(kind) {
  if (kind === 'spam') {
    const g = new THREE.Group();
    const lab = canMaterial(kind);
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.11, 0.12), [CAN_TOP, CAN_TOP, CAN_TOP, CAN_TOP, lab, lab]); b.position.y = 0.055; g.add(b);
    const key = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.01, 0.03), CAN_TOP); key.position.set(0.05, 0.115, 0); g.add(key);
    return g;
  }
  const g = new THREE.Group();
  const c = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.2, 16), [canMaterial(kind), CAN_TOP, CAN_TOP]); c.position.y = 0.1; c.rotation.y = Math.PI; g.add(c);
  for (const y of [0.004, 0.198]) { const rim = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.006, 4, 16), CAN_TOP); rim.rotation.x = Math.PI / 2; rim.position.y = y; g.add(rim); }
  return g;
}
// food cooking on a metal plate: raw colours that brown as it cooks
const PLATE_MAT = new THREE.MeshPhongMaterial({ color: 0xb9bec6, specular: 0xffffff, shininess: 60 });
const RAW_COOKED = {
  venison: [new THREE.Color(0xa3242a), new THREE.Color(0x5a2f16)],
  rabbit: [new THREE.Color(0xe8a8a0), new THREE.Color(0xb27438)],
  fish: [new THREE.Color(0xa9bccb), new THREE.Color(0xc89458)],
};
function makeDish(art) {
  const g = new THREE.Group();
  if (art.startsWith('can:')) {             // an open, labelled can heating up
    const c = makeCan(art.slice(4)); g.add(c);
    const lid = new THREE.Mesh(new THREE.CircleGeometry(0.08, 14), new THREE.MeshLambertMaterial({ color: 0x8a4a22 })); lid.rotation.x = -Math.PI / 2; lid.position.y = art === 'can:spam' ? 0.112 : 0.196; if (art === 'can:spam') lid.scale.set(1.2, 0.7, 1); g.add(lid);
    g.userData = { mats: [] }; return g;
  }
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.16, 0.025, 22), PLATE_MAT); plate.position.y = 0.0125; g.add(plate);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.012, 5, 22), PLATE_MAT); rim.rotation.x = Math.PI / 2; rim.position.y = 0.027; g.add(rim);
  const mat = new THREE.MeshLambertMaterial({ color: RAW_COOKED[art] ? RAW_COOKED[art][0] : 0x884422 });
  const mats = [mat];
  if (art === 'venison') {           // a thick steak with a fat edge
    const steak = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.04, 18), mat); steak.scale.set(1.25, 1, 0.85); steak.position.y = 0.05; g.add(steak);
    const fatMat = new THREE.MeshLambertMaterial({ color: 0xf2e6d6 }); mats.push(fatMat);
    const fat = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.012, 4, 18, Math.PI * 0.8), fatMat); fat.rotation.x = Math.PI / 2; fat.scale.set(1.25, 0.85, 1); fat.position.y = 0.05; g.add(fat);
  } else if (art === 'rabbit') {     // a small roast rabbit: body and two legs
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 9), mat); body.scale.set(1.6, 0.75, 0.9); body.position.y = 0.075; g.add(body);
    for (const s of [-1, 1]) { const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.025, 0.09, 4, 8), mat); leg.rotation.z = Math.PI / 2 + s * 0.2; leg.rotation.y = s * 0.5; leg.position.set(-0.12, 0.05, s * 0.05); g.add(leg); }
  } else if (art === 'fish') {       // a whole trout with tail and eye
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.06, 14, 10), mat); body.scale.set(2.6, 0.7, 0.9); body.position.y = 0.06; g.add(body);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.08, 4), mat); tail.rotation.z = -Math.PI / 2; tail.scale.set(1, 1, 0.3); tail.position.set(0.18, 0.06, 0); g.add(tail);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.008, 6, 4), new THREE.MeshBasicMaterial({ color: 0x111111 })); eye.position.set(-0.12, 0.072, 0.045); g.add(eye);
    const lineMat = new THREE.MeshLambertMaterial({ color: 0x5a3a20 }); mats.push(lineMat);
    for (let k = 0; k < 3; k++) { const grill = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.005, 0.1), lineMat); grill.position.set(-0.06 + k * 0.06, 0.103, 0); g.add(grill); }
  }
  g.userData = { mats, art };
  return g;
}
// show the right dish for a pot state; k = 0 raw .. 1 cooked
function syncDish(holder, art, k) {
  if (holder.userData.art !== art) {
    if (holder.userData.dish) holder.remove(holder.userData.dish);
    holder.userData.dish = art ? makeDish(art) : null; holder.userData.art = art;
    if (holder.userData.dish) holder.add(holder.userData.dish);
  }
  const d = holder.userData.dish; if (!d || !RAW_COOKED[art]) return;
  d.userData.mats[0].color.copy(RAW_COOKED[art][0]).lerp(RAW_COOKED[art][1], clamp(k, 0, 1));
  if (d.userData.mats[1] && art === 'venison') d.userData.mats[1].color.setHex(0xf2e6d6).lerp(new THREE.Color(0xc8904a), clamp(k, 0, 1));
}

// keep a row of shelf slots showing whichever cans are actually there
function syncCanSlots(slots, list, parent) {
  slots.forEach((slot, i) => {
    const want = list && i < list.length ? list[i] : null;
    if (slot.kind === want) return;
    if (slot.mesh) { parent.remove(slot.mesh); slot.mesh = null; }
    slot.kind = want;
    if (want) { slot.mesh = makeCan(want); slot.mesh.position.copy(slot.pos); slot.mesh.rotation.y = slot.ry || 0; parent.add(slot.mesh); }
  });
}

function signTex(text) {
  return canvasTex(1024, 190, (g, w, h) => {
    g.fillStyle = '#5a3a20'; g.fillRect(0, 0, w, h); g.strokeStyle = '#2a190d'; g.lineWidth = 14; g.strokeRect(7, 7, w - 14, h - 14);
    let fs = 120; g.font = `bold ${fs}px Georgia, serif`;
    while (g.measureText(text).width > w - 80 && fs > 40) { fs -= 4; g.font = `bold ${fs}px Georgia, serif`; }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(0,0,0,.5)'; g.fillText(text, w / 2 + 4, h / 2 + 10);
    g.fillStyle = '#fff2d2'; g.fillText(text, w / 2, h / 2 + 6);
  });
}

function buildCabin(c) {
  LOGTEX = LOGTEX || logTex(); GLOWTEX = GLOWTEX || glowSprite();
  const g = new THREE.Group(); g.position.set(c.x, c.base, c.z); g.rotation.y = c.rot; scene.add(g); c.group = g;
  const wall = ashMat(new THREE.MeshLambertMaterial({ map: LOGTEX }), 0x4a4440);
  const plank = new THREE.MeshLambertMaterial({ color: 0x7b5a3c });
  const dark = new THREE.MeshLambertMaterial({ color: 0x23242a });
  const snowM = ashMat(new THREE.MeshLambertMaterial({ color: 0xf2f6fc }), 0x8a857f);
  const stone = new THREE.MeshLambertMaterial({ color: 0x7a7670 });
  const box = (w, h, d, m, x, y, z) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); g.add(o); return o; };
  const T = 0.35, H = 3, Y0 = 0.3, hw = CABIN_W / 2, hd = CABIN_D / 2;
  box(CABIN_W + 0.6, 0.3, CABIN_D + 0.6, plank, 0, 0.15, 0);
  box(CABIN_W + 2 * T, H, T, wall, 0, Y0 + H / 2, -hd - T / 2);
  box(T, H, CABIN_D + 2 * T, wall, -hw - T / 2, Y0 + H / 2, 0);
  box(T, H, CABIN_D + 2 * T, wall, hw + T / 2, Y0 + H / 2, 0);
  const fw = hw + T - 0.8;
  box(fw, H, T, wall, -(0.8 + fw / 2), Y0 + H / 2, hd + T / 2);
  box(fw, H, T, wall, 0.8 + fw / 2, Y0 + H / 2, hd + T / 2);
  box(1.6, 0.8, T, wall, 0, Y0 + 2.6, hd + T / 2);
  // the door swings on hinges at the right side of the doorway
  c.door = new THREE.Group(); c.door.position.set(0.8, Y0, hd + T / 2); g.add(c.door);
  const doorM = new THREE.MeshLambertMaterial({ color: 0x6e4f33 });
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(1.58, 2.2, 0.09), doorM); leaf.position.set(-0.8, 1.1, 0); c.door.add(leaf);
  for (const y of [0.35, 1.1, 1.85]) { const brace = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.14, 0.04), plank); brace.position.set(-0.8, y, 0.06); c.door.add(brace); const b2 = brace.clone(); b2.position.z = -0.06; c.door.add(b2); }
  for (const z of [0.09, -0.09]) { const knob = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshLambertMaterial({ color: 0xb8a24a })); knob.position.set(-1.42, 1.05, z); c.door.add(knob); }
  c.doorAngle = 1.75;
  // gables + roof
  for (const sz of [-1, 1]) box(CABIN_W + 2 * T, 0.32, T, wall, 0, Y0 + H + 0.16, sz * (hd + T / 2));
  const span = hd + T + 0.3, rise = span * Math.tan(0.5);
  const tri = new THREE.Shape([new THREE.Vector2(-hd - T, 0), new THREE.Vector2(hd + T, 0), new THREE.Vector2(0, rise - 0.1)]);
  for (const s of [-1, 1]) { const gm = new THREE.Mesh(new THREE.ShapeGeometry(tri), new THREE.MeshLambertMaterial({ map: LOGTEX, side: THREE.DoubleSide })); gm.rotation.y = Math.PI / 2; gm.position.set(s * (hw + T / 2), Y0 + H, 0); g.add(gm); }
  const slabL = span / Math.cos(0.5) + 0.4;
  for (const s of [-1, 1]) {
    const roof = new THREE.Group(); roof.position.set(0, Y0 + H + rise / 2, s * span / 2); roof.rotation.x = s * 0.5; g.add(roof);
    const r1 = new THREE.Mesh(new THREE.BoxGeometry(CABIN_W + 1.8, 0.25, slabL), plank); roof.add(r1);
    if (s === 1) {   // solar panel for the radio, sitting on top of the snow on the front roof
      const frame = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 1.1), new THREE.MeshLambertMaterial({ color: 0xa8adb5 })); frame.position.set(3.2, 0.37, -0.5); roof.add(frame);
      const cells = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.03, 1.0), new THREE.MeshPhongMaterial({ color: 0x1b2a4a, specular: 0x8899cc, shininess: 70, emissive: 0x050a18 })); cells.position.set(3.2, 0.41, -0.5); roof.add(cells);
      for (let k = 1; k < 4; k++) { const line = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.032, 1.0), new THREE.MeshLambertMaterial({ color: 0x8890a0 })); line.position.set(3.2 - 0.75 + k * 0.375, 0.415, -0.5); roof.add(line); }
    }
    const r2 = new THREE.Mesh(new THREE.BoxGeometry(CABIN_W + 1.9, 0.22, slabL + 0.05), snowM); r2.position.y = 0.22; roof.add(r2);
  }
  // windows (both faces) on side walls + front right
  c.windows = [];
  const win = (x, z, ry) => { for (const off of [-0.2, 0.2]) { const w = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.0), winOff); w.position.set(x + Math.sin(ry) * off, Y0 + 1.75, z + Math.cos(ry) * off); w.rotation.y = ry + (off < 0 ? Math.PI : 0); g.add(w); c.windows.push(w); }
    const fr = box(Math.abs(Math.sin(ry)) > 0.5 ? 0.5 : 1.5, 0.12, Math.abs(Math.sin(ry)) > 0.5 ? 1.5 : 0.5, plank, x, Y0 + 1.18, z); fr.material = snowM; };
  win(-hw - T / 2, 0.5, -Math.PI / 2); win(hw + T / 2, 0.5, Math.PI / 2); win(3.1, hd + T / 2, 0);
  // chimney + stove
  box(0.9, 3.6, 0.9, stone, STOVE[0], Y0 + H + 1.6, STOVE[1] - 0.2);
  const [chx, chz] = toWorld(c, STOVE[0], STOVE[1] - 0.2);
  c.chimneyTop = new THREE.Vector3(chx, c.base + Y0 + H + 3.5, chz);
  box(1.1, 0.9, 0.8, dark, STOVE[0], Y0 + 0.5, STOVE[1]);
  box(1.2, 0.08, 0.9, dark, STOVE[0], Y0 + 0.97, STOVE[1]);
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 2.3), dark); pipe.position.set(STOVE[0], Y0 + 2.1, STOVE[1] - 0.2); g.add(pipe);
  c.stoveGlow = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const sd = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.4), c.stoveGlow); sd.position.set(STOVE[0], Y0 + 0.5, STOVE[1] + 0.41); g.add(sd);
  c.pot = new THREE.Group(); c.pot.position.set(STOVE[0] + 0.2, Y0 + 1.01, STOVE[1] + 0.05); c.pot.userData = {}; g.add(c.pot);
  c.steam = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOWTEX, color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }));
  c.steam.scale.set(0.5, 0.8, 1); c.steam.position.set(STOVE[0] + 0.25, Y0 + 1.6, STOVE[1]); g.add(c.steam);
  // woodbox with stack
  const [wx, wz] = WOODBOX;
  box(0.9, 0.08, 1.5, plank, wx, Y0 + 0.05, wz); box(0.06, 0.6, 1.5, plank, wx - 0.42, Y0 + 0.32, wz); box(0.06, 0.6, 1.5, plank, wx + 0.42, Y0 + 0.32, wz);
  box(0.9, 0.6, 0.06, plank, wx, Y0 + 0.32, wz - 0.72); box(0.9, 0.6, 0.06, plank, wx, Y0 + 0.32, wz + 0.72);
  c.woodLogs = [];
  const logM = new THREE.MeshLambertMaterial({ color: 0x7a5132 }), logGeo = new THREE.CylinderGeometry(0.12, 0.12, 1.3, 7).rotateX(Math.PI / 2);
  for (let i = 0; i < 12; i++) { const l = new THREE.Mesh(logGeo, logM); l.position.set(wx - 0.27 + (i % 3) * 0.27, Y0 + 0.2 + Math.floor(i / 3) * 0.2, wz); g.add(l); c.woodLogs.push(l); }
  // table, candles, shelf
  box(1.7, 0.08, 1.1, plank, 2, Y0 + 0.85, 0.55);
  for (const [x, z] of [[1.25, 0.1], [2.75, 0.1], [1.25, 1.0], [2.75, 1.0]]) box(0.08, 0.85, 0.08, plank, x, Y0 + 0.42, z);
  box(0.6, 0.06, 1.0, plank, 4.68, 1.48, 1.6);
  c.candleFlames = [];
  const wax = new THREE.MeshLambertMaterial({ color: 0xf1e6cc });
  for (const [x, z, y] of CANDLES) {
    const cd = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.24, 8), wax); cd.position.set(x, y - 0.0, z); g.add(cd);
    const fl = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOWTEX, color: 0xffd08a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    fl.scale.set(0.35, 0.5, 1); fl.position.set(x, y + 0.2, z); g.add(fl); c.candleFlames.push(fl);
  }
  // pantry
  const [px, pz] = PANTRY;
  box(0.04, 1.9, 1.5, plank, 4.96, Y0 + 0.95, pz);                                   // back
  for (const s of [-1, 1]) box(0.55, 1.9, 0.05, plank, 4.68, Y0 + 0.95, pz + s * 0.73); // sides
  for (const y of [0.04, 0.62, 1.22, 1.88]) box(0.55, 0.05, 1.46, plank, 4.68, Y0 + y, pz); // shelves
  c.canSlots = [0, 1, 2, 3].map((i) => ({ pos: new THREE.Vector3(4.66, Y0 + 0.645, pz - 0.5 + i * 0.33), ry: -Math.PI / 2, kind: null, mesh: null }));
  c.cabinGroup = g;
  for (let k = 0; k < 3; k++) { const jar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.18, 10), new THREE.MeshLambertMaterial({ color: [0xd8b06a, 0xb85a3a, 0xe8e0c8][k], transparent: true, opacity: 0.85 })); jar.position.set(4.68, Y0 + 1.34, pz - 0.35 + k * 0.35); g.add(jar); }
  // bed + rug
  box(2.2, 0.45, 1.3, plank, -2.8, Y0 + 0.23, 2.9);
  box(1.9, 0.12, 1.22, new THREE.MeshLambertMaterial({ color: 0x8c2f2a }), -2.65, Y0 + 0.5, 2.9);
  box(0.45, 0.12, 0.9, new THREE.MeshLambertMaterial({ color: 0xece4d4 }), -3.6, Y0 + 0.52, 2.9);
  box(3.2, 0.02, 2.2, new THREE.MeshLambertMaterial({ color: 0x5b3a52 }), 0, Y0 + 0.01, 0.2);
  // name sign over door
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.78), (() => { const t = signTex(c.name); return new THREE.MeshBasicMaterial({ map: t, color: 0xd8d0c0 }); })());
  sign.position.set(0, Y0 + 2.6, hd + T + 0.04); g.add(sign);
  const signLamp = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOWTEX, color: 0xffe0a0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55 }));
  signLamp.scale.set(0.6, 0.6, 1); signLamp.position.set(0, Y0 + 3.1, hd + T + 0.3); g.add(signLamp);
  // interior light, beacon glow, chimney smoke
  c.light = new THREE.PointLight(0xff9a4a, 0, 15, 1); c.light.position.set(-1.6, Y0 + 2.2, -1.2); g.add(c.light);
  c.beacon = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOWTEX, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  c.beacon.scale.set(22, 22, 1); c.beacon.position.set(0, Y0 + H + 3, 0); g.add(c.beacon);
  c.smoke = makeSmoke(c.chimneyTop); scene.add(c.smoke);

  // collision boxes in local space [minX, maxX, minZ, maxZ]
  const e = hw + T;
  c.solids = [
    [-e, e, -hd - T, -hd], [-e, -hw, -hd - T, hd + T], [hw, e, -hd - T, hd + T],
    [-e, -0.8, hd, hd + T], [0.8, e, hd, hd + T],
    [STOVE[0] - 0.6, STOVE[0] + 0.6, STOVE[1] - 0.45, STOVE[1] + 0.45],
    [1.15, 2.85, 0.0, 1.1], [px + 0.2, e, pz - 0.75, pz + 0.75], [-3.9, -1.7, 2.25, 3.55], [wx - 0.45, wx + 0.45, wz - 0.75, wz + 0.75],
  ];

  // regional props
  if (c.region === 'mill') {
    const wheel = new THREE.Group(); const wm = new THREE.MeshLambertMaterial({ color: 0x5a3e28 });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.16, 6, 24), wm); wheel.add(rim);
    for (let i = 0; i < 8; i++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(0.14, 5.2, 0.14), wm); sp.rotation.z = (i / 8) * Math.PI; wheel.add(sp);
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.9), snowM); pad.position.set(Math.cos(i / 8 * 6.283) * 2.6, Math.sin(i / 8 * 6.283) * 2.6, 0); pad.rotation.z = i / 8 * 6.283; wheel.add(pad); }
    wheel.rotation.y = Math.PI / 2; wheel.position.set(hw + 1.2, 2.4, -1); g.add(wheel); c.wheel = wheel;
    const ice = new THREE.Mesh(new THREE.PlaneGeometry(4, 40), iceMat); ice.rotation.x = -Math.PI / 2; ice.position.set(hw + 1.2, 0.04, -1); g.add(ice);
  }
  if (c.region === 'hollow') {
    c.wisps = [];
    for (let i = 0; i < 9; i++) {
      const w = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOWTEX, color: 0x9bf0ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6 }));
      w.scale.set(0.9, 0.9, 1); w.userData = { a: i * 0.7, r: 14 + (i * 7) % 18, y: 1.2 + (i % 3) * 0.6 }; scene.add(w); c.wisps.push(w);
    }
  }
  // solar radio on the right-hand wall, with its little panel on the roof
  const radio = new THREE.Group(); radio.position.set(RADIO[0], Y0 + 1.45, RADIO[1]); radio.rotation.y = -Math.PI / 2; g.add(radio);
  const rbody = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.36, 0.2), new THREE.MeshLambertMaterial({ color: 0x3a3f36 })); radio.add(rbody);
  const rgrill = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.24), new THREE.MeshLambertMaterial({ color: 0x15171a })); rgrill.position.set(-0.13, 0, 0.101); radio.add(rgrill);
  c.radioDial = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.09), new THREE.MeshBasicMaterial({ color: 0x6b5a2a })); c.radioDial.position.set(0.15, 0.06, 0.101); radio.add(c.radioDial);
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.6), dark); ant.position.set(0.25, 0.45, 0); ant.rotation.z = -0.3; radio.add(ant);
  const shelf = box(0.3, 0.05, 0.8, plank, RADIO[0] - 0.05, Y0 + 1.25, RADIO[1]);
  // cable from the solar panel, down the right-hand gable, through the wall to the radio
  const cableM = new THREE.MeshLambertMaterial({ color: 0x15161a });
  const cable = (a, b) => {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), len = A.distanceTo(B);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, len, 5), cableM);
    m.position.copy(A).add(B).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize()); g.add(m);
  };
  const gx = hw + T + 0.03, pY = Y0 + H + 1.82;
  cable([4.0, pY, 2.06], [gx, Y0 + H + 1.55, 2.0]);               // across the roof to the edge
  cable([gx, Y0 + H + 1.55, 2.0], [gx, Y0 + H + 0.1, 0.9]);         // down the gable
  cable([gx, Y0 + H + 0.1, 0.9], [gx, Y0 + 1.62, -0.9]);            // down the wall
  cable([gx, Y0 + 1.62, -0.9], [RADIO[0] + 0.08, Y0 + 1.62, RADIO[1]]);   // in through the wall
  for (const [cy, cz] of [[Y0 + H - 0.3, 0.55], [Y0 + 2.3, -0.3]]) { const clip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.06), new THREE.MeshLambertMaterial({ color: 0x8a8f99 })); clip.position.set(gx - 0.01, cy, cz); g.add(clip); }

  // chopping block out front (an axe turns up here on day 2)
  const stump = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.48, 0.6, 10), new THREE.MeshLambertMaterial({ color: 0x6a4a30 }));
  stump.position.set(3.6, 0.3, 6.3); g.add(stump);
  const stumpTop = new THREE.Mesh(new THREE.CircleGeometry(0.42, 12), new THREE.MeshLambertMaterial({ color: 0xc9a77a })); stumpTop.rotation.x = -Math.PI / 2; stumpTop.position.set(3.6, 0.61, 6.3); g.add(stumpTop);
}

function makeSmoke(origin) {
  const n = 28, seeds = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { seeds[i * 2] = i / n; seeds[i * 2 + 1] = Math.random(); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); g.setAttribute('seed', new THREE.BufferAttribute(seeds, 2));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uT: clockU, uO: { value: origin }, uA: { value: 0 }, uWind: { value: new THREE.Vector2(1, 0) }, uCol: { value: new THREE.Color(0x8a8f99) } },
    vertexShader: `uniform float uT; uniform vec3 uO; uniform vec2 uWind; attribute vec2 seed; varying float vA;
      void main(){ float t = fract(uT*0.13 + seed.x); vec3 p = uO + vec3(uWind.x*t*t*9. + sin(seed.y*30.+uT)*0.4*t, t*10., uWind.y*t*t*9. + cos(seed.y*20.+uT)*0.4*t);
        vec4 mv = viewMatrix*vec4(p,1.); gl_Position = projectionMatrix*mv; gl_PointSize = (90. + t*260.)/-mv.z; vA = (1.-t)*smoothstep(0.,0.08,t); }`,
    fragmentShader: `uniform float uA; uniform vec3 uCol; varying float vA; void main(){ float d = length(gl_PointCoord-0.5); if(d>0.5) discard; gl_FragColor = vec4(uCol, (1.-d*2.)*vA*uA*0.55); }`,
  });
  const pts = new THREE.Points(g, mat); pts.frustumCulled = false; return pts;
}

function buildLandmarks() {
  // trailhead signpost pointing to every cabin
  const g = new THREE.Group(); g.position.set(SPAWN.x, spawnBase, SPAWN.z); scene.add(g);
  const wood = new THREE.MeshLambertMaterial({ color: 0x5a3e28 });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 4.4), wood); post.position.y = 2.2; g.add(post);
  cabins.forEach((c, i) => {
    const a = Math.atan2(c.x - SPAWN.x, c.z - SPAWN.z);
    const arm = new THREE.Group(); arm.position.y = 3.8 - i * 0.55; arm.rotation.y = a - Math.PI / 2; g.add(arm);
    const tex = canvasTex(512, 96, (gg, w, h) => { gg.fillStyle = '#6b4a2e'; gg.beginPath(); gg.moveTo(0, 8); gg.lineTo(w - 50, 8); gg.lineTo(w - 4, h / 2); gg.lineTo(w - 50, h - 8); gg.lineTo(0, h - 8); gg.fill();
      gg.fillStyle = '#f3e3c3'; gg.font = 'bold 46px Georgia, serif'; gg.textBaseline = 'middle'; gg.fillText(c.name, 18, h / 2 + 2); });
    const board = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.42), new THREE.MeshLambertMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }));
    board.position.x = 1.15; arm.add(board);
  });
  // big bonfire in a stone ring
  const bf = new THREE.Group(); bf.position.set(3.5, 0, -2); g.add(bf);
  for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2, st = new THREE.Mesh(new THREE.DodecahedronGeometry(0.42, 0), new THREE.MeshLambertMaterial({ color: 0x6f6b66 })); st.position.set(Math.cos(a) * 1.9, 0.2, Math.sin(a) * 1.9); st.rotation.set(a, a * 2, 0); bf.add(st); }
  const logMat = new THREE.MeshLambertMaterial({ color: 0x5a3a22 });
  for (let k = 0; k < 7; k++) { const a = k / 7 * Math.PI * 2, l = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 2.6, 7), logMat); l.position.set(Math.cos(a) * 0.55, 1.0, Math.sin(a) * 0.55); l.rotation.set(Math.sin(a) * 0.45, 0, -Math.cos(a) * 0.45); bf.add(l); }
  const embers = new THREE.Mesh(new THREE.CircleGeometry(1.1, 16), new THREE.MeshBasicMaterial({ color: 0x2a1408 })); embers.rotation.x = -Math.PI / 2; embers.position.y = 0.06; bf.add(embers);
  const flames = [];
  for (let k = 0; k < 9; k++) { const f = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOWTEX || (GLOWTEX = glowSprite()), color: k % 3 ? 0xff9a3c : 0xffd27a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); f.userData = { ph: k * 1.3, r: (k % 4) * 0.22 }; bf.add(f); flames.push(f); }
  const fl = new THREE.PointLight(0xff9a4a, 0, 30, 1.2); fl.position.y = 2; bf.add(fl);
  const smoke = makeSmoke(new THREE.Vector3(SPAWN.x + 3.5, spawnBase + 3, SPAWN.z - 2)); scene.add(smoke);
  BONFIRE_FX = { flames, light: fl, embers, smoke, logMat };
  // summit radio mast with a blinking light, visible from everywhere
  const sc = cabins.find((c) => c.region === 'summit');
  if (sc) {
    const [mx, mz] = toWorld(sc, 0, -14), mb = heightFn(mx, mz);
    const steel = new THREE.MeshLambertMaterial({ color: 0x8a8f99 });
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.35, 22, 6), steel); m.position.set(mx, mb + 11, mz); scene.add(m);
    mast = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex('rgba(255,90,80,1)', 'rgba(255,40,30,0.3)'), fog: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    mast.scale.set(5, 5, 1); mast.position.set(mx, mb + 22.4, mz); scene.add(mast);
    MAST_TOP = new THREE.Vector3(mx, mb + 21.5, mz + 2);
  }
}

function buildSnow() {
  const n = quality === 'pi' ? 2200 : 5000;
  const seeds = new Float32Array(n * 4); for (let i = 0; i < n * 4; i++) seeds[i] = Math.random();
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); g.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uT: clockU, uCam: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector3(70, 36, 70) }, uWind: { value: new THREE.Vector2() }, uFall: { value: 2.2 }, uDen: { value: 0.35 }, uCol: { value: new THREE.Color(0xffffff) } },
    vertexShader: `uniform float uT; uniform vec3 uCam; uniform vec3 uBox; uniform vec2 uWind; uniform float uFall; uniform float uDen; attribute vec4 seed; varying float vA;
      void main(){ vec3 p = seed.xyz*uBox; float s = 0.6 + seed.w*0.8;
        p.y -= uT*uFall*s; p.x += uT*uWind.x*s + sin(uT*0.7 + seed.w*20.)*0.7; p.z += uT*uWind.y*s + cos(uT*0.6 + seed.w*17.)*0.7;
        vec3 rel = mod(p - uCam + uBox*0.5, uBox) - uBox*0.5; vec4 mv = viewMatrix*vec4(uCam + rel, 1.);
        gl_Position = projectionMatrix*mv; gl_PointSize = clamp((1.5 + seed.w*2.5) * (40. / max(-mv.z, 0.5)), 1.0, 7.0);
        vA = step(seed.w, uDen) * smoothstep(uBox.x*0.5, uBox.x*0.3, length(rel.xz)) * smoothstep(0.6, 2.5, -mv.z); }`,
    fragmentShader: `uniform vec3 uCol; varying float vA; void main(){ float d = length(gl_PointCoord-0.5); if(d>0.5 || vA<0.01) discard; gl_FragColor = vec4(uCol, vA*(1.-d*2.)*0.9); }`,
  });
  snow = new THREE.Points(g, mat); snow.frustumCulled = false; scene.add(snow);
}

// ------------------------------------------------------------- logs (pool)
const logMeshes = new Map();
let logGeoW, logMatW, logRingMat;
function syncLogs(list) {
  if (!logGeoW) {
    logGeoW = new THREE.CylinderGeometry(0.27, 0.31, 1.9, 9).rotateZ(Math.PI / 2);
    logMatW = new THREE.MeshLambertMaterial({ color: 0xa8743f, emissive: 0x3a200c });
    logRingMat = new THREE.MeshBasicMaterial({ color: 0xffc070, transparent: true, opacity: 0.0, depthWrite: false });
  }
  const seen = new Set();
  for (const [id, x, z, r] of list) {
    seen.add(id);
    if (!logMeshes.has(id)) {
      const m = new THREE.Mesh(logGeoW, logMatW); m.position.set(x, groundAt(x, z) + 0.28, z); m.rotation.y = r; scene.add(m);
      m.userData = { id, x, z }; logMeshes.set(id, m);
    }
  }
  for (const [id, m] of logMeshes) if (!seen.has(id)) { scene.remove(m); logMeshes.delete(id); }
}

// ------------------------------------------------------------------- story
// Day 2 axes + animals, day 3 rods + ice holes, day 4 helicopter, day 5 sirens, radio, bunker and the bomb.
let WINFO = null;
const itemMeshes = new Map();
const animalMeshes = new Map();
let heli = null, bunkerHatches = [], bunkerRoom = null, holeMeshes = [];
let MAST_TOP = new THREE.Vector3(0, 120, -220), ASHK = 0, BONFIRE_FX = null;
let viewAxe = null, viewRod = null, swingT = 0, bobber = null;
let lastDay = 0, impactSeen = false, shakeT = 0, sirenWasOn = false;
const ROOM_DEPTH = 32;   // the shelter is this far under its hatch

const PART_NAMES = { battery: 'battery', fuel: 'fuel can', rotor: 'rotor blade' };
const PART_FROM = { battery: 'Summit Lookout', fuel: 'Old Mill', rotor: 'Hollow End' };
const FOOD_NAMES = { stew: 'stew', meat: 'venison', fish: 'trout' };
function dishName(art, kind) {
  if (art === 'rabbit') return 'roast rabbit'; if (art === 'venison') return 'venison steak'; if (art === 'fish') return 'pan-fried trout';
  if (art && art.startsWith('can:')) return 'hot ' + CAN_INFO[art.slice(4)].name; return 'hot ' + FOOD_NAMES[kind];
}
const FOOD_TIME = { stew: 20, meat: 25, fish: 15 };

function std(color, extra) { return new THREE.MeshLambertMaterial({ color, ...(extra || {}) }); }

function makeAxeMesh() {
  const g = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.85, 7), std(0x9a6b3e)); handle.position.y = 0.42; g.add(handle);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.13, 0.05), std(0x8d949e, { emissive: 0x111418 })); head.position.set(0.09, 0.8, 0); g.add(head);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.052), std(0xd6dde6, { emissive: 0x222222 })); edge.position.set(0.23, 0.8, 0); g.add(edge);
  return g;
}
function makeRodMesh() {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.03, 1.9, 6), std(0x2d3a2a)); pole.position.y = 0.95; g.add(pole);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.35, 8), std(0xb98b55)); grip.position.y = 0.2; g.add(grip);
  const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 12), std(0xc0c4cc, { emissive: 0x222222 })); reel.rotation.z = Math.PI / 2; reel.position.set(0.05, 0.42, 0); g.add(reel);
  return g;
}
function makePartMesh(kind) {
  const g = new THREE.Group();
  if (kind === 'battery') {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.36, 0.32), std(0x24262b)); b.position.y = 0.18; g.add(b);
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.32), std(0x3a6fd8)); top.position.y = 0.38; g.add(top);
    for (const [x, c] of [[-0.15, 0xd9362b], [0.15, 0x111111]]) { const t = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.07, 8), std(c)); t.position.set(x, 0.43, 0); g.add(t); }
  } else if (kind === 'fuel') {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.55, 0.2), std(0xc8261e)); b.position.y = 0.28; g.add(b);
    const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.14, 8), std(0xd8b03a)); sp.position.set(0.12, 0.6, 0); sp.rotation.z = -0.5; g.add(sp);
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.06), std(0x8a1a14)); h.position.set(-0.05, 0.6, 0); g.add(h);
  } else {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.05, 0.3), std(0x2c3036)); blade.position.y = 0.12; g.add(blade);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.052, 0.3), std(0xe8c23a)); tip.position.set(1.65, 0.12, 0); g.add(tip);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.12, 10), std(0x7a7f88)); hub.position.set(-1.8, 0.12, 0); g.add(hub);
  }
  return g;
}

function buildStory(world) {
  WINFO = world;
  // ice holes on the frozen lake
  const holeM = new THREE.MeshBasicMaterial({ color: 0x08131f });
  const rimM = std(0xf2f6fc);
  for (const [x, z] of world.holes) {
    const g = new THREE.Group(); g.position.set(x, ICE_Y + 0.04, z); scene.add(g);
    const hole = new THREE.Mesh(new THREE.CircleGeometry(0.55, 18), holeM); hole.rotation.x = -Math.PI / 2; g.add(hole);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.12, 5, 18), rimM); rim.rotation.x = -Math.PI / 2; g.add(rim);
    g.visible = false; holeMeshes.push(g);
  }
  // rod rack on the land end of the dock
  const lc = cabins.find((c) => c.region === 'lake');
  if (lc) {
    const ux = lc.x - LAKE.x, uz = lc.z - LAKE.z, d = Math.hypot(ux, uz), dx = ux / d, dz = uz / d;
    const sx = LAKE.x + dx * (LAKE.r - 2) + dx * 6 - dx * 1.2, sz = LAKE.z + dz * (LAKE.r - 2) + dz * 6 - dz * 1.2;
    const rack = new THREE.Group(); rack.position.set(sx, Math.max(ICE_Y + 0.55, heightFn(sx, sz) + 0.05), sz); rack.rotation.y = Math.atan2(dx, dz); scene.add(rack);
    const wood = std(0x6b4a32);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.08, 0.08), wood); bar.position.set(0, 1.3, -0.3); rack.add(bar);
    for (const x of [-1.15, 1.15]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.4, 0.1), wood); post.position.set(x, 0.7, -0.3); rack.add(post); }
  }
  // helipad + helicopter
  const [hx, hz] = world.helipad, hb = heightFn(hx, hz);
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 0.3, 32), std(0x6d7076)); pad.position.set(hx, hb + 0.1, hz); scene.add(pad);
  const hTex = canvasTex(256, 256, (g, w) => { g.fillStyle = '#6d7076'; g.fillRect(0, 0, w, w); g.strokeStyle = '#f1f1f1'; g.lineWidth = 14; g.beginPath(); g.arc(w / 2, w / 2, w / 2 - 14, 0, 7); g.stroke(); g.fillStyle = '#f1f1f1'; g.font = 'bold 150px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('H', w / 2, w / 2 + 8); });
  const hMark = new THREE.Mesh(new THREE.CircleGeometry(6.6, 32), new THREE.MeshLambertMaterial({ map: hTex })); hMark.rotation.x = -Math.PI / 2; hMark.position.set(hx, hb + 0.26, hz); scene.add(hMark);
  heli = buildHelicopter(); heli.g.position.set(hx, hb + 0.25, hz); heli.g.rotation.y = 0.6; heli.base = hb + 0.25; scene.add(heli.g);
  // the bunker hatches (only the real one is shown) and the room beneath
  for (const [bx, bz] of world.bunkers) {
    const b = heightFn(bx, bz), g = new THREE.Group(); g.position.set(bx, b, bz); scene.add(g);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.5, 3.6), std(0x8a8c88)); slab.position.y = 0.2; g.add(slab);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.16, 20), std(0x4f6b4a, { emissive: 0x0a0f0a })); lid.position.y = 0.52; g.add(lid);
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.05, 6, 16), std(0xb8a24a)); wheel.rotation.x = -Math.PI / 2; wheel.position.y = 0.64; g.add(wheel);
    const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.6, 10), std(0x6a6d70)); vent.position.set(1.4, 1.0, -1.4); g.add(vent);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.3, 10), std(0x6a6d70)); cap.position.set(1.4, 1.9, -1.4); g.add(cap);
    const signT = canvasTex(256, 256, (c, w) => { c.fillStyle = '#f2c230'; c.fillRect(0, 0, w, w); c.fillStyle = '#111'; c.beginPath(); c.arc(w / 2, w / 2, 26, 0, 7); c.fill();
      for (let k = 0; k < 3; k++) { const a = k * 2.094 - 1.571; c.beginPath(); c.moveTo(w / 2, w / 2); c.arc(w / 2, w / 2, 100, a - 0.52, a + 0.52); c.closePath(); c.fill(); }
      c.fillStyle = '#f2c230'; c.beginPath(); c.arc(w / 2, w / 2, 36, 0, 7); c.fill(); c.fillStyle = '#111'; c.beginPath(); c.arc(w / 2, w / 2, 24, 0, 7); c.fill(); });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), new THREE.MeshLambertMaterial({ map: signT, emissive: 0x332200, side: THREE.DoubleSide }));
    sign.position.set(0, 1.25, 1.85); g.add(sign);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.2), std(0x555555)); post.position.set(0, 0.6, 1.83); g.add(post);
    const beacon = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex('rgba(255,80,60,1)', 'rgba(255,30,20,0.3)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
    beacon.scale.set(3, 3, 1); beacon.position.set(1.4, 2.2, -1.4); beacon.visible = false; g.add(beacon);
    g.userData = { beacon, base: b, x: bx, z: bz };
    g.visible = false; bunkerHatches.push(g);
  }
  bunkerRoom = buildBunkerRoom(); scene.add(bunkerRoom);
  buildBomb();
  // held tools
  viewAxe = makeAxeMesh(); viewAxe.scale.setScalar(0.7); viewAxe.position.set(0.42, -0.62, -0.75); viewAxe.rotation.set(-0.2, -0.3, -0.25); viewAxe.visible = false; camera.add(viewAxe);
  viewRod = makeRodMesh(); viewRod.scale.setScalar(0.85); viewRod.position.set(0.38, -0.7, -0.6); viewRod.rotation.set(-0.9, -0.2, -0.2); viewRod.visible = false; camera.add(viewRod);
  bobber = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), std(0xe8392b, { emissive: 0x551010 })); bobber.visible = false; scene.add(bobber);
}

function buildHelicopter() {
  const g = new THREE.Group();
  const body = std(0x2f4f3a), dark = std(0x222428), glass = new THREE.MeshPhongMaterial({ color: 0x9fc6e6, specular: 0xffffff, shininess: 80, transparent: true, opacity: 0.55 });
  const cab = new THREE.Mesh(new THREE.SphereGeometry(1.5, 16, 12), body); cab.scale.set(1, 0.9, 1.5); cab.position.y = 1.8; g.add(cab);
  const win = new THREE.Mesh(new THREE.SphereGeometry(1.52, 16, 12, 0, Math.PI * 2, 0, 1.1), glass); win.scale.set(0.95, 0.85, 1.45); win.position.set(0, 1.9, -0.25); win.rotation.x = -1.1; g.add(win);
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.4, 5.5, 8), body); boom.rotation.x = Math.PI / 2; boom.position.set(0, 2.2, 4.4); g.add(boom);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.3, 0.8), body); fin.position.set(0, 2.8, 7); g.add(fin);
  const tail = new THREE.Group(); tail.position.set(0.18, 2.9, 7.1); g.add(tail);
  for (let k = 0; k < 2; k++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.2, 0.12), dark); b.rotation.x = k * Math.PI / 2; tail.add(b); }
  for (const x of [-1.1, 1.1]) {
    const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.6, 6), dark); skid.rotation.x = Math.PI / 2; skid.position.set(x, 0.1, 0); g.add(skid);
    for (const z of [-0.9, 0.9]) { const st = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.75, 5), dark); st.position.set(x * 0.85, 0.45, z); st.rotation.z = x > 0 ? -0.35 : 0.35; g.add(st); }
  }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.6, 8), dark); mast.position.y = 3.35; g.add(mast);
  const rotor = new THREE.Group(); rotor.position.y = 3.68; g.add(rotor);
  const blades = [];
  for (let k = 0; k < 4; k++) { const b = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.05, 0.32), dark); b.position.x = 2.6; const arm = new THREE.Group(); arm.rotation.y = k * Math.PI / 2; arm.add(b); rotor.add(arm); blades.push(arm); }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.15, 10), dark); rotor.add(hub);
  const lamp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex('rgba(255,90,80,1)', 'rgba(255,40,30,0.3)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  lamp.scale.set(1.6, 1.6, 1); lamp.position.set(0, 0.4, 0); lamp.visible = false; g.add(lamp);
  return { g, rotor, tail, blades, lamp, spin: 0, alt: 0 };
}

function buildBunkerRoom() {
  // 12 x 8 m shelter. Local coords: ladder on the front wall (+z), TV on the left wall (-x),
  // electric burners on the right wall (+x), canned food on the back wall (-z).
  const g = new THREE.Group();
  const concrete = new THREE.MeshLambertMaterial({ color: 0x8b8e8a, side: THREE.BackSide });
  const shell = new THREE.Mesh(new THREE.BoxGeometry(12, 3.2, 8), concrete); shell.position.y = 1.6; g.add(shell);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 8), std(0x55585a)); floor.rotation.x = -Math.PI / 2; floor.position.y = 0.01; g.add(floor);
  const steel = std(0x5d6a5a), dark = std(0x26282b), wood = std(0x7b5a3c);
  // ladder up to the hatch
  const ladder = new THREE.Group(); ladder.position.set(0, 0, 3.8); g.add(ladder);
  for (const x of [-0.35, 0.35]) { const r = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 3.2), steel); r.position.set(x, 1.6, 0); ladder.add(r); }
  for (let k = 0; k < 8; k++) { const r = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.7), steel); r.rotation.z = Math.PI / 2; r.position.set(0, 0.3 + k * 0.38, 0); ladder.add(r); }
  // bunk beds in the front-left corner
  const mattress = std(0x7d8a6a);
  for (const y of [0.4, 1.5]) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 1.0), steel); f.position.set(-4.6, y, 3.2); g.add(f);
    const m = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.14, 0.9), mattress); m.position.set(-4.6, y + 0.12, 3.2); g.add(m);
  }
  // canned food on the back wall: 3 shelves x 8 cans
  const cans = [];
  for (let row = 0; row < 3; row++) {
    const y = 0.55 + row * 0.65;
    const sh = new THREE.Mesh(new THREE.BoxGeometry(9.6, 0.06, 0.45), wood); sh.position.set(0, y, -3.75); g.add(sh);
    for (const x of [-4.7, 0, 4.7]) { const br = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.2, 0.4), steel); br.position.set(x, y - 0.12, -3.78); g.add(br); }
    for (let k = 0; k < 8; k++) cans.push({ pos: new THREE.Vector3(-4.2 + k * 1.2, y + 0.03, -3.7), ry: 0, kind: null, mesh: null });
  }
  const sTex = canvasTex(512, 128, (c, w, h) => { c.fillStyle = '#f2c230'; c.fillRect(0, 0, w, h); c.fillStyle = '#111'; c.font = 'bold 64px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('FALLOUT SHELTER', w / 2, h / 2 + 4); });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.65), new THREE.MeshBasicMaterial({ map: sTex })); sign.position.set(0, 2.75, -3.97); g.add(sign);
  // five electric burners on a counter along the right wall, run off a battery bank
  const counter = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 6.2), std(0x6a6d70)); counter.position.set(5.5, 0.45, 0); g.add(counter);
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.05, 6.3), std(0x2f3236)); top.position.set(5.5, 0.92, 0); g.add(top);
  const burners = [];
  for (let i = 0; i < 5; i++) {
    const z = -2.4 + i * 1.2;
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.04, 18), dark); plate.position.set(5.45, 0.96, z); g.add(plate);
    const coilMat = new THREE.MeshBasicMaterial({ color: 0x331a14 });
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.025, 6, 20), coilMat); coil.rotation.x = -Math.PI / 2; coil.position.set(5.45, 0.99, z); g.add(coil);
    const pot = new THREE.Group(); pot.position.set(5.45, 1.0, z); pot.rotation.y = Math.PI / 2; pot.userData = {}; g.add(pot);
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 8), std(0x111111)); knob.rotation.z = Math.PI / 2; knob.position.set(5.03, 0.75, z); g.add(knob);
    burners.push({ coilMat, pot });
  }
  for (let k = 0; k < 3; k++) { const b = makePartMesh('battery'); b.position.set(5.4, 0.0, -1.6 + k * 1.6); b.rotation.y = Math.PI / 2; g.add(b); }
  // flat-screen TV on the left wall, fed by a car battery on the floor
  const tvFrame = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.35, 2.3), dark); tvFrame.position.set(-5.94, 1.85, 0); g.add(tvFrame);
  const tvMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const tv = new THREE.Mesh(new THREE.PlaneGeometry(2.16, 1.22), tvMat); tv.rotation.y = Math.PI / 2; tv.position.set(-5.89, 1.85, 0); g.add(tv);
  const labelTex = canvasTex(256, 40, (c, w, h) => { c.fillStyle = 'rgba(200,20,20,.9)'; c.fillRect(0, 0, 70, h); c.fillStyle = '#fff'; c.font = 'bold 24px sans-serif'; c.textBaseline = 'middle'; c.fillText('LIVE', 8, h / 2 + 1); c.fillStyle = 'rgba(0,0,0,.6)'; c.fillRect(70, 0, w - 70, h); c.fillStyle = '#fff'; c.font = '20px sans-serif'; c.fillText('SUMMIT CAM 1', 80, h / 2 + 1); });
  const label = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.1), new THREE.MeshBasicMaterial({ map: labelTex, transparent: true })); label.rotation.y = Math.PI / 2; label.position.set(-5.885, 2.38, -0.7); g.add(label);
  const carBat = makePartMesh('battery'); carBat.position.set(-5.5, 0, 1.5); carBat.rotation.y = Math.PI / 2; g.add(carBat);
  for (const [z, c] of [[1.42, 0xd9362b], [1.58, 0x111111]]) {
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.45, 5), std(c)); cable.position.set(-5.85, 0.95, z * 0.9); cable.rotation.x = 0.35; g.add(cable);
  }
  // Geiger counters hanging by the ladder
  const geigers = [];
  const hook = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.06), steel); hook.position.set(2.6, 1.72, 3.94); g.add(hook);
  for (let k = 0; k < 6; k++) {
    const gc = new THREE.Group(); gc.position.set(2.0 + k * 0.24, 1.45, 3.9); g.add(gc);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.24, 0.08), std(0xe8c23a)); gc.add(body);
    const dial = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.07), new THREE.MeshBasicMaterial({ color: 0xf2f2e8 })); dial.position.set(0, 0.05, -0.041); dial.rotation.y = Math.PI; gc.add(dial);
    geigers.push(gc);
  }
  // light
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff1c0 })); bulb.position.set(0, 3.0, 0); g.add(bulb);
  const light = new THREE.PointLight(0xffe2a8, 0, 16, 1); light.position.set(0, 2.8, 0); g.add(light);
  g.userData = { light, bulb, cans, burners, tv, tvMat, geigers };
  g.visible = false;
  return g;
}

// local positions of the bunker stations (room coords)
const BK_CAN = [0, -3.3, 1.2], BK_GEIGER = [2.6, 3.4, 1.45], BK_LADDER = [0, 3.4, 1.4];
const BK_BURNERS = [0, 1, 2, 3, 4].map((i) => [5.0, -2.4 + i * 1.2, 1.0]);

// ------------------------------------------------------------- the bomb
let bomb = null, tvTarget = null, tvCam = null, staticTex = null, ashMats = [], TREE_MAT = null, ROCK_MAT = null;
const GZ = { x: 20, z: -10 };
function ashMat(mat, to) { ashMats.push({ mat, from: mat.color.clone(), to: new THREE.Color(to) }); return mat; }
function applyAsh(k) {
  for (const a of ashMats) a.mat.color.copy(a.from).lerp(a.to, k);
}
function buildBomb() {
  const g = new THREE.Group(); scene.add(g);
  const warhead = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex('rgba(255,255,230,1)', 'rgba(255,170,90,0.4)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  warhead.scale.set(40, 40, 1); g.add(warhead);
  const trailGeo = new THREE.BufferGeometry(); trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(80 * 3), 3));
  const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0xfff1d0, transparent: true, opacity: 0.8, fog: false })); trail.frustumCulled = false; scene.add(trail);
  const gy = heightFn(GZ.x, GZ.z);
  const fireMat = new THREE.MeshBasicMaterial({ color: 0xfff6d0, transparent: true, fog: false, depthWrite: false });
  const fire = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18), fireMat); fire.position.set(GZ.x, gy, GZ.z); scene.add(fire);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xfff0d8, transparent: true, side: THREE.DoubleSide, fog: false, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 64), ringMat); ring.rotation.x = -Math.PI / 2; ring.position.set(GZ.x, gy + 3, GZ.z); scene.add(ring);
  const cloud = new THREE.Group(); cloud.position.set(GZ.x, gy, GZ.z); scene.add(cloud);
  const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffa860, emissive: 0xff6a20, transparent: true, fog: false, depthWrite: false });
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.75, 1, 18, 1, true), cloudMat); cloud.add(stem);
  const cap = new THREE.Group(); cloud.add(cap);
  for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2, b = new THREE.Mesh(new THREE.SphereGeometry(0.45, 14, 10), cloudMat); b.position.set(Math.cos(a) * 0.75, (k % 2) * 0.12, Math.sin(a) * 0.75); cap.add(b); }
  const crown = new THREE.Mesh(new THREE.SphereGeometry(0.75, 18, 12), cloudMat); crown.position.y = 0.25; crown.scale.y = 0.7; cap.add(crown);
  const skirt = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.18, 8, 24), cloudMat); skirt.rotation.x = Math.PI / 2; skirt.position.y = -0.45; cloud.add(skirt);
  fire.visible = ring.visible = cloud.visible = false;
  bomb = { g, warhead, trail, fire, fireMat, ring, ringMat, cloud, cloudMat, stem, cap, skirt, gy };
  // the summit camera that feeds the bunker TV
  tvTarget = new THREE.WebGLRenderTarget(quality === 'pi' ? 256 : 384, quality === 'pi' ? 144 : 216);
  tvCam = new THREE.PerspectiveCamera(62, 16 / 9, 1, 4200);
  tvCam.position.copy(MAST_TOP); tvCam.lookAt(GZ.x, gy + 120, GZ.z);
  staticTex = canvasTex(160, 90, () => {});
}
function bombTick(dt, t) {
  if (!bomb || !S) return;
  const W = WINFO, B = bomb, finale = S.day >= W.days;
  // incoming warhead between the sirens and the strike
  if (finale && S.siren && !S.impact) {
    const f = clamp((localTod - W.sirenTod) / (W.impactTod - W.sirenTod), 0, 1);
    const sx = 1900, sy = 2600, sz = -1700;
    const pos = (ff) => [lerp(sx, GZ.x, ff), lerp(sy, B.gy, ff * ff), lerp(sz, GZ.z, ff)];
    const [x, y, z] = pos(f); B.warhead.position.set(x, y, z);
    const arr = B.trail.geometry.attributes.position.array;
    for (let i = 0; i < 80; i++) { const [a, b2, c] = pos(Math.max(0, f - i * 0.005)); arr[i * 3] = a; arr[i * 3 + 1] = b2; arr[i * 3 + 2] = c; }
    B.trail.geometry.attributes.position.needsUpdate = true;
    B.g.visible = true; B.trail.visible = true;
  } else { B.g.visible = false; B.trail.visible = false; }
  // the blast
  if (finale && S.impact) {
    const a = impactAge;
    const fr = a < 2.5 ? 30 + a * 130 : 355 + (a - 2.5) * 6;
    B.fire.visible = a < 16; B.fire.scale.setScalar(Math.min(fr, 420));
    B.fire.position.y = B.gy + Math.min(fr * 0.6, 260) + a * 8;
    B.fireMat.opacity = clamp(1.1 - a / 14, 0, 1);
    B.fireMat.color.setHSL(lerp(0.15, 0.03, clamp(a / 8, 0, 1)), 1, lerp(0.95, 0.45, clamp(a / 10, 0, 1)));
    B.ring.visible = a < 12; const rr = a * 140; B.ring.scale.set(rr, rr, 1); B.ringMat.opacity = clamp(1 - a / 12, 0, 1) * 0.8;
    B.cloud.visible = a > 1;
    const h = Math.min(1500, 160 + a * 70), w = Math.min(620, 120 + a * 26);
    B.stem.scale.set(w * 0.16, h, w * 0.16); B.stem.position.y = h / 2;
    B.cap.scale.set(w, w * 0.55, w); B.cap.position.y = h + w * 0.15;
    B.skirt.scale.set(w * 0.8, w * 0.8, w * 0.6); B.skirt.position.y = h * 0.62;
    const cool = clamp((a - 4) / 40, 0, 1);
    B.cloudMat.color.setHex(0xffa860).lerp(C(0x6e645a), cool); B.cloudMat.emissive.setHex(0xff6a20).multiplyScalar(1 - cool * 0.95);
    B.cloudMat.opacity = 0.9 * clamp(1 - (a - 120) / 60, 0, 1);   // drifts away after a couple of minutes
    B.cloud.visible = B.cloud.visible && B.cloudMat.opacity > 0.02;
  } else { B.fire.visible = B.ring.visible = B.cloud.visible = false; }
}

// dust kicked up in the ash
const puffs = [];
let puffTex = null, puffAcc = 0;
function spawnPuff(x, y, z) {
  if (!puffTex) puffTex = glowTex('rgba(170,165,158,0.75)', 'rgba(150,145,138,0.3)');
  let p = puffs.find((q) => q.life <= 0);
  if (!p) {
    if (puffs.length > 90) return;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, transparent: true, depthWrite: false })); scene.add(s);
    p = { s, life: 0, vx: 0, vy: 0, vz: 0 }; puffs.push(p);
  }
  p.life = p.max = 2.8 + Math.random() * 1.6; p.s.visible = true;
  p.s.position.set(x + (Math.random() - 0.5) * 0.6, y + 0.1, z + (Math.random() - 0.5) * 0.6);
  p.vx = (Math.random() - 0.5) * 0.5; p.vy = 0.25 + Math.random() * 0.45; p.vz = (Math.random() - 0.5) * 0.5;
}
function puffTick(dt, ashK) {
  for (const p of puffs) {
    if (p.life <= 0) continue;
    p.life -= dt; if (p.life <= 0) { p.s.visible = false; continue; }
    const k = 1 - p.life / p.max;
    p.s.position.x += p.vx * dt; p.s.position.y += p.vy * dt * (1 - k * 0.7); p.s.position.z += p.vz * dt;
    const sc = 0.5 + k * 2.2; p.s.scale.set(sc, sc, 1); p.s.material.opacity = (1 - k) * 0.55;
  }
  if (ashK < 0.5) return;
  puffAcc -= dt;
  if (puffAcc > 0) return;
  puffAcc = 0.09;
  const P = myState();
  const moving = Math.abs(me.vx) + Math.abs(me.vz) > 1.2;
  if (P && !P.inB && moving && me.onGround) spawnPuff(me.x, me.y, me.z);
  for (const a of avatars.values()) { if (a.g.visible && a.wasMoving && Math.random() < 0.6) spawnPuff(a.g.position.x, a.g.position.y, a.g.position.z); }
}

// Geiger counter: clicks faster the hotter it is
let geigerT = 0;
function radAt(x, z) { return 0.4 + 6.0 * Math.exp(-((x - GZ.x) ** 2 + (z - GZ.z) ** 2) / (2 * 160 * 160)); }
function geigerTick(dt) {
  const P = myState(); const el = $('geiger');
  if (!P || !P.gc) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const rate = S && S.impact ? (P.inB ? 0.02 : radAt(me.x, me.z)) : 0.0012;   // mSv/h
  $('geigerRate').textContent = rate < 0.01 ? (rate * 1000).toFixed(1) + ' µSv/h' : rate.toFixed(2) + ' mSv/h';
  $('geigerDose').textContent = `dose ${P.dose.toFixed(1)} mSv`;
  el.classList.toggle('hot', rate > 2);
  const cps = Math.min(40, rate * 6 + 0.3);
  geigerT -= dt;
  while (geigerT <= 0) { geigerT += -Math.log(Math.random() + 1e-6) / cps; if (actx) noiseBurst(0.006, 6000, 0.35); }
}

function renderTV() {
  if (!bomb || !bunkerRoom) return;
  const P = myState(); if (!P || !P.inB) return;
  const ud = bunkerRoom.userData;
  const dead = S.impact && impactAge > 40;     // the summit camera finally dies
  if (dead) {
    const cv = staticTex.image, g = cv.getContext('2d'), img = g.createImageData(cv.width, cv.height);
    for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 200; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0); g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(30, 36, 100, 18); g.fillStyle = '#fff'; g.font = 'bold 12px sans-serif'; g.fillText('NO SIGNAL', 48, 49);
    staticTex.needsUpdate = true; ud.tvMat.map = staticTex; ud.tvMat.color.set(0xffffff); ud.tvMat.needsUpdate = true;
    return;
  }
  if (ud.tvMat.map !== tvTarget.texture) { ud.tvMat.map = tvTarget.texture; ud.tvMat.color.set(0xffffff); ud.tvMat.needsUpdate = true; }
  if ((frameN % 3) !== 0) return;
  const wasRoom = bunkerRoom.visible; bunkerRoom.visible = false;
  const lv = lantern.visible; lantern.visible = false;
  renderer.setRenderTarget(tvTarget); renderer.render(scene, tvCam); renderer.setRenderTarget(null);
  bunkerRoom.visible = wasRoom; lantern.visible = lv;
}

function bunkerXZ() { if (!S || !WINFO) return null; return WINFO.bunkers[S.bunker] || null; }
function roomFloor() { const b = bunkerXZ(); return b ? heightFn(b[0], b[1]) - ROOM_DEPTH : 0; }

function syncItems(list) {
  const seen = new Set();
  for (const [id, kind, x, z] of list) {
    seen.add(id);
    let m = itemMeshes.get(id);
    if (!m) {
      m = new THREE.Group();
      const model = kind === 'axe' ? makeAxeMesh() : kind === 'rod' ? makeRodMesh() : makePartMesh(kind);
      m.add(model);
      const gy = onIce(x, z) ? Math.max(ICE_Y + 0.55, terrainAt(x, z)) : groundAt(x, z);
      if (kind === 'axe') { model.rotation.set(0, 0.6, -0.5); m.position.set(x, gy + 0.55, z); }
      else if (kind === 'rod') { model.rotation.set(0.25, 0, 0); m.position.set(x, gy + 0.05, z); }
      else m.position.set(x, gy, z);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOWTEX || (GLOWTEX = glowSprite()), color: kind === 'axe' || kind === 'rod' ? 0xfff0b0 : 0x9fe8ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      glow.scale.set(1.6, 1.6, 1); glow.position.y = 1.4; m.add(glow); m.userData = { id, kind, x, z, glow };
      scene.add(m); itemMeshes.set(id, m);
    }
  }
  for (const [id, m] of itemMeshes) if (!seen.has(id)) { scene.remove(m); itemMeshes.delete(id); }
}

function makeAnimalMesh(kind) {
  const g = new THREE.Group(), legs = [];
  if (kind === 'deer') {
    const fur = std(0x8a5a34), belly = std(0xd8c0a0), dark = std(0x3a2618);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 1.3), fur); body.position.y = 1.05; g.add(body);
    const rump = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.25, 0.08), belly); rump.position.set(0, 1.1, 0.68); g.add(rump);
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.6, 0.25), fur); neck.position.set(0, 1.45, -0.62); neck.rotation.x = 0.5; g.add(neck);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.42), fur); head.position.set(0, 1.75, -0.86); g.add(head);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.06), dark); nose.position.set(0, 1.72, -1.08); g.add(nose);
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.1), fur); ear.position.set(s * 0.15, 1.9, -0.76); ear.rotation.z = s * 0.6; g.add(ear);
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.45, 5), std(0xd8c8a8)); ant.position.set(s * 0.12, 2.05, -0.78); ant.rotation.z = s * 0.45; g.add(ant);
      const tine = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, 0.22, 5), std(0xd8c8a8)); tine.position.set(s * 0.2, 2.12, -0.88); tine.rotation.set(-0.6, 0, s * 0.2); g.add(tine);
    }
    for (const [x, z] of [[-0.17, -0.5], [0.17, -0.5], [-0.17, 0.5], [0.17, 0.5]]) {
      const leg = new THREE.Group(); leg.position.set(x, 0.8, z); g.add(leg);
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.8, 0.09), fur); l.position.y = -0.4; leg.add(l);
      const hoof = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.11), dark); hoof.position.y = -0.8; leg.add(hoof);
      legs.push(leg);
    }
  } else {
    const fur = std(0xd9d4cc), pink = std(0xd8a0a0);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), fur); body.scale.set(0.9, 0.85, 1.25); body.position.y = 0.24; g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), fur); head.position.set(0, 0.4, -0.25); g.add(head);
    for (const s of [-1, 1]) { const ear = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.03), fur); ear.position.set(s * 0.05, 0.6, -0.22); ear.rotation.z = s * 0.15; g.add(ear);
      const inner = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.16, 0.01), pink); inner.position.set(s * 0.05, 0.6, -0.235); g.add(inner); }
    const tail = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5), std(0xffffff)); tail.position.set(0, 0.3, 0.27); g.add(tail);
    for (const [x, z] of [[-0.1, -0.12], [0.1, -0.12], [-0.12, 0.15], [0.12, 0.15]]) { const leg = new THREE.Group(); leg.position.set(x, 0.12, z); const l = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.12), fur); l.position.y = -0.06; leg.add(l); g.add(leg); legs.push(leg); }
  }
  scene.add(g);
  return { g, legs, kind, t: null, hop: Math.random() * 6 };
}

function syncAnimals(list) {
  const seen = new Set();
  for (const [id, kind, x, z, ry, spd] of list) {
    seen.add(id);
    let a = animalMeshes.get(id);
    if (!a) { a = makeAnimalMesh(kind); a.g.position.set(x, groundAt(x, z), z); a.g.rotation.y = ry + Math.PI; animalMeshes.set(id, a); }
    a.t = { x, z, ry, spd };
  }
  for (const [id, a] of animalMeshes) if (!seen.has(id)) { scene.remove(a.g); animalMeshes.delete(id); }
}

function animateBonfire(t) {
  const B = BONFIRE_FX; if (!B || !S) return;
  const f = (S.bonfire || 0) / 100, lit = f > 0;
  B.flames.forEach((s, i) => {
    s.visible = lit; const u = s.userData, k = (t * 1.4 + u.ph) % 1;
    s.position.set(Math.sin(u.ph + t * 2) * u.r, 0.6 + k * (2.2 + f * 1.6), Math.cos(u.ph + t * 1.7) * u.r);
    const sz = (1.9 - k * 1.2) * (0.7 + f * 0.6); s.scale.set(sz, sz * 1.3, 1); s.material.opacity = (1 - k) * 0.9;
  });
  B.light.intensity = lit ? (2.5 + f * 3) * (0.85 + Math.sin(t * 13) * 0.08 + Math.sin(t * 7.1) * 0.07) : 0;
  B.embers.material.color.setRGB(lit ? 0.9 : 0.16, lit ? 0.35 : 0.08, lit ? 0.08 : 0.03);
  B.smoke.material.uniforms.uA.value = lit ? 0.5 + f * 0.5 : 0;
}
function animateStory(dt, t) {
  if (!S || !heli) return;
  animateBonfire(t);
  const k = 1 - Math.exp(-10 * dt);
  // animals
  for (const a of animalMeshes.values()) {
    const p = a.t, g = a.g;
    g.position.x = lerp(g.position.x, p.x, k); g.position.z = lerp(g.position.z, p.z, k);
    let d = (p.ry + Math.PI) - g.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d)); g.rotation.y += d * k;
    const moving = p.spd > 0.2;
    a.hop += dt * (p.spd > 3 ? 14 : 7);
    let y = groundAt(g.position.x, g.position.z);
    if (a.kind === 'rabbit' && moving) y += Math.abs(Math.sin(a.hop)) * (p.spd > 3 ? 0.35 : 0.15);
    g.position.y = y;
    a.legs.forEach((l, i) => { l.rotation.x = moving ? Math.sin(a.hop + (i % 2 ? 0 : Math.PI) + (i > 1 ? 1.2 : 0)) * (p.spd > 3 ? 0.8 : 0.4) : 0; });
  }
  // items bob and glow
  for (const m of itemMeshes.values()) { const gl = m.userData.glow; gl.material.opacity = 0.45 + Math.sin(t * 3 + m.position.x) * 0.25; gl.position.y = 1.3 + Math.sin(t * 2 + m.position.z) * 0.1; }
  // ice holes from day 3
  for (const h of holeMeshes) h.visible = S.day >= 3;
  // helicopter
  const H = S.heli, hp = heli.g.position;
  const flying = H.fly > 0;
  const hk = flying ? 1 - Math.exp(-25 * dt) : k;
  hp.x = lerp(hp.x, H.x, hk); hp.z = lerp(hp.z, H.z, hk);
  const targetAlt = flying ? Math.min(45, (8 - H.fly) * 18, H.fly * 18) : 0;
  heli.alt = lerp(heli.alt, Math.max(0, targetAlt), Math.min(1, dt * 2));
  hp.y = heightFn(hp.x, hp.z) + 0.25 + heli.alt;
  const bxz = bunkerXZ();
  if (flying && bxz) { const want = Math.atan2(-(bxz[0] - hp.x), -(bxz[1] - hp.z)); let d = want - heli.g.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d)); heli.g.rotation.y += d * Math.min(1, dt * 2); }
  const spinTarget = H.run ? 26 : 0;
  heli.spin = lerp(heli.spin, spinTarget, Math.min(1, dt * 0.8));
  heli.rotor.rotation.y += heli.spin * dt; heli.tail.rotation.x += heli.spin * 1.6 * dt;
  heli.blades.forEach((b) => (b.visible = H.parts[2]));
  heli.lamp.visible = H.run && Math.sin(t * 6) > 0;
  // bunker hatch + room
  bunkerHatches.forEach((g, i) => {
    g.visible = i === S.bunker;
    const me2 = myState();
    g.userData.beacon.visible = i === S.bunker && S.siren && me2 && me2.kb && Math.sin(t * 5) > 0;
  });
  if (bxz) {
    bunkerRoom.position.set(bxz[0], roomFloor(), bxz[1]);
    const p = myState(), inB = p && p.inB;
    bunkerRoom.visible = !!inB;
    const L = bunkerRoom.userData.light;
    L.intensity = inB ? (S.impact && shakeT > 0 ? (Math.random() < 0.3 ? 0.2 : 2.2) : 2.2) : 0;
    if (inB && S.bk) {
      const ud = bunkerRoom.userData;
      syncCanSlots(ud.cans, S.bk.cl, bunkerRoom);
      ud.burners.forEach((b, i) => { const [pot, kind, art] = S.bk.burners[i]; const on = pot >= 0; syncDish(b.pot, on ? art || 'can:stew' : '', on ? pot / (FOOD_TIME[kind] || 20) : 0);
        b.coilMat.color.setRGB(on ? 1 : 0.2, on ? 0.25 + Math.sin(t * 9 + i) * 0.03 : 0.1, on ? 0.08 : 0.08); });
      const worn = S.players.filter((q) => q.gc).length;
      ud.geigers.forEach((g2, i) => (g2.visible = i < Math.max(0, 6 - worn)));
    }
  }
  // impact
  if (S.impact && !impactSeen) {
    impactSeen = true; shakeT = 5;
    const p = myState();
    if (!(p && p.inB)) { const fl = $('flash'); fl.style.transition = 'none'; fl.style.opacity = 1; requestAnimationFrame(() => { fl.style.transition = 'opacity 3.5s ease-out'; fl.style.opacity = 0; }); }
    rumble();
  }
  if (!S.impact) impactSeen = false;
  // tools in hand
  const p = myState();
  const nearHole = p && p.rod && S.day >= 3 && WINFO.holes.some(([x, z]) => Math.hypot(x - me.x, z - me.z) < 5);
  const fishing = p && p.ft > 0;
  viewRod.visible = !!(p && p.rod && (nearHole || fishing) && !p.inB);
  viewAxe.visible = !!(p && p.axe && !viewRod.visible && !p.inB && !(p.f > 0) && !p.lost);
  swingT = Math.max(0, swingT - dt * 3.2);
  const sw = Math.sin(swingT * Math.PI);
  viewAxe.rotation.set(-0.2 - sw * 1.4, -0.3 + sw * 0.4, -0.25 - sw * 0.3);
  viewAxe.position.set(0.4 - sw * 0.15, -0.66 + sw * 0.2, -0.7 - sw * 0.2);
  viewRod.rotation.x = -0.9 + (fishing ? Math.sin(t * 2.5) * 0.04 - 0.2 : 0);
  if (fishing && p.fh >= 0) { const [x, z] = WINFO.holes[p.fh]; bobber.visible = true; bobber.position.set(x, ICE_Y + 0.05 + Math.max(0, Math.sin(t * 7)) * (p.ft < 1.2 ? 0.15 : 0.02), z); }
  else bobber.visible = false;
  // camera shake after the blast
  if (shakeT > 0) { shakeT -= dt; const s = shakeT * 0.02; camera.position.x += (Math.random() - 0.5) * s; camera.position.y += (Math.random() - 0.5) * s; }
}

function storyTargets(out) {
  const p = myState(); if (!p || !S) return;
  for (const m of itemMeshes.values()) {
    const { id, kind, x, z } = m.userData;
    if (Math.hypot(x - me.x, z - me.z) < 6) out.push({ kind: 'item', item: kind, id, x, z, y: m.position.y + 0.4 });
  }
  if (p.axe) for (const [id, a] of animalMeshes) {
    const gp = a.g.position;
    if (Math.hypot(gp.x - me.x, gp.z - me.z) < 5) out.push({ kind: 'animal', id, animal: a.kind, x: gp.x, z: gp.z, y: gp.y + (a.kind === 'deer' ? 1.1 : 0.25) });
  }
  if (S.day >= 3) WINFO.holes.forEach(([x, z], i) => { if (Math.hypot(x - me.x, z - me.z) < 4) out.push({ kind: 'hole', i, x, z, y: ICE_Y }); });
  if (S.day >= 4 && heli) { const hp = heli.g.position; if (Math.hypot(hp.x - me.x, hp.z - me.z) < 7) out.push({ kind: 'heli', x: hp.x, z: hp.z, y: hp.y + 1.5, big: true }); }
  const b = bunkerXZ();
  if (b && (S.day >= 4 || p.inB)) {
    if (p.inB) {
      const fl = roomFloor(), at = ([lx, lz, ly]) => ({ x: b[0] + lx, z: b[1] + lz, y: fl + ly });
      out.push({ kind: 'bunker', ...at(BK_LADDER) });
      out.push({ kind: 'bk_can', ...at(BK_CAN) });
      out.push({ kind: 'bk_geiger', ...at(BK_GEIGER) });
      BK_BURNERS.forEach((pos, i) => out.push({ kind: 'bk_burner', i, ...at(pos) }));
    }
    else if (Math.hypot(b[0] - me.x, b[1] - me.z) < 4.5) out.push({ kind: 'bunker', x: b[0], z: b[1], y: heightFn(b[0], b[1]) + 0.6, big: true });
  }
}

function storyPrompt(t, p) {
  if (t.kind === 'item') {
    if (t.item === 'axe') return p.axe ? [null, 'You already have an axe'] : ['E', 'Take the axe'];
    if (t.item === 'rod') return p.rod ? [null, 'You already have a fishing rod'] : ['E', 'Take the fishing rod'];
    return p.part ? [null, `Already carrying the ${PART_NAMES[p.part]}`] : ['E', `Pick up the helicopter ${PART_NAMES[t.item]}`];
  }
  if (t.kind === 'animal') return ['E', `Swing the axe at the ${t.animal}  (or click)`];
  if (t.kind === 'hole') {
    if (!p.rod) return [null, 'An ice hole. You need a fishing rod (Frozen Lake dock).'];
    if (p.fh === t.i && p.ft > 0) return ['E', p.ft < 1.2 ? 'Something is biting…!' : 'Fishing… (E to reel in)'];
    return p.fish >= 6 ? [null, 'Your bag is full of fish - go cook them'] : ['E', 'Drop a line and fish'];
  }
  if (t.kind === 'heli') {
    const H = S.heli;
    if (H.fly > 0) return [null, 'In flight…'];
    if (p.part) return ['E', `Fit the ${PART_NAMES[p.part]}`];
    if (!H.parts.every(Boolean)) {
      const miss = ['battery', 'fuel', 'rotor'].filter((_, i) => !H.parts[i]).map((k) => `${PART_NAMES[k]} (${PART_FROM[k]})`);
      return [null, 'Helicopter needs: ' + miss.join(', ')];
    }
    if (!H.run) return ['E', 'Start the engine'];
    if (S.siren && !S.impact) return ['E', 'Fly everyone nearby to the bunker!'];
    return [null, 'Engine running - stay close to a radio'];
  }
  if (t.kind === 'bunker') {
    if (p.inB) {
      if (S.siren && !S.impact) return [null, 'Stay inside - the bomb is coming!'];
      if (S.impact && !S.clear) return [null, `Hatch locked - fallout outside. Opens in ${fmtDur((WINFO.hatchTod - localTod + 1440) % 1440, S.rate)}`];
      return ['E', p.gc ? 'Climb the ladder out' : 'Climb out (take a Geiger counter first!)'];
    }
    if (S.impact && !S.clear) return [null, 'The hatch is sealed from inside'];
    return ['E', 'Open the hatch and climb into the bunker'];
  }
  if (t.kind === 'bk_can') return p.can ? [null, `Already holding ${CAN_INFO[p.ck].name} - cook it on a burner`] : S.bk.cans > 0 ? ['E', `Take a can of ${CAN_INFO[S.bk.cl[S.bk.cl.length - 1]].name} (${S.bk.cans} on the shelves)`] : [null, 'The shelves are empty'];
  if (t.kind === 'bk_geiger') return p.gc ? [null, 'You are wearing a Geiger counter'] : ['E', 'Clip on a Geiger counter'];
  if (t.kind === 'bk_burner') {
    const [pot, kind] = S.bk.burners[t.i];
    if (pot >= 0 && kind) { const need = FOOD_TIME[kind]; const art = S.bk.burners[t.i][2]; return pot >= need ? ['E', `Eat the ${dishName(art, kind)}`] : [null, `Burner ${t.i + 1}: ${dishName(art, kind)} ${Math.round(pot / need * 100)}%`]; }
    if (p.meat || p.fish || p.can) return ['E', `Cook ${p.meat ? (p.mk === 'rabbit' ? 'rabbit' : 'venison') : p.fish ? 'trout' : 'the ' + CAN_INFO[p.ck].name} on burner ${t.i + 1}` + cookChoices(p)];
    return [null, `Electric burner ${t.i + 1} (battery powered) - grab a can from the shelves`];
  }
  return null;
}

function storyInteract(t) {
  if (t.kind === 'item') send({ t: 'act', a: 'item', id: t.id });
  else if (t.kind === 'animal') { if (swingT < 0.5) { swingT = 1; chop(); } send({ t: 'act', a: 'hit', id: t.id }); }
  else if (t.kind === 'hole') send({ t: 'act', a: 'fish', i: t.i });
  else if (t.kind === 'heli') send({ t: 'act', a: 'heli' });
  else if (t.kind === 'bunker') send({ t: 'act', a: 'bunker' });
  else if (t.kind === 'bk_can' || t.kind === 'bk_geiger' || t.kind === 'bk_burner') send({ t: 'act', a: t.kind, i: t.i });
  else return false;
  return true;
}

function storyHud(p) {
  const d = S.day, W = WINFO, rows = [];
  const tick = (ok, text) => rows.push(`<div class="obj${ok ? ' done' : ''}"><span>${ok ? '✓' : '•'}</span>${text}</div>`);
  if (d === 1) tick(false, 'Keep the stoves lit through the 2 AM gale');
  if (S.sleep && S.sleep[0] > 0 && d < W.days) tick(false, `😴 ${S.sleep[0]}/${S.sleep[1]} ready to sleep${S.sleepWhy ? ' - ' + S.sleepWhy : ' - waiting for everyone to get in bed'}`);
  if (d >= 2 && d < 4) { tick(!!p.axe, 'Find an axe (chopping block outside each cabin)'); tick(false, 'Hunt deer or rabbits, cook the meat on a stove'); }
  if (d === 3) { tick(!!p.rod, 'Find a fishing rod (Frozen Lake dock)'); tick(false, 'Fish at an ice hole on the lake, cook the fish'); }
  if (d === 4 || (d === 5 && !S.siren)) {
    const H = S.heli;
    ['battery', 'fuel', 'rotor'].forEach((k, i) => tick(H.parts[i], `Helicopter ${PART_NAMES[k]} (${PART_FROM[k]})`));
    tick(H.run, 'Get the helicopter running');
  }
  if (d === 5 && !S.siren) tick(false, 'Stay near a cabin\'s solar radio this morning');
  if (d === 5 && S.siren && !S.impact) {
    tick(!!p.kb, 'Listen to a cabin\'s solar radio');
    tick(!!p.inB, `Get into the bunker - impact in ${fmtDur((W.impactTod - localTod + 1440) % 1440, S.rate)}`);
    if (S.heli.run) tick(false, 'Or fly there: the helicopter is running');
  }
  if (d === 5 && S.impact && !p.lost) {
    tick(S.clear, S.clear ? 'The fallout has settled' : `Wait out the fallout - hatch opens in ${fmtDur((W.hatchTod - localTod + 1440) % 1440, S.rate)}`);
    tick(!!p.gc, 'Clip on a Geiger counter (by the ladder)');
    tick(false, 'Cook canned food on the electric burners');
    if (S.clear) tick(false, 'Climb out and walk the ash until 6 PM');
  }
  $('objList').innerHTML = rows.join('');
  $('objDay').textContent = `Day ${d} of ${W.days}`;
  const inv = [];
  if (p.axe) inv.push('🪓 Axe'); if (p.rod) inv.push('🎣 Rod');
  if (p.meat) inv.push(`🥩 ${p.meat} meat`); if (p.fish) inv.push(`🐟 ${p.fish} fish`);
  if (p.part) inv.push(`🔧 ${PART_NAMES[p.part]}`);
  $('inv').innerHTML = inv.map((s) => `<span>${s}</span>`).join('');
  $('inv').classList.toggle('hidden', !inv.length);
  $('lostOv').classList.toggle('hidden', !p.lost || S.phase === 'dawn');
  $('sleepOv').classList.toggle('hidden', !(S.slept > 0));
  $('flyOv').classList.toggle('hidden', !(p.fly > 0));
  $('bunkerOv').classList.toggle('hidden', !(p.inB && S.impact && impactAge < 12) || S.phase === 'dawn');
  // day banner
  if (d !== lastDay) {
    lastDay = d;
    const sub = { 1: 'Keep the stoves lit through the 2 AM gale.', 2: 'Animals are out. Find an axe and hunt.', 3: 'The ice is thick. Find a rod and go fishing.', 4: 'Race to get the helicopter running.', 5: 'Something is wrong. Stay near a radio.' }[d];
    $('bannerDay').textContent = `Day ${d}`; $('bannerSub').textContent = sub;
    const b = $('banner'); b.classList.remove('hidden'); b.style.opacity = 1;
    clearTimeout(b._t); b._t = setTimeout(() => { b.style.opacity = 0; setTimeout(() => b.classList.add('hidden'), 900); }, 5500);
  }
}

function showRadio(text) {
  const el = $('radioOv'); $('radioText').textContent = ''; el.classList.remove('hidden');
  let i = 0; clearInterval(el._iv);
  el._iv = setInterval(() => { i += 2; $('radioText').textContent = text.slice(0, i); if (i >= text.length) clearInterval(el._iv); }, 30);
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.add('hidden'), Math.max(9000, text.length * 75));
  staticBurst();
  try { if (window.speechSynthesis) { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text.replace(/\.\.\./g, ', ')); u.rate = 1.02; u.pitch = 0.8; u.volume = volume; if (volume === 0) return; speechSynthesis.speak(u); } } catch (e) { /* no voice on this machine */ }
}

// sounds for the story
let sirenNodes = null;
function sirenTick(dt) {
  if (!actx) return;
  const on = S && S.siren && !S.impact;
  if (on && !sirenNodes) {
    const o = actx.createOscillator(), o2 = actx.createOscillator(), g = actx.createGain();
    o.type = 'sawtooth'; o2.type = 'square'; g.gain.value = 0;
    const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1400;
    o.connect(f); o2.connect(f); f.connect(g).connect(OUT()); o.start(); o2.start();
    sirenNodes = { o, o2, g, t: 0 };
  }
  if (sirenNodes) {
    sirenNodes.t += dt;
    const ph = (Math.sin(sirenNodes.t * 2 * Math.PI / 7) + 1) / 2;
    const fq = 330 + ph * 560;
    sirenNodes.o.frequency.value = fq; sirenNodes.o2.frequency.value = fq * 1.005;
    const p = myState();
    const target = on ? (p && p.inB ? 0.015 : insideAny() ? 0.05 : 0.09) : 0;
    sirenNodes.g.gain.value += (target - sirenNodes.g.gain.value) * Math.min(1, dt * 2);
    if (!on && sirenNodes.g.gain.value < 0.002) { sirenNodes.o.stop(); sirenNodes.o2.stop(); sirenNodes = null; }
  }
}
function noiseBurst(seconds, freq, vol) {
  if (!actx) return;
  const n = actx.sampleRate * seconds, b = actx.createBuffer(1, n, actx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
  const s = actx.createBufferSource(); s.buffer = b; const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
  const g = actx.createGain(); g.gain.value = vol; s.connect(f).connect(g).connect(OUT()); s.start();
}
function staticBurst() { noiseBurst(0.6, 4000, 0.15); }
function rumble() { noiseBurst(6, 120, 1.2); }
function chop() { noiseBurst(0.12, 1800, 0.35); }

// walk up to a log and it jumps into your arms - no aiming needed
let pickupCd = 0;
function autoPickup(dt) {
  pickupCd -= dt;
  const P = myState(); if (!P || pickupCd > 0 || P.c >= 4 || P.inB || P.f > 0 || P.lost) return;
  let best = null, bd = 1.9;
  for (const m of logMeshes.values()) {
    if (m.userData.asked && performance.now() - m.userData.asked < 1500) continue;
    const d = Math.hypot(m.position.x - me.x, m.position.z - me.z); if (d < bd) { bd = d; best = m; }
  }
  if (!best) return;
  best.userData.asked = performance.now(); pickupCd = 0.3;
  send({ t: 'act', a: 'pickup', id: best.userData.id });
}
let hiSprite = null;
function highlightTarget() {
  if (!hiSprite) {
    hiSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex('rgba(255,236,170,0.9)', 'rgba(255,200,90,0.25)'), transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
    hiSprite.renderOrder = 4; scene.add(hiSprite);
  }
  const t = target;
  if (!t || t.big || t.kind === 'bonfire' || t.kind.startsWith('bk_') || t.kind === 'animal' || t.kind === 'item' || t.kind === 'stove' || t.kind === 'woodbox' || t.kind === 'pantry' || t.kind === 'candle' || t.kind === 'radio' || t.kind === 'door' || t.kind === 'bed') { hiSprite.visible = false; return; }
  hiSprite.visible = true; hiSprite.position.set(t.x, t.y + 0.35, t.z);
  const s = 1.3 + Math.sin(clockU.value * 6) * 0.15; hiSprite.scale.set(s, s, 1);
}

// ------------------------------------------------------------------ avatars
const avatars = new Map();
function nameTex(name, color) {
  return canvasTex(256, 64, (g, w, h) => {
    g.font = 'bold 30px system-ui, sans-serif'; const tw = g.measureText(name).width + 34;
    g.fillStyle = 'rgba(8,12,22,0.7)'; g.beginPath(); g.roundRect((w - tw) / 2, 8, tw, 46, 23); g.fill();
    g.fillStyle = color; g.beginPath(); g.arc((w - tw) / 2 + 18, 31, 7, 0, 7); g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(name, w / 2 + 8, 32);
  });
}
function makeAvatar(p) {
  const g = new THREE.Group();
  const coat = new THREE.MeshLambertMaterial({ color: p.color });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.8, 4, 10), coat); body.position.y = 0.78; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 10), new THREE.MeshLambertMaterial({ color: 0xe9c4a2 })); head.position.y = 1.5; g.add(head);
  const hat = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 8, 0, 6.283, 0, 1.6), coat); hat.position.y = 1.55; g.add(hat);
  const bob = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshLambertMaterial({ color: 0xffffff })); bob.position.y = 1.82; g.add(bob);
  const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.07, 6, 14), new THREE.MeshLambertMaterial({ color: 0xf0e6d2 })); scarf.rotation.x = Math.PI / 2; scarf.position.y = 1.28; g.add(scarf);
  const eyeM = new THREE.MeshBasicMaterial({ color: 0x111111 });
  for (const s of [-1, 1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 4), eyeM); e.position.set(s * 0.08, 1.53, -0.22); g.add(e); }
  const lamp = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOWTEX || (GLOWTEX = glowSprite()), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  lamp.scale.set(1.1, 1.1, 1); lamp.position.set(0.42, 0.85, -0.25); g.add(lamp);
  const back = []; const logM = new THREE.MeshLambertMaterial({ color: 0x7a5132 });
  for (let i = 0; i < 4; i++) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.9, 6), logM); l.rotation.z = Math.PI / 2; l.position.set(0, 0.7 + i * 0.2, 0.38); g.add(l); back.push(l); }
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: nameTex(p.name, p.color), depthTest: false, transparent: true }));
  tag.scale.set(2.2, 0.55, 1); tag.position.y = 2.2; tag.renderOrder = 5; g.add(tag);
  scene.add(g);
  return { g, coat, back, base: new THREE.Color(p.color), t: { x: p.x, y: p.y, z: p.z, ry: p.ry } };
}

// ---------------------------------------------------------------- network
let ws, myId = null, world = null, S = null, nightSeconds = 720, localTod = 1080;
const nightMin = () => (localTod - 1080 + 1440) % 1440;   // minutes since 6 PM tonight
const isNight = () => localTod >= 1080 || localTod < 360;
const me = { x: 0, y: 0, z: 30, vx: 0, vz: 0, vy: 0, yaw: 0, pitch: 0, onGround: true };
let joined = false;

// Where the game server might be. Normally it serves this page itself, but when the
// page is opened from somewhere else (The Shelf, My Apps, a file) we look for it on
// the usual ports - first on the computer the page came from, then on this computer.
const GAME_PORT = 8790;
function serverCandidates() {
  const out = [], add = (h) => { if (h && !out.includes(h)) out.push(h); };
  const typed = ($('srvIn') && $('srvIn').value.trim()) || '';
  if (typed) {
    const h = typed.replace(/^\w+:\/\//, '').replace(/\/.*$/, '');
    add(/:\d+$/.test(h) ? h : `${h}:${GAME_PORT}`);
    if (!/:\d+$/.test(h)) for (let p = GAME_PORT + 1; p < GAME_PORT + 6; p++) add(`${h}:${p}`);
  }
  if (location.protocol.startsWith('http')) add(location.host);
  const hosts = [];
  if (location.hostname) hosts.push(location.hostname);
  hosts.push('localhost');
  for (const h of hosts) for (let p = GAME_PORT; p < GAME_PORT + 6; p++) add(`${h}:${p}`);
  return out;
}
function tryServer(host, name, color) {
  return new Promise((resolve) => {
    let done = false, sock;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(t); if (!ok) { try { sock.close(); } catch (e) {} } resolve(ok ? sock : null); };
    const t = setTimeout(() => finish(false), 2500);
    try { sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`); } catch (e) { finish(false); return; }
    sock.onopen = () => sock.send(JSON.stringify({ t: 'join', name, color }));
    sock.onerror = () => finish(false);
    sock.onclose = () => finish(false);
    sock.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { finish(false); return; }
      if (m.t === 'welcome') { sock._welcome = m; finish(true); } else finish(false);
    };
  });
}
async function connect(name, color) {
  $('joinErr').textContent = 'Looking for the game server…';
  for (const host of serverCandidates()) {
    const sock = await tryServer(host, name, color);
    if (!sock) continue;
    ws = sock;
    store('ffc.server', host);
    ws.onclose = () => { if (joined) toast('Lost connection to the server. Refresh to rejoin.', 60000); };
    ws.onerror = null;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'state') onState(m);
      else if (m.t === 'chat') addChat(m.from, m.color, m.text);
      else if (m.t === 'radio') showRadio(m.text);
    };
    $('joinErr').textContent = '';
    onWelcome(sock._welcome);
    return;
  }
  $('srvRow').classList.remove('hidden');
  $('joinErr').innerHTML = `Couldn't find a game server. Start <b>Frostfall Cabins Server</b> (start-windows.bat or start-pi.sh) and keep its window open. If it's on another computer, type the address from its window above, e.g. <b>10.0.0.80:${GAME_PORT}</b>.`;
  $('go').disabled = false;
}
function send(o) {
  if (o.t === 'act') { o.x = +me.x.toFixed(2); o.z = +me.z.toFixed(2); o.y = +me.y.toFixed(2); }   // where I am right now, even on a slow frame
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
}

function onWelcome(m) {
  myId = m.id; world = m.world; nightSeconds = world.nightSeconds;
  makeRenderer();
  buildWorld(world);
  me.x = SPAWN.x; me.z = SPAWN.z; me.y = groundAt(me.x, me.z);
  me.yaw = Math.atan2(-(cabins[0].x - me.x), -(cabins[0].z - me.z));
  const gb = $('galeBand'); gb.style.left = ((720 + world.galeStart) / 1440 * 100) + '%'; gb.style.width = ((world.galeEnd - world.galeStart) / 1440 * 100) + '%';
  document.querySelector('.night').style.background = 'linear-gradient(90deg, rgba(255,214,140,.28) 0%, rgba(255,214,140,.28) 46%, rgba(255,255,255,.08) 54%, rgba(255,255,255,.08) 100%)';
  $('join').classList.add('hidden'); $('hud').classList.remove('hidden');
  joined = true;
  buildCabinList();
  toast('Glowing windows and chimney smoke mean a fire is burning. Logs glow when you can pick them up.', 9000);
  startAudio();
  if (!qs.has('auto')) $('clickOv').classList.remove('hidden');
  requestAnimationFrame(frame);
}

function onState(m) {
  S = m;
  { const d = Math.abs(localTod - m.tod); if (Math.min(d, 1440 - d) > 1.5) localTod = m.tod; }
  m.cabins.forEach((cs, i) => { if (cabins[i]) cabins[i].state = cs; });
  syncLogs(m.logs);
  syncItems(m.items || []);
  syncAnimals(m.animals || []);
  const ids = new Set();
  for (const p of m.players) {
    ids.add(p.id);
    if (p.id === myId) {
      if (p.tp) { me.x = p.x; me.z = p.z; me.y = p.inB ? roomFloor() : groundAt(p.x, p.z); me.vx = me.vz = me.vy = 0; }
      continue;
    }
    let a = avatars.get(p.id);
    if (!a) { a = makeAvatar(p); avatars.set(p.id, a); a.g.position.set(p.x, p.y, p.z); }
    a.t = p; if (p.tp) a.g.position.set(p.x, p.y, p.z);
  }
  for (const [id, a] of avatars) if (!ids.has(id)) { scene.remove(a.g); avatars.delete(id); }
  for (const e of m.events) toast(e);
  updateHud();
}

// ------------------------------------------------------------------- input
const keys = {};
let locked = false, chatting = false, bigMap = false;
addEventListener('keydown', (e) => {
  if (!joined) return;
  if (chatting) {
    if (e.key === 'Enter') { const v = $('chatIn').value.trim(); if (v) send({ t: 'chat', text: v }); closeChat(); }
    else if (e.key === 'Escape') closeChat();
    return;
  }
  keys[e.code] = true;
  if (e.code === 'KeyE') interact();
  if ((e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3') && target && (target.kind === 'stove' || target.kind === 'bk_burner')) {
    const food = { Digit1: 'meat', Digit2: 'fish', Digit3: 'stew' }[e.code];
    send({ t: 'act', a: target.kind, cabin: target.cabin, i: target.i, food });
  }
  if (e.code === 'KeyT' || e.code === 'Enter') { e.preventDefault(); openChat(); }
  if (e.code === 'KeyM') { bigMap = !bigMap; resizeMap(); }
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') setVolume(volume - 0.1, true);
  if (e.code === 'Equal' || e.code === 'NumpadAdd') setVolume(volume + 0.1, true);
  if (e.code === 'KeyN') { if (volume > 0) { lastVol = volume; setVolume(0, true); } else setVolume(lastVol || 0.7, true); }
  if (e.code === 'Tab') { e.preventDefault(); $('roster').classList.remove('hidden'); renderRoster(); }
});
addEventListener('keyup', (e) => { keys[e.code] = false; if (e.code === 'Tab') $('roster').classList.add('hidden'); });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
function openChat() { chatting = true; const ci = $('chatIn'); ci.classList.remove('hidden'); ci.value = ''; ci.focus(); if (document.pointerLockElement) document.exitPointerLock(); for (const k in keys) keys[k] = false; }
function closeChat() { chatting = false; $('chatIn').classList.add('hidden'); $('chatIn').blur(); canvas.requestPointerLock?.(); }
$('clickOv').addEventListener('click', () => canvas.requestPointerLock?.());
canvas.addEventListener('click', () => { if (joined && !locked) canvas.requestPointerLock?.(); });
canvas.addEventListener('mousedown', (e) => {
  if (!joined || !locked || e.button !== 0) return;
  const p = myState();
  if (p && p.axe && viewAxe && viewAxe.visible && swingT <= 0) { swingT = 1; chop(); }
  if (target) interact();
});
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  $('clickOv').classList.toggle('hidden', locked || chatting || qs.has('auto'));
});
addEventListener('mousemove', (e) => {
  if (!locked) return;
  me.yaw -= e.movementX * 0.0022; me.pitch = clamp(me.pitch - e.movementY * 0.0022, -1.45, 1.45);
});

// ------------------------------------------------------------- interaction
let target = null;
function interactTargets() {
  const out = [];
  for (const m of logMeshes.values()) out.push({ kind: 'log', id: m.userData.id, x: m.position.x, z: m.position.z, y: m.position.y });
  cabins.forEach((c, i) => {
    if (Math.hypot(me.x - c.x, me.z - c.z) > 12) return;
    const add = (kind, [lx, lz], y, extra) => { const [x, z] = toWorld(c, lx, lz); out.push({ kind, cabin: i, x, z, y: c.base + y, ...extra }); };
    add('stove', STOVE, 1.2); add('woodbox', WOODBOX, 0.8); add('pantry', PANTRY, 1.3); add('radio', RADIO, 1.75); add('door', [0, CABIN_D / 2 + 0.18], 1.2); add('bed', [-2.8, 2.9], 0.6);
    CANDLES.forEach((cd, k) => add('candle', cd, cd[2], { i: k }));
  });
  storyTargets(out);
  if (WINFO) { const [bx, bz] = WINFO.bonfire; if (Math.hypot(bx - me.x, bz - me.z) < 5) out.push({ kind: 'bonfire', x: bx, z: bz, y: spawnBase + 1, big: true }); }
  return out;
}
const REACH = { bed: 2.3, bonfire: 4.5, bk_can: 2.6, bk_geiger: 2.4, bk_burner: 1.9, door: 2.8, log: 4.0, item: 3.6, animal: 4.0, hole: 3.0, heli: 6.5, bunker: 4.6, radio: 2.8 };
function findTarget() {
  const fx = -Math.sin(me.yaw), fz = -Math.cos(me.yaw);
  const eye = me.y + 1.62, look = Math.sin(me.pitch);
  let best = null, bs = 1e9;
  for (const t of interactTargets()) {
    const dx = t.x - me.x, dz = t.z - me.z, d = Math.hypot(dx, dz);
    const reach = REACH[t.kind] || 2.9;
    if (d > reach) continue;
    const facing = d < 0.01 ? 1 : (dx * fx + dz * fz) / d;
    const close = t.kind === 'log' || t.kind === 'item' ? 2.0 : t.big ? 99 : 1.2;
    if (facing < 0.3 && d > close) continue;
    const vert = t.big ? 0 : Math.abs((t.y - eye) / Math.max(d, 0.6) - look * 1.2);
    const s = d * 0.6 + (1 - facing) * 3 + Math.min(vert, 2) * 0.6 + (t.kind === 'animal' ? -1 : 0);
    if (s < bs) { bs = s; best = t; }
  }
  return best;
}
function myState() { return S ? S.players.find((p) => p.id === myId) : null; }
function promptFor(t) {
  const p = myState(); if (!p || !t) return null;
  if (t.kind === 'log') return p.c < 4 ? ['E', 'Pick up firewood  (or click)'] : [null, 'Your arms are full (4 logs)'];
  if (t.kind === 'bonfire') {
    const lit = S.bonfire > 0;
    if (S.impact) return [null, 'The bonfire is buried in ash'];
    if (S.gale > 0.5) return [null, lit ? 'The bonfire' : 'Too windy to light the bonfire'];
    if (p.c > 0) return S.bonfire > 85 ? [null, 'The bonfire is roaring - warm up here'] : ['E', lit ? 'Throw a log on the bonfire' : 'Relight the bonfire with a log'];
    return [null, lit ? 'Bonfire - stand close to warm up' : 'The bonfire is out - bring a log to relight it'];
  }
  const sp = storyPrompt(t, p); if (sp) return sp;
  const cs = cabins[t.cabin].state; if (!cs) return null;
  if (t.kind === 'bed') {
    const [v, n] = S.sleep || [0, 1];
    if (!isNight() || S.day >= WINFO.days) return [null, 'A warm bed - you can sleep here at night'];
    if (p.zz) return ['E', `Get up (${v}/${n} ready to sleep)` + (S.sleepWhy ? ` - ${S.sleepWhy}` : '')];
    return ['E', `Sleep until dawn (${v}/${n} ready) - everyone needs a lit stove with wood to last the night`];
  }
  if (t.kind === 'door') return ['E', cs.door ? 'Close the door (keeps the heat in)' : 'Open the door'];
  if (t.kind === 'radio') return ['E', S.siren && !S.impact ? 'LISTEN to the emergency broadcast!' : 'Listen to the solar radio'];
  if (t.kind === 'woodbox') return p.c > 0 ? ['E', `Stack ${Math.min(p.c, 12 - cs.wood)} log${p.c > 1 ? 's' : ''} in the woodbox (${cs.wood}/12)`] : cs.wood > 0 ? ['E', `Take a log (${cs.wood} stacked)`] : [null, 'Woodbox is empty'];
  if (t.kind === 'pantry') return p.can ? [null, `Already holding a can of ${CAN_INFO[p.ck].name}`] : cs.cans > 0 ? ['E', `Take a can of ${CAN_INFO[cs.cl[cs.cl.length - 1]].name} (${cs.cans} left)`] : [null, 'Pantry is empty'];
  if (t.kind === 'candle') return cs.candles[t.i] ? ['E', 'Blow out candle'] : cs.fuel > 0 ? ['E', 'Light candle from the stove'] : [null, 'Light the stove first'];
  if (t.kind === 'stove') {
    const pk = cs.pk || 'stew', need = FOOD_TIME[pk] || 20;
    if (cs.pot >= need) return ['E', `Eat the ${dishName(cs.art, pk)}`];
    if (cs.pot < 0 && (p.meat || p.fish || p.can)) {
      const what = p.meat ? (p.mk === 'rabbit' ? 'rabbit' : 'venison') : p.fish ? 'trout' : `the ${CAN_INFO[p.ck].name}`;
      if (cs.fuel > 0) return ['E', `Cook ${what}` + cookChoices(p)];
      if (!p.meat && !p.fish) return ['E', 'Set the can on the stove (light it to heat)'];
      if (!(p.c > 0 || cs.wood > 0)) return [null, `Light the stove to cook ${what} - bring firewood`];
    }
    const src = p.c > 0 ? '' : cs.wood > 0 ? ' from the woodbox' : null;
    const heat = cs.pot >= 0 ? `  ·  ${dishName(cs.art, pk)} ${Math.round(cs.pot / need * 100)}%` : '';
    if (src !== null) {
      if (cs.fuel > 91) return [null, 'Stove is roaring — full' + heat];
      return ['E', (cs.fuel <= 0 ? 'Light the stove' : 'Add a log') + src + heat];
    }
    return [null, (cs.fuel > 0 ? 'Fire burning — bring more logs' : 'Stove is cold — bring firewood') + heat];
  }
  return null;
}
// when you carry more than one kind of food, the prompt offers the number keys
function cookChoices(p) {
  const opts = [];
  if (p.meat) opts.push('1 ' + (p.mk === 'rabbit' ? 'rabbit' : 'venison')); if (p.fish) opts.push('2 trout'); if (p.can) opts.push('3 ' + CAN_INFO[p.ck].name);
  return opts.length > 1 ? '   ·   or press ' + opts.join(' · ') : '';
}
function interact() {
  const t = target; if (!t || !S) return;
  if (t.kind === 'log') send({ t: 'act', a: 'pickup', id: t.id });
  else if (t.kind === 'bonfire') send({ t: 'act', a: 'bonfire' });
  else if (t.kind === 'bed') send({ t: 'act', a: 'sleep', cabin: t.cabin });
  else if (storyInteract(t)) return;
  else send({ t: 'act', a: t.kind, cabin: t.cabin, i: t.i });
}

// ----------------------------------------------------------------- physics
function collide() {
  const R = 0.4;
  for (const c of cabins) {
    if (Math.abs(me.x - c.x) > 12 || Math.abs(me.z - c.z) > 12) continue;
    let [lx, lz] = toLocal(c, me.x, me.z);
    const solids = c.doorAngle < 0.6 ? [...c.solids, [-0.8, 0.8, CABIN_D / 2, CABIN_D / 2 + 0.35]] : c.solids;
    for (const [x0, x1, z0, z1] of solids) {
      const cx = clamp(lx, x0, x1), cz = clamp(lz, z0, z1);
      const dx = lx - cx, dz = lz - cz, d = Math.hypot(dx, dz);
      if (d < R) {
        if (d > 1e-4) { lx = cx + dx / d * R; lz = cz + dz / d * R; }
        else { // inside the box: push out along the shortest axis
          const opts = [[x0 - R - lx, 0], [x1 + R - lx, 0], [0, z0 - R - lz], [0, z1 + R - lz]].sort((a, b) => Math.abs(a[0] + a[1]) - Math.abs(b[0] + b[1]));
          lx += opts[0][0]; lz += opts[0][1];
        }
      }
    }
    [me.x, me.z] = toWorld(c, lx, lz);
  }
  const k0 = Math.floor(me.x / 10), k1 = Math.floor(me.z / 10);
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    const cell = treeCells.get((k0 + a) + ',' + (k1 + b)); if (!cell) continue;
    for (const [tx, tz, tr] of cell) {
      const dx = me.x - tx, dz = me.z - tz, d = Math.hypot(dx, dz), m = tr + R;
      if (d < m && d > 1e-4) { me.x = tx + dx / d * m; me.z = tz + dz / d * m; }
    }
  }
  const r = Math.hypot(me.x, me.z); if (r > 300) { me.x *= 300 / r; me.z *= 300 / r; }
}

function movePlayer(dt, frozen) {
  const P = myState();
  if (P && P.fly > 0) {            // riding the helicopter
    me.vx = me.vz = me.vy = 0;
    if (heli) { me.x = heli.g.position.x; me.z = heli.g.position.z; me.y = heli.g.position.y + 0.4; }
    return;
  }
  if (P && P.lost) { me.vx = me.vz = 0; return; }
  if (P && P.inB) {                // inside the shelter: walk around the room
    const b = bunkerXZ(), fl = roomFloor();
    let ix = 0, iz = 0;
    if (!chatting) { if (keys.KeyW || keys.ArrowUp) iz -= 1; if (keys.KeyS || keys.ArrowDown) iz += 1; if (keys.KeyA || keys.ArrowLeft) ix -= 1; if (keys.KeyD || keys.ArrowRight) ix += 1; }
    const l = Math.hypot(ix, iz) || 1, s = Math.sin(me.yaw), c = Math.cos(me.yaw);
    me.x += ((ix * c + iz * s) / l) * 3.5 * dt; me.z += ((-ix * s + iz * c) / l) * 3.5 * dt;
    if (b) { me.x = clamp(me.x, b[0] - 4, b[0] + 4); me.z = clamp(me.z, b[1] - 2.6, b[1] + 3); }
    me.y = fl; me.vy = 0; me.onGround = true;
    return;
  }
  const ice = onIce(me.x, me.z);
  let ix = 0, iz = 0;
  if (!frozen && !chatting) {
    if (keys.KeyW || keys.ArrowUp) iz -= 1; if (keys.KeyS || keys.ArrowDown) iz += 1;
    if (keys.KeyA || keys.ArrowLeft) ix -= 1; if (keys.KeyD || keys.ArrowRight) ix += 1;
  }
  const len = Math.hypot(ix, iz) || 1; ix /= len; iz /= len;
  const sp = (keys.ShiftLeft || keys.ShiftRight ? 9.5 : 5.2) * (S && S.gale > 0.5 && !insideAny() ? 0.8 : 1);
  const s = Math.sin(me.yaw), c = Math.cos(me.yaw);
  const wx = (ix * c + iz * s) * sp, wz = (-ix * s + iz * c) * sp;
  const acc = ice ? 2.2 : 14;
  me.vx += (wx - me.vx) * Math.min(1, acc * dt); me.vz += (wz - me.vz) * Math.min(1, acc * dt);
  // the gale shoves you around outdoors
  if (S && S.gale > 0 && !insideAny()) { const w = windVec(); me.vx += w.x * S.gale * 0.9 * dt; me.vz += w.y * S.gale * 0.9 * dt; }
  const ox = me.x, oz = me.z;
  me.x += me.vx * dt; me.z += me.vz * dt;
  collide();
  let g = groundAt(me.x, me.z);
  // block steep climbs (valley walls / cliffs)
  if (g - me.y > 0.9 && me.onGround) { me.x = ox; me.z = oz; me.vx *= 0.2; me.vz *= 0.2; g = groundAt(me.x, me.z); }
  if (!frozen && keys.Space && me.onGround) { me.vy = 7.2; me.onGround = false; }
  me.vy -= (ASHK > 0.5 ? 10 : 22) * dt; me.y += me.vy * dt;
  if (me.y <= g + 0.02 || (me.onGround && me.y - g < 0.6 && me.vy <= 0)) { me.y = g; me.vy = 0; me.onGround = true; } else me.onGround = false;
}
function insideAny() { for (const c of cabins) { const [lx, lz] = toLocal(c, me.x, me.z); if (Math.abs(lx) < CABIN_W / 2 && Math.abs(lz) < CABIN_D / 2) return c; } return null; }
function windVec() { const a = 0.6 + Math.sin(clockU.value * 0.05) * 0.4; return new THREE.Vector2(Math.cos(a) * 9, Math.sin(a) * 9); }

// --------------------------------------------------------------- atmosphere
const C = (h) => new THREE.Color(h);
const SKY = {
  day: [C(0x4f8fd6), C(0xd9e8f6)], dusk: [C(0x29386a), C(0xd88a68)], night: [C(0x03060f), C(0x0e1a30)], dawn: [C(0x3d5d92), C(0xf0a47a)], gale: [C(0x4a5566), C(0x6f7b8c)],
};
// how dark it is (0 day .. 1 night) and how much sunrise/sunset colour there is
function skyState(t) {
  if (t >= 450 && t < 990) return { dark: 0, warm: 0, eve: false };
  if (t >= 990 && t < 1170) { const k = (t - 990) / 180; return { dark: smooth(0.1, 1, k), warm: Math.sin(k * Math.PI), eve: true }; }
  if (t >= 300 && t < 450) { const k = (t - 300) / 150; return { dark: 1 - smooth(0, 0.9, k), warm: Math.sin(k * Math.PI), eve: false }; }
  return { dark: 1, warm: 0, eve: false };
}
const ASH_HI = new THREE.Color(0x4a4640), ASH_LO = new THREE.Color(0x8c8378);
const tmpA = new THREE.Color(), tmpB = new THREE.Color(), fogC = new THREE.Color(), SUNC = new THREE.Color(0xfff1d8);
const SKY_BLAST_LO = new THREE.Color(0xff7a2a), SKY_BLAST_HI = new THREE.Color(0x6a2a1a);
let impactAge = 0;
function atmosphere(dt) {
  const gale = S ? S.gale : 0;
  const { dark, warm, eve } = skyState(localTod);
  tmpA.copy(SKY.day[0]).lerp(SKY.night[0], dark); tmpB.copy(SKY.day[1]).lerp(SKY.night[1], dark);
  const tint = eve ? SKY.dusk : SKY.dawn;
  tmpA.lerp(tint[0], warm * 0.7); tmpB.lerp(tint[1], warm * 0.85);
  const gn = 1 - dark * 0.55;
  tmpA.lerp(tmpC(SKY.gale[0], gn), gale); tmpB.lerp(tmpC(SKY.gale[1], gn), gale);
  if (S && S.impact) {             // the blast lights the sky, then fades
    impactAge = ((localTod - WINFO.impactTod + 1440) % 1440) / (S.rate || 1); const glow = Math.max(0, 1 - impactAge / 60);
    tmpB.lerp(SKY_BLAST_LO, 0.75 * glow); tmpA.lerp(SKY_BLAST_HI, 0.45 * glow);
  } else impactAge = 0;
  if (S && S.siren && !S.impact) tmpB.lerp(SKY_BLAST_LO, 0.08 + Math.max(0, Math.sin(clockU.value * 0.9)) * 0.06);
  ASHK = S && S.impact ? smooth(1.5, 7, impactAge) : 0;
  if (ASHK > 0) { tmpA.lerp(ASH_HI, ASHK * 0.9); tmpB.lerp(ASH_LO, ASHK * 0.9); }
  applyAsh(ASHK);
  sky.material.uniforms.top.value.copy(tmpA); sky.material.uniforms.bot.value.copy(tmpB);
  fogC.copy(tmpB).lerp(tmpA, 0.3);
  scene.fog.color.copy(fogC);
  const inside = insideAny();
  scene.fog.density = lerp(lerp(lerp(0.0028, 0.0075, dark), 0.0065, ASHK), inside ? 0.02 : 0.05, gale);
  stars.material.opacity = dark * (1 - gale);
  moon.material.opacity = (dark > 0.5 ? dark : 1 - dark) * (1 - gale) * 0.95;
  moon.material.color.set(dark > 0.5 ? 0xffffff : 0xfff2c8);   // the moon by night, the sun by day
  stars.visible = moon.visible = snow.visible = !inside;
  sky.position.copy(camera.position); stars.position.copy(camera.position);
  if (dark > 0.5) moon.position.set(camera.position.x - 380, camera.position.y + 420, camera.position.z - 520);
  else { const sa = ((localTod - 360) / 720) * Math.PI; moon.position.set(camera.position.x + Math.cos(sa) * 600, camera.position.y + 120 + Math.sin(sa) * 520, camera.position.z - 300); }
  hemi.intensity = lerp(1.35, 0.32, dark) * (1 - gale * 0.25);
  hemi.color.set(0x8aa4d6).lerp(C(0xaab4c4), gale);
  moonLight.intensity = lerp(1.0, 0.45, dark) * (1 - gale * 0.7);
  moonLight.color.set(0xbcd0ff).lerp(SUNC, 1 - dark);
  lantern.distance = 26; lantern.visible = dark > 0.25 || insideAny();
  frostU.value = (0.3 + gale * 0.6) * (1 - ASHK);
  terrainMat.color.set(0xffffff).lerp(C(0xd6e4ff), gale * 0.6);
  // snow
  const u = snow.material.uniforms, w = windVec();
  u.uCam.value.copy(camera.position);
  u.uWind.value.set(w.x * gale * 1.8 + 0.4, w.y * gale * 1.8);
  u.uFall.value = lerp(2.2 + gale * 3, 0.7, ASHK);
  u.uDen.value = lerp(0.3 + gale * 0.7, 0.75, ASHK);
  u.uCol.value.set(0xffffff).lerp(ASH_LO, ASHK);
  u.uBox.value.set(inside ? 40 : 70, 36, inside ? 40 : 70);
  // frost vignette
  const p = myState();
  const cold = p ? clamp((55 - p.w) / 55, 0, 1) : 0;
  $('frost').style.opacity = Math.max(cold * 0.95, inside ? 0 : gale * 0.35).toFixed(3);
  lantern.intensity = 3.2 * (0.9 + Math.sin(clockU.value * 13) * 0.03 + Math.sin(clockU.value * 7.3) * 0.04);
  if (mast) mast.material.opacity = Math.sin(clockU.value * 3) > 0.2 ? 1 : 0.08;
}
function tmpC(c, k) { return c.clone().multiplyScalar(k); }

function animateCabins(t) {
  const w = windVec(), gale = S ? S.gale : 0;
  for (const c of cabins) {
    const cs = c.state; if (!cs) continue;
    const f = cs.fuel / 100, lit = cs.fuel > 0, nc = cs.candles.reduce((a, b) => a + b, 0);
    const flick = 0.85 + Math.sin(t * 11 + c.i) * 0.08 + Math.sin(t * 23.7 + c.i * 3) * 0.07;
    c.light.intensity = lit ? (2.2 + f * 2.2) * flick + nc * 0.5 : nc * 0.35;
    for (const win of c.windows) win.material = lit || nc ? winOn : winOff;
    c.stoveGlow.color.setRGB(lit ? 1 * flick : 0.07, lit ? 0.45 * flick : 0.07, lit ? 0.12 : 0.07);
    c.beacon.material.opacity = lit ? (0.25 + f * 0.45) * flick : 0;
    c.smoke.material.uniforms.uA.value = lit ? 0.4 + f * 0.6 : 0;
    c.smoke.material.uniforms.uWind.value.set(0.25 + w.x / 9 * (0.3 + gale), w.y / 9 * (0.3 + gale));
    c.woodLogs.forEach((l, i) => (l.visible = i < cs.wood));
    const want = cs.door ? 1.75 : 0;
    if (c.doorWant !== undefined && c.doorWant !== want && Math.hypot(me.x - c.x, me.z - c.z) < 40) noiseBurst(want ? 0.35 : 0.18, want ? 900 : 300, want ? 0.18 : 0.5);
    c.doorWant = want;
    c.doorAngle += (want - c.doorAngle) * 0.18;
    c.door.rotation.y = c.doorAngle;
    syncCanSlots(c.canSlots, cs.cl, c.cabinGroup);
    c.candleFlames.forEach((fl, i) => { fl.visible = !!cs.candles[i]; fl.scale.set(0.3 + Math.sin(t * 17 + i) * 0.03, 0.48 + Math.sin(t * 13 + i * 2) * 0.05, 1); });
    const need = FOOD_TIME[cs.pk] || 20;
    syncDish(c.pot, cs.pot >= 0 ? cs.art || 'can:stew' : '', cs.pot / need);
    c.steam.visible = cs.pot >= 0 && (cs.pot >= need || (lit && cs.pot > need * 0.4)); c.steam.position.y = 1.65 + Math.sin(t * 2) * 0.08;
    c.steam.material.opacity = cs.pot >= need ? 0.4 : 0.18;
    if (c.wisps) c.wisps.forEach((wp) => { const d = wp.userData; d.a += 0.004; wp.position.set(c.x + Math.cos(d.a) * d.r, groundAt(c.x + Math.cos(d.a) * d.r, c.z + Math.sin(d.a * 1.3) * d.r) + d.y + Math.sin(t + d.r) * 0.3, c.z + Math.sin(d.a * 1.3) * d.r); });
  }
}

function animateAvatars(dt, t) {
  const k = 1 - Math.exp(-12 * dt);
  for (const a of avatars.values()) {
    const p = a.t, g = a.g;
    const moving = Math.hypot(p.x - g.position.x, p.z - g.position.z) > 0.03;
    g.position.x = lerp(g.position.x, p.x, k); g.position.z = lerp(g.position.z, p.z, k); g.position.y = lerp(g.position.y, p.y, k);
    let d = p.ry - g.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d)); g.rotation.y += d * k;
    g.children[0].position.y = 0.78 + (moving ? Math.abs(Math.sin(t * 9)) * 0.06 : 0);
    a.wasMoving = moving;
    a.back.forEach((l, i) => (l.visible = i < p.c));
    a.coat.color.copy(a.base); if (p.f > 0) a.coat.color.lerp(C(0xcfe9ff), 0.85);
    g.rotation.z = p.f > 0 || p.lost ? 0.25 : 0;
    const mine = myState();
    g.visible = !!p.inB === !!(mine && mine.inB) && !(p.fly > 0);
  }
}

// --------------------------------------------------------------------- hud
function fmtClock(m) { const tot = Math.floor(m) % 1440; let h = Math.floor(tot / 60) % 24; const mm = tot % 60; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${String(mm).padStart(2, '0')} ${ap}`; }
function fmtDur(gm, rate) { const s = Math.max(0, rate ? gm / rate : gm * nightSeconds / 720); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }
function buildCabinList() {
  $('cabList').innerHTML = cabins.map((c, i) => `<div class="cab" id="cab${i}"><div class="row"><span class="nm"><span class="dot" style="background:${REGION_COL[c.region]}"></span>${c.name}</span><span class="meta" id="cabM${i}"></span></div><div class="bar"><i id="cabB${i}"></i></div></div>`).join('');
}
function updateHud() {
  if (!S || !world) return;
  const p = myState(); if (!p) return;
  $('clockT').textContent = fmtClock(localTod);
  const ph = $('clockP');
  const finaleDay = S.day >= world.days;
  $('galeBand').style.display = finaleDay ? 'none' : '';
  if (S.phase === 'dawn') { ph.textContent = finaleDay ? 'The valley is silent' : 'Dawn — the gale has passed'; ph.className = 'ph'; }
  else if (finaleDay && S.impact) {
    if (!S.clear) { ph.textContent = `FALLOUT · hatch opens in ${fmtDur((world.hatchTod - localTod + 1440) % 1440, S.rate)}`; ph.className = 'ph gale'; }
    else { ph.textContent = `Ash everywhere · night falls in ${fmtDur((1080 - localTod + 1440) % 1440, S.rate)}`; ph.className = 'ph warn'; }
  }
  else if (finaleDay && S.siren) { ph.textContent = `AIR RAID · impact in ${fmtDur((world.impactTod - localTod + 1440) % 1440, S.rate)}`; ph.className = 'ph gale'; }
  else if (!isNight()) {
    const left = (1080 - localTod + 1440) % 1440;
    ph.textContent = `Daylight · night falls in ${fmtDur(left, S.rate)}${finaleDay ? '' : ''}`; ph.className = left < 70 ? 'ph warn' : 'ph';
  }
  else if (finaleDay) {
    if (S.impact) { ph.textContent = 'After the blast'; ph.className = 'ph'; }
    else { ph.textContent = 'No gale tonight · stay near a radio'; ph.className = 'ph'; }
  }
  else if (S.m >= world.galeStart && S.m < world.galeEnd) { ph.textContent = `ICY GALE · ends in ${fmtDur(world.galeEnd - S.m)}`; ph.className = 'ph gale'; }
  else if (S.m < world.galeStart) { const left = world.galeStart - S.m; ph.textContent = `Gale arrives in ${fmtDur(left)}`; ph.className = left < 90 ? 'ph warn' : 'ph'; }
  else { ph.textContent = `Sunrise in ${fmtDur(world.dawn - S.m)} - a new day`; ph.className = 'ph'; }
  $('nightNow').style.left = clamp(((localTod - 360 + 1440) % 1440) / 1440 * 100, 0, 100) + '%';
  $('warmBar').style.width = p.w + '%'; $('warmN').textContent = Math.round(p.w);
  $('hungBar').style.width = p.h + '%'; $('hungN').textContent = Math.round(p.h);
  document.querySelectorAll('#carry .logdot').forEach((d, i) => d.classList.toggle('on', i < p.c));
  const ct = $('canTag'); ct.classList.toggle('hidden', !p.can); ct.textContent = p.can ? CAN_INFO[p.ck].name : '';
  cabins.forEach((c, i) => {
    const cs = c.state; if (!cs) return;
    const here = S.players.filter((q) => q.in === i);
    const el = $('cab' + i); el.classList.toggle('here', p.in === i); el.classList.toggle('out', cs.fuel <= 0);
    $('cabB' + i).style.width = cs.fuel + '%';
    $('cabM' + i).innerHTML = `${cs.fuel > 0 ? Math.round(cs.fuel) + '%' : 'cold'} · wood ${cs.wood}` + (here.length ? `<span class="pips">${here.map((q) => `<b style="background:${q.color}"></b>`).join('')}</span>` : '');
  });
  storyHud(p);
  $('frozenOv').classList.toggle('hidden', !(p.f > 0));
  if (p.f > 0) $('frozenMsg').textContent = `Thawing out by the nearest fire in ${Math.ceil(p.f)}…`;
  const dov = $('dawnOv');
  if (S.summary) {
    dov.classList.remove('hidden'); dov.classList.toggle('soft', !S.summary.finale);
    const s = S.summary;
    const head = s.finale
      ? `<div class="big">${s.saved.length ? 'You survived' : 'The valley is silent'}</div><div style="color:var(--dim);margin-top:6px">${s.saved.length} of ${s.players.length} made it into the bunker${s.saved.length ? ': ' + s.saved.map(esc).join(', ') : ''}.</div>`
      : `<div class="big">Good morning - Day ${s.day + 1}</div><div style="color:var(--dim);margin-top:6px">You made it through night ${s.day}. ${s.litCabins.length} of 5 cabins kept burning${s.litCabins.length ? ': ' + s.litCabins.join(', ') : ''}.</div>`;
    $('dawnCard').innerHTML = `${head}
      <table><tr><th></th><th>Hiker</th>${s.finale ? '<th>Bunker</th>' : ''}<th>Logs</th><th>Hunted</th><th>Fish</th><th>Frozen</th></tr>${s.players.map((r, i) => `<tr><td>${i === 0 ? '★' : ''}</td><td><span class="dot" style="background:${r.color}"></span>${esc(r.name)}</td>${s.finale ? `<td>${r.saved ? '✓' : '✗'}</td>` : ''}<td>${r.logs}</td><td>${r.kills}</td><td>${r.catches}</td><td>${r.freezes}</td></tr>`).join('')}</table>
      <div style="color:var(--dim);margin-top:12px">${s.finale ? `A new story begins on Day 1 in ${Math.ceil(S.dawnIn)}s` : 'The sun is up - get moving!'}</div>`;
  } else dov.classList.add('hidden');
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function renderRoster() {
  if (!S) return;
  $('roster').innerHTML = `<table><tr><th>Hiker</th><th>Warmth</th><th>Where</th></tr>${S.players.map((p) => `<tr><td><span class="dot" style="background:${p.color}"></span>${esc(p.name)}${p.id === myId ? ' (you)' : ''}</td><td>${p.f > 0 ? 'frozen' : Math.round(p.w)}</td><td>${p.in >= 0 ? cabins[p.in].name : 'outdoors'}</td></tr>`).join('')}</table>`;
}
function toast(text, ms = 4500) {
  const t = document.createElement('div'); t.className = 'toast panel'; t.textContent = text; $('toasts').appendChild(t);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
  setTimeout(() => { t.style.opacity = 0; setTimeout(() => t.remove(), 700); }, ms);
}
function addChat(from, color, text) {
  const d = document.createElement('div'); d.innerHTML = `<b style="color:${esc(color)}">${esc(from)}:</b> ${esc(text)}`; $('chatLog').appendChild(d);
  while ($('chatLog').children.length > 7) $('chatLog').firstChild.remove();
  setTimeout(() => { d.style.opacity = 0.25; }, 20000);
}

const proj = new THREE.Vector3();
function updateTags() {
  const mineP = myState();
  const inside = insideAny() || (mineP && (mineP.inB || mineP.lost));
  cabins.forEach((c, i) => {
    const el = cabinTags[i], d = Math.hypot(c.x - me.x, c.z - me.z);
    proj.set(c.x, c.base + 8, c.z).project(camera);
    if (inside || d < 16 || proj.z > 1 || Math.abs(proj.x) > 1.05 || Math.abs(proj.y) > 1.05) { el.style.display = 'none'; return; }
    el.style.display = ''; el.style.left = ((proj.x + 1) / 2 * innerWidth) + 'px'; el.style.top = ((1 - proj.y) / 2 * innerHeight) + 'px';
    const lit = c.state && c.state.fuel > 0;
    el.className = 'ctag' + (lit ? ' lit' : '');
    el.innerHTML = `<b>${c.name}</b>${Math.round(d)} m · ${lit ? 'fire lit' : 'cold'}`;
  });
}

// --------------------------------------------------------------------- map
function resizeMap() { const cv = $('map'), s = bigMap ? Math.min(560, innerHeight - 80) : 190; cv.width = cv.height = s; $('mapWrap').classList.toggle('big', bigMap); }
function drawMap() {
  const cv = $('map'), g = cv.getContext('2d'), s = cv.width, k = s / 600, X = (x) => s / 2 + x * k, Z = (z) => s / 2 + z * k;
  g.fillStyle = '#121a28'; g.fillRect(0, 0, s, s);
  g.fillStyle = '#1a2436'; g.beginPath(); g.arc(s / 2, s / 2, 295 * k, 0, 7); g.fill();
  g.fillStyle = 'rgba(143,208,255,.35)'; g.beginPath(); g.arc(X(LAKE.x), Z(LAKE.z), LAKE.r * k, 0, 7); g.fill();
  g.fillStyle = 'rgba(200,215,235,.12)'; g.beginPath(); g.arc(X(0), Z(-275), 70 * k, 0, 7); g.fill();
  g.fillStyle = '#8a6a4a';
  for (const m of logMeshes.values()) { if (Math.hypot(m.position.x - me.x, m.position.z - me.z) < (bigMap ? 400 : 90)) g.fillRect(X(m.position.x) - 1, Z(m.position.z) - 1, bigMap ? 3 : 2, bigMap ? 3 : 2); }
  for (const c of cabins) {
    const lit = c.state && c.state.fuel > 0;
    if (lit) { const gr = g.createRadialGradient(X(c.x), Z(c.z), 0, X(c.x), Z(c.z), 14 * (bigMap ? 2 : 1)); gr.addColorStop(0, 'rgba(255,170,80,.8)'); gr.addColorStop(1, 'rgba(255,120,40,0)'); g.fillStyle = gr; g.fillRect(X(c.x) - 30, Z(c.z) - 30, 60, 60); }
    g.save(); g.translate(X(c.x), Z(c.z)); g.rotate(-c.rot);
    g.fillStyle = lit ? '#ffb35c' : '#64748b'; g.fillRect(-4, -3, 8, 6); g.restore();
    if (bigMap) { g.fillStyle = '#dfe7f3'; g.font = '13px system-ui, sans-serif'; g.textAlign = 'center'; g.fillText(c.name, X(c.x), Z(c.z) - 10); }
  }
  g.fillStyle = '#f3e3c3'; g.fillRect(X(SPAWN.x) - 2, Z(SPAWN.z) - 2, 4, 4);
  if (S && WINFO) {
    const me2 = myState();
    if (S.day >= 3) { g.fillStyle = '#0b1a2a'; for (const [x, z] of WINFO.holes) { g.beginPath(); g.arc(X(x), Z(z), bigMap ? 3 : 1.6, 0, 7); g.fill(); } }
    for (const m of itemMeshes.values()) { const { kind, x, z } = m.userData; g.fillStyle = kind === 'axe' || kind === 'rod' ? '#ffe9a0' : '#7fe0ff'; g.fillRect(X(x) - 2, Z(z) - 2, 4, 4); }
    if (S.day >= 4) {
      const H = S.heli; g.fillStyle = H.run ? '#7dffa0' : '#c9d3e0'; g.font = `bold ${bigMap ? 16 : 11}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('H', X(H.x), Z(H.z));
    }
    const b = bunkerXZ();
    if (b && me2 && (me2.kb || me2.inB)) {
      const pulse = 5 + Math.sin(clockU.value * 5) * 2;
      g.strokeStyle = '#ff5a4a'; g.lineWidth = 2; g.beginPath(); g.arc(X(b[0]), Z(b[1]), pulse * (bigMap ? 1.6 : 1), 0, 7); g.stroke();
      g.fillStyle = '#f2c230'; g.beginPath(); g.arc(X(b[0]), Z(b[1]), bigMap ? 4 : 2.5, 0, 7); g.fill();
      if (bigMap) { g.fillStyle = '#ffd27a'; g.font = '13px system-ui, sans-serif'; g.textBaseline = 'alphabetic'; g.fillText('BUNKER', X(b[0]), Z(b[1]) - 12); }
    }
    if (bigMap) for (const a of animalMeshes.values()) { g.fillStyle = a.kind === 'deer' ? '#c08a5a' : '#e8e2d8'; g.fillRect(X(a.g.position.x) - 1.5, Z(a.g.position.z) - 1.5, 3, 3); }
  }
  if (S) for (const p of S.players) { if (p.id === myId) continue; g.fillStyle = p.color; g.beginPath(); g.arc(X(p.x), Z(p.z), bigMap ? 5 : 3.5, 0, 7); g.fill(); }
  g.save(); g.translate(X(me.x), Z(me.z)); g.rotate(-me.yaw); g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, -7); g.lineTo(4.5, 5); g.lineTo(0, 2.5); g.lineTo(-4.5, 5); g.closePath(); g.fill(); g.restore();
}

// ------------------------------------------------------------------- audio
let actx, windGain, windFilter, crackleGain, master = null;
let volume = (() => { const v = parseFloat(store('ffc.volume')); return isFinite(v) ? clamp(v, 0, 1) : 0.7; })();
function OUT() { if (!master) { master = actx.createGain(); master.gain.value = volume * volume; master.connect(actx.destination); } return master; }
function setVolume(v, show) {
  volume = clamp(Math.round(v * 20) / 20, 0, 1); store('ffc.volume', String(volume));
  if (master) master.gain.value = volume * volume;
  $('volSlider').value = Math.round(volume * 100); $('volIcon').textContent = volume === 0 ? '🔇' : volume < 0.4 ? '🔈' : volume < 0.75 ? '🔉' : '🔊';
  if (show) { const el = $('volWrap'); el.classList.add('flash'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('flash'), 900); }
}
let lastVol = 0.7;
function startAudio() {
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    const len = actx.sampleRate * 2, buf = actx.createBuffer(1, len, actx.sampleRate), d = buf.getChannelData(0);
    let last = 0; for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    const src = actx.createBufferSource(); src.buffer = buf; src.loop = true;
    windFilter = actx.createBiquadFilter(); windFilter.type = 'bandpass'; windFilter.frequency.value = 500; windFilter.Q.value = 0.6;
    windGain = actx.createGain(); windGain.gain.value = 0;
    src.connect(windFilter).connect(windGain).connect(OUT()); src.start();
    crackleGain = actx.createGain(); crackleGain.gain.value = 0; crackleGain.connect(OUT());
  } catch (e) { actx = null; }
}
let crackleT = 0;
function audioTick(dt, t) {
  if (!actx) return;
  if (actx.state === 'suspended') actx.resume();
  const gale = S ? S.gale : 0, inside = insideAny();
  const target = (0.05 + gale * 0.4) * (inside ? 0.3 : 1);
  windGain.gain.value += (target - windGain.gain.value) * Math.min(1, dt * 2);
  windFilter.frequency.value = 350 + gale * 500 + Math.sin(t * 0.7) * 120 + Math.sin(t * 2.3) * 60;
  // fire crackle near a lit stove
  let near = 0;
  for (const c of cabins) { if (!c.state || c.state.fuel <= 0) continue; const [x, z] = toWorld(c, ...STOVE); near = Math.max(near, 1 - Math.hypot(me.x - x, me.z - z) / 9); }
  if (S && S.bonfire > 0 && WINFO) near = Math.max(near, 1.2 * (1 - Math.hypot(me.x - WINFO.bonfire[0], me.z - WINFO.bonfire[1]) / 14));
  crackleT -= dt;
  if (near > 0 && crackleT <= 0) {
    crackleT = 0.03 + Math.random() * 0.25;
    const n = actx.createBufferSource(), b = actx.createBuffer(1, 400, actx.sampleRate), dd = b.getChannelData(0);
    for (let i = 0; i < 400; i++) dd[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / 400, 3);
    n.buffer = b; const gg = actx.createGain(); gg.gain.value = near * (0.08 + Math.random() * 0.18); n.connect(gg).connect(OUT()); n.start();
  }
}

// -------------------------------------------------------------------- loop
let last = performance.now(), sendAcc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  clockU.value += dt;
  if (S && S.phase === 'play') localTod = (localTod + dt * (S.rate || 1)) % 1440;
  const p = myState(), frozen = p && p.f > 0;
  movePlayer(dt, frozen);
  if (p && p.inB && Math.abs(me.y - roomFloor()) > 1) me.y = roomFloor();
  const bob = me.onGround && (Math.abs(me.vx) + Math.abs(me.vz) > 1) ? Math.sin(clockU.value * 10) * 0.04 : 0;
  camera.position.set(me.x, me.y + (frozen ? 0.6 : 1.62) + bob, me.z);
  camera.rotation.set(me.pitch, me.yaw, frozen ? 0.4 : 0, 'YXZ');
  sendAcc += dt;
  if (sendAcc > 1 / 15) { sendAcc = 0; send({ t: 'pos', x: +me.x.toFixed(2), y: +me.y.toFixed(2), z: +me.z.toFixed(2), ry: +me.yaw.toFixed(3) }); }
  target = frozen ? null : findTarget();
  const pr = promptFor(target), pe = $('prompt');
  if (pr) { pe.classList.remove('hidden'); pe.innerHTML = (pr[0] ? `<kbd>${pr[0]}</kbd>` : '') + esc(pr[1]); } else pe.classList.add('hidden');
  atmosphere(dt);
  animateCabins(clockU.value);
  animateAvatars(dt, clockU.value);
  animateStory(dt, clockU.value);
  bombTick(dt, clockU.value);
  puffTick(dt, ASHK);
  geigerTick(dt);
  autoPickup(dt);
  highlightTarget();
  updateTags();
  if ((frameN++ & 3) === 0) { drawMap(); if (!$('roster').classList.contains('hidden')) renderRoster(); }
  if (S) $('clockT').textContent = fmtClock(localTod);
  audioTick(dt, clockU.value);
  sirenTick(dt);
  renderTV();
  renderer.render(scene, camera);
}
let frameN = 0;

// --------------------------------------------------------------- join form
const COLORS = ['#e8a33d', '#d9534f', '#4fa3e0', '#5cb85c', '#a77bd8', '#f06fa8', '#3fc1b5', '#f1f1f1'];
let pickedColor = store('ffc.color') || COLORS[Math.floor(Math.random() * COLORS.length)];
$('swatches').innerHTML = COLORS.map((c) => `<div class="sw" data-c="${c}" style="background:${c}"></div>`).join('');
const paintSw = () => document.querySelectorAll('.sw').forEach((s) => s.classList.toggle('on', s.dataset.c === pickedColor));
document.querySelectorAll('.sw').forEach((s) => s.addEventListener('click', () => { pickedColor = s.dataset.c; paintSw(); }));
paintSw();
const paintQ = () => document.querySelectorAll('#quality button').forEach((b) => b.classList.toggle('on', b.dataset.q === quality));
document.querySelectorAll('#quality button').forEach((b) => b.addEventListener('click', () => { quality = b.dataset.q; paintQ(); }));
paintQ();
$('nameIn').value = qs.get('name') || store('ffc.name') || '';
$('srvIn').value = qs.get('server') || store('ffc.server') || '';
$('srvIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
function join() {
  const name = $('nameIn').value.trim() || 'Hiker';
  store('ffc.name', name); store('ffc.color', pickedColor); store('ffc.quality', quality);
  $('go').disabled = true; $('joinErr').textContent = '';
  connect(name, pickedColor);
}
$('go').addEventListener('click', join);
$('nameIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
if (qs.has('auto')) join();

$('volSlider').addEventListener('input', (e) => setVolume(e.target.value / 100));
$('volIcon').addEventListener('click', () => { if (volume > 0) { lastVol = volume; setVolume(0, true); } else setVolume(lastVol || 0.7, true); });
setVolume(volume);

// handy for testing / screenshots: window.ff.go(x, z, yaw, pitch)
window.ff = { me, go(x, z, yaw = me.yaw, pitch = 0) { me.x = x; me.z = z; me.y = groundAt(x, z); me.yaw = yaw; me.pitch = pitch; }, cabins: () => cabins, send, state: () => S };
