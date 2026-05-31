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
const TURN_RATE = 2.4;       // Q/E keyboard turn rate (rad/s) — turning works even without pointer lock
const PITCH_MIN = -0.95, PITCH_MAX = 0.55;
const MAX_RANGE = 140;       // bullet reach
const HIT_R = 1.0;           // how close the aim ray must pass a ped to hit
const AMMO_MAX = 12;
const RELOAD_TIME = 1.15;    // seconds
const FIRE_COOLDOWN = 0.14;  // min seconds between shots
const NPC_COUNT = 24;        // crowd size — scaled up for the bigger zoned town
const BOUND = 84;            // half-size of the walkable town square (7x7 zoned grid)
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

// ---- camera feel (live-tunable in the console via window.ONFOOT_CAM) --------
// Damped follow + speed-based FOV are most of what reads as "smooth". Tunables
// are time-constants in seconds (smaller = snappier); edit ONFOOT_CAM.* live.
const CAM = {
  followTau: 0.09,   // on-foot position smoothing (s)
  driveTau: 0.16,    // driving chase smoothing (s)
  fovBase: 62,       // base vertical FOV
  fovDrive: 78,      // FOV at top car speed (sells velocity)
  fovTau: 0.30,      // FOV easing (s)
};
let _camInit = false;                     // seed the smoothed position on first frame / after mode change
const _camPos = new THREE.Vector3();      // smoothed camera position (on-foot)
let _curFov = CAM.fovBase;                // smoothed FOV
if (typeof window !== 'undefined') window.ONFOOT_CAM = CAM;
// frame-rate-independent smoothing factor for a given time-constant
function camDamp(tau, dt) { return 1 - Math.exp(-dt / Math.max(0.0001, tau)); }
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
const justPressed = new Set();   // edge-pressed keys this frame (for an optional systems layer)
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
  // Rigged, animated model when the (optional) actor art loaded; else the
  // procedural box-person below. Same contract: feet at origin, ~1.8 tall,
  // facing +Z, userData.muzzle when armed, walk driven via animateWalk().
  if (OF._makeActor) {
    try {
      const a = OF._makeActor({
        armed,
        colorize: armed ? null : colors.shirt,          // peds tinted toward their shirt colour for variety
        scaleVar: 0.94 + Math.random() * 0.16,
      });
      if (a) return a;
    } catch (e) { console.warn('[ONFOOT] actor build failed; procedural person', e); }
  }

  const g = new THREE.Group();

  // --- helpers (defensive: nothing here may throw in a way that kills render) ---
  const mk = (geo, col, rough) => {
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: col, roughness: rough == null ? 0.85 : rough }));
    m.castShadow = true; m.receiveShadow = true; return m;
  };
  // Capsule whose TOP (the joint) sits at the mesh's local origin, so a parent
  // rotation.x reads as a swing pivoting from the shoulder/hip. `len` is the
  // straight section between the two hemispherical caps; total length = len + 2*r.
  const limbCapsule = (r, len) => {
    let geo;
    try { geo = new THREE.CapsuleGeometry(r, len, 4, 10); }
    catch (e) { geo = new THREE.CylinderGeometry(r, r, len + r * 2, 10); } // r0.170 has Capsule, but fall back just in case
    // shift down so the top cap apex is at y=0 (the pivot)
    geo.translate(0, -(len / 2 + r), 0);
    return geo;
  };
  const skin = colors.skin, shirt = colors.shirt, pants = colors.pants, hair = colors.hair;

  // tiny per-spawn cosmetic variety (build / height)
  const sx = 0.92 + Math.random() * 0.20;   // girth
  const sy = 0.96 + Math.random() * 0.12;   // height
  const build = 0.9 + Math.random() * 0.22; // limb chunkiness
  const shoe = 0x2b2b30;

  // ============================================================
  // LEGS — animated mesh is the UPPER leg; its capsule top sits at the hip
  // joint so animateWalk's rotation.x swings the whole leg from the hip.
  // Lower leg + shoe are children that swing along.
  // ============================================================
  const mkLeg = (sign) => {
    const hipY = 0.92;                       // hip joint height
    const thighLen = 0.30, thighR = 0.115 * build;
    const up = mk(limbCapsule(thighR, thighLen), pants);
    up.position.set(sign * 0.13, hipY, 0);   // pivot AT the hip

    const kneeY = -(thighLen + thighR * 2);  // bottom of thigh (local to up)
    const shinLen = 0.28, shinR = 0.095 * build;
    const lo = mk(limbCapsule(shinR, shinLen), pants);
    lo.position.set(0, kneeY + thighR * 0.4, 0.005); // slight overlap at knee
    up.add(lo);

    // rounded shoe: squashed sphere + a small toe cap, toe forward (+Z)
    const ankleY = -(shinLen + shinR * 2) + shinR * 0.3;
    const foot = mk(new THREE.SphereGeometry(0.12, 12, 10), shoe, 0.55);
    foot.scale.set(0.95, 0.55, 1.7);
    foot.position.set(0, ankleY - 0.02, 0.07);
    lo.add(foot);
    const toe = mk(new THREE.SphereGeometry(0.08, 10, 8), shoe, 0.55);
    toe.scale.set(1.0, 0.7, 1.0);
    toe.position.set(0, ankleY - 0.03, 0.19);
    lo.add(toe);
    return up;
  };
  const legL = mkLeg(-1), legR = mkLeg(1);

  // ============================================================
  // HIPS + TORSO — capsules give a rounded, tapered trunk
  // ============================================================
  const hips = mk(limbCapsule(0.20 * build, 0.10), pants);
  hips.position.set(0, 1.10, 0); hips.scale.set(1.25, 1.0, 0.85);

  // torso capsule: shoulders ~1.66, taper handled by slight scale
  const torsoLen = 0.42, torsoR = 0.21 * build;
  const torso = mk(limbCapsule(torsoR, torsoLen), shirt);
  // place so its top (shoulder line) is around Y=1.70
  torso.position.set(0, 1.70, 0); torso.scale.set(1.18, 1.0, 0.78);

  // chest/upper-pec swell for a less tubular silhouette
  const chest = mk(new THREE.SphereGeometry(0.20 * build, 14, 12), shirt);
  chest.scale.set(1.3, 0.7, 0.85); chest.position.set(0, 1.55, 0.03);

  // shoulder caps (gentle taper into the arms)
  const shoulderGeo = new THREE.SphereGeometry(0.11 * build, 12, 10);
  const shL = mk(shoulderGeo, shirt); shL.position.set(-0.27, 1.66, 0);
  const shR = mk(shoulderGeo, shirt); shR.position.set(0.27, 1.66, 0);

  // ============================================================
  // NECK + HEAD + FACE
  // ============================================================
  const neck = mk(limbCapsule(0.075, 0.06), skin); neck.position.set(0, 1.86, 0);

  const head = mk(new THREE.SphereGeometry(0.165, 18, 16), skin);
  head.scale.set(0.95, 1.08, 1.0);          // slightly squashed / elongated jaw
  head.position.set(0, 2.02, 0);

  // hair cap — scaled sphere clipped to the upper/back skull
  const cap = mk(new THREE.SphereGeometry(0.172, 16, 14), hair, 0.92);
  cap.scale.set(1.02, 0.85, 1.05);
  cap.position.set(0, 0.04, -0.012); head.add(cap);
  // fringe/bangs over the forehead
  const bang = mk(new THREE.SphereGeometry(0.10, 12, 8), hair, 0.92);
  bang.scale.set(1.5, 0.5, 0.6); bang.position.set(0, 0.06, 0.13); head.add(bang);

  // ears
  const earGeo = new THREE.SphereGeometry(0.045, 8, 8);
  const earL = mk(earGeo, skin); earL.scale.set(0.6, 1.2, 1.0); earL.position.set(-0.155, 0.0, 0); head.add(earL);
  const earR = mk(earGeo, skin); earR.scale.set(0.6, 1.2, 1.0); earR.position.set(0.155, 0.0, 0); head.add(earR);

  // eyes (whites + pupils) on the +Z face
  const eyeGeo = new THREE.SphereGeometry(0.032, 10, 8);
  const eyeL = mk(eyeGeo, 0xf4f4f4, 0.35); eyeL.scale.set(1.1, 0.8, 0.6); eyeL.position.set(-0.06, 0.025, 0.145); head.add(eyeL);
  const eyeR = mk(eyeGeo, 0xf4f4f4, 0.35); eyeR.scale.set(1.1, 0.8, 0.6); eyeR.position.set(0.06, 0.025, 0.145); head.add(eyeR);
  const pupGeo = new THREE.SphereGeometry(0.016, 8, 8);
  const pupL = mk(pupGeo, 0x1a1a22, 0.3); pupL.position.set(-0.06, 0.02, 0.165); head.add(pupL);
  const pupR = mk(pupGeo, 0x1a1a22, 0.3); pupR.position.set(0.06, 0.02, 0.165); head.add(pupR);

  // brows (thin rounded bars), nose (capsule), mouth (squashed sphere)
  const browGeo = new THREE.SphereGeometry(0.04, 8, 6);
  const browL = mk(browGeo, hair, 0.9); browL.scale.set(1.3, 0.35, 0.5); browL.position.set(-0.06, 0.075, 0.15); head.add(browL);
  const browR = mk(browGeo, hair, 0.9); browR.scale.set(1.3, 0.35, 0.5); browR.position.set(0.06, 0.075, 0.15); head.add(browR);
  const nose = mk(limbCapsule(0.028, 0.05), skin); nose.rotation.x = Math.PI; nose.position.set(0, 0.05, 0.155); head.add(nose);
  const mouth = mk(new THREE.SphereGeometry(0.05, 10, 6), 0x7a3b3b, 0.55); mouth.scale.set(1.1, 0.35, 0.4); mouth.position.set(0, -0.085, 0.145); head.add(mouth);

  // ============================================================
  // ARMS — animated mesh is the UPPER arm; capsule top sits at the shoulder
  // joint so rotation.x swings from the shoulder. Forearm + hand are children.
  // ============================================================
  const mkArm = (sign) => {
    const shoulderY = 1.66;
    const upperLen = 0.26, upperR = 0.075 * build;
    const up = mk(limbCapsule(upperR, upperLen), shirt);
    up.position.set(sign * 0.27, shoulderY, 0); // pivot AT the shoulder

    const elbowY = -(upperLen + upperR * 2);
    const foreLen = 0.24, foreR = 0.062 * build;
    const lo = mk(limbCapsule(foreR, foreLen), skin); // rolled-sleeve forearm -> skin
    lo.position.set(0, elbowY + upperR * 0.4, 0.004);
    up.add(lo);

    const wristY = -(foreLen + foreR * 2) + foreR * 0.2;
    const hand = mk(new THREE.SphereGeometry(0.07, 12, 10), skin);
    hand.scale.set(0.85, 1.15, 0.7);
    hand.position.set(0, wristY - 0.01, 0.01);
    lo.add(hand);
    return up;
  };
  const armL = mkArm(-1), armR = mkArm(1);

  g.add(legL, legR, hips, torso, chest, shL, shR, neck, head, armL, armR);
  g.userData.armL = armL; g.userData.armR = armR; g.userData.legL = legL; g.userData.legR = legR;

  if (armed) {
    // raise the right arm forward and clip a little pistol near the right hand
    armR.position.set(0.27, 1.62, 0.06); armR.rotation.x = -1.35;
    const gun = new THREE.Group();
    const slide = mk(new THREE.BoxGeometry(0.08, 0.10, 0.30), 0x222228, 0.45); slide.position.set(0, 0.02, 0.06); gun.add(slide);
    const barrel = mk(new THREE.CylinderGeometry(0.022, 0.022, 0.10, 8), 0x2a2a30, 0.4);
    barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.02, 0.24); gun.add(barrel);
    const grip = mk(new THREE.BoxGeometry(0.07, 0.16, 0.10), 0x18181c, 0.45); grip.position.set(0, -0.10, -0.05); grip.rotation.x = 0.25; gun.add(grip);
    gun.position.set(0.30, 1.30, 0.5);
    const muzzle = new THREE.Object3D(); muzzle.position.set(0.30, 1.34, 0.72);
    g.add(gun, muzzle);
    g.userData.muzzle = muzzle; g.userData.gun = gun;
  }

  // subtle per-spawn body-shape variety (scale the whole rig; feet stay at Y=0)
  g.scale.set(sx, sy, sx);
  return g;
}

// A low-poly building filling (part of) a town cell, with lit windows. The town
// now has distinct zones — the optional styling is read POSITIONALLY from
// arguments[1] (NOT a named 2nd param) so the headless scene-stats tool, which
// extracts this function by its exact signature text and runs it in isolation,
// keeps working and still calls it as buildBuilding with rng alone. Kept fully
// self-contained (THREE + rng + locals only), and brace-balanced even in comments,
// for that same reason (the extractor counts braces in comments too).
function buildBuilding(rng) {
  const opts = (arguments.length > 1 && arguments[1]) || {};
  const zone = opts.zone || 'midtown';   // 'downtown'|'midtown'|'industrial'|'residential'
  const g = new THREE.Group();

  // zone presets: height/footprint bands, window density, palette, winKey. winKey
  // selects a shared emissive window material at instancing time (0 cool office
  // white, 1 warm, 2 dim industrial) — keep the colours below in sync with the
  // shared materials built in ensureInit's window-instancing pass.
  let hLo, hHi, wLo, wHi, winChance, winKey, tones;
  switch (zone) {
    case 'downtown':
      hLo = 16; hHi = 32; wLo = 7; wHi = 11; winChance = 0.82; winKey = 0;
      tones = [0x6b7280, 0x5c6b7a, 0x4f5a66, 0x737a82, 0x5a6470]; break;
    case 'industrial':
      hLo = 5; hHi = 9; wLo = 10; wHi = 13; winChance = 0.3; winKey = 2;
      tones = [0x7a7266, 0x6f6a60, 0x83786a, 0x6b6258, 0x7d7468]; break;
    case 'residential':
      hLo = 4; hHi = 7; wLo = 6; wHi = 9; winChance = 0.7; winKey = 1;
      tones = [0x8a6f5a, 0x7d6e63, 0x96785f, 0x6f6258, 0x8f8378]; break;
    case 'midtown':
    default:
      hLo = 9; hHi = 20; wLo = 7; wHi = 11; winChance = 0.66; winKey = 1;
      tones = [0x6b7280, 0x7a6f63, 0x5c6b7a, 0x736a78, 0x6f7a6a]; break;
  }

  const h = hLo + rng() * (hHi - hLo);
  const w = wLo + rng() * (wHi - wLo), d = wLo + rng() * (wHi - wLo);
  const tone = tones[(rng() * tones.length) | 0];
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color: tone, roughness: 0.9 }));
  body.position.y = h / 2; body.castShadow = true; body.receiveShadow = true;
  g.add(body);

  // ROOF dressing for skyline variety: a pitched cap on houses; a parapet + a
  // rooftop housing box on tall blocks.
  if (zone === 'residential') {
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 4),
      new THREE.MeshStandardMaterial({ color: 0x5a4636, roughness: 0.95 }));
    roof.rotation.y = Math.PI / 4; roof.scale.set(w * 0.72, 1.3, d * 0.72);
    roof.position.y = h + 0.65; roof.castShadow = true; g.add(roof);
  } else if (h > 12) {
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, 0.5, d + 0.4),
      new THREE.MeshStandardMaterial({ color: 0x3f444c, roughness: 0.85 }));
    cap.position.y = h + 0.2; cap.castShadow = true; g.add(cap);
    if (rng() < 0.7) {
      const hut = new THREE.Mesh(new THREE.BoxGeometry(w * 0.3, 1.4, d * 0.3),
        new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.9 }));
      hut.position.set((rng() - 0.5) * w * 0.3, h + 1.1, (rng() - 0.5) * d * 0.3);
      hut.castShadow = true; g.add(hut);
    }
  }

  // WINDOW strips: emissive squares on the ±Z faces (downtown also gets ±X for a
  // denser skyline). Each is tagged userData.winKey so ensureInit can collapse
  // EVERY window in the town into a few InstancedMeshes (one per key) — that
  // batching is what keeps the bigger, taller map cheap on draw calls.
  const winCol = [0xbfe0ff, 0xffe39a, 0xc9c2a8][winKey];   // must match instancifyTown winMats
  const winEm = [0x9ecbff, 0xffcf6a, 0x9a8f60][winKey];
  const winEi = winKey === 2 ? 0.75 : 0.85;                // industrial intentionally dimmer
  const winMat = new THREE.MeshStandardMaterial({ color: winCol, emissive: winEm, emissiveIntensity: winEi, roughness: 0.5 });
  const rows = Math.max(2, (h / 2.6) | 0);
  const winGeo = new THREE.BoxGeometry(0.9, 1.1, 0.1);
  const faces = zone === 'downtown' ? ['z', 'x'] : ['z'];
  for (const ax of faces) {
    const span = ax === 'z' ? w : d, depth = ax === 'z' ? d : w;
    const nC = Math.max(2, (span / 2.2) | 0);
    for (let face = -1; face <= 1; face += 2) {
      for (let r = 0; r < rows; r++) for (let c = 0; c < nC; c++) {
        if (rng() > winChance) continue;       // some windows dark / blank wall
        const win = new THREE.Mesh(winGeo, winMat);
        const along = -span / 2 + 1.1 + c * (span - 2.2) / Math.max(1, nC - 1);
        const up = 1.6 + r * (h - 2.4) / Math.max(1, rows - 1);
        if (ax === 'z') { win.position.set(along, up, face * (depth / 2 + 0.02)); }
        else { win.position.set(face * (depth / 2 + 0.02), up, along); win.rotation.y = Math.PI / 2; }
        win.userData.winKey = winKey;
        g.add(win);
      }
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
  const PI = Math.PI;

  // --- materials ---
  const body = new THREE.MeshPhysicalMaterial({ color: bodyColor, roughness: 0.3, metalness: 0.3, clearcoat: 0.9, clearcoatRoughness: 0.18 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x14141a, roughness: 0.55, metalness: 0.1 }); // black plastic trim / rockers
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1b20, roughness: 0.7 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.9, roughness: 0.22 });
  const grilleMat = new THREE.MeshStandardMaterial({ color: 0x202024, metalness: 0.5, roughness: 0.45 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x9fc4d8, roughness: 0.06, metalness: 0.0, transmission: 0.55, transparent: true, opacity: 0.5, clearcoat: 1.0, ior: 1.45 });
  const tail = new THREE.MeshStandardMaterial({ color: 0xff3838, emissive: 0xcc1010, emissiveIntensity: 1.1, roughness: 0.35 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xfff3c0, emissive: 0xfff0b0, emissiveIntensity: 1.2, roughness: 0.25 });
  const lensMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.05, metalness: 0.0, transmission: 0.4, transparent: true, opacity: 0.55, clearcoat: 1.0 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xd7dade, metalness: 0.9, roughness: 0.26 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x111116, roughness: 0.9 });

  // Helper: a rounded "soft box" via a capsule squashed on its length axis still
  // reads boxy; instead we round real boxes by stacking the box with thin chamfer
  // rails along its top edges. capsule(): a horizontal capsule used for hull/roof
  // curvature. Falls back to a plain box if CapsuleGeometry is unavailable.
  function softHull(w, h, d, mat, segCap) {
    // Body hull as a capsule laid along Z (rounds nose+tail+sides), scaled to size.
    try {
      const r = Math.min(w, h) * 0.5;
      const len = Math.max(0.01, d - 2 * r);
      const cap = new THREE.CapsuleGeometry(r, len, 4, segCap || 12);
      // Capsule's long axis is Y; rotate so length runs along Z.
      cap.rotateX(PI / 2);
      const m = new THREE.Mesh(cap, mat);
      // squash the round cross-section into the body's W x H footprint
      m.scale.set(w / (2 * r), h / (2 * r), 1);
      return m;
    } catch (e) {
      return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    }
  }

  // nose is -Z, tail is +Z (matches headlights at -Z, taillights at +Z)
  // --- main painted hull: rounded capsule core (sides/nose/tail curved) ---
  const hull = softHull(1.96, 0.74, 4.0, body, 16); hull.position.y = 0.7;
  // belt-line filler box keeps a solid silhouette under the capsule curve
  const belt = new THREE.Mesh(new THREE.BoxGeometry(1.82, 0.42, 3.62), body); belt.position.y = 0.62;
  // sloped hood + trunk give the long curved profile
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.26, 1.5), body); hood.position.set(0, 0.96, -1.22); hood.rotation.x = -0.1;
  const trunk = new THREE.Mesh(new THREE.BoxGeometry(1.82, 0.3, 1.1), body); trunk.position.set(0, 0.95, 1.42); trunk.rotation.x = 0.09;

  // --- curved cabin / greenhouse: capsule roof (rounded) over a tapered base ---
  const cabinBase = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.5, 1.96), body); cabinBase.position.set(0, 1.06, 0.06);
  const roof = softHull(1.52, 0.5, 1.78, body, 12); roof.position.set(0, 1.4, 0.12);
  // A-pillar / windshield-frame chamfer fillers to soften the cabin-to-hood join
  const cowl = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.2, 0.34), body); cowl.position.set(0, 1.14, -0.86); cowl.rotation.x = -0.45;

  // --- rockers / lower side cladding + underbody ---
  const rockerL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.24, 3.0), trim); rockerL.position.set(-0.96, 0.46, 0.05);
  const rockerR = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.24, 3.0), trim); rockerR.position.set(0.96, 0.46, 0.05);
  const underTray = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.2, 3.3), dark); underTray.position.y = 0.4;

  // --- glass: curved windshield, rear glass, side windows (physical, transparent) ---
  const wind = new THREE.Mesh(new THREE.BoxGeometry(1.46, 0.5, 0.05), glass); wind.position.set(0, 1.32, -0.7); wind.rotation.x = -0.46;
  const rearGlass = new THREE.Mesh(new THREE.BoxGeometry(1.46, 0.44, 0.05), glass); rearGlass.position.set(0, 1.32, 0.9); rearGlass.rotation.x = 0.46;
  const sideGlassL = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.32, 1.46), glass); sideGlassL.position.set(-0.78, 1.34, 0.12);
  const sideGlassR = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.32, 1.46), glass); sideGlassR.position.set(0.78, 1.34, 0.12);

  // --- front face: grille + rounded headlights (sphere base + clear lens) ---
  const grille = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.26, 0.06), grilleMat); grille.position.set(0, 0.68, -2.0);
  const grilleBar1 = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.022, 6, 20, PI), chrome); grilleBar1.position.set(0, 0.74, -2.0); grilleBar1.rotation.z = PI; grilleBar1.scale.set(1.05, 0.32, 1);
  const hl1 = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10), lamp); hl1.position.set(-0.66, 0.78, -1.98); hl1.scale.set(1.3, 0.78, 0.6);
  const hl2 = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10), lamp); hl2.position.set(0.66, 0.78, -1.98); hl2.scale.set(1.3, 0.78, 0.6);
  const hlLensL = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8), lensMat); hlLensL.position.set(-0.66, 0.78, -2.0); hlLensL.scale.set(1.3, 0.8, 0.45);
  const hlLensR = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8), lensMat); hlLensR.position.set(0.66, 0.78, -2.0); hlLensR.scale.set(1.3, 0.8, 0.45);

  // --- rear face: rounded tail lights (emissive) + chrome strip ---
  const tl1 = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 8), tail); tl1.position.set(-0.64, 0.82, 1.98); tl1.scale.set(1.5, 0.85, 0.5);
  const tl2 = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 8), tail); tl2.position.set(0.64, 0.82, 1.98); tl2.scale.set(1.5, 0.85, 0.5);
  const tlBar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.04, 0.05), chrome); tlBar.position.set(0, 0.82, 2.0);

  // --- rounded bumpers (capsule-profile) + chrome lips ---
  const bumperF = softHull(1.94, 0.26, 0.34, trim, 8); bumperF.position.set(0, 0.46, -2.0);
  const bumperFlip = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.08), chrome); bumperFlip.position.set(0, 0.36, -2.08);
  const bumperR = softHull(1.94, 0.26, 0.34, trim, 8); bumperR.position.set(0, 0.46, 2.0);
  const bumperRlip = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.08), chrome); bumperRlip.position.set(0, 0.36, 2.08);

  // --- pronounced wheel arches (torus flares) over each wheel ---
  function makeArch(x, z) {
    const arch = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.1, 8, 18, PI), trim);
    arch.position.set(x, 0.56, z);
    arch.rotation.y = PI / 2;          // open the arch toward the side
    arch.scale.set(1, 1, 0.55);        // flatten against the flank
    return arch;
  }
  const archFL = makeArch(-0.99, -1.4), archFR = makeArch(0.99, -1.4);
  const archRL = makeArch(-0.99, 1.45), archRR = makeArch(0.99, 1.45);

  // --- side mirrors (rounded pods) ---
  const mirrorL = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), body); mirrorL.position.set(-1.04, 1.14, -0.5); mirrorL.scale.set(1, 0.85, 1.3);
  const mirrorR = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), body); mirrorR.position.set(1.04, 1.14, -0.5); mirrorR.scale.set(1, 0.85, 1.3);
  const mirrorLglass = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.08, 0.13), glass); mirrorLglass.position.set(-1.12, 1.14, -0.5);
  const mirrorRglass = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.08, 0.13), glass); mirrorRglass.position.set(1.12, 1.14, -0.5);

  // --- chrome belt-line trim + door-seam hints on each flank ---
  const beltTrimL = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 2.4), chrome); beltTrimL.position.set(-0.95, 0.92, 0.1);
  const beltTrimR = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 2.4), chrome); beltTrimR.position.set(0.95, 0.92, 0.1);
  const seamL = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.4, 0.025), trim); seamL.position.set(-0.96, 0.74, 0.55);
  const seamR = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.4, 0.025), trim); seamR.position.set(0.96, 0.74, 0.55);

  g.add(
    underTray, belt, hull, hood, trunk, cabinBase, roof, cowl, rockerL, rockerR,
    wind, rearGlass, sideGlassL, sideGlassR,
    grille, grilleBar1, hl1, hl2, hlLensL, hlLensR,
    tl1, tl2, tlBar,
    bumperF, bumperFlip, bumperR, bumperRlip,
    archFL, archFR, archRL, archRR,
    mirrorL, mirrorR, mirrorLglass, mirrorRglass,
    beltTrimL, beltTrimR, seamL, seamR
  );

  // --- wheels: front pair (-Z) then rear pair (+Z); axle along X so they roll on Z.
  // Front wheels live inside a steer-pivot Group so steer (pivot.rotation.y) and roll
  // (wheel.rotation.x) compose cleanly. Each wheel is a sub-group: tire + sidewall + hub + spokes. ---
  const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.34, 22); wheelGeo.rotateZ(PI / 2);          // tire tread
  const sidewallGeo = new THREE.TorusGeometry(0.42, 0.1, 8, 22); sidewallGeo.rotateY(PI / 2);          // rounded tire shoulder
  const hubGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.08, 16); hubGeo.rotateZ(PI / 2);              // alloy rim disc
  const hubCenterGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.1, 10); hubCenterGeo.rotateZ(PI / 2);   // center cap

  function makeWheel(side) {
    // side = -1 for left, +1 for right (determines which face the hub/cap shows)
    const w = new THREE.Mesh(wheelGeo, tireMat);
    const hubFace = side * 0.16;
    const sidewall = new THREE.Mesh(sidewallGeo, tireMat); sidewall.position.x = hubFace * 0.6;
    const hub = new THREE.Mesh(hubGeo, hubMat); hub.position.x = hubFace;
    const cap = new THREE.Mesh(hubCenterGeo, chrome); cap.position.x = hubFace + 0.05;
    // alloy spokes radiating from the hub center
    for (let s = 0; s < 5; s++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.42, 0.04), hubMat);
      spoke.position.x = hubFace;
      spoke.rotation.x = (s / 5) * PI * 2;
      hub.add(spoke);
    }
    w.add(sidewall, hub, cap);
    return w;
  }

  const wheels = [], steerPivots = [];
  let wi = 0;
  for (const [x, z] of [[-1.04, -1.4], [1.04, -1.4], [-1.04, 1.45], [1.04, 1.45]]) {
    const side = x < 0 ? -1 : 1;
    const w = makeWheel(side);
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
// TOWN BATCHER — collapse the static town repeats into InstancedMeshes (one draw
// per batch). WINDOWS are the prize: every building makes its own window meshes
// with their own geometry/material instances, but they're all the SAME
// 0.9x1.1x0.1 box and have only 3 distinct emissive looks (by userData.winKey),
// so we merge them ACROSS every building onto one shared geometry + one shared
// material per key. Sidewalk pads and lamp poles/bulbs already share geo+mat, so
// they batch by (geo|mat). Building bodies/roofs/huts have unique geometry and are
// left as individual meshes — so the async texture pass can still map facades onto
// them. Defensive: any failure leaves the plain meshes. Returns { before, after }.
// ============================================================
function instancifyTown(root) {
  if (!THREE.InstancedMesh) return { before: 0, after: 0 };
  root.updateMatrixWorld(true);
  const winGeo = new THREE.BoxGeometry(0.9, 1.1, 0.1);
  const winMats = [
    new THREE.MeshStandardMaterial({ color: 0xbfe0ff, emissive: 0x9ecbff, emissiveIntensity: 0.85, roughness: 0.5 }),
    new THREE.MeshStandardMaterial({ color: 0xffe39a, emissive: 0xffcf6a, emissiveIntensity: 0.85, roughness: 0.5 }),
    new THREE.MeshStandardMaterial({ color: 0xc9c2a8, emissive: 0x9a8f60, emissiveIntensity: 0.75, roughness: 0.5 }),
  ];
  const winByKey = [[], [], []];
  const buckets = new Map();          // geo|mat -> { geo, mat, items[] }
  let before = 0;
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh) return;
    before++;
    const wk = o.userData && o.userData.winKey;
    if (wk != null && winByKey[wk]) { winByKey[wk].push(o); return; }
    if (Array.isArray(o.material) || !o.geometry || !o.material) return;
    const key = o.geometry.uuid + '|' + o.material.uuid;
    let b = buckets.get(key);
    if (!b) { b = { geo: o.geometry, mat: o.material, items: [] }; buckets.set(key, b); }
    b.items.push(o);
  });
  let after = 0;
  const bake = (geo, mat, items) => {
    const inst = new THREE.InstancedMesh(geo, mat, items.length);
    inst.castShadow = items.some((m) => m.castShadow);
    inst.receiveShadow = items.some((m) => m.receiveShadow);
    inst.frustumCulled = false;   // instances span the whole map; base-geo culling would wrongly hide them
    for (let i = 0; i < items.length; i++) { items[i].updateWorldMatrix(true, false); inst.setMatrixAt(i, items[i].matrixWorld); }
    inst.instanceMatrix.needsUpdate = true;
    root.add(inst); after++;
    for (const m of items) m.removeFromParent();
  };
  for (let k = 0; k < winByKey.length; k++) if (winByKey[k].length) bake(winGeo, winMats[k], winByKey[k]);
  for (const b of buckets.values()) {
    if (b.items.length < 2) { after++; continue; }   // singletons (bodies/roofs/huts) stay as meshes
    bake(b.geo, b.mat, b.items);
  }
  // sweep up now-empty groups (cosmetic tidy)
  const empties = [];
  root.traverse((o) => { if (o !== root && o.isGroup && o.children.length === 0) empties.push(o); });
  for (const g of empties) g.removeFromParent();
  return { before, after };
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
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 300;
  sun.shadow.camera.left = -105; sun.shadow.camera.right = 105;
  sun.shadow.camera.top = 105; sun.shadow.camera.bottom = -105;   // covers the wider 7x7 town
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
  // (street markings — crosswalks + lane dashes — are painted by gta/onfoot-detail.js,
  //  which lays them on the real street lines; the old block-centre stripes are gone.)

  // ============================================================
  // TOWN — a 7x7 grid (CELL=24) of zoned blocks around an open spawn plaza.
  // Zones radiate out from the centre: a tall DOWNTOWN core (sometimes clustered),
  // a MIDTOWN ring, then an outer ring split into a west INDUSTRIAL belt and east
  // RESIDENTIAL streets. Everything is parented to one `town` group; afterwards the
  // hundreds of window meshes (and the shared lamp parts + sidewalk pads) are
  // collapsed into a few InstancedMeshes so the bigger, denser map stays cheap.
  // ============================================================
  const rng = makeRng(0x51EAD7);
  const CELL = 24, GRID = 3;
  const town = new THREE.Group(); town.name = 'town';

  // shared resources for the per-cell repeats (so the batcher can merge them)
  const padGeo = new THREE.PlaneGeometry(20, 20);
  const padMat = new THREE.MeshStandardMaterial({ color: 0x8f8b82, roughness: 0.97 });   // concrete sidewalk
  const lampPoleGeo = new THREE.CylinderGeometry(0.1, 0.12, 4, 8);
  const lampPoleMat = new THREE.MeshStandardMaterial({ color: 0x33363c });
  const lampBulbGeo = new THREE.SphereGeometry(0.28, 10, 10);
  const lampBulbMat = new THREE.MeshStandardMaterial({ color: 0xfff0b0, emissive: 0xffd070, emissiveIntensity: 1.2 });

  const zoneFor = (gx, gz) => {
    const ring = Math.max(Math.abs(gx), Math.abs(gz));
    if (ring <= 1) return 'downtown';
    if (ring === 2) return 'midtown';
    return gx < 0 ? 'industrial' : 'residential';   // outer ring
  };
  const placeBuilding = (cx, cz, zone, ox, oz) => {
    const { mesh, w, d } = buildBuilding(rng, { zone });
    mesh.position.set(cx + ox, 0, cz + oz);
    town.add(mesh);
    aabbs.push({ minX: cx + ox - w / 2, maxX: cx + ox + w / 2, minZ: cz + oz - d / 2, maxZ: cz + oz + d / 2 });
  };

  for (let gx = -GRID; gx <= GRID; gx++) {
    for (let gz = -GRID; gz <= GRID; gz++) {
      if (gx === 0 && gz === 0) continue;                  // spawn plaza, kept open
      if (gx === 0 && (gz === -1 || gz === -2)) continue;  // open corridor to the bank (gta heist)
      const zone = zoneFor(gx, gz);
      const emptyP = zone === 'downtown' ? 0.05 : zone === 'midtown' ? 0.16 : 0.3;
      if (rng() < emptyP) continue;                        // occasional empty lot (airier outer rings)
      const cx = gx * CELL, cz = gz * CELL;

      // concrete sidewalk pad grounds the block (street asphalt shows in the gaps)
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.rotation.x = -Math.PI / 2; pad.position.set(cx, 0.0, cz); pad.receiveShadow = true;
      town.add(pad);

      // downtown cells sometimes hold a small cluster of towers; else one block.
      // Offsets are kept tight (single ≤±1, cluster radius ≤~3.1) so even the
      // widest footprint (industrial half ≈6.5, downtown half ≈5.5) stays ≥~3
      // units shy of the cross-street centreline at ±12 — drivable clearance.
      const cluster = zone === 'downtown' && rng() < 0.5 ? (rng() < 0.5 ? 2 : 3) : 1;
      if (cluster === 1) {
        placeBuilding(cx, cz, zone, (rng() - 0.5) * 2, (rng() - 0.5) * 2);
      } else {
        for (let i = 0; i < cluster; i++) {
          const a = (i / cluster) * Math.PI * 2 + rng();
          const rr = 2.0 + rng() * 1.1;
          placeBuilding(cx, cz, zone, Math.cos(a) * rr, Math.sin(a) * rr);
        }
      }

      // a simple street lamp near the block corner (shared geo/mat -> batched)
      if (rng() < 0.55) {
        const lamp = new THREE.Group();
        const pole = new THREE.Mesh(lampPoleGeo, lampPoleMat); pole.position.y = 2; pole.castShadow = true;
        const bulb = new THREE.Mesh(lampBulbGeo, lampBulbMat); bulb.position.y = 4;
        lamp.add(pole, bulb); lamp.position.set(cx + 11, 0, cz + 11); town.add(lamp);
      }
    }
  }
  scene.add(town);
  // collapse all the static repeats (windows across every building, sidewalk pads,
  // lamp poles/bulbs) into a handful of InstancedMeshes — the big draw-call win.
  try {
    const r = instancifyTown(town);
    console.log(`[ONFOOT world] town batched: ${r.before} meshes -> ${r.after} draws (${town.children.length} top-level)`);
  } catch (e) { console.warn('[ONFOOT world] town instancing skipped', e); }

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
// Push an XZ point out of every building AABB it overlaps, along the shallowest
// axis. Iterated to convergence: resolving one box can shove the point into a
// neighbour, and the old single pass left it stuck inside — that's what let you
// squeeze through wall seams and inside corners. We re-run until nothing overlaps.
function resolveCollision(pos, pad) {
  for (let iter = 0; iter < 4; iter++) {
    let hit = false;
    for (const a of aabbs) {
      if (pos.x > a.minX - pad && pos.x < a.maxX + pad && pos.z > a.minZ - pad && pos.z < a.maxZ + pad) {
        const dl = pos.x - (a.minX - pad), dr = (a.maxX + pad) - pos.x;
        const db = pos.z - (a.minZ - pad), df = (a.maxZ + pad) - pos.z;
        const m = Math.min(dl, dr, db, df);
        if (m === dl) pos.x = a.minX - pad;
        else if (m === dr) pos.x = a.maxX + pad;
        else if (m === db) pos.z = a.minZ - pad;
        else pos.z = a.maxZ + pad;
        hit = true;
      }
    }
    if (!hit) break;
  }
  pos.x = Math.max(-BOUND, Math.min(BOUND, pos.x));
  pos.z = Math.max(-BOUND, Math.min(BOUND, pos.z));
}
// Swept horizontal move: advance in steps no larger than ~half the collider
// radius, resolving after each, so a fast move (or a laggy big-dt frame) can't
// tunnel through a wall and corners resolve cleanly instead of letting you slip by.
function moveAndCollide(pos, dx, dz, pad) {
  const dist = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(dist / Math.max(0.05, pad * 0.5)));
  const sx = dx / steps, sz = dz / steps;
  for (let i = 0; i < steps; i++) {
    pos.x += sx; pos.z += sz;
    resolveCollision(pos, pad);
  }
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
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  justPressed.add(e.code);   // captured at keydown so fast taps aren't lost by a per-frame poll
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
function tryPointerLock() {
  // robust request: focus the canvas, request inside the click gesture, and surface
  // a denial instead of failing silently (Q/E still turn the player either way)
  try {
    if (canvas.focus) canvas.focus();
    const p = canvas.requestPointerLock && canvas.requestPointerLock();
    if (p && typeof p.catch === 'function') p.catch((err) => console.warn('[ONFOOT] pointer lock denied — use Q/E to turn', err));
  } catch (err) { console.warn('[ONFOOT] pointer lock failed — use Q/E to turn', err); }
}
function onMouseDown(e) {
  if (!OF.active || mode !== 'foot') return;             // no shooting from the driver's seat
  if (!locked) { tryPointerLock(); return; }             // first click grabs the mouse for look; Q/E turn regardless
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
  if (OF.combatOwned) return;   // an optional systems layer (gta/onfoot-bridge.js) owns weapons + firing
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

  // let an optional systems layer (police) claim the shot first if a cop is
  // closer than the pedestrian, so a single bullet hits exactly one target.
  const copClaimed = OF.onFire ? OF.onFire(best ? bestT : MAX_RANGE) === true : false;
  if (best && !copClaimed) killPed(best);
  startleNearby();
  updateHud();
}

function killPed(p) {
  p.dead = true; p.state = 'dead'; p.t = 0;
  p.fall = (Math.random() < 0.5 ? 1 : -1);             // tip direction
  for (const m of p.mats) { m.transparent = true; }
  kills++;
  if (OF.onKill) OF.onKill(p);
  updateHud();
}

// ============================================================
// ENTER / EXIT — swap the whole view to the on-foot canvas
// ============================================================
let saved = null;
// ---- loading screen --------------------------------------------------------
// Building the scene + compiling shaders + uploading the procedural textures is
// heavy and used to stutter the first second of play. We show this overlay, do
// all that work plus a GPU warm-up behind it, and only start the loop once it's
// ready — so gameplay begins smooth.
let loadingEl = null, entering = false;
function showLoading() {
  const frame = document.getElementById('frame') || document.body;
  if (!loadingEl) {
    loadingEl = document.createElement('div');
    loadingEl.id = 'foot-loading';
    loadingEl.style.cssText = 'position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:radial-gradient(circle at 50% 38%,#14233a,#070f1c 78%);color:#eaf2ff;font-family:system-ui,Segoe UI,Roboto,sans-serif;transition:opacity .4s ease';
    loadingEl.innerHTML =
      '<div style="font-size:12px;letter-spacing:4px;color:#7fa8d8">WEEKEND ROAD TRIP</div>' +
      '<div style="font-size:clamp(26px,5vw,46px);font-weight:800;letter-spacing:2px">LOADING…</div>' +
      '<div style="width:min(60%,260px);height:6px;border-radius:3px;background:#1b2a42;overflow:hidden"><i id="foot-loading-bar" style="display:block;height:100%;width:15%;background:linear-gradient(90deg,#4f8cff,#7ee2b8);transition:width .35s ease"></i></div>' +
      '<div id="foot-loading-label" style="font-size:13px;color:#9fb6d6">Preparing the city…</div>';
    frame.appendChild(loadingEl);
  }
  loadingEl.style.display = 'flex';
  loadingEl.style.opacity = '1';
}
function setLoading(label, pct) {
  if (!loadingEl) return;
  if (label) { const l = loadingEl.querySelector('#foot-loading-label'); if (l) l.textContent = label; }
  if (pct != null) { const b = loadingEl.querySelector('#foot-loading-bar'); if (b) b.style.width = pct + '%'; }
}
function hideLoading() {
  if (!loadingEl) return;
  const el = loadingEl;
  el.style.opacity = '0';
  setTimeout(() => { el.style.display = 'none'; }, 430);
}

function enter() {
  if (OF.active || entering) return;
  entering = true;
  showLoading();
  setLoading('Preparing the city…', 15);
  // let the overlay paint, then load character art (async) BEFORE the town build
  // so people spawn as rigged models; fully optional, falls back to procedural.
  requestAnimationFrame(() => requestAnimationFrame(() => preloadActorArt(enterBuild)));
}

// Dynamic-import the optional rigged-character module + load its model, then
// continue to the build. If anything fails, buildPerson uses procedural people.
function preloadActorArt(next) {
  if (OF._actorTried) { next(); return; }
  OF._actorTried = true;
  setLoading('Loading characters…', 28);
  import('./gta/onfoot-actors.js')
    .then((mod) => { OF._actorMod = mod; return mod.preloadActors(); })
    .then((ok) => { if (ok && OF._actorMod) OF._makeActor = OF._actorMod.makeActor; })
    .catch((e) => { console.warn('[ONFOOT] character art unavailable; procedural people', e); })
    .finally(() => { try { next(); } catch (e) { console.error('[ONFOOT] build failed', e); entering = false; hideLoading(); } });
}

function enterBuild() {
  try {
    setLoading('Building the town…', 40);
    if (!ensureInit()) { entering = false; hideLoading(); return; }
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
    mode = 'foot'; playerVehicle = null; _camInit = false;
    if (player.mesh) player.mesh.visible = true;
    for (const v of vehicles) { v.occupied = false; v.speed = 0; v.mesh.rotation.z = 0; }
    player.pos.set(2.4, 0, 6); player.vy = 0; player.grounded = true;
    player.ammo = AMMO_MAX; player.reloadT = 0; player.fireT = 0;
    yaw = Math.PI; pitch = -0.1; recoil = 0; kills = 0;
    keys.clear();
    showToast('You step out of the convertible. The town is yours.<br><b>Click</b> to look around &middot; <b>WASD</b> walk &middot; <b>Click</b> shoot &middot; <b>E</b> to steal any car');
    updateHud();

    setLoading('Spinning up the city systems…', 60);
    if (OF.onEnter) OF.onEnter();    // boot the optional systems layer before the first frame
    // wait for the layer's async pipeline (textures/lighting/post-FX) to settle,
    // then warm the GPU, so the first real frames don't stutter.
    waitForLayerThenWarm(0);
  } catch (e) {
    console.error('[ONFOOT] enter failed; staying in the base game', e);
    entering = false; hideLoading(); exit();
  }
}

// Hold the loading screen until the optional systems layer signals its async
// setup is done (OF.layerReady), then precompile shaders + prime a few frames so
// play starts smooth. Falls through after ~4s if nothing ever signals.
function waitForLayerThenWarm(tries) {
  if (OF.layerReady === false && tries < 240) {
    requestAnimationFrame(() => waitForLayerThenWarm(tries + 1));
    return;
  }
  setLoading('Warming up…', 85);
  try { resizeIfNeeded(); } catch (e) {}
  try { renderer.compile(scene, camera); } catch (e) {}     // precompile every material's shader + upload textures
  for (let i = 0; i < 3; i++) {                             // prime the post-FX composer (AA/AO/bloom) too
    try { if (OF.renderHook) OF.renderHook(0.016); else renderer.render(scene, camera); } catch (e) {}
  }
  setLoading('Ready', 100);
  hideLoading();
  entering = false;
  lastT = 0;
  rafId = requestAnimationFrame(loop);
}

function exit() {
  if (OF.active && OF.onExit) OF.onExit();   // tear down the optional systems layer
  OF.active = false;
  entering = false;
  hideLoading();
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
    if (OF.renderHook) OF.renderHook(dt);   // optional post-processing pipeline (gta realism layer)
    else renderer.render(scene, camera);
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

  if (OF.onTick) OF.onTick(dt);   // optional systems layer (gta/onfoot-bridge.js)
}

function updateOnFoot(dt) {
  // keyboard turn fallback — Q turns left, E turns right; works with or without pointer lock
  if (keys.has('KeyQ')) yaw += TURN_RATE * dt;
  if (keys.has('KeyE')) yaw -= TURN_RATE * dt;
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
  // smooth acceleration/deceleration toward the desired velocity (momentum -> feel)
  if (moving) { mx /= ml; mz /= ml; }
  const _tvx = (moving ? mx : 0) * speed, _tvz = (moving ? mz : 0) * speed;   // target velocity
  const _ak = 1 - Math.exp(-dt / 0.11);                                       // accel/decel time-constant (s)
  player._vx = (player._vx || 0) + (_tvx - (player._vx || 0)) * _ak;
  player._vz = (player._vz || 0) + (_tvz - (player._vz || 0)) * _ak;
  const _vmag = Math.hypot(player._vx, player._vz);
  if (_vmag > 0.02) moveAndCollide(player.pos, player._vx * dt, player._vz * dt, PLAYER_R);

  // gravity / jump / ground
  player.vy -= GRAV * dt;
  player.pos.y += player.vy * dt;
  if (player.pos.y <= 0) { player.pos.y = 0; player.vy = 0; player.grounded = true; }

  resolveCollision(player.pos, PLAYER_R);

  // body faces camera yaw when aiming (locked), else faces movement direction
  const targetFacing = yaw;   // body faces the aim/view direction; movement stays strafe-relative (tighter TPS feel)
  player.facing = lerpAngle(player.facing, targetFacing, 0.35);
  player.mesh.position.copy(player.pos);
  player.mesh.rotation.y = player.facing;
  animateWalk(player.mesh, _vmag > 0.3, dt, _vmag);   // animation driven by ACTUAL speed (so momentum reads)

  // reload / fire timers
  if (player.reloadT > 0) { player.reloadT -= dt; if (player.reloadT <= 0) { player.ammo = AMMO_MAX; updateHud(); } }
  if (player.fireT > 0) player.fireT -= dt;

  // --- camera: damped third-person orbit behind the player ---
  // Look direction stays LIVE off the mouse (aim feels crisp); only the camera's
  // position eases toward its target, which is what reads as "smooth".
  const cpz = Math.cos(pitch);
  _dir.set(Math.sin(yaw) * cpz, Math.sin(pitch), Math.cos(yaw) * cpz);
  const head = _v.copy(player.pos).setY(EYE);
  // pull the camera in if its orbit point would sit inside a building (ease off walls, don't clip through)
  let camDist = CAM_DIST;
  for (let s = 0; s < 6; s++) {
    if (!insideBuilding(head.x - _dir.x * camDist, head.z - _dir.z * camDist, 0.4)) break;
    camDist -= 0.8; if (camDist < 1.2) { camDist = 1.2; break; }
  }
  const desiredCam = _v2.copy(head).addScaledVector(_dir, -camDist);
  desiredCam.y += 0.4 + recoil * 2;
  if (desiredCam.y < 0.6) desiredCam.y = 0.6;
  if (!_camInit) { _camPos.copy(desiredCam); _camInit = true; }        // seed on first frame / after mode change (no swoop)
  _camPos.lerp(desiredCam, camDamp(CAM.followTau, dt));
  camera.position.copy(_camPos);
  _curFov += (CAM.fovBase - _curFov) * camDamp(CAM.fovTau, dt);        // ease FOV back to base on foot
  if (Math.abs(camera.fov - _curFov) > 0.02) { camera.fov = _curFov; camera.updateProjectionMatrix(); }
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
  moveAndCollide(v.pos, fx * v.speed * dt, fz * v.speed * dt, CAR_RADIUS);
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

  // chase camera: smoothly trail behind the car; FOV widens with speed for a sense of velocity
  const target = _v.copy(v.pos); target.y += 1.3;
  const desired = _v2.set(v.pos.x - fx * CAR_CAM_DIST, CAR_CAM_HEIGHT, v.pos.z - fz * CAR_CAM_DIST);
  camera.position.lerp(desired, camDamp(CAM.driveTau, dt));
  if (camera.position.y < 1.2) camera.position.y = 1.2;
  const speedFrac = Math.min(1, Math.abs(v.speed) / CAR_MAX_SPEED);
  const wantFov = CAM.fovBase + (CAM.fovDrive - CAM.fovBase) * speedFrac;
  _curFov += (wantFov - _curFov) * camDamp(CAM.fovTau, dt);
  camera.fov = _curFov; camera.updateProjectionMatrix();
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
  if (OF.onJack) OF.onJack(v);
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
  _camInit = false;   // re-seed the on-foot camera cleanly (no swoop from the chase-cam position)
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

// walk animation: drive the rigged model's AnimationMixer when present, else the
// cheap procedural arm/leg swing.
function animateWalk(mesh, moving, dt, sp) {
  const u = mesh.userData;
  if (u.actor) {
    if (OF._actorMod) OF._actorMod.updateActor(u.actor, dt, { moving, running: (sp || 0) >= 5.0, dead: !!u.dead, pitch });
    return;
  }
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
  if (OF.onResize) OF.onResize(w, h);   // resize the optional post-processing composer
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
// Additive integration surface for an optional systems layer (gta/onfoot-bridge.js):
// read-only access to internals + optional hooks the bridge assigns. When no bridge
// is loaded, OF.onEnter/onTick/onFire/onKill/onJack/onExit are simply never set, so
// this changes nothing about the base on-foot mode. Placed here (after all module
// declarations) so direct field refs aren't in a temporal-dead-zone.
OF.internals = {
  THREE,
  get scene() { return scene; },
  get camera() { return camera; },
  get renderer() { return renderer; },
  get canvas() { return canvas; },
  player, keys, peds, vehicles, aabbs,
  get yaw() { return yaw; }, set yaw(v) { yaw = v; },
  get pitch() { return pitch; }, set pitch(v) { pitch = v; },
  get locked() { return locked; },
  get mode() { return mode; },
  get playerVehicle() { return playerVehicle; },
  bound: BOUND,
  resolveCollision, insideBuilding, spawnVehicle, nearestVehicle, enterVehicle, exitVehicle, killPed, startleNearby, justPressed,
};

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

// Title-screen entry: a visible "ENTER HEIST MODE" button (index.html #btn-heist)
// so first-time players can jump into the on-foot heist without finishing the
// drive or knowing the #gta link. The button carries no data-action, so game.js
// ignores it and this is the only handler.
{
  const heistBtn = document.getElementById('btn-heist');
  if (heistBtn) heistBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    try { enter(); } catch (err) { console.error('[ONFOOT] heist-button enter failed', err); }
  });
}
