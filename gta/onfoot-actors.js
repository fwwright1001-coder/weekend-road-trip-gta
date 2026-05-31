// ============================================================
// gta/onfoot-actors.js — rigged, animated character art for the on-foot mode.
// ------------------------------------------------------------
// Loads a single rigged humanoid (Soldier.glb — Idle/Walk/Run) once, then clones
// it per character (SkeletonUtils, so each clone gets its own skeleton +
// AnimationMixer). onfoot3d's buildPerson() uses this when ready and falls back
// to its procedural box-person if not, so a missing asset can never crash.
//
// ARMED actors (the player) also get a procedural GUN/AIM RIG: the gun is parented
// to the right-hand bone, the right arm/forearm are posed into a weapon-ready
// stance (with aim-pitch elevation), and each shot kicks a recoil that decays.
// The bone angles are tunable LIVE via window.ONFOOT_AIM (dial them in-browser).
//
// Contract: makeActor() returns a THREE.Group (feet at origin, ~1.8 tall, facing
// +Z) with userData.actor. Drive it with updateActor(actor, dt, { moving, running,
// dead, pitch }). Recoil auto-fires off the 'gunfire' crime event.
// ============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { GTA } from './core.js';

const MODEL_URL = new URL('../assets/models/Soldier.glb', import.meta.url).href;
const TARGET_HEIGHT = 1.8;          // normalize the model to ~human height (matches the box-person)
const FACING = Math.PI;             // Soldier.glb's rig front is -Z, so rotate inner 180° to face +Z (travel/
                                    // camera convention). Per Lane A's REQUESTS.md finding (heel→toe points -Z
                                    // at rotation.y=0); also aligns the actor-space accessories (brim front / pack back).
const CLIPS = { idle: 'Idle', walk: 'Walk', run: 'Run' };   // clips this model has; missing ones are skipped

// Procedural aim/gun rig — LIVE-EDITABLE in the console via window.ONFOOT_AIM
// (e.g. `ONFOOT_AIM.armX = -1.0`). Angles are radians; the defaults are a best
// guess for the Mixamo rig — dial them in a browser until the gun points right.
const AIM = {
  enabled: true,
  gunScale: 1.0,               // scale the gun mesh if it loads too big/small in the hand
  gunPos: [0.02, 0.0, 0.06],   // gun offset inside the right-hand bone (bone-local)
  gunRot: [Math.PI / 2, 0, 0], // gun orientation in the hand (barrel forward)
  muzzleZ: 0.40,               // barrel tip distance from the gun origin
  armX: -1.15, armY: 0.15, armZ: 0.10,   // right-arm "weapon ready" pose
  foreX: -0.55, foreY: 0.0, foreZ: 0.0,  // right-forearm bend
  pitchArm: 0.55,              // how much look-pitch raises/lowers the aim
  recoilKickPos: 0.06,         // gun jerks back this far on a shot (local Z)
  recoilKickArm: 0.28,         // arm kicks up this much on a shot
  recoilDecay: 7,              // recoil falls off at this rate (per second)
  recoilAmount: 1.0,           // strength of each shot's kick (0..1)
  dump() { const o = {}; for (const k in AIM) if (typeof AIM[k] !== 'function') o[k] = AIM[k]; return o; },
};
if (typeof window !== 'undefined') window.ONFOOT_AIM = AIM;

let _src = null;        // { scene, animations }
let _scale = 1;         // normalization scale
let _footY = 0;         // y offset so feet rest at 0 after scaling
let _ready = false, _failed = false, _loading = null;
const _armed = [];      // armed actors (the player) — recoil kicked on player gunfire
let _busWired = false;

function _wireBus() {
  if (_busWired) return; _busWired = true;
  try {
    // combat.js emits a 'gunfire' crime on each player shot — kick the gun recoil
    GTA.bus.on('crime', (e) => {
      if (e && e.kind === 'gunfire') for (const a of _armed) a.recoil = Math.min(1, a.recoil + AIM.recoilAmount);
    });
  } catch (e) { /* no bus yet -> recoil simply won't kick */ }
}

export function actorsReady() { return _ready; }

// Load + normalize the model once. Resolves true on success, false on failure.
export function preloadActors() {
  if (_ready || _failed) return Promise.resolve(_ready);
  if (_loading) return _loading;
  _loading = new Promise((resolve) => {
    let loader;
    try { loader = new GLTFLoader(); } catch (e) { _failed = true; return resolve(false); }
    loader.load(MODEL_URL, (gltf) => {
      try {
        _src = { scene: gltf.scene, animations: gltf.animations || [] };
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const h = Math.max(0.001, box.max.y - box.min.y);
        _scale = TARGET_HEIGHT / h;
        _footY = -box.min.y * _scale;
        _ready = true;
        resolve(true);
      } catch (e) { console.warn('[actors] normalize failed; procedural fallback', e); _failed = true; resolve(false); }
    }, undefined, (err) => { console.warn('[actors] model load failed; procedural fallback', err); _failed = true; resolve(false); });
  });
  return _loading;
}

// ---- crowd variety helpers -------------------------------------------------
// All clones come off ONE soldier model, so without help every pedestrian looks
// identical. We can't touch the rig (Lane A owns buildPerson), but makeActor is
// ours — so we vary tint strength, desync the walk cycle, and bolt small original
// accessories (caps, hard hats, beanies, backpacks, hi-vis vests, handbags) onto
// the actor group. Accessories live in ACTOR space (feet at 0, ~1.8 tall) — not on
// bones — so their size/placement is predictable regardless of the model's raw
// scale; heights are scaled by scaleVar so they ride the head whatever the build.
const _pickHex = (a) => a[(Math.random() * a.length) | 0];
function _accMat(col, opts) {
  return new THREE.MeshStandardMaterial(Object.assign({ color: col, roughness: 0.75 }, opts || {}));
}
function _addCivAccessories(g, sv) {
  const y = (v) => v * sv;
  // headgear (one of, or none)
  const r = Math.random();
  if (r < 0.30) {                                   // baseball cap (dome + brim)
    const col = _pickHex([0xc0392b, 0x2c3e6b, 0x2d6a4f, 0x4a4a52, 0x8a5a2b, 0xb0832b]);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), _accMat(col, { roughness: 0.7 }));
    cap.scale.set(1.05, 0.82, 1.05); cap.position.y = y(1.78); cap.castShadow = true; g.add(cap);
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.02, 0.13), _accMat(col, { roughness: 0.7 }));
    brim.position.set(0, y(1.755), 0.12); brim.castShadow = true; g.add(brim);
  } else if (r < 0.44) {                            // hard hat (worker)
    const hat = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), _accMat(0xf2c33d, { roughness: 0.5 }));
    hat.scale.set(1.05, 0.78, 1.18); hat.position.y = y(1.79); hat.castShadow = true; g.add(hat);
  } else if (r < 0.55) {                            // knit beanie
    const beanie = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), _accMat(_pickHex([0x333842, 0x6b3b3b, 0x2d4a5a, 0x554a2b]), { roughness: 0.95 }));
    beanie.position.y = y(1.74); beanie.castShadow = true; g.add(beanie);
  }
  // backpack on the back
  if (Math.random() < 0.26) {
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.34, 0.16), _accMat(_pickHex([0x2c3e6b, 0x3d6b2f, 0x6b2f3d, 0x33363c]), { roughness: 0.85 }));
    pack.position.set(0, y(1.26), -0.17); pack.castShadow = true; g.add(pack);
  }
  // hi-vis safety vest (faintly emissive so it pops at dusk)
  if (Math.random() < 0.14) {
    const vest = new THREE.Mesh(new THREE.BoxGeometry(0.33, 0.36, 0.24), _accMat(0xeaff3a, { emissive: 0x9aa800, emissiveIntensity: 0.25, roughness: 0.6 }));
    vest.position.y = y(1.18); vest.castShadow = true; g.add(vest);
  }
  // handbag at one hip
  if (Math.random() < 0.14) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const bag = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 0.08), _accMat(_pickHex([0x5a3a2b, 0x2b2b33, 0x7a3a55]), { roughness: 0.7 }));
    bag.position.set(side * 0.24, y(1.0), 0.04); bag.castShadow = true; g.add(bag);
  }
}

// Build one character. Returns a Group (feet at origin, ~1.8 tall, facing +Z)
// with userData.actor, or null if the model isn't ready (caller falls back).
//   opts: { colorize?: hex, armed?: bool, scaleVar?: number }
export function makeActor(opts = {}) {
  if (!_ready || !_src) return null;
  let inner;
  try { inner = cloneSkinned(_src.scene); } catch (e) { return null; }

  const s = _scale * (opts.scaleVar || 1);
  inner.scale.setScalar(s);
  inner.position.y = _footY * (opts.scaleVar || 1);
  inner.rotation.y = FACING;

  // per-actor tint + strength (hoisted so every material on one person agrees,
  // and the crowd spreads across light/strong tints rather than all looking the same)
  const tint = opts.colorize != null ? new THREE.Color(opts.colorize) : null;
  const tintAmt = 0.42 + Math.random() * 0.32;
  inner.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    o.frustumCulled = false;
    if (o.material) {
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
      if (tint) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m.color) m.color.lerp(tint, tintAmt);
      }
    }
  });

  const g = new THREE.Group();
  g.add(inner);

  const mixer = new THREE.AnimationMixer(inner);
  const actions = {};
  for (const key in CLIPS) {
    const clip = THREE.AnimationClip.findByName(_src.animations, CLIPS[key]);
    if (clip) actions[key] = mixer.clipAction(clip);
  }
  const actor = { mixer, actions, current: null, dead: false, armed: false, recoil: 0, bones: null, gun: null, gunRestZ: 0 };
  g.userData.actor = actor;
  if (actions.idle) { actions.idle.play(); actor.current = 'idle'; }
  // crowd believability: vary each walker's gait speed slightly and desync the
  // cycle so a group of peds doesn't march in perfect lockstep.
  mixer.timeScale = 0.86 + Math.random() * 0.3;
  try { mixer.update(Math.random() * 1.6); } catch (e) { /* harmless if no clip */ }

  if (!opts.armed) {
    try { _addCivAccessories(g, opts.scaleVar || 1); } catch (e) { /* accessories optional */ }
  }

  if (opts.armed) {
    _wireBus();
    // find the bones the aim rig poses
    const bones = {};
    inner.traverse((o) => {
      if (!o.isBone) return;
      switch (o.name) {
        case 'mixamorigRightHand': bones.hand = o; break;
        case 'mixamorigRightForeArm': bones.foreArm = o; break;
        case 'mixamorigRightArm': bones.arm = o; break;
        case 'mixamorigSpine2': bones.spine = o; break;
      }
    });
    const gun = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.12, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x23262b, metalness: 0.6, roughness: 0.4 }));
    gun.castShadow = true;
    gun.scale.setScalar(AIM.gunScale);
    const muzzle = new THREE.Object3D(); gun.add(muzzle); muzzle.position.set(0, 0, AIM.muzzleZ);
    if (bones.hand) {
      bones.hand.add(gun);                                   // gun follows the hand through animation
      gun.position.set(AIM.gunPos[0], AIM.gunPos[1], AIM.gunPos[2]);
      gun.rotation.set(AIM.gunRot[0], AIM.gunRot[1], AIM.gunRot[2]);
      actor.bones = bones; actor.gun = gun; actor.gunRestZ = gun.position.z;
      _armed.push(actor);
    } else {
      gun.position.set(0.24, 1.2, 0.55); g.add(gun);         // no skeleton -> bolt to the group (fallback)
    }
    actor.armed = true;
    g.userData.muzzle = muzzle; g.userData.gun = gun;
  }
  return g;
}

// Crossfade to the clip the movement state implies, advance the mixer, then apply
// the procedural aim pose (armed only) AFTER the mixer so it overrides the arm.
export function updateActor(actor, dt, st) {
  if (!actor || !actor.mixer) return;
  if (!actor.dead) {
    let want = 'idle';
    if (st && st.dead && actor.actions.death) want = 'death';
    else if (st && st.running) want = 'run';
    else if (st && st.moving) want = 'walk';
    if (want === 'death') actor.dead = true;
    _setState(actor, want);
  }
  actor.mixer.update(dt || 0);
  if (actor.armed) {
    if (actor.recoil > 0) actor.recoil = Math.max(0, actor.recoil - (dt || 0) * AIM.recoilDecay);
    if (actor.bones && AIM.enabled) _applyAim(actor, (st && st.pitch) || 0);
  }
}

// procedural weapon-ready pose + aim-pitch + recoil kick (overrides the right arm)
function _applyAim(actor, pitch) {
  const b = actor.bones, r = actor.recoil;
  if (b.arm) b.arm.rotation.set(AIM.armX - pitch * AIM.pitchArm - r * AIM.recoilKickArm, AIM.armY, AIM.armZ);
  if (b.foreArm) b.foreArm.rotation.set(AIM.foreX, AIM.foreY, AIM.foreZ);
  if (actor.gun) actor.gun.position.z = actor.gunRestZ - r * AIM.recoilKickPos;
}

function _setState(actor, name) {
  if (actor.current === name) return;
  const next = actor.actions[name];
  if (!next) return;
  const prev = actor.current && actor.actions[actor.current];
  if (name === 'death') { next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true; }
  next.reset().fadeIn(0.2).play();
  if (prev && prev !== next) prev.fadeOut(0.2);
  actor.current = name;
}

// manual recoil kick (also auto-fired off the 'gunfire' crime event)
export function kickRecoil(actor, amount) {
  if (actor && actor.armed) actor.recoil = Math.min(1, actor.recoil + (amount == null ? 1 : amount));
}

export default { preloadActors, actorsReady, makeActor, updateActor, kickRecoil };
