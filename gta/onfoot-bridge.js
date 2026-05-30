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
// ============================================================
import { GTA, GU } from './core.js';
import './wanted.js';
import './economy.js';
import './police.js';
import './combat.js';
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
        if (!I || !I.vehicles) return null;
        let best = null, bd = Infinity;
        for (const v of I.vehicles) { if (v.occupied) continue; const d = Math.hypot(v.pos.x - pos.x, v.pos.z - pos.z); if (d < bd) { bd = d; best = v; } }
        return best;
      },
      spawnAt(x, z, opts) {
        if (!I || !I.spawnVehicle) return null;
        const heading = (opts && opts.heading) || 0, color = (opts && opts.color) || 0x394150;
        try { return I.spawnVehicle(x, z, heading, color); } catch (e) { return null; }
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
    time: { t: 0, dt: 0 },
    rng: GU.makeRng(0x6CED2A11),
    config: { difficulty: 0.9, pedDensity: 1, persist: true, mode: 'onfoot' },
  };
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
function pedOnHit(src) {
  return function () { try { if (!src.dead && I.killPed) I.killPed(src); } catch (e) {} };
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
  GTA.bus.on('playerHurt', () => {
    ensureFlash();
    if (!_flashEl) return;
    _flashEl.style.transition = 'none'; _flashEl.style.opacity = '0.42';
    requestAnimationFrame(() => { if (_flashEl) { _flashEl.style.transition = 'opacity .5s ease-out'; _flashEl.style.opacity = '0'; } });
  });
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
// PICKUPS — guns (bridge) + ammo/health/armor (economy)
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
      const name = wp.weaponId === 'ak47' ? 'an AK-47' : wp.weaponId === 'smg' ? 'an SMG' : wp.weaponId === 'shotgun' ? 'a shotgun' : 'a weapon';
      GTA.bus.emit('toast', { html: `Picked up <b>${name}</b>. <b>Tab</b> / <b>1-5</b> to switch.`, ms: 3500 });
    }
  }
}
function placePickups() {
  // a starting arsenal scattered near the plaza + heist-relevant kit
  spawnWeaponPickup('ak47', 10, -6);
  spawnWeaponPickup('smg', -14, 10);
  spawnWeaponPickup('shotgun', 16, 14);
  spawnWeaponPickup('ak47', -2, -34);     // near the bank approach
  // ammo / health / armor crates via economy's pickup manager
  const drop = (kind, value, x, z) => GTA.bus.emit('spawnPickup', { kind, value, pos: { x, y: 0, z } });
  drop('ammo', 90, 6, 6); drop('ammo', 120, -10, -10); drop('ammo', 120, 20, -20); drop('ammo', 90, -22, 18);
  drop('armor', 100, 4, -8); drop('armor', 50, -18, -4);
  drop('health', 40, 12, 12); drop('health', 40, -8, 20); drop('health', 40, 0, -28);
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
          try { if (tex && tex.beautifyScene) tex.beautifyScene(I.THREE, I.scene, { envMapIntensity: 0.5 }); } catch (e) { console.warn('[GTA] beautify skipped', e); }
          try {
            if (rmod && rmod.installRealism) {
              const rl = await rmod.installRealism(I.THREE, I.renderer, I.scene, I.camera, I.canvas, {});   // async (env map + composer)
              if (rl && rl.render) { _realism = rl; window.ONFOOT.renderHook = (dt) => rl.render(dt); window.ONFOOT.onResize = (w, h) => rl.setSize(w, h); }
            }
          } catch (e) { console.warn('[GTA] realism pipeline skipped; plain render', e); }
        }).catch((e) => console.warn('[GTA] realism modules unavailable; plain render', e))
          .finally(() => { window.ONFOOT.layerReady = true; });   // release the loader once textures/lighting/post-FX are up (or have failed)
      }
      // loadout: Smeaglodin starts with a pistol + an AK-47, full health + armor
      const c = ctx.systems.combat && ctx.systems.combat.api;
      if (c) { c.giveWeapon('pistol', true); c.giveWeapon('ak47', false); }
      ctx.player.health = ctx.player.maxHealth; ctx.player.armor = 100;
      placePickups();
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
    GTA.bus.emit('toast', { html: 'Heist time. Get to the <b>bank</b> (radar marker), grab the <b>goop</b> from the vault, then <b>escape in a car</b>. Cops will come — fight or flee.', ms: 8000 });
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
  try {
    // just-pressed keys: read onfoot3d's edge-pressed set (captured at keydown
    // time so fast taps of Tab/R/Digit aren't lost), then clear it for next frame.
    _justKeys.clear();
    if (I.justPressed) { for (const k of I.justPressed) _justKeys.add(k); I.justPressed.clear(); }
    else { for (const k of I.keys) if (!_prevKeys.has(k)) _justKeys.add(k); _prevKeys = new Set(I.keys); }

    const driving = I.mode === 'drive' && I.playerVehicle;
    ctx.player.yaw = driving ? I.playerVehicle.heading : I.yaw;
    ctx.player.pitch = I.pitch;
    ctx.player.facing = I.player.facing;
    ctx.player.inVehicle = !!driving;
    ctx.player.vehicle = driving ? I.playerVehicle : null;

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
  if (OF.active && !booted) onEnter();
  return true;
}
if (!install()) {
  let tries = 0;
  const iv = setInterval(() => { if (install() || ++tries > 120) clearInterval(iv); }, 16);
}

export default { onEnter, onExit, onTick };
