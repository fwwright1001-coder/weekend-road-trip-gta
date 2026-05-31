// ============================================================
// gta/physics.js — dynamic car-vs-building impact response (Lane D headline).
// ------------------------------------------------------------
// The host (onfoot3d.js updateDriving) already integrates the car's motion and
// runs moveAndCollide(), which keeps the car OUT of building AABBs. What it used
// to do on a wall hit was a flat `speed *= 0.25` — a soft dead-stop. This module
// replaces that with a GTA-style momentum impact: bleed/redirect velocity by how
// head-on the hit was, bounce a hard head-on off the wall (restitution), shove a
// little knockback along the surface normal, kick a transient nose-pitch JOLT,
// accumulate CRUMPLE damage, and emit feedback events (`shake` + `fx:impact` +
// `fx:crash`) so Lane B's fx layer reacts with debris/dust and the screen shakes.
//
// It is DECOUPLED from the collider geometry: it reads only the *result* of the
// host move (intended-vs-actual distance + the push-out vector resolveCollision
// produced), so any geometry-matched AABBs from Lane C work unchanged.
//
// Wiring: registered as a GTA system (so it has ctx + lifecycle); the bridge
// exposes its api as OF.carImpact, which updateDriving calls at the wall-hit line.
// Pure math + GTA.bus only — fully headless-safe (no DOM / WebGL), so the node
// smoke suite exercises it.
// ============================================================
import { GTA } from './core.js';

// --- tunables (units match onfoot3d: speed in u/s, CAR_MAX_SPEED ≈ 36) -------
const TUNE = {
  refSpeed: 26,          // speed at which a head-on hit reads as a "full" crash (sev→1)
  minSeverity: 0.06,     // below this it's a scrape: slide, don't "crash"
  glanceBleed: 0.10,     // fraction of speed lost on a pure glance (sliding along a wall)
  headOnBleed: 0.82,     // fraction of speed lost on a fully head-on hit
  restitution: 0.20,     // hard head-on bounces back this fraction of speed (recoil)
  bounceMinSev: 0.45,    // only bounce above this severity (else just bleed)
  knockback: 0.30,       // extra metres shoved out along the normal at full severity
  joltMax: 0.26,         // peak nose-pitch (radians) the body jolts on a max impact
  shakeScale: 1.1,       // screen-shake amount per unit severity
};

// vehicles we've jolted recently, so update() can decay their crashJolt to rest.
const _jolted = new Set();

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

// Optional height-awareness (Lane C hands a building's height via info.buildingHeight,
// ~4.4 houses .. ~27 downtown towers): a taller, more massive structure crashes a
// touch harder — scales FEEDBACK only (shake/jolt/crumple/dust), never the speed
// response, so handling stays predictable. Returns 1 when no height is provided.
function heightScale(h) { return (typeof h === 'number' && h > 0) ? clamp(0.85 + h / 55, 0.85, 1.3) : 1; }

// The impact handler. `v` is the host vehicle ({pos, heading, speed, mesh, ...});
// `info` is what updateDriving measured this frame:
//   { speed, dt, dirx, dirz, intended, moved, pushX, pushZ }
//     intended  = |speed| * dt              (distance the car wanted to travel)
//     moved     = actual distance travelled (after moveAndCollide)
//     pushX/Z   = v.pos - intendedPos       (the out-of-wall shove ≈ +normal)
// Mutates v (speed, crashJolt, damage, pos knockback) and emits feedback events.
// Returns the impact severity in [0,1] (0 = no real impact).
function carImpact(v, info) {
  if (!v || !info) return 0;
  const dt = info.dt > 0 ? info.dt : 1 / 60;
  const speed = info.speed != null ? info.speed : (v.speed || 0);
  const aspeed = Math.abs(speed);
  const intended = info.intended || 0;
  const moved = info.moved || 0;
  const blocked = Math.max(0, intended - moved);
  // headOn: 0 (slid right past / glance) .. 1 (travel fully stopped this frame)
  const headOn = intended > 1e-5 ? clamp01(blocked / intended) : 0;
  // severity weights head-on-ness by how fast we were going
  const sev = clamp01(headOn * clamp01(aspeed / TUNE.refSpeed));

  if (sev < TUNE.minSeverity) {
    // a gentle scrape — shed a little speed and keep sliding, no crash event
    v.speed = speed * (1 - TUNE.glanceBleed * headOn);
    return sev;
  }

  // --- momentum response: bleed most forward speed head-on, little on a glance;
  //     a hard head-on recoils off the wall instead of sticking ---------------
  const bleed = TUNE.glanceBleed + (TUNE.headOnBleed - TUNE.glanceBleed) * headOn;
  let ns = speed * (1 - bleed);
  if (sev >= TUNE.bounceMinSev) ns = -speed * TUNE.restitution;   // bounce back
  v.speed = ns;

  // --- knockback: shove the car a touch further out along the surface normal --
  let nx = 0, nz = 0;
  const nlen = Math.hypot(info.pushX || 0, info.pushZ || 0);
  if (nlen > 1e-4) {
    nx = info.pushX / nlen; nz = info.pushZ / nlen;
    if (v.pos) { v.pos.x += nx * TUNE.knockback * sev; v.pos.z += nz * TUNE.knockback * sev; }
  }

  // --- body jolt (nose pitch) + crumple damage (scaled by building mass) ------
  const hk = heightScale(info.buildingHeight);
  v.crashJolt = Math.min(TUNE.joltMax, (v.crashJolt || 0) + TUNE.joltMax * sev * hk);
  v.damage = clamp01((v.damage || 0) + 0.6 * sev * hk);
  _jolted.add(v);

  // --- feedback events (bus no-ops with no listener → headless-safe) ----------
  const pos = v.pos ? { x: v.pos.x, y: 0.6, z: v.pos.z } : (info.pos || { x: 0, y: 0.6, z: 0 });
  const normal = nlen > 1e-4 ? { x: nx, y: 0, z: nz } : null;
  GTA.bus.emit('shake', { amount: TUNE.shakeScale * sev * hk });
  GTA.bus.emit('fx:impact', { pos, kind: 'metal', normal, scale: (1 + 2 * sev) * hk });   // B's fx → debris/sparks
  GTA.bus.emit('fx:crash', { pos, severity: sev, speed, normal, damage: v.damage,         // richer crash (dust/crumple)
    buildingHeight: info.buildingHeight, zone: info.zone });
  return sev;
}

// Per-frame: relax the transient nose-pitch jolt back to rest. The host reads
// v.crashJolt when posing the car mesh; we just decay it here so any vehicle
// settles even if the player drives away from it.
function update(dt) {
  if (!_jolted.size) return;
  const k = Math.max(0, 1 - 9 * dt);   // ~exponential settle
  for (const v of _jolted) {
    v.crashJolt = (v.crashJolt || 0) * k;
    if (!v.crashJolt || Math.abs(v.crashJolt) < 1e-3) { v.crashJolt = 0; _jolted.delete(v); }
  }
}

function reset() { _jolted.clear(); }

// self-register as a GTA system (imported once by the bridge). api.carImpact is
// what the bridge exposes to the host as OF.carImpact.
const system = {
  name: 'physics',
  init() {},
  update,
  reset,
  api: { carImpact, tune: TUNE },
};
GTA.register(system);

export { carImpact, system };
export default system;
