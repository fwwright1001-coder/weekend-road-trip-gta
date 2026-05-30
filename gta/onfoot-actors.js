// ============================================================
// gta/onfoot-actors.js — rigged, animated character art for the on-foot mode.
// ------------------------------------------------------------
// Loads a single CC0 humanoid (RobotExpressive.glb — Idle/Walking/Running/Jump/
// Death/Punch) once, then clones it per character (SkeletonUtils, so each clone
// gets its own skeleton + AnimationMixer). onfoot3d's buildPerson() uses this
// when it's ready and falls back to its procedural box-person if it isn't, so a
// missing/failed asset can never break the game.
//
// Contract for the host: makeActor() returns a THREE.Group whose origin is at
// the FEET, ~1.8 units tall, facing +Z — the same contract as buildPerson — with
// g.userData.actor = the animation handle. Drive it each frame with
// updateActor(g.userData.actor, dt, { moving, running, dead }).
// ============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const MODEL_URL = new URL('../assets/models/RobotExpressive.glb', import.meta.url).href;
const TARGET_HEIGHT = 1.8;          // normalize the model to ~human height (matches the box-person)
const FACING = 0;                   // model front is +Z (matches buildPerson). If people face backward in-game, set Math.PI.
const CLIPS = { idle: 'Idle', walk: 'Walking', run: 'Running', jump: 'Jump', death: 'Death', punch: 'Punch' };

let _src = null;        // { scene, animations }
let _scale = 1;         // normalization scale
let _footY = 0;         // y offset so feet rest at 0 after scaling
let _ready = false, _failed = false, _loading = null;

export function actorsReady() { return _ready; }

// Load + normalize the model once. Resolves true on success, false on failure
// (never rejects — the caller just falls back to procedural people).
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
        _footY = -box.min.y * _scale;     // lift so the lowest point sits at y=0
        _ready = true;
        resolve(true);
      } catch (e) { console.warn('[actors] normalize failed; procedural fallback', e); _failed = true; resolve(false); }
    }, undefined, (err) => { console.warn('[actors] model load failed; procedural fallback', err); _failed = true; resolve(false); });
  });
  return _loading;
}

// Build one character. Returns a Group (feet at origin, ~1.8 tall, facing +Z)
// with userData.actor, or null if the model isn't ready (caller falls back).
//   opts: { colorize?: hex (lerp materials toward it), armed?: bool, scaleVar?: number }
export function makeActor(opts = {}) {
  if (!_ready || !_src) return null;
  let inner;
  try { inner = cloneSkinned(_src.scene); } catch (e) { return null; }

  const s = _scale * (opts.scaleVar || 1);
  inner.scale.setScalar(s);
  inner.position.y = _footY * (opts.scaleVar || 1);
  inner.rotation.y = FACING;

  inner.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    o.frustumCulled = false;                       // skinned bounds can mis-cull; keep visible
    if (o.material) {
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
      if (opts.colorize != null) {
        const tint = new THREE.Color(opts.colorize);
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m.color) m.color.lerp(tint, 0.55);
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
  const actor = { mixer, actions, current: null, dead: false };
  g.userData.actor = actor;
  if (actions.idle) { actions.idle.play(); actor.current = 'idle'; }

  if (opts.armed) {
    // approximate muzzle (right hand, forward) + a tiny gun so the player reads as armed
    const muzzle = new THREE.Object3D(); muzzle.position.set(0.24, 1.2, 0.55); g.add(muzzle);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x23262b, metalness: 0.6, roughness: 0.4 }));
    gun.position.copy(muzzle.position); gun.castShadow = true; g.add(gun);
    g.userData.muzzle = muzzle; g.userData.gun = gun;
  }
  return g;
}

// Crossfade to the clip the movement state implies, then advance the mixer.
export function updateActor(actor, dt, st) {
  if (!actor || !actor.mixer) return;
  if (!actor.dead) {
    let want = 'idle';
    if (st && st.dead) want = 'death';
    else if (st && st.running) want = 'run';
    else if (st && st.moving) want = 'walk';
    if (want === 'death') actor.dead = true;
    _setState(actor, want);
  }
  actor.mixer.update(dt || 0);
}

function _setState(actor, name) {
  if (actor.current === name) return;
  const next = actor.actions[name];
  if (!next) return;                                  // missing clip -> keep current
  const prev = actor.current && actor.actions[actor.current];
  if (name === 'death') { next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true; }
  next.reset().fadeIn(0.2).play();
  if (prev && prev !== next) prev.fadeOut(0.2);
  actor.current = name;
}

export default { preloadActors, actorsReady, makeActor, updateActor };
