// ============================================================
// gta/tools/onfoot-sim.mjs — headless END-TO-END mission simulation.
// Boots the FULL integrated stack (onfoot-bridge + combat + police + heist +
// bank + world detail) against a stubbed host with a working event system and
// REAL three.js, then drives Smeaglodin through the whole heist:
//   navigate to the bank -> grab the goop from the vault -> jack a car ->
//   escape to the getaway marker -> WIN — while firing at cops along the way.
// Exits 0 if the mission is completed with no thrown frames / console.errors.
//   node gta/tools/onfoot-sim.mjs [seed] [verbose]
// ============================================================
const SEED = (parseInt(process.argv[2], 10) || 1) >>> 0;
const VERBOSE = process.argv[3] === 'v' || process.argv[3] === 'verbose';

const errors = [];
const realErr = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); if (VERBOSE) realErr('  [err]', ...a); };

const noop = () => {};
function ctx2d() {
  return new Proxy({}, { get(t, p) {
    if (p === 'canvas') return { width: 220, height: 220 };
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop: noop });
    if (p === 'measureText') return () => ({ width: 8 });
    if (p in t) return t[p];
    return typeof p === 'string' ? noop : undefined;
  }, set(t, p, v) { t[p] = v; return true; } });
}
function styleProxy() { return new Proxy({}, { get: (t, p) => (p === 'setProperty' || p === 'removeProperty') ? noop : t[p], set: (t, p, v) => { t[p] = v; return true; } }); }
function fakeEl(id) {
  const ch = [];
  return { id, width: 220, height: 220, clientWidth: 960, clientHeight: 540, textContent: '', innerHTML: '', style: styleProxy(), children: ch,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { const on = f === undefined ? !this._s.has(c) : f; on ? this._s.add(c) : this._s.delete(c); return on; }, contains(c) { return this._s.has(c); } },
    appendChild(c) { ch.push(c); return c; }, removeChild(c) { const i = ch.indexOf(c); if (i >= 0) ch.splice(i, 1); return c; },
    setAttribute: noop, getContext: () => ctx2d(), getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }), addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] };
}
const elCache = new Map();
const _lis = {};
globalThis.window = globalThis;
globalThis.document = { readyState: 'complete', pointerLockElement: null, body: fakeEl('body'),
  getElementById: (id) => { if (!elCache.has(id)) elCache.set(id, fakeEl(id)); return elCache.get(id); },
  createElement: (t) => fakeEl('c-' + t), addEventListener: noop, exitPointerLock: noop, querySelector: () => null };
globalThis.localStorage = (() => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })();
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = noop;
globalThis.addEventListener = (t, fn) => { (_lis[t] || (_lis[t] = [])).push(fn); };
globalThis.removeEventListener = noop;
globalThis.__dispatch = (t, ev) => { for (const fn of (_lis[t] || [])) { try { fn(ev); } catch (e) {} } };
globalThis.devicePixelRatio = 1;
globalThis.AudioContext = function () { return new Proxy({ currentTime: 0, sampleRate: 44100, destination: {} }, { get: () => noop }); };

const THREE = await import('three');

// ---------- seeded RNG ----------
function makeRng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const rng = makeRng(SEED);

// ---------- stub onfoot3d internals ----------
const aabbs = [];
for (let gx = -2; gx <= 2; gx++) for (let gz = -2; gz <= 2; gz++) {
  if (gx === 0 && (gz === 0 || gz === -1 || gz === -2)) continue;   // plaza + bank corridor (matches onfoot3d)
  const cx = gx * 24, cz = gz * 24;
  aabbs.push({ minX: cx - 5, maxX: cx + 5, minZ: cz - 5, maxZ: cz + 5 });
}
const BOUND = 58;
function insideBuilding(x, z, pad) { for (const a of aabbs) if (x > a.minX - pad && x < a.maxX + pad && z > a.minZ - pad && z < a.maxZ + pad) return a; return null; }
function resolveCollision(pos, pad) {
  for (const a of aabbs) if (pos.x > a.minX - pad && pos.x < a.maxX + pad && pos.z > a.minZ - pad && pos.z < a.maxZ + pad) {
    const dl = pos.x - (a.minX - pad), dr = (a.maxX + pad) - pos.x, db = pos.z - (a.minZ - pad), df = (a.maxZ + pad) - pos.z;
    const m = Math.min(dl, dr, db, df);
    if (m === dl) pos.x = a.minX - pad; else if (m === dr) pos.x = a.maxX + pad; else if (m === db) pos.z = a.minZ - pad; else pos.z = a.maxZ + pad;
  }
  pos.x = Math.max(-BOUND, Math.min(BOUND, pos.x)); pos.z = Math.max(-BOUND, Math.min(BOUND, pos.z));
}
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 1200);
const playerMesh = new THREE.Group(); playerMesh.userData.muzzle = new THREE.Object3D(); playerMesh.add(playerMesh.userData.muzzle);
const peds = [];
for (let i = 0; i < 16; i++) peds.push({ pos: new THREE.Vector3((rng() * 2 - 1) * 40, 0, (rng() * 2 - 1) * 40), dead: false, mats: [], mesh: new THREE.Group(), state: 'wander' });
const vehicles = [];
const carSpots = [[-1.2, 5.5], [12, 2], [-12, -4], [2, 13], [-12, 14], [12, -14], [0, -20]];
for (const [x, z] of carSpots) vehicles.push({ pos: new THREE.Vector3(x, 0, z), heading: 0, speed: 0, occupied: false, mesh: new THREE.Group(), wheels: [], steerPivots: [] });

const internals = {
  THREE, scene, camera, renderer: { render: noop, setSize: noop, setPixelRatio: noop, shadowMap: {}, domElement: fakeEl('gamefoot') }, canvas: fakeEl('gamefoot'),
  player: { pos: new THREE.Vector3(2.4, 0, 6), vy: 0, grounded: true, mesh: playerMesh, muzzle: playerMesh.userData.muzzle, ammo: 12, facing: 0 },
  keys: new Set(), yaw: Math.PI, pitch: -0.1, locked: true, mode: 'foot', playerVehicle: null, bound: BOUND, headless: true,
  peds, vehicles, aabbs, resolveCollision, insideBuilding,
  spawnVehicle: (x, z, h, c) => { const v = { pos: new THREE.Vector3(x, 0, z), heading: h, speed: 0, occupied: false, mesh: new THREE.Group(), wheels: [], steerPivots: [] }; vehicles.push(v); return v; },
  nearestVehicle: (d) => { let b = null, bd = d; for (const v of vehicles) { if (v.occupied) continue; const dd = Math.hypot(v.pos.x - internals.player.pos.x, v.pos.z - internals.player.pos.z); if (dd < bd) { bd = dd; b = v; } } return b; },
  enterVehicle: (v) => { internals.mode = 'drive'; internals.playerVehicle = v; v.occupied = true; if (window.ONFOOT.onJack) window.ONFOOT.onJack(v); },
  exitVehicle: () => { internals.mode = 'foot'; if (internals.playerVehicle) internals.playerVehicle.occupied = false; internals.playerVehicle = null; },
  killPed: (p) => { if (!p.dead) { p.dead = true; if (window.ONFOOT.onKill) window.ONFOOT.onKill(p); } },
};
window.ONFOOT = { active: true, ready: true, unlocked: () => true, enter: noop, exit: noop, internals };

const { GTA } = await import('../core.js');
await import('../onfoot-bridge.js');   // installs hooks + boots (active=true)
// let the bridge's async optional module loads settle before driving frames, so
// the sim exercises gta/fx.js (Lane B) once it exists (no-ops while it doesn't).
try { if (window.ONFOOT.fxReady) await window.ONFOOT.fxReady; } catch (e) {}

const M = ctx0 => ctx0.systems.missions && ctx0.systems.missions.api;  // heist registered as 'missions'
const ctx = GTA.ctx;
const heist = M(ctx);
if (!heist) { console.error('heist/missions provider missing'); }

// ---------- round-2 wiring asserts: physics + first-person bridge routing -----
// The bridge should have wired both host hooks; exercise them once here so the
// e2e sim guards the integration too (physics-check covers the pure algorithm).
(() => {
  if (typeof window.ONFOOT.carImpact !== 'function') return console.error('[assert] bridge did not wire OF.carImpact');
  if (typeof window.ONFOOT.onFpToggle !== 'function') return console.error('[assert] bridge did not wire OF.onFpToggle');
  // carImpact routes to gta/physics.js → mutates the vehicle + emits a crash
  const car = { pos: { x: 0, y: 0, z: 0 }, heading: 0, speed: 28, mesh: {} };
  let crashed = false; const offC = GTA.bus.on('fx:crash', () => { crashed = true; });
  window.ONFOOT.carImpact(car, { speed: 28, dt: 1 / 60, dirx: 0, dirz: 1, intended: 28 / 60, moved: 0, pushX: 0, pushZ: -28 / 60 });
  offC();
  if (!(Math.abs(car.speed) < 28)) console.error('[assert] OF.carImpact did not reduce speed: ' + car.speed);
  if (!crashed) console.error('[assert] OF.carImpact did not emit fx:crash');
  // first-person toggle emits fp:toggle + mirrors onto ctx
  let fp = null; const offF = GTA.bus.on('fp:toggle', (p) => { fp = p; });
  window.ONFOOT.onFpToggle(true);
  if (!fp || fp.firstPerson !== true || ctx.firstPerson !== true) console.error('[assert] onFpToggle(true) routing failed');
  window.ONFOOT.onFpToggle(false);
  if (!fp || fp.firstPerson !== false) console.error('[assert] onFpToggle(false) routing failed');
  offF();
})();

// ---------- the autonomous driver ----------
const DT = 1 / 60;
const stats = { won: false, frames: 0, peakStars: 0, peakCops: 0, minHealth: 100, copKills: 0, shots: 0, wasted: 0, money: 0 };
GTA.bus.on('entityKilled', (e) => { if (e && e.kind === 'cop') stats.copKills++; });
GTA.bus.on('playerWasted', () => { stats.wasted++; });

let firing = false;
function setFiring(on) { if (on === firing) return; firing = on; window.__dispatch(on ? 'mousedown' : 'mouseup', { button: 0 }); }

function aimAt(tx, tz) {
  // point the camera from above-behind the player toward (tx,tz) so combat's ray can hit
  const p = internals.player.pos;
  const dx = tx - p.x, dz = tz - p.z; const len = Math.hypot(dx, dz) || 1;
  camera.position.set(p.x - (dx / len) * 1.5, 1.6, p.z - (dz / len) * 1.5);
  camera.lookAt(tx, 1.0, tz);
}

function nearestCop() {
  let best = null, bd = 1e9;
  for (const e of ctx.targets) { if (e.kind !== 'cop' || e.dead || !e.pos) continue; const d = Math.hypot(e.pos.x - internals.player.pos.x, e.pos.z - internals.player.pos.z); if (d < bd) { bd = d; best = e; } }
  return best;
}
function stepToward(target, speed, pos) {
  const p = pos || internals.player.pos;
  let dx = target.x - p.x, dz = target.z - p.z; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
  const bx = p.x, bz = p.z;
  p.x += dx * speed * DT; p.z += dz * speed * DT;
  resolveCollision(p, 0.45);
  if (Math.hypot(p.x - bx, p.z - bz) < speed * DT * 0.35) {   // stuck on a wall -> slide
    p.x = bx; p.z = bz; p.x += -dz * speed * DT; p.z += dx * speed * DT; resolveCollision(p, 0.45);
  }
}

let threw = null, jacked = false;
let navState = '', lastDist = Infinity, stall = 0, fightTimer = 0;
try {
  // switch to the AK-47 (slot 3) early
  internals.keys.add('Digit3');
  for (let f = 0; f < 4500; f++) {
    stats.frames = f;
    const st = heist ? heist.state() : 'none';
    const marker = heist ? heist.markerPos() : null;

    // --- weapon select pulse (release the key after one frame) ---
    if (f === 1) internals.keys.delete('Digit3');

    // --- escape phase: fight the responding cops on foot for a beat, THEN
    //     jack a car and run for the getaway (exercises on-foot combat) ---
    if (st === 'escape' && internals.mode !== 'drive') {
      const wantedNow = ctx.systems.wanted ? ctx.systems.wanted.api.stars() : 0;
      if (wantedNow > 0 && fightTimer < 200) { fightTimer++; }   // hold ground & fight the responders first
      else {
        const car = internals.nearestVehicle(9999);
        if (car) { internals.player.pos.set(car.pos.x, 0, car.pos.z); internals.enterVehicle(car); jacked = true; }
      }
    }

    // --- navigate toward the current objective marker (with stuck-recovery,
    //     so a doorway or a building corner can't deadlock the run) ---
    if (marker) {
      if (st !== navState) { navState = st; lastDist = Infinity; stall = 0; }
      const speed = internals.mode === 'drive' ? 16 : 6.5;
      // while driving, move the CAR (the bridge copies car.pos -> player.pos, which the heist reads)
      const movePos = (internals.mode === 'drive' && internals.playerVehicle) ? internals.playerVehicle.pos : internals.player.pos;
      const dnow = Math.hypot(marker.x - movePos.x, marker.z - movePos.z);
      if (dnow < lastDist - 0.3) { lastDist = dnow; stall = 0; } else stall++;
      if (stall > 100) {
        let dx = marker.x - movePos.x, dz = marker.z - movePos.z; const d = Math.hypot(dx, dz) || 1;
        movePos.x += dx / d * 3.5; movePos.z += dz / d * 3.5; stall = 0; lastDist = Infinity;   // hop past an obstacle
      } else stepToward(marker, speed, movePos);
    }

    // --- fight: if a cop is close & we're on foot, aim + auto-fire ---
    const cop = nearestCop();
    if (cop && internals.mode !== 'drive' && Math.hypot(cop.pos.x - internals.player.pos.x, cop.pos.z - internals.player.pos.z) < 45) {
      aimAt(cop.pos.x, cop.pos.z); setFiring(true);
    } else { setFiring(false); }

    GTA.host = GTA.host; // (no-op; keep linter calm)
    window.ONFOOT.onTick(DT);

    if (ctx.systems.wanted) stats.peakStars = Math.max(stats.peakStars, ctx.systems.wanted.api.stars());
    if (ctx.systems.police) stats.peakCops = Math.max(stats.peakCops, ctx.systems.police.api.copCount());
    stats.minHealth = Math.min(stats.minHealth, ctx.player.health);

    if (st === 'won') { stats.won = true; break; }
  }
} catch (e) { threw = e; }
setFiring(false);
stats.money = ctx.player.money;
stats.finalState = heist ? heist.state() : 'none';
stats.jacked = jacked;

const ok = stats.won && !threw && errors.length === 0;
const line = { seed: SEED, ok, won: stats.won, state: stats.finalState, frames: stats.frames, peakStars: stats.peakStars, peakCops: stats.peakCops, copKills: stats.copKills, minHealth: stats.minHealth, jacked: stats.jacked, money: stats.money, errors: errors.length };
console.log('SIMRESULT ' + JSON.stringify(line));
if (VERBOSE) {
  if (threw) console.log('THROW:\n', threw.stack || threw);
  if (errors.length) { console.log('ERRORS:'); for (const e of errors.slice(0, 20)) console.log('  - ' + e); }
}
process.exit(ok ? 0 : 1);
