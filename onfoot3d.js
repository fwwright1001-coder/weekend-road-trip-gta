// ============================================================
// onfoot3d.js — the hidden "step out of the car" mode (experiment/onfoot-gta)
// ------------------------------------------------------------
// When you FINISH the coast-to-coast drive, the trip doesn't just end — the
// game quietly unlocks a third-person on-foot sandbox. Marty parks the
// convertible at the boardwalk, opens the door, and you can walk a small town,
// jump, draw a pistol, and shoot the pedestrians wandering around. A self-
// contained "GTA opening" easter egg bolted onto the finish line.
//
// DESIGN CONTRACT — this module is deliberately decoupled from game.js:
//   * It never imports or edits the driving sim. It only READS the public
//     bridge window.__roadtrip (screen state) to know when the player has won.
//   * It owns its own Three.js scene + renderer drawn to its own <canvas
//     id="gamefoot">. It does not touch render3d.js's scene.
//   * It gates itself: the mode is only reachable after a legitimate finish
//     (localStorage 'wrt.onfoot.unlocked'). Press F on the WIN screen to step
//     out; once unlocked, F on the title screen re-enters (for testing).
//   * Everything is wrapped so a failure here can NEVER brick the base game:
//     enter()/loop() are try/caught and fall back to restoring the 2D/3D view.
//
// Coordinate convention (right-handed, Y up): the player walks the XZ plane,
// Y is height, feet rest at Y=0. Camera is a third-person orbit behind the guy.
// ============================================================
import * as THREE from 'three';

// ---- tunables --------------------------------------------------------------
const WALK = 4.4;            // player walk speed (units/s)
const RUN = 7.6;             // player run speed (Shift)
const PED_WALK = 1.7;        // pedestrian stroll speed
const PED_FLEE = 5.6;        // pedestrian panic-run speed
const GRAV = 24;             // gravity (units/s^2)
const JUMP_V = 8.4;          // jump impulse
const PLAYER_R = 0.45;       // player capsule radius (for collision)
const PED_R = 0.42;          // pedestrian radius
const EYE = 1.55;            // head/aim height above feet
const CAM_DIST = 5.6;        // third-person camera distance
const MOUSE_SENS = 0.0022;   // pointer-lock look sensitivity
const PITCH_MIN = -0.95, PITCH_MAX = 0.55;
const MAX_RANGE = 140;       // bullet reach
const HIT_R = 1.0;           // how close the aim ray must pass a ped to hit
const AMMO_MAX = 12;
const RELOAD_TIME = 1.15;    // seconds
const FIRE_COOLDOWN = 0.14;  // min seconds between shots
const NPC_COUNT = 16;
const BOUND = 58;            // half-size of the walkable town square
const RESPAWN_DELAY = 4.0;   // seconds a downed ped stays before a new one strolls in

// ---- driving (arcade, GTA-ish) ---------------------------------------------
const CAR_ACCEL = 26;        // throttle accel (units/s^2)
const CAR_BRAKE = 42;        // braking decel while moving forward
const CAR_REVERSE_ACCEL = 16;// reverse accel once stopped
const CAR_MAX_SPEED = 36;    // forward top speed (units/s)
const CAR_MAX_REVERSE = -12; // reverse top speed
const CAR_DRAG = 0.6;        // rolling resistance under throttle (per s)
const CAR_COAST_DRAG = 1.4;  // engine braking when off throttle
const CAR_HANDBRAKE_DRAG = 4.0; // Space: scrub speed hard
const CAR_TURN = 2.3;        // steering rate (rad/s) at full authority
const CAR_RADIUS = 1.9;      // collision pad vs buildings
const CAR_CAM_DIST = 9.5;    // chase-cam distance behind the car
const CAR_CAM_HEIGHT = 4.6;  // chase-cam height
const RUN_OVER_SPEED = 5;    // min speed to knock down a ped you drive into

// ---- public handle ---------------------------------------------------------
const OF = {
  active: false,
  ready: false,
  enter,
  exit,
  unlocked: () => localStorage.getItem('wrt.onfoot.unlocked') === 'true',
};
window.ONFOOT = OF;

// ---- module state ----------------------------------------------------------
let scene, camera, renderer, canvas;
let initialized = false;
let rafId = 0, lastT = 0;

const keys = new Set();
let locked = false;          // pointer-lock engaged
let yaw = 0, pitch = -0.12;  // camera orientation
let recoil = 0;              // transient upward kick, decays each frame

const player = {
  pos: new THREE.Vector3(2.4, 0, 6),
  vy: 0,
  grounded: true,
  mesh: null,
  gun: null,
  muzzle: null,
  ammo: AMMO_MAX,
  reloadT: 0,
  fireT: 0,
  facing: 0,               // smoothed body yaw
};

const peds = [];             // {mesh, mat[], pos, vel, target, state, t, dead, fall}
const aabbs = [];            // building footprints {minX,maxX,minZ,maxZ}
const vehicles = [];         // {mesh, wheels[], pos, heading, speed, occupied}
let mode = 'foot';           // 'foot' | 'drive'
let playerVehicle = null;    // the car you're currently driving, or null

// tracer / muzzle visuals
let tracer, tracerT = 0, muzzleFlash, flashT = 0;

// scratch vectors (avoid per-frame allocation)
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3();

// HUD elements (created/looked-up lazily)
let hudEl, ammoEl, killsEl, promptEl, toastEl, crosshairEl, speedEl, footStatsEl, driveStatsEl;
let kills = 0;

// tiny self-contained audio for the gun (never touches game.js's audio)
let actx = null;
function gunSound() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();   // recover from autoplay/tab-visibility suspension
    const t = actx.currentTime;
    // short noise burst + low thump
    const buf = actx.createBuffer(1, 1024, actx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
    const noise = actx.createBufferSource(); noise.buffer = buf;
    const ng = actx.createGain(); ng.gain.setValueAtTime(0.35, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    noise.connect(ng).connect(actx.destination); noise.start(t);
    const osc = actx.createOscillator(); osc.type = 'square';
    osc.frequency.setValueAtTime(180, t); osc.frequency.exponentialRampToValueAtTime(60, t + 0.1);
    const og = actx.createGain(); og.gain.setValueAtTime(0.25, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(og).connect(actx.destination); osc.start(t); osc.stop(t + 0.13);
  } catch (e) { /* audio is optional */ }
}

// ============================================================
// MESH BUILDERS
// ============================================================
// A blocky "generic guy" — low-poly to match the road-trip art. Origin at the
// feet (Y=0), ~1.8 tall. `armed` adds a pistol in the right hand.
function buildPerson(colors, armed) {
  const g = new THREE.Group();
  const mk = (geo, col) => {
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: col, roughness: 0.85 }));
    m.castShadow = true; m.receiveShadow = true; return m;
  };
  const skin = colors.skin, shirt = colors.shirt, pants = colors.pants, hair = colors.hair;
  const legL = mk(new THREE.BoxGeometry(0.26, 0.8, 0.28), pants); legL.position.set(-0.16, 0.4, 0);
  const legR = mk(new THREE.BoxGeometry(0.26, 0.8, 0.28), pants); legR.position.set(0.16, 0.4, 0);
  const torso = mk(new THREE.BoxGeometry(0.62, 0.72, 0.36), shirt); torso.position.set(0, 1.16, 0);
  const armL = mk(new THREE.BoxGeometry(0.18, 0.66, 0.2), shirt); armL.position.set(-0.42, 1.18, 0);
  const armR = mk(new THREE.BoxGeometry(0.18, 0.66, 0.2), shirt); armR.position.set(0.42, 1.18, 0);
  const head = mk(new THREE.BoxGeometry(0.34, 0.36, 0.34), skin); head.position.set(0, 1.72, 0);
  const cap = mk(new THREE.BoxGeometry(0.36, 0.14, 0.36), hair); cap.position.set(0, 1.94, 0);
  g.add(legL, legR, torso, armL, armR, head, cap);
  g.userData.armL = armL; g.userData.armR = armR; g.userData.legL = legL; g.userData.legR = legR;
  if (armed) {
    // raise the right arm forward and clip a little pistol to the hand
    armR.position.set(0.42, 1.34, 0.18); armR.rotation.x = -1.35;
    const gun = mk(new THREE.BoxGeometry(0.12, 0.16, 0.4), 0x222228); gun.position.set(0.42, 1.28, 0.5);
    const muzzle = new THREE.Object3D(); muzzle.position.set(0.42, 1.32, 0.72); g.add(muzzle);
    g.add(gun);
    g.userData.muzzle = muzzle; g.userData.gun = gun;
  }
  return g;
}

// A low-poly building cluster filling a town cell, with lit windows.
function buildBuilding(rng) {
  const g = new THREE.Group();
  const h = 6 + rng() * 18;
  const w = 7 + rng() * 5, d = 7 + rng() * 5;
  const tones = [0x6b7280, 0x7a6f63, 0x5c6b7a, 0x736a78, 0x6f7a6a];
  const tone = tones[(rng() * tones.length) | 0];
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color: tone, roughness: 0.9 }));
  body.position.y = h / 2; body.castShadow = true; body.receiveShadow = true;
  g.add(body);
  // window strips: emissive yellow squares on the +Z and -Z faces
  const winMat = new THREE.MeshStandardMaterial({ color: 0xffe39a, emissive: 0xffcf6a, emissiveIntensity: 0.85, roughness: 0.5 });
  const rows = Math.max(2, (h / 2.6) | 0), cols = Math.max(2, (w / 2.2) | 0);
  const winGeo = new THREE.BoxGeometry(0.9, 1.1, 0.1);
  for (let face = -1; face <= 1; face += 2) {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (rng() < 0.35) continue; // some windows dark
      const win = new THREE.Mesh(winGeo, winMat);
      win.position.set(-w / 2 + 1.1 + c * (w - 2.2) / Math.max(1, cols - 1),
        1.6 + r * (h - 2.4) / Math.max(1, rows - 1), face * (d / 2 + 0.02));
      g.add(win);
    }
  }
  return { mesh: g, w, d };
}

// A drivable car (simplified from render3d's buildCar). Faces -Z at heading 0
// per the convention that +Z is "forward" — but the driving model integrates
// position along (sin h, cos h), so we orient the body so its nose points that
// way: the model's nose is -Z, so we add the wheels and let rotation.y = heading
// spin the whole group (nose ends up along +forward; cosmetic only).
// Returns { group, wheels[] }. wheels[0..1] front, [2..3] rear (for steer/spin).
function buildCarMesh(bodyColor) {
  const g = new THREE.Group();
  const body = new THREE.MeshPhysicalMaterial({ color: bodyColor, roughness: 0.34, metalness: 0.0, clearcoat: 0.8, clearcoatRoughness: 0.25 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1b20, roughness: 0.7 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.85, roughness: 0.3 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x9fc4d8, roughness: 0.1, transparent: true, opacity: 0.5 });
  const tail = new THREE.MeshStandardMaterial({ color: 0xff3838, emissive: 0xcc1010, emissiveIntensity: 1.1, roughness: 0.4 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xfff3c0, emissive: 0xfff0b0, emissiveIntensity: 1.2 });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.6, 4.1), body); hull.position.y = 0.62;
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.32, 1.5), body); hood.position.set(0, 0.86, -1.25);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.62, 1.7), body); cabin.position.set(0, 1.12, 0.2);
  const rear = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.4, 1.2), body); rear.position.set(0, 0.9, 1.35);
  const sill = new THREE.Mesh(new THREE.BoxGeometry(2.08, 0.28, 3.4), dark); sill.position.y = 0.4;
  const wind = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.5, 0.08), glass); wind.position.set(0, 1.32, -0.66); wind.rotation.x = -0.35;
  const tl1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.08), tail); tl1.position.set(-0.6, 0.78, 2.06);
  const tl2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.08), tail); tl2.position.set(0.6, 0.78, 2.06);
  const hl1 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.2, 0.08), lamp); hl1.position.set(-0.62, 0.78, -2.06);
  const hl2 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.2, 0.08), lamp); hl2.position.set(0.62, 0.78, -2.06);
  const bumperF = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.18, 0.14), chrome); bumperF.position.set(0, 0.5, -2.06);
  const bumperR = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.18, 0.14), chrome); bumperR.position.set(0, 0.5, 2.06);
  g.add(sill, hull, hood, cabin, rear, wind, tl1, tl2, hl1, hl2, bumperF, bumperR);
  // wheels — front pair (-Z) then rear pair (+Z); axle is along X so they roll on Z.
  // Front wheels live inside a steer-pivot Group so steer (pivot.rotation.y) and roll
  // (wheel.rotation.x) compose cleanly instead of precessing under one Euler order.
  const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.38, 16); wheelGeo.rotateZ(Math.PI / 2);
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x111116, roughness: 0.9 });
  const wheels = [], steerPivots = [];
  let wi = 0;
  for (const [x, z] of [[-1.06, -1.4], [1.06, -1.4], [-1.06, 1.45], [1.06, 1.45]]) {
    const w = new THREE.Mesh(wheelGeo, tireMat);
    if (wi < 2) {
      const pivot = new THREE.Group(); pivot.position.set(x, 0.5, z);
      pivot.add(w); g.add(pivot); steerPivots.push(pivot);   // w sits at pivot origin
    } else {
      w.position.set(x, 0.5, z); g.add(w);
    }
    wheels.push(w); wi++;
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { group: g, wheels, steerPivots };
}

const CAR_COLORS = [0xd8392e, 0x2f6f8f, 0x394150, 0xb0b4ba, 0x2f7a45, 0xc9a24f, 0x7a3a8f, 0x202428];
// Build a car, register it as a drivable vehicle at (x,z) facing `heading`.
function spawnVehicle(x, z, heading, color) {
  const { group, wheels, steerPivots } = buildCarMesh(color);
  group.position.set(x, 0, z);
  group.rotation.y = heading;
  scene.add(group);
  const v = { mesh: group, wheels, steerPivots, pos: new THREE.Vector3(x, 0, z), heading, speed: 0, occupied: false };
  vehicles.push(v);
  return v;
}

// ============================================================
// SEEDED RNG — deterministic town layout (Math.random is fine here, but a
// seed keeps the same town every visit so it feels like a real place).
// ============================================================
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// ============================================================
// INIT — build the town once (lazy, on first enter)
// ============================================================
function ensureInit() {
  if (initialized) return true;
  canvas = document.getElementById('gamefoot');
  if (!canvas) return false;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  // warm coastal dusk to match the end-of-trip mood
  scene.background = new THREE.Color('#f3b066');
  scene.fog = new THREE.Fog('#f3b066', 70, 320);

  camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 1200);

  // sky dome (gradient, ignores fog so the horizon stays clean)
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { topColor: { value: new THREE.Color('#5a7fb0') }, horizonColor: { value: new THREE.Color('#f6c78a') }, exponent: { value: 0.9 } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'varying vec3 vDir; uniform vec3 topColor; uniform vec3 horizonColor; uniform float exponent; void main(){ float t = pow(clamp(vDir.y,0.0,1.0), exponent); gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0); }',
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), skyMat));

  scene.add(new THREE.HemisphereLight(0xffffff, 0x4a4540, 0.85));
  const sun = new THREE.DirectionalLight(0xffe2b0, 1.9);
  sun.position.set(-40, 60, 30); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 220;
  sun.shadow.camera.left = -80; sun.shadow.camera.right = 80;
  sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
  sun.shadow.bias = -0.0004;
  scene.add(sun); scene.add(sun.target);

  // ground: grass apron + asphalt plaza/streets
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(800, 800),
    new THREE.MeshStandardMaterial({ color: 0x6f8f5a, roughness: 1 }));
  grass.rotation.x = -Math.PI / 2; grass.position.y = -0.02; grass.receiveShadow = true;
  scene.add(grass);
  const asphalt = new THREE.Mesh(new THREE.PlaneGeometry(BOUND * 2 + 8, BOUND * 2 + 8),
    new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 0.95 }));
  asphalt.rotation.x = -Math.PI / 2; asphalt.position.y = -0.01; asphalt.receiveShadow = true;
  scene.add(asphalt);
  // a few yellow street stripes for readability
  const stripeMat = new THREE.MeshBasicMaterial({ color: 0xffea88 });
  for (let i = -2; i <= 2; i++) {
    for (let s = -BOUND + 4; s < BOUND; s += 8) {
      const st = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 3), stripeMat);
      st.rotation.x = -Math.PI / 2; st.position.set(i * 24, 0.005, s); scene.add(st);
    }
  }

  // town blocks on a 5x5 grid; skip the central cell (your spawn plaza)
  const rng = makeRng(0x51EAD7);
  const CELL = 24;
  for (let gx = -2; gx <= 2; gx++) {
    for (let gz = -2; gz <= 2; gz++) {
      if (gx === 0 && gz === 0) continue;           // spawn plaza, kept open
      if (rng() < 0.18) continue;                   // occasional empty lot
      const cx = gx * CELL, cz = gz * CELL;
      const { mesh, w, d } = buildBuilding(rng);
      // jitter inside the cell but keep clear of the cross-streets
      const ox = (rng() - 0.5) * 3, oz = (rng() - 0.5) * 3;
      mesh.position.set(cx + ox, 0, cz + oz);
      scene.add(mesh);
      aabbs.push({ minX: cx + ox - w / 2, maxX: cx + ox + w / 2, minZ: cz + oz - d / 2, maxZ: cz + oz + d / 2 });
      // street lamp on a corner
      if (rng() < 0.7) {
        const lamp = new THREE.Group();
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 4, 8),
          new THREE.MeshStandardMaterial({ color: 0x33363c })); pole.position.y = 2; pole.castShadow = true;
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 10),
          new THREE.MeshStandardMaterial({ color: 0xfff0b0, emissive: 0xffd070, emissiveIntensity: 1.2 })); bulb.position.y = 4;
        lamp.add(pole, bulb); lamp.position.set(cx + w / 2 + 2, 0, cz + d / 2 + 2); scene.add(lamp);
      }
    }
  }

  // drivable cars: the red convertible at the plaza + parked cars on the streets
  // (x=±12 / z=±12 sit in the cross-streets between the building blocks)
  spawnVehicle(-1.2, 5.5, 0.2, 0xd8392e);   // your convertible, beside spawn
  spawnVehicle(12, 2, Math.PI / 2, 0x2f6f8f);
  spawnVehicle(-12, -4, 0, 0x394150);
  spawnVehicle(2, 13, Math.PI, 0x2f7a45);
  spawnVehicle(-12, 14, Math.PI / 2, 0xc9a24f);
  spawnVehicle(12, -14, 0, 0x7a3a8f);

  // the player
  player.mesh = buildPerson({ skin: 0xd9a679, shirt: 0x2f6f8f, pants: 0x2b2b33, hair: 0x3a2a1a }, true);
  player.muzzle = player.mesh.userData.muzzle;
  scene.add(player.mesh);

  // pedestrians
  for (let i = 0; i < NPC_COUNT; i++) spawnPed(rng, true);

  // tracer line + muzzle flash
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  tracer = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: 0xfff2a0, transparent: true, opacity: 0 }));
  tracer.frustumCulled = false; scene.add(tracer);
  muzzleFlash = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0 }));
  scene.add(muzzleFlash);

  resize();
  initialized = true;
  OF.ready = true;
  return true;
}

const SHIRTS = [0xc94f4f, 0x4f7fc9, 0x4fae6b, 0xc9a24f, 0x8a4fc9, 0xc97fae, 0x4fbfc9, 0xb0683a];
function spawnPed(rng, atRandomSpot) {
  const r = rng || Math.random;
  const colors = { skin: [0xd9a679, 0xc68642, 0xf1c27d, 0x8d5524][(r() * 4) | 0], shirt: SHIRTS[(r() * SHIRTS.length) | 0], pants: 0x33343b, hair: 0x241a12 };
  const mesh = buildPerson(colors, false);
  const mats = [];
  mesh.traverse((o) => { if (o.isMesh) mats.push(o.material); });
  // place on a street, not inside a building
  let px, pz, tries = 0;
  do { px = (r() * 2 - 1) * (BOUND - 4); pz = (r() * 2 - 1) * (BOUND - 4); tries++; }
  while (insideBuilding(px, pz, PED_R + 0.5) && tries < 40);
  mesh.position.set(px, 0, pz);
  scene.add(mesh);
  const ped = {
    mesh, mats, pos: new THREE.Vector3(px, 0, pz), vel: new THREE.Vector3(),
    target: new THREE.Vector3(px, 0, pz), state: 'wander', t: 0, dead: false, fall: 0, walkPhase: r() * 10,
  };
  pickTarget(ped, r);
  peds.push(ped);
  return ped;
}

function pickTarget(ped, rng) {
  const r = rng || Math.random;
  let tx, tz, tries = 0;
  do { tx = (r() * 2 - 1) * (BOUND - 4); tz = (r() * 2 - 1) * (BOUND - 4); tries++; }
  while (insideBuilding(tx, tz, PED_R + 0.5) && tries < 30);
  ped.target.set(tx, 0, tz);
}

// ============================================================
// COLLISION — keep entities out of building footprints + inside bounds
// ============================================================
function insideBuilding(x, z, pad) {
  for (const a of aabbs) {
    if (x > a.minX - pad && x < a.maxX + pad && z > a.minZ - pad && z < a.maxZ + pad) return a;
  }
  return null;
}
// push an XZ point out of any building it overlaps, along the shallowest axis
function resolveCollision(pos, pad) {
  for (const a of aabbs) {
    if (pos.x > a.minX - pad && pos.x < a.maxX + pad && pos.z > a.minZ - pad && pos.z < a.maxZ + pad) {
      const dl = pos.x - (a.minX - pad), dr = (a.maxX + pad) - pos.x;
      const db = pos.z - (a.minZ - pad), df = (a.maxZ + pad) - pos.z;
      const m = Math.min(dl, dr, db, df);
      if (m === dl) pos.x = a.minX - pad;
      else if (m === dr) pos.x = a.maxX + pad;
      else if (m === db) pos.z = a.minZ - pad;
      else pos.z = a.maxZ + pad;
    }
  }
  pos.x = Math.max(-BOUND, Math.min(BOUND, pos.x));
  pos.z = Math.max(-BOUND, Math.min(BOUND, pos.z));
}

// ============================================================
// INPUT
// ============================================================
// All listeners use capture + stopImmediatePropagation while active so the
// driving game's window listeners never see our keys (it stays frozen on WIN).
function onKeyDown(e) {
  // F enters the mode from the WIN screen, or the title screen once unlocked
  if (!OF.active && e.code === 'KeyF') {
    const br = window.__roadtrip;
    const scr = br && br.state && br.state.screen;
    if (scr === 'win' || (scr === 'title' && OF.unlocked())) { enter(); e.preventDefault(); e.stopImmediatePropagation(); }
    return;
  }
  if (!OF.active) return;
  e.stopImmediatePropagation();
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.code === 'KeyE') {                                // enter / exit a car
    if (mode === 'drive') exitVehicle();
    else { const v = nearestVehicle(3.8); if (v) enterVehicle(v); }
    return;
  }
  if (e.code === 'KeyP') { exit(); return; }             // leave the whole on-foot mode
  if (mode === 'foot') {
    if (e.code === 'Space' && player.grounded) { player.vy = JUMP_V; player.grounded = false; }
    if (e.code === 'KeyR') reload();
  }
}
function onKeyUp(e) {
  if (!OF.active) return;
  e.stopImmediatePropagation();
  keys.delete(e.code);
}
function onMouseDown(e) {
  if (!OF.active || mode !== 'foot') return;             // no shooting from the driver's seat
  if (!locked) { canvas.requestPointerLock(); return; }
  if (e.button === 0) fire();
}
function onMouseMove(e) {
  if (!OF.active || !locked) return;
  yaw -= e.movementX * MOUSE_SENS;
  pitch -= e.movementY * MOUSE_SENS;
  pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch));
}
function onPointerLockChange() { locked = document.pointerLockElement === canvas; }

// nearest un-occupied car within maxDist of the player on foot
function nearestVehicle(maxDist) {
  let best = null, bd = maxDist;
  for (const v of vehicles) {
    if (v.occupied) continue;
    const d = Math.hypot(v.pos.x - player.pos.x, v.pos.z - player.pos.z);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

function reload() {
  if (player.reloadT <= 0 && player.ammo < AMMO_MAX) { player.reloadT = RELOAD_TIME; }
}

function fire() {
  if (mode !== 'foot') return;
  if (player.fireT > 0 || player.reloadT > 0) return;
  if (player.ammo <= 0) { reload(); return; }
  player.ammo--; player.fireT = FIRE_COOLDOWN;
  recoil += 0.05; gunSound();

  // aim ray = camera forward through the crosshair (screen center)
  camera.getWorldDirection(_dir);
  const origin = camera.position;
  // nearest ped whose centre lies within HIT_R of the ray and in front of us
  let best = null, bestT = MAX_RANGE;
  for (const p of peds) {
    if (p.dead) continue;
    _v.copy(p.pos); _v.y += 1.0;                       // aim at chest height
    _v2.copy(_v).sub(origin);
    const t = _v2.dot(_dir);
    if (t < 0 || t > bestT) continue;
    _v.copy(origin).addScaledVector(_dir, t);          // closest point on ray
    const d = _v.distanceTo(_v2.copy(p.pos).setY(p.pos.y + 1.0));
    if (d < HIT_R) { best = p; bestT = t; }
  }

  // tracer endpoint
  const muzzleWorld = _v2; player.muzzle.getWorldPosition(muzzleWorld);
  const end = _v.copy(origin).addScaledVector(_dir, best ? bestT : MAX_RANGE);
  const pa = tracer.geometry.attributes.position;
  pa.setXYZ(0, muzzleWorld.x, muzzleWorld.y, muzzleWorld.z);
  pa.setXYZ(1, end.x, end.y, end.z);
  pa.needsUpdate = true;
  tracer.material.opacity = 0.9; tracerT = 0.06;
  muzzleFlash.position.copy(muzzleWorld); muzzleFlash.material.opacity = 1; flashT = 0.05;

  if (best) killPed(best);
  startleNearby();
  updateHud();
}

function killPed(p) {
  p.dead = true; p.state = 'dead'; p.t = 0;
  p.fall = (Math.random() < 0.5 ? 1 : -1);             // tip direction
  for (const m of p.mats) { m.transparent = true; }
  kills++;
  updateHud();
}

// ============================================================
// ENTER / EXIT — swap the whole view to the on-foot canvas
// ============================================================
let saved = null;
function enter() {
  if (OF.active) return;
  try {
    if (!ensureInit()) return;
    localStorage.setItem('wrt.onfoot.unlocked', 'true');
    OF.active = true;
    // remember and hide the driving view
    const g = document.getElementById('game');
    const g3 = document.getElementById('game3d');
    const ov = document.getElementById('overlay');
    const hud2d = document.getElementById('hud');
    const status = document.getElementById('rt3d-status');
    saved = {
      gameHidden: g && g.classList.contains('hidden'),
      g3Hidden: g3 && g3.classList.contains('hidden'),
      ovDisplay: ov && ov.style.display,
    };
    if (g) g.classList.add('hidden');
    if (g3) g3.classList.add('hidden');
    if (ov) ov.style.display = 'none';
    if (hud2d) hud2d.classList.add('hidden');
    if (status) status.style.display = 'none';
    canvas.classList.remove('hidden');
    if (hudEl) hudEl.classList.remove('hidden');

    // reset to on-foot at the plaza next to the car (clear any prior drive state)
    mode = 'foot'; playerVehicle = null;
    if (player.mesh) player.mesh.visible = true;
    for (const v of vehicles) { v.occupied = false; v.speed = 0; v.mesh.rotation.z = 0; }
    player.pos.set(2.4, 0, 6); player.vy = 0; player.grounded = true;
    player.ammo = AMMO_MAX; player.reloadT = 0; player.fireT = 0;
    yaw = Math.PI; pitch = -0.1; recoil = 0; kills = 0;
    keys.clear();
    showToast('You step out of the convertible. The town is yours.<br><b>Click</b> to look around &middot; <b>WASD</b> walk &middot; <b>Click</b> shoot &middot; <b>E</b> to steal any car');
    updateHud();

    lastT = 0;
    rafId = requestAnimationFrame(loop);
  } catch (e) {
    console.error('[ONFOOT] enter failed; staying in the base game', e);
    exit();
  }
}

function exit() {
  OF.active = false;
  if (rafId) cancelAnimationFrame(rafId); rafId = 0;
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  if (canvas) canvas.classList.add('hidden');
  if (hudEl) hudEl.classList.add('hidden');
  if (crosshairEl) crosshairEl.classList.add('hidden');
  // restore the driving view exactly as it was
  const g = document.getElementById('game');
  const g3 = document.getElementById('game3d');
  const ov = document.getElementById('overlay');
  const status = document.getElementById('rt3d-status');
  if (saved) {
    if (g) g.classList.toggle('hidden', !!saved.gameHidden);
    if (g3) g3.classList.toggle('hidden', !!saved.g3Hidden);
    if (ov) ov.style.display = saved.ovDisplay || 'grid';
  } else if (ov) { ov.style.display = 'grid'; }
  if (status) status.style.display = '';
}

// ============================================================
// PER-FRAME LOOP
// ============================================================
function loop(time) {
  if (!OF.active) return;
  const dt = Math.min(0.05, (time - lastT) / 1000 || 0);
  lastT = time;
  try {
    update(dt);
    postFrameUi(dt);
    renderer.render(scene, camera);
  } catch (e) {
    console.error('[ONFOOT] frame failed; leaving on-foot mode', e);
    exit(); return;
  }
  rafId = requestAnimationFrame(loop);
}

function update(dt) {
  resizeIfNeeded();
  if (mode === 'drive') updateDriving(dt);
  else updateOnFoot(dt);

  // pedestrians live whether you're on foot or cruising past
  for (const p of peds) updatePed(p, dt);

  // visual timers (tracer / muzzle flash)
  if (tracerT > 0) { tracerT -= dt; if (tracerT <= 0) tracer.material.opacity = 0; }
  if (flashT > 0) { flashT -= dt; if (flashT <= 0) muzzleFlash.material.opacity = 0; }
}

function updateOnFoot(dt) {
  // --- player movement relative to camera yaw ---
  // The camera looks toward +_fwd (see camera block below), so forward = +_fwd
  // and screen-right = +_right (matches the camera basis: W into screen, D right).
  _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));            // camera horizontal forward (into screen)
  _right.set(-Math.cos(yaw), 0, Math.sin(yaw));         // camera-right (screen right)
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? RUN : WALK;
  let mx = 0, mz = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) { mx += _fwd.x; mz += _fwd.z; }
  if (keys.has('KeyS') || keys.has('ArrowDown')) { mx -= _fwd.x; mz -= _fwd.z; }
  if (keys.has('KeyA') || keys.has('ArrowLeft')) { mx -= _right.x; mz -= _right.z; }
  if (keys.has('KeyD') || keys.has('ArrowRight')) { mx += _right.x; mz += _right.z; }
  const ml = Math.hypot(mx, mz);
  const moving = ml > 0.001;
  if (moving) { mx /= ml; mz /= ml; player.pos.x += mx * speed * dt; player.pos.z += mz * speed * dt; }

  // gravity / jump / ground
  player.vy -= GRAV * dt;
  player.pos.y += player.vy * dt;
  if (player.pos.y <= 0) { player.pos.y = 0; player.vy = 0; player.grounded = true; }

  resolveCollision(player.pos, PLAYER_R);

  // body faces camera yaw when aiming (locked), else faces movement direction
  const targetFacing = (locked || !moving) ? yaw : Math.atan2(mx, mz);
  player.facing = lerpAngle(player.facing, targetFacing, 0.25);
  player.mesh.position.copy(player.pos);
  player.mesh.rotation.y = player.facing;
  animateWalk(player.mesh, moving, dt);

  // reload / fire timers
  if (player.reloadT > 0) { player.reloadT -= dt; if (player.reloadT <= 0) { player.ammo = AMMO_MAX; updateHud(); } }
  if (player.fireT > 0) player.fireT -= dt;

  // --- camera: third-person orbit behind the player ---
  const cz = Math.cos(pitch);
  _dir.set(Math.sin(yaw) * cz, Math.sin(pitch), Math.cos(yaw) * cz); // look direction
  const head = _v.copy(player.pos).setY(EYE);
  camera.position.copy(head).addScaledVector(_dir, -CAM_DIST);       // behind the head
  camera.position.y += 0.4 + recoil * 2;
  if (camera.position.y < 0.6) camera.position.y = 0.6;
  camera.lookAt(head.x + _dir.x, head.y + _dir.y + recoil, head.z + _dir.z);
  recoil = Math.max(0, recoil - dt * 0.6);
}

// ============================================================
// DRIVING — arcade car physics + chase cam
// ============================================================
function updateDriving(dt) {
  const v = playerVehicle;
  const throttle = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const steer = (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) - (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0);
  const handbrake = keys.has('Space');

  // longitudinal: throttle, brake, reverse
  if (throttle > 0) v.speed += CAR_ACCEL * dt;
  else if (throttle < 0) {
    if (v.speed > 0.3) v.speed -= CAR_BRAKE * dt;       // brake while rolling forward
    else v.speed -= CAR_REVERSE_ACCEL * dt;             // then reverse
  }
  // resistance: handbrake > engine-braking (coasting) > rolling
  const drag = handbrake ? CAR_HANDBRAKE_DRAG : (throttle === 0 ? CAR_COAST_DRAG : CAR_DRAG);
  v.speed -= v.speed * drag * dt;
  v.speed = Math.max(CAR_MAX_REVERSE, Math.min(CAR_MAX_SPEED, v.speed));
  if (Math.abs(v.speed) < 0.03) v.speed = 0;

  // steering authority grows with speed and flips in reverse (like real cars)
  const steerAuth = Math.max(-1, Math.min(1, v.speed / 6));
  v.heading += steer * CAR_TURN * steerAuth * dt;

  // integrate position along heading; bleed speed on a wall hit
  const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
  const px = v.pos.x, pz = v.pos.z;
  v.pos.x += fx * v.speed * dt;
  v.pos.z += fz * v.speed * dt;
  resolveCollision(v.pos, CAR_RADIUS);
  const moved = Math.hypot(v.pos.x - px, v.pos.z - pz);
  const intended = Math.abs(v.speed) * dt;
  if (intended > 0.05 && moved < intended * 0.5) v.speed *= 0.25;  // crunched into a building

  // run over any live ped you plough into at speed
  if (Math.abs(v.speed) > RUN_OVER_SPEED) {
    for (const p of peds) {
      if (p.dead) continue;
      if (Math.hypot(p.pos.x - v.pos.x, p.pos.z - v.pos.z) < 1.7) { killPed(p); startleNearby(); }
    }
  }

  // apply to the mesh: position, heading, a little body roll, wheel spin + steer
  v.mesh.position.copy(v.pos);
  v.mesh.rotation.y = v.heading;
  v.mesh.rotation.z = lerpNum(v.mesh.rotation.z, -steer * steerAuth * 0.06, 0.2);
  for (let i = 0; i < v.wheels.length; i++) v.wheels[i].rotation.x -= v.speed * dt * 0.6;  // roll
  for (const sp of v.steerPivots) sp.rotation.y = steer * 0.4;                              // front-wheel steer

  // chase camera: smoothly trail behind the car along its heading
  const target = _v.copy(v.pos); target.y += 1.3;
  const desired = _v2.set(v.pos.x - fx * CAR_CAM_DIST, CAR_CAM_HEIGHT, v.pos.z - fz * CAR_CAM_DIST);
  camera.position.lerp(desired, 1 - Math.pow(0.0015, dt));   // frame-rate-independent smoothing
  if (camera.position.y < 1.2) camera.position.y = 1.2;
  camera.lookAt(target.x + fx * 4, target.y, target.z + fz * 4);

  updateHud();
}

// ============================================================
// ENTER / EXIT A VEHICLE
// ============================================================
function enterVehicle(v) {
  mode = 'drive';
  playerVehicle = v;
  v.occupied = true;
  keys.clear();                         // start the drive scheme from a clean input state
  player.mesh.visible = false;
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  if (crosshairEl) crosshairEl.classList.add('hidden');
  // snap the camera straight behind the car so there's no swoop
  const fx = Math.sin(v.heading), fz = Math.cos(v.heading);
  camera.position.set(v.pos.x - fx * CAR_CAM_DIST, CAR_CAM_HEIGHT, v.pos.z - fz * CAR_CAM_DIST);
  showToast('You jack the car. <b>W/S</b> drive &middot; <b>A/D</b> steer &middot; <b>SPACE</b> handbrake &middot; <b>E</b> get out');
  updateHud();
}
function exitVehicle() {
  const v = playerVehicle;
  if (!v) { mode = 'foot'; return; }
  keys.clear();                         // don't leak held throttle/steer into walk input
  v.speed = 0;
  v.occupied = false;
  v.mesh.rotation.z = 0;
  // step out beside the car (door side), then shove clear of any wall
  const sx = Math.cos(v.heading), sz = -Math.sin(v.heading);   // car's side unit vector
  player.pos.set(v.pos.x + sx * 2.4, 0, v.pos.z + sz * 2.4);
  resolveCollision(player.pos, PLAYER_R);
  player.vy = 0; player.grounded = true; player.facing = v.heading;
  yaw = v.heading; pitch = -0.1;         // align the on-foot orbit cam behind the player (no snap)
  player.mesh.visible = true;
  player.mesh.position.copy(player.pos);
  playerVehicle = null;
  mode = 'foot';
  if (crosshairEl) crosshairEl.classList.remove('hidden');
  updateHud();
}

function updatePed(p, dt) {
  if (p.state === 'dead') {
    p.t += dt;
    // tip over in the first ~0.5s, then fade out, then respawn
    const fallAng = Math.min(1, p.t / 0.5) * (Math.PI / 2) * p.fall;
    p.mesh.rotation.z = fallAng;
    p.mesh.position.copy(p.pos);
    if (p.t > 1.2) { const o = Math.max(0, 1 - (p.t - 1.2) / 1.0); for (const m of p.mats) m.opacity = o; }
    if (p.t > RESPAWN_DELAY) respawnPed(p);
    return;
  }

  // panic if the player recently fired nearby — flee
  if (p.state === 'flee') { p.t -= dt; if (p.t <= 0) p.state = 'wander'; }

  let dx, dz;
  if (p.state === 'flee') {
    dx = p.pos.x - player.pos.x; dz = p.pos.z - player.pos.z;     // away from player
  } else {
    dx = p.target.x - p.pos.x; dz = p.target.z - p.pos.z;
    if (Math.hypot(dx, dz) < 1.2) { pickTarget(p); dx = p.target.x - p.pos.x; dz = p.target.z - p.pos.z; }
  }
  const l = Math.hypot(dx, dz) || 1;
  const sp = p.state === 'flee' ? PED_FLEE : PED_WALK;
  p.pos.x += (dx / l) * sp * dt; p.pos.z += (dz / l) * sp * dt;
  resolveCollision(p.pos, PED_R);
  p.mesh.position.copy(p.pos);
  p.mesh.rotation.y = Math.atan2(dx, dz);
  animateWalk(p.mesh, true, dt, sp);
}

function respawnPed(p) {
  // recycle: reset transform/opacity and drop it back on a random street edge
  let px, pz, tries = 0;
  do { px = (Math.random() * 2 - 1) * (BOUND - 4); pz = (Math.random() * 2 - 1) * (BOUND - 4); tries++; }
  while (insideBuilding(px, pz, PED_R + 0.5) && tries < 40);
  p.pos.set(px, 0, pz); p.mesh.position.copy(p.pos);
  p.mesh.rotation.set(0, 0, 0);
  for (const m of p.mats) { m.opacity = 1; m.transparent = false; }
  p.dead = false; p.state = 'wander'; p.t = 0; pickTarget(p);
}

// make nearby peds flee when the player shoots
function startleNearby() {
  for (const p of peds) {
    if (p.dead) continue;
    if (p.pos.distanceTo(player.pos) < 22) { p.state = 'flee'; p.t = 3 + Math.random() * 2; }
  }
}

// cheap procedural walk: swing arms/legs opposite when moving
function animateWalk(mesh, moving, dt, sp) {
  const u = mesh.userData;
  if (!u.legL) return;
  u.phase = (u.phase || 0) + (moving ? (sp || WALK) * dt * 2.2 : 0);
  const s = moving ? Math.sin(u.phase) * 0.5 : 0;
  u.legL.rotation.x = s; u.legR.rotation.x = -s;
  if (u.armL && !u.muzzle) { u.armL.rotation.x = -s; u.armR.rotation.x = s; }
}

// ============================================================
// HUD
// ============================================================
function ensureHud() {
  hudEl = document.getElementById('foot-hud');
  ammoEl = document.getElementById('foot-ammo');
  killsEl = document.getElementById('foot-kills');
  promptEl = document.getElementById('foot-prompt');
  toastEl = document.getElementById('foot-toast');
  crosshairEl = document.getElementById('foot-crosshair');
  speedEl = document.getElementById('foot-speed');
  footStatsEl = document.getElementById('foot-stats-foot');
  driveStatsEl = document.getElementById('foot-stats-drive');
}
function updateHud() {
  if (!hudEl) return;
  if (mode === 'drive') {
    if (footStatsEl) footStatsEl.classList.add('hidden');
    if (driveStatsEl) driveStatsEl.classList.remove('hidden');
    if (speedEl && playerVehicle) speedEl.textContent = String(Math.round(Math.abs(playerVehicle.speed) * 3.1));
    if (crosshairEl) crosshairEl.classList.add('hidden');
  } else {
    if (driveStatsEl) driveStatsEl.classList.add('hidden');
    if (footStatsEl) footStatsEl.classList.remove('hidden');
    if (ammoEl) ammoEl.textContent = player.reloadT > 0 ? 'RELOADING…' : `${player.ammo} / ${AMMO_MAX}`;
    if (killsEl) killsEl.textContent = String(kills);
    if (crosshairEl) crosshairEl.classList.toggle('hidden', !OF.active);
  }
}
let toastT = 0;
function showToast(html) {
  if (!toastEl) return;
  toastEl.innerHTML = html; toastEl.classList.remove('hidden'); toastT = 7;
}

// fold the toast timer + crosshair visibility into the frame via a light tick
function postFrameUi(dt) {
  if (toastT > 0) { toastT -= dt; if (toastT <= 0 && toastEl) toastEl.classList.add('hidden'); }
}

// ============================================================
// SIZING
// ============================================================
let lastW = 0, lastH = 0;
function resize() {
  const w = canvas.clientWidth || 960, h = canvas.clientHeight || 540;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  lastW = w; lastH = h;
}
function resizeIfNeeded() {
  if (canvas.clientWidth !== lastW || canvas.clientHeight !== lastH) resize();
}

// ============================================================
// SMALL MATH HELPERS
// ============================================================
function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
function lerpNum(a, b, t) { return a + (b - a) * t; }

// ============================================================
// WIN-SCREEN WATCHER — reveal the easter egg only after a real finish
// ============================================================
function watchForWin() {
  const winScreen = document.getElementById('screen-win');
  if (!winScreen) return;
  const reveal = () => {
    if (!winScreen.classList.contains('hidden')) {
      localStorage.setItem('wrt.onfoot.unlocked', 'true');
      if (promptEl) promptEl.classList.remove('hidden');
    }
  };
  new MutationObserver(reveal).observe(winScreen, { attributes: true, attributeFilter: ['class'] });
  reveal();
}

// ============================================================
// BOOT — wire listeners + HUD; build nothing heavy until first enter()
// ============================================================
ensureHud();
watchForWin();
// capture-phase so we pre-empt game.js's window listeners while active
window.addEventListener('keydown', onKeyDown, true);
window.addEventListener('keyup', onKeyUp, true);
window.addEventListener('mousedown', onMouseDown, true);
window.addEventListener('mousemove', onMouseMove, false);
document.addEventListener('pointerlockchange', onPointerLockChange, false);
window.addEventListener('resize', () => { if (initialized && OF.active) resize(); });

// Shareable playtest entry: opening the page with #gta (or ?gta / #playtest)
// unlocks and drops you straight into the on-foot/GTA sandbox — no need to
// finish the whole drive first. The normal hidden flow (finish -> F) still works.
if (/gta|playtest/i.test(location.hash) || /gta|playtest/i.test(location.search)) {
  localStorage.setItem('wrt.onfoot.unlocked', 'true');
  // defer a frame so game.js has finished its own boot + initial applyScreen
  requestAnimationFrame(() => { try { enter(); } catch (e) { console.error('[ONFOOT] auto-enter failed', e); } });
}
