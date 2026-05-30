// ============================================================
// render3d.js — optional Three.js renderer for Weekend Road Trip
// ------------------------------------------------------------
// This module draws the SAME simulation that game.js already runs. It does not
// own any game logic: every frame it reads window.__roadtrip (the read-only
// bridge published by game.js) and positions 3D objects from that state.
//
// Coordinate mapping from the 2D side-scroller to the 3D road:
//   2D screen x (obstacles scroll right -> left)  ->  3D depth Z (far -> near)
//   fixed PLAYER_X                                 ->  the car's plane (z = 0)
//   2D screen y (GROUND_Y = road, smaller = up)    ->  3D height Y
//   biomeIdx + biomeBlend()                        ->  sky / fog / ground colour
//
// Look: "polished stylized" — clean low-poly shapes, soft shadows, ACES tone
// mapping, gradient sky, clearcoat car paint. The 2D canvas renderer in game.js
// stays the default and the fallback; press T to toggle. If anything here
// throws, game.js disables 3D and falls back.
// ============================================================
import * as THREE from 'three';

// Public handle game.js looks for (see the render() delegate in game.js).
const RT = {
  enabled: (localStorage.getItem('wrt.render3d') || 'true') !== 'false',
  ready: false,
  render: renderFrame,
  toggle: () => setEnabled(!RT.enabled),
};
window.RT3D = RT;

// ---- tunables (eyeball these; they drive the whole look) -------------------
const SCALE = 0.05;      // pixels -> world units for sizes / heights
const SCALE_Z = 0.06;    // pixels -> world units for depth (distance ahead)
const ROAD_HALF = 5.5;   // half width of the asphalt
const SEMI_LANE = 3.2;   // lateral offset for overtaking semis
const DASH_GAP = 6;      // spacing of centre-line dashes (world units)
const DASH_SPAN = 108;   // total scroll length before a dash recycles
const Z_NEAR = 16;       // nearest road point (behind the car a little)
const Z_FAR = -110;      // farthest visible road point
// Behind-the-car chase camera: centred, above + behind, looking down the road.
const CAM_POS = { x: 0, y: 3.5, z: 10 };
const CAM_LOOK = { x: 0, y: 1.4, z: -22 };
const FOV_BASE = 55, FOV_GAIN = 12;
const SCN_COUNT = 20;    // roadside props per side
const SCN_GAP = 16;      // spacing between props (world units)
const SCN_SPAN = 320;    // scroll length before a prop recycles into the distance

// ---- module state ----------------------------------------------------------
let bridge = null;          // window.__roadtrip
let C = null;               // bridge.consts (W, GROUND_Y, PLAYER_X, ...)
let scene, camera, renderer, car, wheels = [], cabin = null;
let hemi, sun, skyMat;
let initialized = false;
const dashes = [], posts = [], scnSlots = [];
let lastBiomeIdx = -1;
const statusEl = () => document.getElementById('rt3d-status');

// Shared geometries / materials (built once, reused by every pooled mesh).
let G = {}, M = {};
// Per-type object pools so we never allocate meshes inside the frame loop.
const pools = {};

// Scratch colours for per-frame biome blending (avoid per-frame allocation).
const _ca = new THREE.Color(), _cb = new THREE.Color(), _out = new THREE.Color();

// ============================================================
// COORDINATE HELPERS
// ============================================================
function zForX(x) { return (C.PLAYER_X - x) * SCALE_Z; }          // ahead -> -Z
function worldH(px) { return px * SCALE; }                          // size
// World Y of an entity's vertical centre, given its 2D top y and height.
function centreY(y, h) { return (C.GROUND_Y - (y + h / 2)) * SCALE; }

// Effective biome colour for a property, blended toward the neighbouring biome
// exactly like game.js's blendedBiomeColor(). `i` indexes into array props.
function biomeColor(prop, i = 0) {
  const cur = bridge.currentBiome();
  const idx = bridge.state.biomeIdx;
  const blend = bridge.biomeBlend();
  const BIOMES = bridge.BIOMES;
  const pick = (b) => (Array.isArray(b[prop]) ? b[prop][i] : b[prop]);
  _ca.set(pick(cur));
  if (blend > 0) {
    _cb.set(pick(BIOMES[Math.min(idx + 1, BIOMES.length - 1)]));
    return _out.lerpColors(_ca, _cb, blend);
  }
  if (blend < 0) {
    _cb.set(pick(BIOMES[Math.max(idx - 1, 0)]));
    return _out.lerpColors(_ca, _cb, -blend);
  }
  return _out.copy(_ca);
}

// ============================================================
// POOLING — reuse meshes per type, just toggle .visible each frame
// ============================================================
function poolGet(type) {
  const p = pools[type] || (pools[type] = { items: [], idx: 0 });
  if (p.idx >= p.items.length) {
    const m = make[type]();
    m.traverse((o) => {
      if (o.isMesh) { o.castShadow = type !== 'pothole'; o.receiveShadow = type === 'pothole'; }
    });
    scene.add(m);
    p.items.push(m);
  }
  const m = p.items[p.idx++];
  m.visible = true;
  return m;
}
function poolReset() { for (const k in pools) pools[k].idx = 0; }
function poolHideRest() {
  for (const k in pools) {
    const p = pools[k];
    for (let i = p.idx; i < p.items.length; i++) p.items[i].visible = false;
  }
}

// ============================================================
// MESH BUILDERS (one factory per entity type; share G/M resources)
// ============================================================
const make = {
  pothole() {
    const m = new THREE.Mesh(G.pothole, M.pothole);
    m.rotation.x = -Math.PI / 2;
    return m;
  },
  cone() { return new THREE.Mesh(G.cone, M.cone); },
  sign() {
    // Overhead gantry: two posts + beam + red panel — clearly something to duck under.
    const g = new THREE.Group();
    const postGeo = G.post, postMat = M.signPost;
    const lp = new THREE.Mesh(postGeo, postMat); lp.position.set(-ROAD_HALF + 0.3, 1.6, 0);
    const rp = new THREE.Mesh(postGeo, postMat); rp.position.set(ROAD_HALF - 0.3, 1.6, 0);
    const beam = new THREE.Mesh(G.beam, postMat); beam.position.y = 3.2;
    const panel = new THREE.Mesh(G.signPanel, M.signPanel); panel.position.y = 2.7;
    g.add(lp, rp, beam, panel);
    return g;
  },
  fuel() {
    const g = new THREE.Group();
    const can = new THREE.Mesh(G.fuel, M.fuel);
    const spout = new THREE.Mesh(G.spout, M.fuel); spout.position.set(0.18, 0.45, 0);
    g.add(can, spout);
    return g;
  },
  snack() { return new THREE.Mesh(G.snack, M.snack); },
  pitstop() {
    const g = new THREE.Group();
    const lp = new THREE.Mesh(G.post, M.pit); lp.position.set(-ROAD_HALF + 0.4, 1.6, 0);
    const rp = new THREE.Mesh(G.post, M.pit); rp.position.set(ROAD_HALF - 0.4, 1.6, 0);
    const beam = new THREE.Mesh(G.beam, M.pit); beam.position.y = 3.2;
    g.add(lp, rp, beam);
    return g;
  },
  semi() {
    const g = new THREE.Group();
    const trailer = new THREE.Mesh(G.semiTrailer, M.semiTrailer); trailer.position.set(0, 1.35, 0.6);
    const cab = new THREE.Mesh(G.semiCab, M.semiCab); cab.position.set(0, 1.1, -2.6);
    g.add(trailer, cab);
    return g;
  },
};

// ============================================================
// THE CAR — a little red convertible facing -Z (down the road)
// ============================================================
function buildCar() {
  const g = new THREE.Group();
  // Stylized red convertible, facing -Z. Built to read clearly from behind:
  // open cockpit + seats + rollbar, protruding wheels with light rims, taillights.
  const red = new THREE.MeshPhysicalMaterial({ color: 0xd8392e, roughness: 0.3, metalness: 0.0, clearcoat: 0.9, clearcoatRoughness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1b20, roughness: 0.7 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.85, roughness: 0.3 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x9fc4d8, roughness: 0.08, metalness: 0.0, transparent: true, opacity: 0.45 });
  const tail = new THREE.MeshStandardMaterial({ color: 0xff3838, emissive: 0xcc1010, emissiveIntensity: 1.3, roughness: 0.4 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xfff3c0, emissive: 0xfff0b0, emissiveIntensity: 1.4 });

  // main hull: lower body + raised hood + rear deck + dark rocker
  const hull = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.6, 4.1), red); hull.position.y = 0.62;
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.32, 1.5), red); hood.position.set(0, 0.86, -1.25);
  const rear = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.4, 1.2), red); rear.position.set(0, 0.9, 1.35);
  const sill = new THREE.Mesh(new THREE.BoxGeometry(2.08, 0.28, 3.4), dark); sill.position.y = 0.4;

  // open cockpit: a dark recessed tub with two seats, a windshield + a rollbar
  const tub = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 1.9), dark); tub.position.set(0, 0.95, 0.15);
  const seatL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.6), dark); seatL.position.set(-0.4, 1.18, 0.45);
  const seatR = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.6), dark); seatR.position.set(0.4, 1.18, 0.45);
  const wind = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.5, 0.08), glass); wind.position.set(0, 1.3, -0.75); wind.rotation.x = -0.35;
  cabin = wind; // hidden on duck (see renderFrame)
  const barL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), chrome); barL.position.set(-0.55, 1.35, 0.95);
  const barR = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), chrome); barR.position.set(0.55, 1.35, 0.95);
  const barTop = new THREE.Mesh(new THREE.BoxGeometry(1.22, 0.12, 0.12), chrome); barTop.position.set(0, 1.55, 0.95);

  // lights + bumpers (front = -Z, rear = +Z)
  const tl1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.08), tail); tl1.position.set(-0.6, 0.78, 2.06);
  const tl2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.08), tail); tl2.position.set(0.6, 0.78, 2.06);
  const hl1 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.2, 0.08), lamp); hl1.position.set(-0.62, 0.78, -2.06);
  const hl2 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.2, 0.08), lamp); hl2.position.set(0.62, 0.78, -2.06);
  const bumperF = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.22, 0.2), dark); bumperF.position.set(0, 0.5, -2.05);
  const bumperR = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.22, 0.2), dark); bumperR.position.set(0, 0.5, 2.05);

  g.add(sill, hull, hood, rear, tub, seatL, seatR, wind, barL, barR, barTop, tl1, tl2, hl1, hl2, bumperF, bumperR);

  // wheels — protrude beyond the body, light rims + a spoke so spin reads; spin on rotation.x
  const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.38, 20); wheelGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.26, 0.26, 0.4, 16); rimGeo.rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(0.42, 0.09, 0.52);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x111116, roughness: 0.9 });
  const wp = [[-1.06, -1.4], [1.06, -1.4], [-1.06, 1.45], [1.06, 1.45]];
  wheels = [];
  for (const [x, z] of wp) {
    const w = new THREE.Group(); w.position.set(x, 0.5, z);
    const tire = new THREE.Mesh(wheelGeo, tireMat);
    const rim = new THREE.Mesh(rimGeo, chrome);
    const spoke = new THREE.Mesh(spokeGeo, chrome);
    w.add(tire, rim, spoke);
    g.add(w);
    wheels.push(w);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// ============================================================
// ROADSIDE SCENERY — one prop generator per biome (low-poly, stylized)
// ============================================================
function buildProp(name) {
  const g = new THREE.Group();
  const rnd = (a, b) => a + Math.random() * (b - a);
  if (name === 'CITY') {
    // varied building blocks; some "lit" with a warm emissive tint
    const h = rnd(5, 16), w = rnd(3, 6), d = rnd(3, 6);
    const tone = [0x4a4e5a, 0x53506a, 0x3e4a5c, 0x615a52][(Math.random() * 4) | 0];
    const lit = Math.random() < 0.5;
    const mat = new THREE.MeshStandardMaterial({ color: tone, roughness: 0.85, emissive: lit ? 0x2a2620 : 0x070808, emissiveIntensity: lit ? 0.5 : 1 });
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); b.position.y = h / 2; g.add(b);
    if (Math.random() < 0.5) { const caph = rnd(1, 3); const cap = new THREE.Mesh(new THREE.BoxGeometry(w * 0.5, caph, d * 0.5), mat); cap.position.y = h + caph / 2; g.add(cap); }
  } else if (name === 'FOREST') {
    const th = rnd(1, 1.8);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, th, 7), new THREE.MeshStandardMaterial({ color: 0x5a3c22, roughness: 1 }));
    trunk.position.y = th / 2; g.add(trunk);
    const green = new THREE.MeshStandardMaterial({ color: 0x2f6a34, roughness: 1 });
    const ch = rnd(2.5, 4);
    const c1 = new THREE.Mesh(new THREE.ConeGeometry(rnd(1.1, 1.8), ch, 8), green); c1.position.y = th + ch / 2 - 0.2; g.add(c1);
    const c2 = new THREE.Mesh(new THREE.ConeGeometry(rnd(0.8, 1.2), ch * 0.7, 8), green); c2.position.y = th + ch * 0.9; g.add(c2);
  } else if (name === 'DESERT') {
    if (Math.random() < 0.6) {
      const green = new THREE.MeshStandardMaterial({ color: 0x4a7a44, roughness: 0.9 });
      const bh = rnd(2.4, 4);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.45, bh, 9), green); body.position.y = bh / 2; g.add(body);
      for (const s of [-1, 1]) if (Math.random() < 0.7) {
        const ah = rnd(0.8, 1.4), ay = rnd(1, bh - 0.6);
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, ah, 7), green); arm.position.set(s * 0.55, ay, 0); g.add(arm);
        const up = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, ah * 0.8, 7), green); up.position.set(s * 0.55, ay + ah * 0.5, 0); g.add(up);
      }
    } else {
      const tan = new THREE.MeshStandardMaterial({ color: 0xb07a4a, roughness: 1, flatShading: true });
      const mh = rnd(2, 5), mw = rnd(4, 8);
      const mesa = new THREE.Mesh(new THREE.CylinderGeometry(mw * 0.5, mw * 0.62, mh, 6), tan); mesa.position.y = mh / 2; g.add(mesa);
    }
  } else { // COAST
    if (Math.random() < 0.55) {
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(rnd(1, 2.4), 0), new THREE.MeshStandardMaterial({ color: 0x6b6e72, roughness: 1, flatShading: true }));
      rock.position.y = rnd(0.2, 0.6); rock.scale.y = rnd(0.5, 0.9); g.add(rock);
    } else {
      const th = rnd(2.5, 4.5);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.26, th, 7), new THREE.MeshStandardMaterial({ color: 0x8a6a40, roughness: 1 }));
      trunk.position.y = th / 2; trunk.rotation.z = rnd(-0.12, 0.12); g.add(trunk);
      const frond = new THREE.MeshStandardMaterial({ color: 0x3f8f55, roughness: 1, side: THREE.DoubleSide });
      for (let k = 0; k < 6; k++) {
        const f = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.2, 4), frond);
        f.position.y = th; f.rotation.z = Math.PI / 2; f.rotation.y = (k / 6) * Math.PI * 2;
        g.add(f);
      }
    }
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

// Rebuild every slot's prop for the given biome (called on biome change only).
function rebuildScenery(name) {
  for (const grp of scnSlots) {
    for (let j = grp.children.length - 1; j >= 0; j--) {
      const child = grp.children[j];
      grp.remove(child);
      child.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    }
    grp.add(buildProp(name));
  }
}

// ============================================================
// INIT — build the scene once (lazy; called when 3D is first enabled)
// ============================================================
function ensureInit() {
  if (initialized) return true;
  bridge = window.__roadtrip;
  if (!bridge) return false;              // game.js not booted yet; try next frame
  C = bridge.consts;

  const canvas = document.getElementById('game3d');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Linear (no tone mapping): keeps the sky dome, fog and lit ground colour-
  // consistent so they meet seamlessly at the horizon — and suits the clean
  // stylized look. (Filmic ACES tone-mapped only the meshes, not the sky dome,
  // which produced a bright seam at the horizon.)
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#9bc3e0');
  scene.fog = new THREE.Fog('#9bc3e0', 55, 420);

  camera = new THREE.PerspectiveCamera(FOV_BASE, 16 / 9, 0.1, 2200);
  camera.position.set(CAM_POS.x, CAM_POS.y, CAM_POS.z);
  camera.lookAt(CAM_LOOK.x, CAM_LOOK.y, CAM_LOOK.z);

  // Gradient sky dome (stylized; its shader ignores scene fog so the horizon stays clean).
  skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color('#9bc3e0') },
      horizonColor: { value: new THREE.Color('#fde4b8') },
      exponent: { value: 2.6 },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying vec3 vDir; uniform vec3 topColor; uniform vec3 horizonColor; uniform float exponent; void main(){ float t = pow(clamp(vDir.y, 0.0, 1.0), exponent); gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0); }',
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1600, 32, 16), skyMat));

  // Lighting: soft sky/ground ambient + a shadow-casting sun.
  hemi = new THREE.HemisphereLight(0xffffff, 0x3a3a40, 0.75);
  scene.add(hemi);
  sun = new THREE.DirectionalLight(0xfff0c0, 1.7);
  sun.position.set(-12, 18, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 70;
  sun.shadow.camera.left = -20;
  sun.shadow.camera.right = 20;
  sun.shadow.camera.top = 20;
  sun.shadow.camera.bottom = -24;
  scene.add(sun);
  scene.add(sun.target);   // defaults to (0,0,0) — the car's plane

  // --- road + shoulders ---
  const roadLen = Z_NEAR - Z_FAR;
  const roadCz = (Z_NEAR + Z_FAR) / 2;
  M.road = new THREE.MeshStandardMaterial({ color: '#222226', roughness: 0.92 });
  M.grass = new THREE.MeshStandardMaterial({ color: '#3a5a3a', roughness: 1.0 });
  const road = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, roadLen), M.road);
  road.rotation.x = -Math.PI / 2; road.position.z = roadCz; road.receiveShadow = true;
  scene.add(road);
  // One big ground plane that runs past the fog distance, so its edges are never
  // visible and the horizon is a clean fog blend (kills the bright horizon seam).
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), M.grass);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.05, roadCz);
  ground.receiveShadow = true;
  scene.add(ground);

  // --- shared geometries / materials for pooled entities ---
  G.pothole = new THREE.CircleGeometry(0.9, 22);
  G.cone = new THREE.ConeGeometry(0.45, 1.4, 16);
  G.post = new THREE.BoxGeometry(0.18, 3.2, 0.18);
  G.beam = new THREE.BoxGeometry(ROAD_HALF * 2, 0.22, 0.22);
  G.signPanel = new THREE.BoxGeometry(2.0, 1.0, 0.12);
  G.fuel = new THREE.BoxGeometry(0.7, 0.9, 0.5);
  G.spout = new THREE.BoxGeometry(0.18, 0.3, 0.18);
  G.snack = new THREE.BoxGeometry(0.6, 0.6, 0.6);
  G.semiTrailer = new THREE.BoxGeometry(2.2, 2.7, 5.5);
  G.semiCab = new THREE.BoxGeometry(2.2, 2.2, 1.8);
  M.pothole = new THREE.MeshStandardMaterial({ color: 0x111114, roughness: 1 });
  M.cone = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.6, emissive: 0x331400, emissiveIntensity: 0.4 });
  M.signPost = new THREE.MeshStandardMaterial({ color: 0x8a8a92, metalness: 0.4, roughness: 0.6 });
  M.signPanel = new THREE.MeshStandardMaterial({ color: 0xd03028, emissive: 0x400a08, emissiveIntensity: 0.5, roughness: 0.5 });
  M.fuel = new THREE.MeshStandardMaterial({ color: 0x2fae5a, emissive: 0x0c3a1c, emissiveIntensity: 0.5, roughness: 0.5 });
  M.snack = new THREE.MeshStandardMaterial({ color: 0xf5d76e, emissive: 0x4a3c10, emissiveIntensity: 0.6, roughness: 0.5 });
  M.pit = new THREE.MeshStandardMaterial({ color: 0x39c2c2, emissive: 0x0c3636, emissiveIntensity: 0.5, roughness: 0.5 });
  M.semiTrailer = new THREE.MeshStandardMaterial({ color: 0xdfe2e6, roughness: 0.7 });
  M.semiCab = new THREE.MeshStandardMaterial({ color: 0x3a6aa8, roughness: 0.6 });

  // --- centre-line dashes (scroll to sell speed) ---
  M.dash = new THREE.MeshBasicMaterial({ color: '#ffea88' });
  const dashGeo = new THREE.PlaneGeometry(0.32, 2.4);
  for (let i = 0; i < Math.ceil(DASH_SPAN / DASH_GAP); i++) {
    const d = new THREE.Mesh(dashGeo, M.dash);
    d.rotation.x = -Math.PI / 2; d.position.y = 0.02;
    scene.add(d); dashes.push(d);
  }
  // --- shoulder reflector posts (extra motion cue) ---
  M.postRef = new THREE.MeshStandardMaterial({ color: 0xeeeeee, emissive: 0x222222 });
  const refGeo = new THREE.BoxGeometry(0.12, 0.8, 0.12);
  for (let i = 0; i < 18; i++) {
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(refGeo, M.postRef);
      p.position.set(s * (ROAD_HALF + 0.5), 0.4, 0);
      scene.add(p); posts.push(p);
    }
  }

  car = buildCar();
  scene.add(car);

  // roadside scenery slots (props recycle by scrolling; content swaps per biome)
  for (const side of [-1, 1]) {
    for (let i = 0; i < SCN_COUNT; i++) {
      const grp = new THREE.Group();
      grp.userData = { i, side, margin: 3 + Math.random() * 36 };
      scene.add(grp);
      scnSlots.push(grp);
    }
  }
  rebuildScenery(bridge.currentBiome().name);
  lastBiomeIdx = bridge.state.biomeIdx;

  resize();
  initialized = true;
  RT.ready = true;
  return true;
}

// ============================================================
// PER-FRAME RENDER
// ============================================================
function renderFrame() {
  if (!initialized && !ensureInit()) return;
  resizeIfNeeded();
  const st = bridge.state;
  const p = st.player;
  const speedFrac = Math.max(0, Math.min(1, (st.speed - C.BASE_SPEED) / (C.MAX_SPEED - C.BASE_SPEED)));

  // --- biome-driven sky / fog / lights / surfaces ---
  // Match fog exactly to the (slightly muted) sky-dome horizon so ground and sky
  // blend into one another at the horizon instead of leaving a bright band.
  skyMat.uniforms.topColor.value.copy(biomeColor('sky', 0));
  skyMat.uniforms.horizonColor.value.copy(biomeColor('sky', 2)).multiplyScalar(0.9);
  scene.fog.color.copy(skyMat.uniforms.horizonColor.value);
  scene.background.copy(scene.fog.color);
  hemi.color.copy(biomeColor('sky', 0));
  sun.color.copy(biomeColor('sunColor'));
  M.road.color.copy(biomeColor('road'));
  M.grass.color.copy(biomeColor('grass'));

  // --- scroll the road markings / posts toward the camera ---
  const scroll = st.distance * SCALE_Z;
  for (let i = 0; i < dashes.length; i++) {
    const wrap = (((i * DASH_GAP - scroll) % DASH_SPAN) + DASH_SPAN) % DASH_SPAN;
    dashes[i].position.z = Z_NEAR - wrap;
  }
  const postGap = DASH_SPAN / 9;
  for (let i = 0; i < posts.length; i++) {
    const k = i >> 1, side = (i & 1) ? 1 : -1;
    const wrap = (((k * postGap - scroll) % DASH_SPAN) + DASH_SPAN) % DASH_SPAN;
    posts[i].position.z = Z_NEAR - wrap;
    posts[i].position.x = side * (ROAD_HALF + 0.5);
  }

  // --- roadside scenery: swap props on biome change, then scroll like the posts ---
  if (st.biomeIdx !== lastBiomeIdx) { rebuildScenery(bridge.currentBiome().name); lastBiomeIdx = st.biomeIdx; }
  for (const grp of scnSlots) {
    const u = grp.userData;
    const phase = u.side > 0 ? SCN_GAP * 0.5 : 0;
    const wrap = (((u.i * SCN_GAP + phase - scroll) % SCN_SPAN) + SCN_SPAN) % SCN_SPAN;
    grp.position.z = Z_NEAR - wrap;
    grp.position.x = u.side * (ROAD_HALF + u.margin);
  }

  // --- the car: jump (Y), duck (squash), accel/brake tilt, wheel spin, bob ---
  const lift = (C.GROUND_Y - p.y) * SCALE;          // 0 grounded, >0 mid-jump
  const bob = (p.bob || 0) * SCALE * 0.4;
  car.position.set(0, 0.0 + lift + bob, 0);
  car.rotation.x = -(p.tilt || 0) * 1.4;            // nose dips on accel, lifts on brake
  car.scale.y = p.ducking ? 0.66 : 1;
  if (cabin) cabin.visible = !p.ducking;            // drop the windscreen when ducking
  for (const w of wheels) w.rotation.x = -(p.wheelAngle || 0);

  // --- entities: map each 2D {x,y,w,h} to a 3D mesh at depth z ---
  poolReset();
  const t = st.runTime || 0;

  for (const o of st.obstacles) {
    if (o.x > C.W + 120 || o.x < -120) continue;
    const m = poolGet(o.type);
    const z = zForX(o.x);
    if (o.type === 'pothole') {
      m.position.set(0, 0.015, z);
      m.scale.set(worldH(o.w) / 1.8, worldH(o.h) / 1.8 + 0.4, 1);
    } else if (o.type === 'cone') {
      m.position.set(0, 0.7, z);
    } else if (o.type === 'sign') {
      m.position.set(0, 0, z);
    }
  }

  for (const c of st.collectibles) {
    if (c.x > C.W + 160 || c.x < -120) continue;
    const m = poolGet(c.type);
    const z = zForX(c.x);
    if (c.type === 'pitstop') {
      m.position.set(0, 0, z);
    } else {
      const yc = Math.max(0.6, centreY(c.y, c.h));
      m.position.set(0, yc + Math.sin(t * 3 + (c.bob || 0)) * 0.18, z);
      m.rotation.y = t * 2;
    }
  }

  for (const s of st.semis) {
    if (s.x > C.W + 280 || s.x < -160) continue;
    const m = poolGet('semi');
    m.position.set(SEMI_LANE, 0, zForX(s.x));
  }
  poolHideRest();

  // --- camera: gentle speed-driven FOV for a sense of velocity ---
  const fov = FOV_BASE + speedFrac * FOV_GAIN;
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = fov; camera.updateProjectionMatrix(); }

  renderer.render(scene, camera);
  writeStatus(st);
}

// ============================================================
// CANVAS SIZING / TOGGLE / STATUS
// ============================================================
let lastW = 0, lastH = 0;
function resize() {
  const canvas = renderer.domElement;
  const w = canvas.clientWidth || 960, h = canvas.clientHeight || 540;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  lastW = w; lastH = h;
}
function resizeIfNeeded() {
  const canvas = renderer.domElement;
  if (canvas.clientWidth !== lastW || canvas.clientHeight !== lastH) resize();
}

function applyCanvasVisibility() {
  const c2d = document.getElementById('game');
  const c3d = document.getElementById('game3d');
  if (c2d) c2d.classList.toggle('hidden', RT.enabled);
  if (c3d) c3d.classList.toggle('hidden', !RT.enabled);
}
function setEnabled(on) {
  RT.enabled = on;
  localStorage.setItem('wrt.render3d', on ? 'true' : 'false');
  if (on) ensureInit();
  applyCanvasVisibility();
  if (!on && statusEl()) statusEl().textContent = '2D mode (press T for 3D)';
}

function writeStatus(st) {
  const el = statusEl();
  if (!el) return;
  const b = bridge.currentBiome();
  const m = Math.round(st.distance);
  el.textContent = `3D · ${b.name} · ${m}m · ${st.obstacles.length + st.collectibles.length} obj · [T] 2D`;
}

// Toggle key — ignore while typing initials or in the ghost textarea.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyT') return;
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (bridge && bridge.state.screen === bridge.SCREEN.INITIALS) return;
  RT.toggle();
});
window.addEventListener('resize', () => { if (initialized) resize(); });

// Boot: reflect persisted preference; init now if 3D is the active renderer.
applyCanvasVisibility();
if (RT.enabled) {
  try { ensureInit(); }
  catch (e) { RT.enabled = false; applyCanvasVisibility(); console.error('[RT3D] init failed; staying in 2D', e); }
}
