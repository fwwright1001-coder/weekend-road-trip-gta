// ============================================================
// gta/onfoot-actors.js — pedestrian character art for the on-foot mode.
// ------------------------------------------------------------
// ROUND 3: the only vendored rig (Soldier.glb) is the armoured Mixamo *Vanguard*
// (a sci-fi SOLDIER — helmet/visor/armour as geometry, no textures), so per the
// creator note "the soldier look is gone", makeActor() now returns an ORIGINAL
// low-poly CIVILIAN (varied skin/hair/clothing + accessories) built procedurally
// here. It honours the host's animateWalk contract: a THREE.Group, feet at origin,
// ~1.8 tall, facing +Z, with userData.legL/legR/armL/armR (limb groups the host
// swings about X). The player is NOT routed here — buildPerson only calls makeActor
// for UNARMED peds; makeActor returns null for armed so buildPerson keeps the
// gangster. So this file no longer produces a skeleton/mixer at runtime.
//
// The Soldier model loader (preloadActors) + the armed GUN/AIM rig below
// (AIM/_applyAim/_armed/_wireBus/updateActor's armed branch) are RETAINED but
// currently UNUSED at runtime — kept only so the offline aim-check/actor-check
// tools still validate the asset, and so a future skeletal-civilian asset could
// re-enable the rigged path. window.ONFOOT_AIM still tunes the (offline) rig.
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

// ============================================================
// CIVILIAN RESKIN (round 3) — the vendored rig is the Mixamo *Vanguard*: an
// armoured sci-fi SOLDIER (helmet + visor + armour plates, all geometry, no
// textures), so no amount of tinting makes a pedestrian read as a civilian. Per
// the creator note ("the soldier look is gone"), pedestrians are now ORIGINAL
// low-poly civilians built here — varied skin/hair/clothing, animated via the
// host's procedural arm/leg swing (userData.legL/legR/armL/armR). The player is
// unaffected: buildPerson only calls makeActor for UNARMED peds; the armed player
// stays the procedural gangster buildPerson owns.
// ============================================================
const _civSkin = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0xa9764a, 0xd9a679];
const _civHair = [0x2a1a0f, 0x4a2f1a, 0x6b4a2e, 0x141414, 0x8a7a5a, 0x9a3a2a, 0xb8b8b8, 0x33291c];
const _civShirt = [0xc94f4f, 0x4f7fc9, 0x4fae6b, 0xc9a24f, 0x8a4fc9, 0x3a8a8a, 0xb0683a, 0x4a4f57, 0xc97fae, 0x4fbfb0];
const _civPants = [0x2b2b33, 0x3a3a45, 0x4a3b2a, 0x2f4150, 0x55504a, 0x3a2f2a, 0x6a6a72];
function _buildCivilian(opts) {
  const g = new THREE.Group();
  const sv = opts.scaleVar || 1;
  const skin = _pickHex(_civSkin), hair = _pickHex(_civHair);
  const shirt = opts.colorize != null ? opts.colorize : _pickHex(_civShirt);
  const pants = _pickHex(_civPants), shoeCol = 0x222227;
  const build = 0.9 + Math.random() * 0.32;
  const mk = (geo, col, rough) => { const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: col, roughness: rough == null ? 0.85 : rough })); m.castShadow = true; m.receiveShadow = true; return m; };
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

  // legs / arms are GROUPS pivoting at the hip / shoulder, so the host's
  // animateWalk (which rotates userData.legL/legR/armL/armR about X) swings them.
  const mkLeg = (sign) => {
    const grp = new THREE.Group(); grp.position.set(sign * 0.12, 0.92, 0);
    const leg = mk(box(0.18 * build, 0.84, 0.2 * build), pants); leg.position.y = -0.42; grp.add(leg);
    const shoe = mk(box(0.19, 0.12, 0.32), shoeCol, 0.6); shoe.position.set(0, -0.86, 0.06); grp.add(shoe);
    return grp;
  };
  const mkArm = (sign) => {
    const grp = new THREE.Group(); grp.position.set(sign * 0.3 * build, 1.5, 0);
    const sleeve = Math.random() < 0.5 ? shirt : skin;     // long or short sleeves
    const arm = mk(box(0.12 * build, 0.56, 0.13 * build), sleeve); arm.position.y = -0.28; grp.add(arm);
    return grp;
  };
  const legL = mkLeg(-1), legR = mkLeg(1), armL = mkArm(-1), armR = mkArm(1);

  const pelvis = mk(box(0.42 * build, 0.26, 0.26 * build), pants); pelvis.position.y = 0.88;
  const torso = mk(box(0.46 * build, 0.62, 0.28 * build), shirt); torso.position.y = 1.21;
  // a slim collar/neck so the head doesn't float
  const neck = mk(box(0.12, 0.1, 0.12), skin); neck.position.y = 1.55;
  const head = mk(new THREE.SphereGeometry(0.135, 12, 10), skin); head.scale.set(0.95, 1.06, 1.0); head.position.y = 1.69;
  const hairCap = mk(new THREE.SphereGeometry(0.143, 12, 10), hair, 0.9); hairCap.scale.set(1.02, 0.82, 1.06); hairCap.position.set(0, 1.73, -0.01);

  g.add(legL, legR, pelvis, torso, armL, armR, neck, head, hairCap);
  g.userData.legL = legL; g.userData.legR = legR; g.userData.armL = armL; g.userData.armR = armR;
  // hats / backpacks / vests / bags for extra crowd variety (over the hair)
  try { _addCivAccessories(g, sv); } catch (e) { /* accessories optional */ }
  g.scale.setScalar(sv);
  return g;
}

// Build one pedestrian. Returns a Group (feet at origin, ~1.8 tall, facing +Z)
// with userData.legL/legR/armL/armR (animated by the host's procedural swing).
//   opts: { colorize?: hex (shirt tint), armed?: bool, scaleVar?: number }
// The player (armed) is never routed here — return null so buildPerson keeps owning it.
export function makeActor(opts = {}) {
  if (opts.armed) return null;
  try { return _buildCivilian(opts); } catch (e) { return null; }
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
