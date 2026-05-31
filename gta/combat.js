// ============================================================
// gta/combat.js — weapons, shooting, the player damage pipeline
// ------------------------------------------------------------
// This system owns:
//   * the weapon definitions + the player's loadout (owned weapons, clips/reserve)
//   * the firing pipeline: hitscan rays vs the SHARED ctx.targets registry, with
//     a melee fallback for fists
//   * shot visuals (tracer line + muzzle-flash sphere) generated entirely in code
//   * the player health/armor model + the inbound 'damage' request handler
//
// It NEVER reaches into other systems' internals. Damage to entities is applied
// by calling the entry.onHit() the OWNING system registered on ctx.targets.
// Damage to the PLAYER arrives as a 'damage' bus event (or a direct api call) and
// is applied here. Crimes/kills are announced on the bus for wanted/police/etc.
//
// All meshes are low-poly, code-generated (no textures/loaders/URLs). Per-frame
// allocation is avoided via module-scope scratch vectors and a tracer pool.
//
// Coordinate convention: right-handed, Y up; entities on the XZ plane, Y = height.
// ============================================================
import { GTA, GU } from './core.js';

// ------------------------------------------------------------
// WEAPON DEFINITIONS
// id, name, damage (per pellet/hit), rangeM, fireCooldown (s), clip, reserveMax,
// auto (hold-to-fire), pellets, spread (rad), melee.
// ------------------------------------------------------------
const WEAPONS = {
  fists: {
    id: 'fists', name: 'Fists', slot: 1, damage: 12, rangeM: 2.2,
    fireCooldown: 0.4, clip: 0, reserveMax: 0, auto: false,
    pellets: 1, spread: 0, melee: true,
  },
  pistol: {
    id: 'pistol', name: 'Pistol', slot: 2, damage: 26, rangeM: 120,
    fireCooldown: 0.18, clip: 12, reserveMax: 120, auto: false,
    pellets: 1, spread: 0.004, melee: false,
  },
  ak47: {
    id: 'ak47', name: 'AK-47', slot: 3, damage: 32, rangeM: 180,
    fireCooldown: 0.1, clip: 30, reserveMax: 300, auto: true,
    pellets: 1, spread: 0.016, melee: false,
  },
  smg: {
    id: 'smg', name: 'SMG', slot: 4, damage: 16, rangeM: 90,
    fireCooldown: 0.075, clip: 30, reserveMax: 300, auto: true,
    pellets: 1, spread: 0.02, melee: false,
  },
  shotgun: {
    id: 'shotgun', name: 'Shotgun', slot: 5, damage: 11, rangeM: 30,
    fireCooldown: 0.8, clip: 6, reserveMax: 60, auto: false,
    pellets: 6, spread: 0.09, melee: false,
  },
};
// slot index (1..5) -> weapon id, for Digit1..Digit5 selection
const SLOT_TO_ID = { 1: 'fists', 2: 'pistol', 3: 'ak47', 4: 'smg', 5: 'shotgun' };
// stable cycle order for Tab
const CYCLE_ORDER = ['fists', 'pistol', 'ak47', 'smg', 'shotgun'];

// ------------------------------------------------------------
// Module-scope scratch (NO per-frame allocation)
// ------------------------------------------------------------
let THREE = null;                  // bound in init from ctx.THREE
let _origin = null;                // ray origin (camera position)
let _dir = null;                   // camera forward
let _rayDir = null;                // jittered per-pellet direction
let _toTarget = null;              // target center - origin
let _hitPoint = null;              // computed impact point
let _aimPoint = null;              // target aim point (pos.y + height*0.6)
let _tmpA = null;                  // misc scratch
let _muzzleWorld = null;           // muzzle world position
let _meleeFwd = null;              // melee forward direction (flat XZ)
let _crimePos = null;              // reusable crime/pos payload vector
let _beamDir = null;               // tracer beam direction (normalized)
let _beamUp = null;                // +Y reference for orienting the beam cylinder

// Per-weapon tracer/flash styling: a warm glow + a near-white hot core, sized and
// tinted per weapon so each gun reads differently down-range.
const TRACER_STYLE = {
  pistol:  { glow: 0xffe48a, core: 0xffffff, r: 0.020, life: 0.055 },
  ak47:    { glow: 0xffae3c, core: 0xfff0c4, r: 0.026, life: 0.05 },
  smg:     { glow: 0xffe48a, core: 0xffffff, r: 0.017, life: 0.04 },
  shotgun: { glow: 0xffc94a, core: 0xfff0c0, r: 0.022, life: 0.06 },
  fists:   null,
};

// ------------------------------------------------------------
// Small aim-assist so center-mass clicks land reliably on low-poly bodies.
// ------------------------------------------------------------
const AIM_ASSIST = 0.55;           // meters added to a target's hit radius
const RELOAD_TIME = 1.6;           // seconds for a reload
const TRACER_LIFE = 0.05;          // seconds a tracer line stays visible
const FLASH_LIFE = 0.045;          // seconds the muzzle flash stays visible

const combat = {
  name: 'combat',
  deps: ['world'],

  // ----- mutable state (seeded in init, restored in reset) -----
  ctx: null,
  owned: null,          // { weaponId: { clip, reserve } } for owned weapons
  current: 'fists',     // current weapon id
  _shownWeapon: null,   // weapon id currently shown on the avatar (mesh swap sync)
  cooldown: 0,          // time remaining before next shot
  reloading: false,
  reloadT: 0,           // reload countdown
  _built: false,
  _fxGroup: null,       // parent for tracer + flash meshes
  _tracerPool: null,    // GTA.makePool of THREE.Line tracers
  _flash: null,         // muzzle-flash sphere mesh
  _flashT: 0,           // flash life countdown
  _unsub: [],           // bus unsubscribers

  // ============================================================
  // INIT
  // ============================================================
  init(ctx) {
    this.ctx = ctx;
    THREE = ctx.THREE;
    if (!THREE) return;                 // can't build anything without three

    // scratch vectors (allocate ONCE)
    _origin = new THREE.Vector3();
    _dir = new THREE.Vector3();
    _rayDir = new THREE.Vector3();
    _toTarget = new THREE.Vector3();
    _hitPoint = new THREE.Vector3();
    _aimPoint = new THREE.Vector3();
    _tmpA = new THREE.Vector3();
    _muzzleWorld = new THREE.Vector3();
    _meleeFwd = new THREE.Vector3();
    _crimePos = new THREE.Vector3();
    _beamDir = new THREE.Vector3();
    _beamUp = new THREE.Vector3(0, 1, 0);

    // ----- loadout: start with just fists (host hands out pistol later) -----
    if (!this.owned) {
      this.owned = {
        fists: { clip: 0, reserve: 0 },
      };
    }
    this.current = 'fists';
    this._shownWeapon = null;   // force a weapon-mesh resync on the first update
    this.cooldown = 0;
    this.reloading = false;
    this.reloadT = 0;
    // keep player.weapon consistent from frame 0; this.current is the source of truth
    if (ctx.player) ctx.player.weapon = this.current;

    // ----- shot FX (built once, reused via pool/timers) -----
    if (!this._built) {
      this._buildFx(ctx);
      this._built = true;
    }

    // ----- bus wiring -----
    // generic "hurt the player" request from any system
    this._unsub.push(ctx.bus.on('damage', (p) => {
      if (!p || p.target !== 'player') return;
      this.api.damagePlayer(p.amount || 0, p.kind || p.source || 'unknown', p.pos || null);
    }));
    // NOTE: economy.js applies pickup effects (heal/addArmor/addAmmo) at the
    // moment of collection and emits 'pickup' purely as a notification. We do
    // NOT subscribe to 'pickup' here — re-applying effects would double-grant
    // them (and route ammo to the wrong weapon). economy calls our api.* directly.
    // restore on respawn
    // respawn restore happens via reset() (GTA.reset calls every system's reset);
    // no separate 'playerRespawn' subscription, to avoid a double restore.
  },

  // ----- FX construction (tracers + muzzle flash), all code-generated -----
  _buildFx(ctx) {
    const grp = new THREE.Group();
    grp.name = 'gta-combat-fx';
    grp.frustumCulled = false;
    ctx.scene.add(grp);
    this._fxGroup = grp;

    // tracer pool: each tracer is a stretched additive "beam" — a wide warm glow
    // cylinder + a thin near-white hot core down its axis. Reads as a bright core
    // with a fading tail from the muzzle to the impact point. (Line linewidth is
    // unreliable across GPUs, so we use real geometry.)
    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);   // unit cylinder, scaled per shot
    const factory = () => {
      const t = new THREE.Group();
      const glowMat = new THREE.MeshBasicMaterial({ color: 0xffe48a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const glow = new THREE.Mesh(beamGeo, glowMat);
      const core = new THREE.Mesh(beamGeo, coreMat);
      glow.frustumCulled = false; core.frustumCulled = false;
      t.add(glow, core);
      t.frustumCulled = false; t.visible = false;
      t.userData = { life: 0, maxLife: TRACER_LIFE, glowMat, coreMat, glow, core };
      return t;
    };
    this._tracerPool = GTA.makePool(factory, grp);

    // muzzle flash: an additive emissive sphere we pop at the muzzle for a frame
    // or two, tinted per weapon and scale-pulsed for a livelier pop.
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffd24a, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), flashMat);
    flash.frustumCulled = false;
    flash.visible = false;
    grp.add(flash);
    this._flash = flash;
    this._flashT = 0;
    this._flashMax = FLASH_LIFE;
  },

  // ============================================================
  // UPDATE — input handling, timers, FX decay
  // ============================================================
  update(dt, ctx) {
    if (!THREE) return;
    const player = ctx.player;
    const input = ctx.input;
    if (!player || !input) return;

    // tick timers regardless of alive state so FX clear out cleanly
    if (this.cooldown > 0) this.cooldown -= dt;
    this._decayFx(dt);

    // keep the avatar's visible weapon mesh in sync with the equipped weapon —
    // this is what makes the modeled gun (and the fists = no-gun state) show up,
    // and updates userData.muzzle so tracers/flash leave the right barrel.
    if (this._shownWeapon !== this.current) this._syncWeaponMesh();

    // reload progress
    if (this.reloading) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) this._finishReload();
    }

    // dead players don't act
    if (player.alive === false) return;

    // ---- weapon selection: Digit1..Digit5 (slot) ----
    for (let n = 1; n <= 5; n++) {
      if (input.consume && input.consume('Digit' + n)) {
        this.api.select(n);
      }
    }
    // ---- Tab cycles weapons ----
    if (input.consume && input.consume('Tab')) {
      this._cycleWeapon(1);
    }
    // ---- R reloads ----
    if (input.consume && input.consume('KeyR')) {
      this._beginReload();
    }

    // ---- firing ----
    // Can't fire while in a vehicle (drive-by not modeled), reloading, or unlocked
    if (player.inVehicle) return;
    if (!input.pointerLocked) return;

    const w = WEAPONS[this.current] || WEAPONS.fists;
    let wantFire = false;
    if (w.auto) {
      // hold-to-fire
      wantFire = !!input.mouseDown;
    } else {
      // semi: one shot per click edge
      wantFire = !!(input.consumeMouse && input.consumeMouse(0));
    }

    if (wantFire && this.cooldown <= 0 && !this.reloading) {
      if (w.melee) {
        this._meleeAttack(ctx, w);
        this.cooldown = w.fireCooldown;
      } else {
        const slot = this.owned[w.id];
        if (slot && slot.clip > 0) {
          this._fire(ctx, w);
          this.cooldown = w.fireCooldown;
        } else {
          // empty: auto-attempt reload if reserves exist, else dry-click cooldown
          if (slot && slot.reserve > 0) this._beginReload();
          else this.cooldown = 0.25;
        }
      }
    }
  },

  // ============================================================
  // RESET — called on respawn / re-enter. No mesh rebuilds.
  // ============================================================
  reset(ctx) {
    this._restoreOnSpawn(ctx || this.ctx);
  },

  _restoreOnSpawn(ctx) {
    if (!ctx) ctx = this.ctx;
    // clear timers + FX
    this.cooldown = 0;
    this.reloading = false;
    this.reloadT = 0;
    this._shownWeapon = null;   // re-sync the in-hand weapon mesh after respawn/re-enter
    this._flashT = 0;
    if (this._flash) { this._flash.visible = false; this._flash.material.opacity = 0; }
    if (this._tracerPool) {
      for (const ln of this._tracerPool.items) { ln.visible = false; ln.userData.life = 0; }
    }
    // refill current weapon's clip from its reserve (cap to clip size)
    const w = WEAPONS[this.current];
    const slot = this.owned && this.owned[this.current];
    if (w && slot && !w.melee) {
      const need = w.clip - slot.clip;
      if (need > 0) {
        const take = Math.min(need, slot.reserve);
        slot.clip += take;
        slot.reserve -= take;
      }
    }
    // restore player health/armor + weapon id
    if (ctx && ctx.player) {
      ctx.player.health = ctx.player.maxHealth || 100;
      ctx.player.weapon = this.current;
    }
  },

  // ============================================================
  // FIRING — hitscan
  // ============================================================
  _fire(ctx, w) {
    const player = ctx.player;
    const slot = this.owned[w.id];
    if (!slot) return;
    slot.clip = Math.max(0, slot.clip - 1);

    // ray origin = camera position; base dir = camera forward
    if (ctx.camera) _origin.copy(ctx.camera.position);
    if (GTA.host && typeof GTA.host.cameraDir === 'function') {
      GTA.host.cameraDir(_dir);
    } else if (ctx.camera) {
      ctx.camera.getWorldDirection(_dir);
    } else {
      _dir.set(0, 0, -1);
    }
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1);
    _dir.normalize();

    const pellets = Math.max(1, w.pellets | 0);
    let anyHit = false;
    const style = TRACER_STYLE[w.id] || TRACER_STYLE.pistol;

    // tracers are DRAWN from the avatar's muzzle node (the ray is still cast from
    // the camera so aim matches the crosshair), so bullets visibly leave the gun.
    this._muzzleStart(ctx, _muzzleWorld);

    for (let p = 0; p < pellets; p++) {
      _rayDir.copy(_dir);
      if (w.spread > 0) this._jitter(_rayDir, w.spread);
      const hit = this._castRay(ctx, _origin, _rayDir, w.rangeM, w.damage);
      // tracer endpoint: impact point if we hit, else max range along the ray
      _tmpA.copy(_origin).addScaledVector(_rayDir, hit.dist);
      this._spawnTracer(_muzzleWorld, _tmpA, style);
      if (hit.hit) anyHit = true;
    }

    // muzzle flash at the avatar's muzzle node
    this._spawnFlash(ctx, style);

    // feedback + crime + recoil
    if (player) {
      _crimePos.copy(player.pos);
      ctx.bus.emit('crime', { kind: 'gunfire', pos: _crimePos, severity: 0.6, source: 'player' });
    }
    ctx.bus.emit('shake', { amount: w.auto ? 0.3 : (w.id === 'shotgun' ? 1.0 : 0.6) });
    if (GTA.host && typeof GTA.host.addRecoil === 'function') {
      GTA.host.addRecoil(w.id === 'shotgun' ? 0.05 : w.id === 'ak47' ? 0.035 : 0.022);
    }
    ctx.bus.emit('weapon:changed', { slot: w.slot, weapon: this._weaponSnapshot() });

    return anyHit;
  },

  // Cast one ray against ctx.targets; returns {hit, dist, entry}.
  // Applies onHit(damage,'player',hitPoint) to the nearest valid target.
  _castRay(ctx, origin, dir, range, damage) {
    const targets = ctx.targets;
    let best = null;
    let bestT = range;             // param distance along the ray to the chosen target
    if (Array.isArray(targets)) {
      for (let i = 0; i < targets.length; i++) {
        const e = targets[i];
        if (!e || e.dead || !e.pos) continue;
        // aim point = entry center, raised toward upper body
        const h = e.height || 1.8;
        _aimPoint.set(e.pos.x, e.pos.y + h * 0.6, e.pos.z);
        // project aim point onto the ray
        _toTarget.copy(_aimPoint).sub(origin);
        const t = _toTarget.dot(dir);           // distance along ray to closest approach
        if (t <= 0 || t > range) continue;       // behind us or out of range
        // closest point on ray
        _hitPoint.copy(origin).addScaledVector(dir, t);
        const perp = _hitPoint.distanceTo(_aimPoint);
        const r = (e.radius || 0.5) + AIM_ASSIST;
        if (perp <= r && t < bestT) {
          bestT = t;
          best = e;
        }
      }
    }
    if (best) {
      // recompute the impact point on the chosen target's closest approach
      _hitPoint.copy(origin).addScaledVector(dir, bestT);
      if (typeof best.onHit === 'function') {
        try { best.onHit(damage, 'player', _hitPoint); }
        catch (err) { /* never let a target's handler brick the frame */ }
      }
      return { hit: true, dist: bestT, entry: best };
    }
    return { hit: false, dist: range, entry: null };
  },

  // jitter a unit direction by up to `spread` radians around a random axis
  _jitter(d, spread) {
    // build two perpendicular axes to d
    _tmpA.set(0, 1, 0);
    if (Math.abs(d.y) > 0.9) _tmpA.set(1, 0, 0);
    // u = d x up  (perpendicular), v = d x u (perpendicular to both)
    const ux = d.y * _tmpA.z - d.z * _tmpA.y;
    const uy = d.z * _tmpA.x - d.x * _tmpA.z;
    const uz = d.x * _tmpA.y - d.y * _tmpA.x;
    const ul = Math.hypot(ux, uy, uz) || 1;
    const nux = ux / ul, nuy = uy / ul, nuz = uz / ul;
    const vx = d.y * nuz - d.z * nuy;
    const vy = d.z * nux - d.x * nuz;
    const vz = d.x * nuy - d.y * nux;
    const rng = this.ctx && this.ctx.rng ? this.ctx.rng : Math.random;
    const ang = (rng() * 2 - 1) * spread;
    const rot = rng() * Math.PI * 2;
    const oxa = Math.cos(rot) * ang, oxb = Math.sin(rot) * ang;
    d.x += nux * oxa + vx * oxb;
    d.y += nuy * oxa + vy * oxb;
    d.z += nuz * oxa + vz * oxb;
    d.normalize();
  },

  // ============================================================
  // MELEE — short forward sphere check against ctx.targets
  // ============================================================
  _meleeAttack(ctx, w) {
    const player = ctx.player;
    if (!player) return;
    // forward along player facing (flat on XZ)
    const f = (player.facing != null) ? player.facing
      : (GTA.host && GTA.host.yaw ? GTA.host.yaw() : (player.yaw || 0));
    _meleeFwd.set(Math.sin(f), 0, Math.cos(f));
    // check point a little ahead of the player at torso height
    const reach = w.rangeM;
    _tmpA.set(
      player.pos.x + _meleeFwd.x * reach * 0.6,
      player.pos.y + 1.0,
      player.pos.z + _meleeFwd.z * reach * 0.6,
    );

    const targets = ctx.targets;
    let best = null, bestD = Infinity;
    if (Array.isArray(targets)) {
      for (let i = 0; i < targets.length; i++) {
        const e = targets[i];
        if (!e || e.dead || !e.pos) continue;
        const dx = e.pos.x - player.pos.x;
        const dz = e.pos.z - player.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > (reach + (e.radius || 0.5)) * (reach + (e.radius || 0.5))) continue;
        // must be roughly in front (dot with facing > 0)
        if (dx * _meleeFwd.x + dz * _meleeFwd.z <= 0) continue;
        if (d2 < bestD) { bestD = d2; best = e; }
      }
    }
    // brief swing flash for feedback
    this._spawnFlash(ctx);
    ctx.bus.emit('shake', { amount: 0 });

    if (best) {
      _hitPoint.set(best.pos.x, best.pos.y + (best.height || 1.8) * 0.6, best.pos.z);
      if (typeof best.onHit === 'function') {
        try { best.onHit(w.damage, 'player', _hitPoint); }
        catch (err) { /* swallow */ }
      }
      _crimePos.copy(player.pos);
      ctx.bus.emit('crime', { kind: 'assault', pos: _crimePos, severity: 0.4, source: 'player' });
    }
  },

  // ============================================================
  // RELOAD
  // ============================================================
  _beginReload() {
    if (this.reloading) return;
    const w = WEAPONS[this.current];
    if (!w || w.melee) return;
    const slot = this.owned[this.current];
    if (!slot) return;
    if (slot.clip >= w.clip) return;       // already full
    if (slot.reserve <= 0) return;         // nothing to load
    this.reloading = true;
    this.reloadT = RELOAD_TIME;
  },

  _finishReload() {
    this.reloading = false;
    this.reloadT = 0;
    const w = WEAPONS[this.current];
    const slot = this.owned[this.current];
    if (!w || !slot || w.melee) return;
    const need = w.clip - slot.clip;
    if (need <= 0) return;
    const take = Math.min(need, slot.reserve);
    slot.clip += take;
    slot.reserve -= take;
    if (this.ctx) this.ctx.bus.emit('weapon:changed', { slot: w.slot, weapon: this._weaponSnapshot() });
  },

  // ============================================================
  // WEAPON SELECTION
  // ============================================================
  _cycleWeapon(dir) {
    // build the list of owned weapons in canonical order
    const ownedIds = CYCLE_ORDER.filter((id) => this.owned[id]);
    if (ownedIds.length === 0) return;
    let idx = ownedIds.indexOf(this.current);
    if (idx < 0) idx = 0;
    idx = (idx + dir + ownedIds.length) % ownedIds.length;
    this._equip(ownedIds[idx]);
  },

  _equip(id) {
    if (!WEAPONS[id]) return;
    if (!this.owned[id]) return;            // can't equip what you don't own
    if (this.current === id) return;
    this.current = id;
    this.reloading = false;
    this.reloadT = 0;
    this.cooldown = Math.max(this.cooldown, 0.12);   // small switch delay
    if (this.ctx && this.ctx.player) this.ctx.player.weapon = id;
    if (this.ctx) this.ctx.bus.emit('weapon:changed', { slot: WEAPONS[id].slot, weapon: this._weaponSnapshot() });
  },

  _weaponSnapshot() {
    const w = WEAPONS[this.current];
    const slot = this.owned[this.current] || { clip: 0, reserve: 0 };
    if (!w) return null;
    return { id: w.id, name: w.name, clip: slot.clip, reserve: slot.reserve, melee: !!w.melee };
  },

  // ============================================================
  // FX — tracers + muzzle flash (pooled, timer-decayed)
  // ============================================================
  // resolve the world-space point a tracer should start from: the avatar's muzzle
  // node (set per weapon by buildPerson's setWeapon), or a fallback just ahead of
  // the camera if the rig has no muzzle.
  _muzzleStart(ctx, out) {
    const player = ctx.player;
    const mz = player && player.mesh && player.mesh.userData ? player.mesh.userData.muzzle : null;
    if (mz && mz.getWorldPosition) { mz.getWorldPosition(out); return out; }
    if (ctx.camera) { out.copy(ctx.camera.position).addScaledVector(_dir, 0.5); return out; }
    out.set(0, 1.3, 0); return out;
  },

  _spawnTracer(a, b, style) {
    if (!this._tracerPool) return;
    // makePool: we manually grab one item without the begin/end frame cycle so
    // tracers can live across frames; we recycle the oldest by scanning life.
    const t = this._acquireTracer();
    if (!t) return;
    const ud = t.userData;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz) || 0.001;
    // place the beam at the segment midpoint, oriented from a -> b (cylinder is +Y)
    t.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    _beamDir.set(dx / len, dy / len, dz / len);
    t.quaternion.setFromUnitVectors(_beamUp, _beamDir);
    const r = (style && style.r) || 0.02;
    ud.glow.scale.set(r, len, r);
    ud.core.scale.set(r * 0.38, len, r * 0.38);
    ud.glowMat.color.setHex((style && style.glow) || 0xffe48a);
    ud.coreMat.color.setHex((style && style.core) || 0xffffff);
    ud.glowMat.opacity = 0.5; ud.coreMat.opacity = 0.95;
    ud.maxLife = (style && style.life) || TRACER_LIFE;
    ud.life = ud.maxLife;
    t.visible = true;
  },

  // grab a free (expired) tracer from the pool, growing it if all are live
  _acquireTracer() {
    const items = this._tracerPool.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].userData.life <= 0) return items[i];
    }
    // all busy -> grow the pool by one (begin/get extends items, end re-hides
    // unused; we immediately re-show the new one ourselves)
    this._tracerPool.begin();
    let made = null;
    const target = items.length + 1;
    while (this._tracerPool.items.length < target) made = this._tracerPool.get();
    this._tracerPool.end();
    return made || this._tracerPool.items[this._tracerPool.items.length - 1];
  },

  _spawnFlash(ctx, style) {
    const flash = this._flash;
    if (!flash) return;
    const player = ctx.player;
    const muzzle = player && player.mesh && player.mesh.userData ? player.mesh.userData.muzzle : null;
    if (muzzle && muzzle.getWorldPosition) {
      muzzle.getWorldPosition(_muzzleWorld);
      flash.position.copy(_muzzleWorld);
    } else if (player) {
      // fall back to a point in front of the player's chest
      const f = (player.facing != null) ? player.facing : 0;
      flash.position.set(
        player.pos.x + Math.sin(f) * 0.6,
        player.pos.y + 1.3,
        player.pos.z + Math.cos(f) * 0.6,
      );
    }
    flash.material.color.setHex(style && style.core ? style.core : 0xffd24a);
    // bigger pop for the heavier guns
    this._flashSize = style === TRACER_STYLE.shotgun ? 1.5 : style === TRACER_STYLE.ak47 ? 1.3 : 1.0;
    flash.visible = true;
    flash.material.opacity = 0.98;
    this._flashT = FLASH_LIFE;
  },

  // Show the modeled weapon that matches the equipped one. buildPerson hangs all
  // five weapons on the avatar + a setWeapon(id) that toggles visibility and points
  // userData.muzzle at the active barrel; we just drive it from the equipped id.
  _syncWeaponMesh() {
    const mesh = this.ctx && this.ctx.player && this.ctx.player.mesh;
    const ud = mesh && mesh.userData;
    if (ud && typeof ud.setWeapon === 'function') {
      try { ud.setWeapon(this.current); } catch (e) { /* never brick a frame on cosmetics */ }
    }
    this._shownWeapon = this.current;   // record even on a no-op rig so we don't retry every frame
  },

  _decayFx(dt) {
    // tracers — fade glow + core over each tracer's (per-weapon) life
    if (this._tracerPool) {
      const items = this._tracerPool.items;
      for (let i = 0; i < items.length; i++) {
        const t = items[i];
        const ud = t.userData;
        if (ud.life > 0) {
          ud.life -= dt;
          const k = Math.max(0, ud.life / (ud.maxLife || TRACER_LIFE));
          ud.glowMat.opacity = 0.5 * k;
          ud.coreMat.opacity = 0.95 * k;
          if (ud.life <= 0) { t.visible = false; ud.glowMat.opacity = 0; ud.coreMat.opacity = 0; }
        }
      }
    }
    // muzzle flash
    if (this._flash && this._flashT > 0) {
      this._flashT -= dt;
      const k = Math.max(0, this._flashT / (this._flashMax || FLASH_LIFE));
      this._flash.material.opacity = 0.98 * k;
      // pulse the scale a touch for a livelier pop (sized per weapon)
      const s = (this._flashSize || 1) * (0.7 + k * 0.8);
      this._flash.scale.set(s, s, s);
      if (this._flashT <= 0) { this._flash.visible = false; this._flash.material.opacity = 0; }
    }
  },

  // ============================================================
  // PUBLIC API
  // ============================================================
  api: {
    // grant a weapon (and optionally equip it). Tops up reserve on re-grant.
    giveWeapon(id, equip = false) {
      const w = WEAPONS[id];
      if (!w) return false;
      if (!combat.owned) combat.owned = {};
      if (!combat.owned[id]) {
        // first time: full clip + a sensible starting reserve (one extra clip
        // for guns; capped to reserveMax)
        const startReserve = w.melee ? 0 : Math.min(w.reserveMax, w.clip * 2);
        combat.owned[id] = { clip: w.clip, reserve: startReserve };
      } else {
        // re-grant: refill clip + add a clip of reserve (capped)
        const slot = combat.owned[id];
        if (!w.melee) {
          if (slot.clip < w.clip) slot.clip = w.clip;
          slot.reserve = Math.min(w.reserveMax, slot.reserve + w.clip);
        }
      }
      if (equip) combat._equip(id);
      if (combat.ctx) {
        combat.ctx.bus.emit('weapon:changed', {
          slot: w.slot, weapon: combat._weaponSnapshot(),
        });
        combat.ctx.bus.emit('toast', { html: `Picked up <b>${w.name}</b>`, ms: 1800 });
      }
      return true;
    },

    // add reserve ammo for a weapon you own (no-op for melee / unowned)
    addAmmo(id, n) {
      const w = WEAPONS[id];
      if (!w || w.melee) return 0;
      if (!combat.owned || !combat.owned[id]) return 0;
      const slot = combat.owned[id];
      const before = slot.reserve;
      slot.reserve = GU.clamp(slot.reserve + (n || 0), 0, w.reserveMax);
      if (id === combat.current && combat.ctx) {
        combat.ctx.bus.emit('weapon:changed', { slot: w.slot, weapon: combat._weaponSnapshot() });
      }
      return slot.reserve - before;
    },

    // heal the player, capped to maxHealth
    heal(n) {
      const p = combat.ctx && combat.ctx.player;
      if (!p) return 0;
      const max = p.maxHealth || 100;
      const before = p.health;
      p.health = GU.clamp((p.health || 0) + (n || 0), 0, max);
      return p.health - before;
    },

    // add armor, capped to 100
    addArmor(n) {
      const p = combat.ctx && combat.ctx.player;
      if (!p) return 0;
      const before = p.armor || 0;
      p.armor = GU.clamp(before + (n || 0), 0, 100);
      return p.armor - before;
    },

    // apply damage to the player: armor soaks first, then health.
    // emits 'playerHurt'; on lethal, emits 'playerWasted' (host respawns).
    damagePlayer(amount, srcKind, pos) {
      const p = combat.ctx && combat.ctx.player;
      if (!p) return;
      if (p.alive === false) return;
      let dmg = Math.max(0, amount || 0);
      if (dmg <= 0) return;

      // armor absorbs up to its value (2/3 to armor, rest to health while armor>0)
      if ((p.armor || 0) > 0) {
        const soak = Math.min(p.armor, dmg * 0.66);
        p.armor = Math.max(0, p.armor - soak);
        dmg -= soak;
      }
      p.health = Math.max(0, (p.health || 0) - dmg);

      const bus = combat.ctx.bus;
      bus.emit('playerHurt', {
        amount: amount || 0, health: p.health, armor: p.armor || 0, source: srcKind || 'unknown',
      });
      bus.emit('shake', { amount: Math.min(2, (amount || 0) / 18) });

      if (p.health <= 0 && p.alive !== false) {
        // mark provisionally dead; host flips alive on the wasted handler/respawn
        p.alive = false;
        const wp = pos ? { x: pos.x, y: pos.y || 0, z: pos.z }
          : { x: p.pos.x, y: p.pos.y || 0, z: p.pos.z };
        bus.emit('playerWasted', { pos: wp, cause: srcKind || 'killed' });
      }
    },

    // current weapon snapshot, or null
    currentWeapon() {
      return combat._weaponSnapshot();
    },

    // select a weapon by id ('pistol') or slot number (1..5). Returns success.
    select(idOrSlot) {
      let id = idOrSlot;
      if (typeof idOrSlot === 'number') id = SLOT_TO_ID[idOrSlot];
      if (!id || !WEAPONS[id]) return false;
      if (!combat.owned || !combat.owned[id]) {
        // requested a weapon you don't own: ignore quietly
        return false;
      }
      combat._equip(id);
      return true;
    },

    // expose read-only weapon defs for any UI that wants them
    weaponDefs() { return WEAPONS; },
    owned() { return combat.owned; },
    isReloading() { return combat.reloading; },
  },
};

GTA.register(combat);
export default combat;
