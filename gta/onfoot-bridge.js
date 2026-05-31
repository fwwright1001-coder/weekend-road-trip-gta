// ============================================================
// gta/onfoot-bridge.js — wires the crime-sandbox SYSTEMS layer onto the
// existing on-foot mode (onfoot3d.js): the full GTA loop — wanted stars,
// police that spawn/chase/shoot and can be shot back, a multi-weapon arsenal
// (pistol / AK-47 / SMG / shotgun) with ammo + pickups, player health + body
// armor + Wasted/Busted, a money economy, the BANK HEIST mission, and a radar.
// ------------------------------------------------------------
// onfoot3d.js stays the HOST (scene, camera, player controller, town, peds,
// driving). This bridge READS window.ONFOOT.internals and reacts via the
// optional hooks (onEnter/onTick/onKill/onJack/onExit). It now OWNS combat:
// onfoot3d's single pistol is suppressed (OF.combatOwned) and gta/combat.js
// runs the full arsenal, fed real mouse/keyboard input. Everything is
// per-system isolated + try/caught, so a bug here can't brick the base mode.
//
// Reuses unchanged: core.js, wanted.js, economy.js, police.js, hud-radar.js,
//   combat.js. The heist (gta/onfoot-heist.js) registers as the HUD's
//   'missions' provider. World + vehicles are adapted by thin shims below.
//   gta/fx.js (Lane B's particle/screen-FX layer) is OPTIONALLY loaded via
//   loadFx() — defensive, so it no-ops until that module exists (see the FX
//   MODULE SEAM section for the contract).
// ============================================================
import { GTA, GU } from './core.js';
import './wanted.js';
import './economy.js';
import './police.js';
import './combat.js';
import './physics.js';   // dynamic car-vs-building impact (registers the 'physics' system)
import './traffic.js';   // ambient NPC traffic AI (registers the 'traffic' system)
import './pickups.js';   // health/armor pickup respawn scheduler (registers 'pickups')
import './hud-radar.js';
import './onfoot-heist.js';
import { buildWorldDetail } from './onfoot-detail.js';

// ---- handles (resolved at enter time) --------------------------------------
let I = null;            // window.ONFOOT.internals
let ctx = null;
let booted = false;
let active = false;
const pedMirrors = [];   // ctx.targets blip entries mirroring onfoot3d's peds
const vehMirrors = [];
const _scratchDir = { x: 0, y: 0, z: 0 };
let _lastPx = null, _lastPy = null, _lastPz = null;   // prior player pos -> velocity
let _shakeMag = 0, _flashEl = null;
let _detailBuilt = false;
let _realism = null, _realismBuilt = false;   // post-FX + textures pipeline (browser only)
let _fxLoaded = false;                         // gta/fx.js (Lane B) — optional particle/FX module
let _audioLoaded = false;                      // gta/audio.js (Lane B) — optional audio module
let _lastWeather = null;                       // mirror OF.weather onto the bus so audio reacts to rain/fog

// ---- real input state (fed to combat.js) -----------------------------------
let _mouseDown = false, _mouseWired = false;
const _justKeys = new Set(), _justMouse = new Set();
let _prevKeys = new Set();

// ---- weapon pickups (bridge-owned; economy handles cash/ammo/health/armor) --
const weaponPickups = [];   // {grp, x, z, weaponId, taken}

// ============================================================
// SHIM 1 — WORLD over onfoot3d's town (aabbs + BOUND + resolveCollision)
// ============================================================
const BLOCK = 24, ROAD_OFFSET = 12, ROAD_HALF = 5;
function makeWorldShim() {
  const THREE = I.THREE;
  const bound = I.bound;
  let landmarks = null;
  const buildLandmarks = () => {
    const out = [{ name: 'plaza', pos: { x: 0, z: 8 }, district: 'downtown' }];
    const a = I.aabbs;
    for (let i = 0; i < a.length; i += Math.max(1, (a.length / 6) | 0)) {
      const b = a[i];
      out.push({ name: 'block_' + i, pos: { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 }, district: 'downtown' });
    }
    return out;
  };
  const api = {
    bound, blockSize: BLOCK, roadHalf: ROAD_HALF, roadOffset: ROAD_OFFSET,
    isInside: (x, z, pad = 0) => I.insideBuilding(x, z, pad),
    resolve: (pos, pad = 0.4) => { I.resolveCollision(pos, pad); return pos; },
    onRoad: (x, z) => !I.insideBuilding(x, z, 0) && Math.abs(x) <= bound && Math.abs(z) <= bound,
    nearestRoad(x, z, out = {}) {
      const sx = Math.round((x - ROAD_OFFSET) / BLOCK) * BLOCK + ROAD_OFFSET;
      const sz = Math.round((z - ROAD_OFFSET) / BLOCK) * BLOCK + ROAD_OFFSET;
      if (Math.abs(x - sx) < Math.abs(z - sz)) { out.x = GU.clamp(sx, -bound, bound); out.z = GU.clamp(z, -bound, bound); out.dir = 0; }
      else { out.x = GU.clamp(x, -bound, bound); out.z = GU.clamp(sz, -bound, bound); out.dir = Math.PI / 2; }
      return out;
    },
    randomSpawn(rng, pad = 0.6, out) {
      const r = rng || Math.random;
      let x, z, tries = 0;
      do { x = (r() * 2 - 1) * (bound - 4); z = (r() * 2 - 1) * (bound - 4); tries++; }
      while (I.insideBuilding(x, z, pad) && tries < 50);
      if (out) { out.set(x, 0, z); return out; }
      return new THREE.Vector3(x, 0, z);
    },
    randomRoadSpawn(rng, out = {}) {
      const r = rng || Math.random;
      const k = Math.round((r() * 2 - 1) * (bound / BLOCK) - 0.5);
      const line = GU.clamp(k * BLOCK + ROAD_OFFSET, -bound, bound);
      const along = (r() * 2 - 1) * (bound - 6);
      if (r() < 0.5) { out.x = line; out.z = along; out.dir = 0; }
      else { out.x = along; out.z = line; out.dir = Math.PI / 2; }
      return out;
    },
    district: () => 'downtown',
    landmarks: () => (landmarks || (landmarks = buildLandmarks())),
    randomLandmark: (rng) => GU.pick(rng, (landmarks || (landmarks = buildLandmarks()))),
  };
  return { name: 'world', deps: [], aabbs: I.aabbs, api, init(c) { c.world = api; this.aabbs = I.aabbs; }, update() {}, reset() {} };
}

// ============================================================
// SHIM 2 — VEHICLES over onfoot3d's cars
// ============================================================
function makeVehiclesShim() {
  return {
    name: 'vehicles', deps: [], init() {}, update() {}, reset() {},
    api: {
      count: () => (I && I.vehicles ? I.vehicles.length : 0),
      playerVehicle: () => (I ? I.playerVehicle : null),
      nearestEnterable(pos) {
        if (!I || !I.vehicles || !pos) return null;
        let best = null, bd = Infinity;
        for (const v of I.vehicles) { if (v.occupied) continue; const d = Math.hypot(v.pos.x - pos.x, v.pos.z - pos.z); if (d < bd) { bd = d; best = v; } }
        return best;
      },
      spawnAt(x, z, opts) {
        if (!I || !I.spawnVehicle) return null;
        const heading = (opts && opts.heading) || 0, color = (opts && opts.color) || 0x394150;
        try { return I.spawnVehicle(x, z, heading, color); } catch (e) { return null; }
      },
      // ambient traffic spawn: prefer Lane A's civilian NPC-car factory (separate
      // internals.traffic[], out of the jack/run-over loop); fall back to a normal
      // jackable spawnVehicle when A's factory isn't present (e.g. headless harness).
      spawnTraffic(x, z, opts) {
        if (I && typeof I.spawnTrafficCar === 'function') {
          try { const rec = I.spawnTrafficCar(x, z, (opts && opts.heading) || 0, opts || {}); if (rec) return rec; } catch (e) { /* fall through */ }
        }
        return this.spawnAt(x, z, opts);
      },
      forceExit() { try { if (I && I.mode === 'drive' && I.exitVehicle) I.exitVehicle(); } catch (e) {} },
    },
  };
}

// ============================================================
// CONTEXT
// ============================================================
function buildCtx() {
  const THREE = I.THREE;
  const player = {
    pos: I.player.pos,
    vel: new THREE.Vector3(),
    get vy() { return I.player.vy; }, set vy(v) { I.player.vy = v; },
    get grounded() { return I.player.grounded; },
    yaw: I.yaw, pitch: I.pitch, facing: I.player.facing,
    health: 100, maxHealth: 100, armor: 0, money: 0,
    inVehicle: false, vehicle: null,
    weapon: 'pistol',
    mesh: I.player.mesh,
    alive: true,
  };
  ctx = {
    THREE,
    headless: !!I.headless,   // true under the node sim — systems (e.g. fx) guard browser-only work on this
    get scene() { return I.scene; }, get camera() { return I.camera; }, get renderer() { return I.renderer; },
    player,
    input: {
      keys: I.keys,
      get pointerLocked() { return I.locked; },
      get mouseDown() { return _mouseDown; },
      held: (c) => I.keys.has(c),
      pressed: (c) => _justKeys.has(c),
      consume: (c) => { const h = _justKeys.has(c); _justKeys.delete(c); return h; },
      mouseJust: (b = 0) => _justMouse.has(b),
      consumeMouse: (b = 0) => { const h = _justMouse.has(b); _justMouse.delete(b); return h; },
    },
    world: null,
    targets: [],
    traffic: [],            // live ambient NPC cars (gta/traffic.js fills this; mirrored to internals.traffic)
    time: { t: 0, dt: 0 },
    rng: GU.makeRng(0x6CED2A11),
    config: { difficulty: 0.9, pedDensity: 1, persist: true, mode: 'onfoot' },
  };
  // expose the live sandbox state for debugging / external probes. The combat model
  // lives HERE (ctx.player.health/armor/money/weapon), not on the host window.ONFOOT —
  // so a probe of window.ONFOOT alone reads "no health"; window.ONFOOT.gta is the truth.
  if (typeof window !== 'undefined' && window.ONFOOT) window.ONFOOT.gta = ctx;
  return ctx;
}

// GTA.host — combat reads camera forward + drives a little recoil (mapped to shake)
function wireHost() {
  GTA.host = {
    addRecoil(a) { _shakeMag = Math.min(1.4, _shakeMag + (a || 0) * 3); },
    cameraDir(out) { const o = out || _scratchDir; if (I && I.camera) I.camera.getWorldDirection(o); return o; },
    yaw: () => (I ? I.yaw : 0), pitch: () => (I ? I.pitch : 0),
  };
}

// ============================================================
// ctx.targets mirrors — peds (shootable: onHit -> onfoot3d.killPed) + vehicles
// ============================================================
// combat.js calls onHit(damage, 'player', hitPoint) on the nearest ctx.targets entry,
// so route the real per-hit damage into the ped's HP (host: hurtPed). Lethal hits drop
// them (killPed → onKill → cash/crime); sub-lethal hits show a flesh impact puff so the
// shot visibly connects instead of feeling inert. Falls back to a one-shot kill if the
// host predates hurtPed.
function pedOnHit(src) {
  return function (dmg) {
    try {
      if (src.dead) return;
      const lethal = I.hurtPed ? I.hurtPed(src, dmg) : (I.killPed ? (I.killPed(src), true) : false);
      if (!lethal) GTA.bus.emit('fx:impact', { pos: { x: src.pos.x, y: 1.15, z: src.pos.z }, kind: 'flesh', scale: 0.7 });
    } catch (e) {}
  };
}
function buildMirrors() {
  pedMirrors.length = 0; vehMirrors.length = 0;
  for (const p of (I.peds || [])) {
    const m = { pos: p.pos, height: 1.7, radius: 0.55, kind: 'ped', dead: false, _mirror: true, _src: p, onHit: pedOnHit(p) };
    pedMirrors.push(m); ctx.targets.push(m);
  }
  for (const v of (I.vehicles || [])) {
    const m = { pos: v.pos, height: 1.4, radius: 1.2, kind: 'vehicle', dead: false, _mirror: true, _src: v, onHit() {} };
    vehMirrors.push(m); ctx.targets.push(m);
  }
}
function refreshMirrors() {
  if (I && I.vehicles && vehMirrors.length < I.vehicles.length) {
    for (let i = vehMirrors.length; i < I.vehicles.length; i++) {
      const v = I.vehicles[i];
      const m = { pos: v.pos, height: 1.4, radius: 1.2, kind: 'vehicle', dead: false, _mirror: true, _src: v, onHit() {} };
      vehMirrors.push(m); ctx.targets.push(m);
    }
  }
  for (const m of pedMirrors) { m.pos = m._src.pos; m.dead = !!m._src.dead; }
  for (const m of vehMirrors) { m.pos = m._src.pos; }
}

// ============================================================
// CRIME / WASTED / BUSTED
// ============================================================
function emitCrime(kind, pos, severity) {
  GTA.bus.emit('crime', { kind, pos: pos || ctx.player.pos, severity: severity == null ? 1 : severity, source: 'player' });
}
function wireOutcomes() {
  GTA.bus.on('playerWasted', () => respawn('wasted'));
  GTA.bus.on('playerBusted', () => respawn('busted'));
}
function respawn(cause) {
  try {
    showWastedScreen(cause);   // dramatized full-screen WASTED/BUSTED beat (DOM-only, headless-safe)
    if (I.mode === 'drive' && I.exitVehicle) I.exitVehicle();
    const lm = ctx.world ? ctx.world.randomLandmark(ctx.rng) : { pos: { x: 0, z: 8 } };
    I.player.pos.set(lm.pos.x, 0, lm.pos.z + 4);
    I.player.vy = 0;
    ctx.player.health = ctx.player.maxHealth; ctx.player.alive = true;
    if (cause === 'busted' && ctx.systems.economy) ctx.systems.economy.api.add(-Math.floor((ctx.player.money || 0) * 0.1), 'bail');
    GTA.bus.emit('toast', { html: cause === 'busted' ? '<b>BUSTED</b> — the cops haul you in.' : '<b>WASTED</b> — Smeaglodin goes down. Respawning…', ms: 4200 });
    _lastPx = _lastPy = _lastPz = null;
    GTA.bus.emit('playerRespawn', { pos: I.player.pos.clone(), cause });
    GTA.reset(ctx);
    ctx.player.armor = 100;   // respawn with a fresh body-armor bar
  } catch (e) { console.error('[GTA bridge] respawn failed', e); }
}

// ============================================================
// FEEDBACK — shake + hit-flash (DOM-only)
// ============================================================
function wireFeedback() {
  GTA.bus.on('shake', (p) => { _shakeMag = Math.min(1.4, _shakeMag + ((p && p.amount) || 0)); });
  // bystanders panic at gunfire (combat owns firing now, so wire it via the crime feed)
  GTA.bus.on('crime', (p) => { if (p && p.kind === 'gunfire' && I && I.startleNearby) { try { I.startleNearby(); } catch (e) {} } });
  // explosions (Lane A's grenade etc.) scatter a wide radius of peds
  GTA.bus.on('fx:explosion', (p) => { if (p && p.pos && I && I.panicPeds) { try { I.panicPeds(p.pos.x, p.pos.z, 14, 'scatter'); } catch (e) {} } });
  GTA.bus.on('playerHurt', () => {
    ensureFlash();
    if (!_flashEl) return;
    _flashEl.style.transition = 'none'; _flashEl.style.opacity = '0.42';
    requestAnimationFrame(() => { if (_flashEl) { _flashEl.style.transition = 'opacity .5s ease-out'; _flashEl.style.opacity = '0'; } });
  });
}
// Full-screen WASTED / BUSTED beat — a cinematic death/arrest moment so the (real,
// already-wired) stakes LAND emotionally instead of just a toast. Big tinted title +
// vignette that flashes in fast and fades over the respawn. DOM-only + headless-safe.
let _wastedEl = null;
function showWastedScreen(cause) {
  if (typeof document === 'undefined' || (I && I.headless)) return;
  try {
    const frame = document.getElementById('frame') || document.body;
    if (!_wastedEl) {
      _wastedEl = document.createElement('div');
      _wastedEl.id = 'gta-wasted';
      _wastedEl.style.cssText = 'position:absolute;inset:0;z-index:38;display:grid;place-items:center;text-align:center;'
        + 'pointer-events:none;opacity:0;font-family:Georgia,serif;font-weight:900;letter-spacing:8px;'
        + 'text-shadow:0 6px 30px rgba(0,0,0,.85);';
      _wastedEl.innerHTML = '<div id="gta-wasted-txt" style="font-size:clamp(40px,11vw,120px)"></div>';
      frame.appendChild(_wastedEl);
    }
    const busted = cause === 'busted';
    _wastedEl.style.background = busted
      ? 'radial-gradient(circle at 50% 45%, rgba(24,52,104,0.38), rgba(0,2,10,0.84))'
      : 'radial-gradient(circle at 50% 45%, rgba(96,14,14,0.42), rgba(8,0,0,0.86))';
    const txt = _wastedEl.querySelector('#gta-wasted-txt');
    if (txt) { txt.textContent = busted ? 'BUSTED' : 'WASTED'; txt.style.color = busted ? '#86b4ff' : '#ff5a5a'; }
    _wastedEl.style.display = 'grid';
    _wastedEl.style.transition = 'none'; _wastedEl.style.opacity = '0';
    requestAnimationFrame(() => {
      if (!_wastedEl) return;
      _wastedEl.style.transition = 'opacity .3s ease-out'; _wastedEl.style.opacity = '1';
      setTimeout(() => { if (_wastedEl) { _wastedEl.style.transition = 'opacity 1.1s ease-in'; _wastedEl.style.opacity = '0'; } }, 1500);
      setTimeout(() => { if (_wastedEl) _wastedEl.style.display = 'none'; }, 2750);
    });
  } catch (e) { /* a cosmetic flourish must never break respawn */ }
}
function ensureFlash() {
  if (_flashEl) return;
  const frame = document.getElementById('frame') || document.body;
  _flashEl = document.createElement('div');
  _flashEl.id = 'gta-hitflash';
  _flashEl.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:21;opacity:0;background:radial-gradient(circle at 50% 60%, rgba(190,20,20,0) 38%, rgba(190,20,20,0.6) 100%);';
  frame.appendChild(_flashEl);
}
function applyShake(dt) {
  if (_shakeMag <= 0 || !I || !I.canvas) return;
  _shakeMag = Math.max(0, _shakeMag - dt * 4);
  if (_shakeMag === 0) { I.canvas.style.transform = ''; return; }
  const k = _shakeMag * 5;
  const ox = (ctx.rng() * 2 - 1) * k, oy = (ctx.rng() * 2 - 1) * k;
  I.canvas.style.transform = `translate(${ox.toFixed(1)}px, ${oy.toFixed(1)}px)`;
}

// ============================================================
// FX MODULE SEAM — gta/fx.js (Lane B's particle / screen-FX layer)
// ------------------------------------------------------------
// Optional, loaded the same defensive way as the realism pipeline: dynamic-
// imported + fully try/caught, so the GTA layer runs fine whether or not fx.js
// exists yet (today it doesn't — Lane B ships it). The MOMENT it lands, this
// wires it with no further changes here.
//
// CONTRACT (also in REQUESTS.md so Lane B has it):
//   * fx.js EITHER self-registers a system on import via
//       GTA.register({ name:'fx', init(ctx), update(dt,ctx), reset(ctx) })   ← preferred
//     OR exports install(ctx, GTA) (named or default) which we call here.
//   * It reads ctx.scene / ctx.camera / ctx.THREE and reacts to GTA.bus events:
//       existing — 'entityKilled', 'crime'(kind:'gunfire'), 'playerHurt', 'shake'
//       optional  — the fx:* family (see core.js catalog): fx:muzzle / fx:impact /
//                   fx:explosion / fx:spawn, emitted by combat.js (Lane A) when it
//                   has the precise barrel/impact point.
//   * It MUST be headless-safe: build scene meshes only; guard any DOM / WebGL-
//     context work behind `ctx.headless` so the node sim exercises it.
//   * It MUST NOT set OF.renderHook (reserved for the realism composer). Per-frame
//     work belongs in update(dt,ctx), which the host calls before the render hook.
// Unlike the realism pipeline, fx loads even headless, so onfoot-sim covers it.
function loadFx(ctx) {
  if (_fxLoaded) return Promise.resolve();
  _fxLoaded = true;
  return import('./fx.js').then((mod) => {
    try {
      const install = mod && (mod.install || (typeof mod.default === 'function' ? mod.default : null));
      if (install) install(ctx, GTA);
      else if (mod && mod.default && mod.default.name && GTA.register) GTA.register(mod.default);
      // else: the module self-registered via GTA.register on import — nothing to do.
      if (GTA.systems.fx) console.info('[GTA bridge] fx layer loaded');
    } catch (e) { console.warn('[GTA] fx.js found but install failed; running without particle FX', e); }
  }).catch((e) => {
    // a missing module is the expected state until Lane B lands fx.js — stay quiet.
    const m = String((e && (e.code || e.message)) || e);
    if (!/Cannot find module|ERR_MODULE_NOT_FOUND|Failed to (fetch|load)|Error resolving module/i.test(m)) {
      console.warn('[GTA] fx.js present but failed to load', e);
    }
  });
}

// ============================================================
// AUDIO MODULE SEAM — gta/audio.js (Lane B's radio/music + soundscape layer)
// ------------------------------------------------------------
// Loaded exactly like fx.js: dynamic-imported + try/caught, so the layer runs
// whether or not audio.js exists yet. CONTRACT (also in REQUESTS.md):
//   * audio.js self-registers a GTA system (name:'audio') OR exports install(ctx, GTA).
//   * It reacts to bus events: audio:station, fx:explosion, crime(gunfire),
//     entityKilled, pickup, wanted:changed, vehicle:jacked.
//   * MUST be headless-safe: guard AudioContext/DOM behind ctx.headless so the
//     node sim runs without a browser. Must NOT set OF.renderHook.
// The radio-station key is read in onTick (brackets → 'audio:station {dir}').
function loadAudio(ctx) {
  if (_audioLoaded) return Promise.resolve();
  _audioLoaded = true;
  return import('./audio.js').then((mod) => {
    try {
      const install = mod && (mod.install || (typeof mod.default === 'function' ? mod.default : null));
      if (install) install(ctx, GTA);
      else if (mod && mod.default && mod.default.name && GTA.register) GTA.register(mod.default);
      if (GTA.systems.audio) console.info('[GTA bridge] audio layer loaded');
    } catch (e) { console.warn('[GTA] audio.js found but install failed; running silent', e); }
  }).catch((e) => {
    const m = String((e && (e.code || e.message)) || e);
    if (!/Cannot find module|ERR_MODULE_NOT_FOUND|Failed to (fetch|load)|Error resolving module/i.test(m)) {
      console.warn('[GTA] audio.js present but failed to load', e);
    }
  });
}

// ============================================================
// PICKUPS — guns (bridge) + ammo/health/armor (economy + respawn via pickups.js)
// ============================================================
function buildGunPickup(id, x, z) {
  const THREE = I.THREE;
  const grp = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.6, roughness: 0.4 });
  const accent = new THREE.MeshStandardMaterial({ color: id === 'ak47' ? 0x7a4a22 : 0x444a52, roughness: 0.7 });
  // a stylized gun silhouette
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.14, 0.18), metal); body.position.y = 1.1;
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.34, 0.16), accent); mag.position.set(-0.05, 0.92, 0);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.14), accent); stock.position.set(0.5, 1.08, 0);
  grp.add(body, mag, stock);
  // glowing pillar so it's findable
  const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 2.2, 14, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0.16, side: THREE.DoubleSide }));
  glow.position.y = 1.1; grp.add(glow);
  grp.position.set(x, 0, z);
  grp.traverse((o) => { if (o.isMesh && o.material.metalness !== undefined) o.castShadow = true; });
  I.scene.add(grp);
  return grp;
}
function spawnWeaponPickup(id, x, z) {
  const grp = buildGunPickup(id, x, z);
  weaponPickups.push({ grp, x, z, weaponId: id, taken: false });
}
function updateWeaponPickups(dt) {
  const p = ctx.player.pos;
  for (const wp of weaponPickups) {
    if (wp.taken) continue;
    wp.grp.rotation.y += dt * 1.4;
    wp.grp.position.y = Math.sin(ctx.time.t * 2 + wp.x) * 0.12;
    if (Math.hypot(p.x - wp.x, p.z - wp.z) < 1.9) {
      wp.taken = true; wp.grp.visible = false;
      const c = ctx.systems.combat && ctx.systems.combat.api;
      if (c) { c.giveWeapon(wp.weaponId, true); }
      const name = wp.weaponId === 'ak47' ? 'an AK-47' : wp.weaponId === 'smg' ? 'an SMG' : wp.weaponId === 'shotgun' ? 'a shotgun' : wp.weaponId === 'grenade' ? 'grenades' : 'a weapon';
      GTA.bus.emit('toast', { html: `Picked up <b>${name}</b>. <b>Tab</b> / <b>1-6</b> to switch.`, ms: 3500 });
    }
  }
}
function placePickups() {
  // a starting arsenal scattered near the plaza + heist-relevant kit
  spawnWeaponPickup('ak47', 10, -6);
  spawnWeaponPickup('smg', -14, 10);
  spawnWeaponPickup('shotgun', 16, 14);
  spawnWeaponPickup('ak47', -2, -34);     // near the bank approach
  spawnWeaponPickup('grenade', -8, -40);  // grenades by the bank — clear the vault guards
  spawnWeaponPickup('shotgun', 52, -50);  // outer ring, so the bigger map rewards exploring
  spawnWeaponPickup('smg', -56, 46);      // outer ring (opposite corner)
  // ammo / health / armor crates via economy's pickup manager.
  const drop = (kind, value, x, z) => GTA.bus.emit('spawnPickup', { kind, value, pos: { x, y: 0, z } });
  // health/armor also register a respawn SEED (gta/pickups.js re-drops them on a
  // timer after collection, so a long fight doesn't strip the map permanently).
  const pk = ctx.systems.pickups && ctx.systems.pickups.api;
  const seed = (kind, value, x, z) => { drop(kind, value, x, z); if (pk) pk.seed(kind, value, x, z); };
  drop('ammo', 90, 6, 6); drop('ammo', 120, -10, -10); drop('ammo', 120, 20, -20); drop('ammo', 90, -22, 18);
  drop('ammo', 120, 48, 40); drop('ammo', 120, -52, -44);   // outer-ring ammo so the edges aren't empty
  seed('armor', 100, 4, -8); seed('armor', 50, -18, -4); seed('armor', 50, -48, 52);
  seed('health', 40, 12, 12); seed('health', 40, -8, 20); seed('health', 40, 0, -28);
  seed('health', 40, 56, -50); seed('health', 40, -44, -54);
}

// ============================================================
// HOOKS
// ============================================================
function wireMouse() {
  if (_mouseWired) return;
  _mouseWired = true;
  window.addEventListener('mousedown', (e) => { if (!active) return; if (e.button === 0) { _mouseDown = true; _justMouse.add(0); } else _justMouse.add(e.button); }, true);
  window.addEventListener('mouseup', (e) => { if (e.button === 0) _mouseDown = false; }, true);
}
function onEnter() {
  try {
    const OF = window.ONFOOT;
    I = OF && OF.internals;
    if (!I || !I.scene) { console.warn('[GTA bridge] ONFOOT.internals not ready'); return; }
    OF.combatOwned = true;     // suppress onfoot3d's built-in pistol; combat.js owns weapons
    OF.layerReady = true;      // loader gate — flipped false only while the async realism setup runs (below)
    if (!booted) {
      buildCtx();
      wireHost();
      wireMouse();
      if (!GTA.systems.world) GTA.register(makeWorldShim());
      if (!GTA.systems.vehicles) GTA.register(makeVehiclesShim());
      wireOutcomes();
      wireFeedback();
      GTA.boot(ctx, { mode: 'onfoot' });
      booted = true;
      buildMirrors();
      // world detail (props) once
      if (!_detailBuilt) { try { buildWorldDetail(I.THREE, I.scene, { exclude: [{ x: 0, z: -42, r: 16 }] }); _detailBuilt = true; } catch (e) { console.error('[GTA bridge] world detail failed', e); } }
      // realism pass (procedural textures + env reflections + post-FX AA/AO/bloom).
      // Browser-only, fully defensive: dynamic-imported so a missing/broken module
      // can't break the game, and it falls back to plain rendering on any failure.
      if (!I.headless && !_realismBuilt) {
        _realismBuilt = true;
        window.ONFOOT.layerReady = false;   // hold the loading screen until this async setup settles
        Promise.all([import('./onfoot-textures.js'), import('./onfoot-render.js')]).then(async ([tex, rmod]) => {
          try { if (tex && tex.beautifyScene) tex.beautifyScene(I.THREE, I.scene, { envMapIntensity: 0.9 }); } catch (e) { console.warn('[GTA] beautify skipped', e); }
          try {
            if (rmod && rmod.installRealism) {
              const rl = await rmod.installRealism(I.THREE, I.renderer, I.scene, I.camera, I.canvas, {});   // async (env map + composer)
              if (rl && rl.render) { _realism = rl; window.ONFOOT.renderHook = (dt) => rl.render(dt); window.ONFOOT.onResize = (w, h) => rl.setSize(w, h); }
            }
          } catch (e) { console.warn('[GTA] realism pipeline skipped; plain render', e); }
        }).catch((e) => console.warn('[GTA] realism modules unavailable; plain render', e))
          .finally(() => { window.ONFOOT.layerReady = true; });   // release the loader once textures/lighting/post-FX are up (or have failed)
      }
      // loadout: Smeaglodin starts with a pistol + an AK-47 + a couple of grenades, full
      // health + armor. The grenade is fully implemented (throw/cook/blast) — grant it so
      // it isn't an unreachable weapon; Tab / 1-6 switch, click throws.
      const c = ctx.systems.combat && ctx.systems.combat.api;
      if (c) { c.giveWeapon('pistol', true); c.giveWeapon('ak47', false); c.giveWeapon('grenade', false); }
      ctx.player.health = ctx.player.maxHealth; ctx.player.armor = 100;
      placePickups();
      // expose the live ambient-traffic list to host-side readers (Lane A/B) as
      // window.ONFOOT.internals.traffic — but DON'T clobber it if Lane A already
      // defined the array via its spawnTrafficCar factory (we feed that one instead).
      if (!Array.isArray(I.traffic)) I.traffic = ctx.traffic;
      // optional Lane-B layers; no-ops until gta/fx.js / gta/audio.js land. The
      // promises are exposed so headless harnesses (onfoot-sim) can await the
      // async module loads before driving frames — otherwise they cover for free.
      OF.fxReady = loadFx(ctx);
      OF.audioReady = loadAudio(ctx);
    } else {
      _lastPx = _lastPy = _lastPz = null;
      ctx.player.health = ctx.player.maxHealth; ctx.player.alive = true;
      GTA.reset(ctx);
      const m = ctx.systems.missions && ctx.systems.missions.api;   // un-stick a 'won' heist + hide overlay
      if (m && m.forceRestart) m.forceRestart();
      ctx.player.armor = 100;
      for (const wp of weaponPickups) { wp.taken = false; wp.grp.visible = true; }
    }
    active = true;
    document.getElementById('gta-hud')?.classList.remove('hidden');
    document.body.classList.add('gta-active');
    GTA.bus.emit('toast', { html: 'Heist time. Get to the <b>bank</b> (radar marker), crack the <b>vault</b> and grab the <b>goop</b>, then <b>escape in a car</b>. The vault is guarded and the cops will swarm — fight or flee.<br>You’re carrying a <b>pistol</b> + <b>AK-47</b> + <b>grenades</b> — <b>Tab</b>/<b>1-6</b> switch, <b>R</b> reload. <b>Click</b> to grab the mouse, or just <b>move the cursor</b> / <b>Q-E</b> to aim.', ms: 8000 });
  } catch (e) { console.error('[GTA bridge] onEnter failed; base on-foot mode unaffected', e); }
}

function onExit() {
  try {
    active = false;
    document.getElementById('gta-hud')?.classList.add('hidden');
    document.getElementById('gta-win')?.style.setProperty('display', 'none');
    document.body.classList.remove('gta-active');
    if (I && I.canvas) I.canvas.style.transform = '';
    if (_flashEl) _flashEl.style.opacity = '0';
    _shakeMag = 0; _mouseDown = false;
  } catch (e) { console.error('[GTA bridge] onExit failed', e); }
}

function onTick(dt) {
  if (!active || !booted) return;
  if (window.ONFOOT && window.ONFOOT.paused) return;   // Lane B's pause menu freezes the sandbox
  try {
    // just-pressed keys: read onfoot3d's edge-pressed set (captured at keydown
    // time so fast taps of Tab/R/Digit aren't lost), then clear it for next frame.
    _justKeys.clear();
    if (I.justPressed) { for (const k of I.justPressed) _justKeys.add(k); I.justPressed.clear(); }
    else { for (const k of I.keys) if (!_prevKeys.has(k)) _justKeys.add(k); _prevKeys = new Set(I.keys); }

    // radio station cycle (Lane B's gta/audio.js consumes this) — ]/[ next/prev.
    if (_justKeys.has('BracketRight')) { _justKeys.delete('BracketRight'); GTA.bus.emit('audio:station', { dir: 1 }); }
    if (_justKeys.has('BracketLeft'))  { _justKeys.delete('BracketLeft');  GTA.bus.emit('audio:station', { dir: -1 }); }

    const driving = I.mode === 'drive' && I.playerVehicle;
    ctx.player.yaw = driving ? I.playerVehicle.heading : I.yaw;
    ctx.player.pitch = I.pitch;
    ctx.player.facing = I.player.facing;
    ctx.player.inVehicle = !!driving;
    ctx.player.vehicle = driving ? I.playerVehicle : null;
    ctx.firstPerson = !!I.firstPerson;   // mirror FP state for systems that poll ctx
    // mirror the combat model back onto the host player object so a console/probe read
    // of window.ONFOOT.internals.player shows live health/armor (not a false "no health").
    try { I.player.health = ctx.player.health; I.player.armor = ctx.player.armor; I.player.alive = ctx.player.alive; } catch (e) {}
    // surface weather changes on the bus (gta/audio.js swells wind + fades in rain hiss).
    const wx = window.ONFOOT && window.ONFOOT.weather;
    if (wx && wx !== _lastWeather) { _lastWeather = wx; GTA.bus.emit('world:weather', { kind: wx, intensity: (window.ONFOOT.weatherIntensity || 0) }); }

    const pp = I.player.pos;
    if (_lastPx !== null && dt > 0) {
      let vx = (pp.x - _lastPx) / dt, vz = (pp.z - _lastPz) / dt;
      if (Math.hypot(vx, vz) > 40) { vx = 0; vz = 0; }
      ctx.player.vel.set(vx, 0, vz);
    } else ctx.player.vel.set(0, 0, 0);
    _lastPx = pp.x; _lastPy = pp.y; _lastPz = pp.z;
    // while driving, the car moves but onfoot3d freezes player.pos — glue the
    // logical player position to the car so the heist escape, radar, wanted, and
    // police targeting all track the vehicle (the win check reads player.pos).
    if (driving && I.playerVehicle && I.playerVehicle.pos) I.player.pos.copy(I.playerVehicle.pos);

    refreshMirrors();
    GTA.tick(dt, ctx);
    updateWeaponPickups(dt);
    applyShake(dt);
    _justMouse.clear();
  } catch (e) { console.error('[GTA bridge] onTick failed', e); }
}

// onfoot3d still calls onKill (combat kills route through I.killPed -> killPed ->
// OF.onKill) and onJack (carjack). onFire is unused now (pistol suppressed).
function onKill(ped) {
  if (!active || !ped) return;
  try {
    if (I && I.startleNearby) I.startleNearby();
    GTA.bus.emit('entityKilled', { entity: ped, kind: 'ped', pos: ped.pos, byPlayer: true });
    emitCrime('assault', ped.pos, 1);
    if (GU.chance(ctx.rng, 0.5)) GTA.bus.emit('spawnPickup', { kind: 'cash', value: 20 + Math.floor(ctx.rng() * 60), pos: { x: ped.pos.x, y: 0, z: ped.pos.z } });
  } catch (e) {}
}
function onJack(v) {
  if (!active) return;
  // sync the player flag immediately (onTick also maintains it each frame, but
  // this avoids a one-frame window where code reads a stale inVehicle=false)
  ctx.player.inVehicle = true; ctx.player.vehicle = v;
  try { GTA.bus.emit('vehicle:jacked', { vehicle: v }); emitCrime('propertyDamage', v && v.pos, 0.3); } catch (e) {}
}

// ============================================================
// INSTALL
// ============================================================
function install() {
  const OF = window.ONFOOT;
  if (!OF) return false;
  OF.onEnter = onEnter; OF.onExit = onExit; OF.onTick = onTick;
  OF.onKill = onKill; OF.onJack = onJack;
  // dynamic car-vs-building impact: updateDriving calls this on a hard wall hit.
  OF.carImpact = (v, info) => {
    try {
      const sys = GTA.systems.physics;
      if (!sys) return 0;
      // enrich with Lane C's per-building height/zone (I.buildings) for a height-aware
      // crash — optional + defensive: absent (e.g. headless sim) → plain momentum impact.
      if (I && I.buildings && v && v.pos && info && info.buildingHeight === undefined) {
        let best = null, bd = Infinity;
        for (const b of I.buildings) { const d = (b.cx - v.pos.x) ** 2 + (b.cz - v.pos.z) ** 2; if (d < bd) { bd = d; best = b; } }
        if (best) { info.buildingHeight = best.height; info.zone = best.zone; }
      }
      return sys.api.carImpact(v, info);
    } catch (e) { console.error('[GTA bridge] carImpact failed', e); return 0; }
  };
  // first-person toggle: onfoot3d flips OF.firstPerson + hides the body, then calls
  // this so systems (fx/hud) hear it. D owns state; B owns the camera/viewmodel.
  OF.onFpToggle = (state) => {
    try { if (ctx) ctx.firstPerson = !!state; GTA.bus.emit('fp:toggle', { firstPerson: !!state }); }
    catch (e) { console.error('[GTA bridge] onFpToggle failed', e); }
  };
  if (OF.active && !booted) onEnter();
  return true;
}
if (!install()) {
  let tries = 0;
  const iv = setInterval(() => { if (install() || ++tries > 120) clearInterval(iv); }, 16);
}

export default { onEnter, onExit, onTick };
