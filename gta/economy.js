// ============================================================
// gta/economy.js — the money ledger AND the world-pickup manager
// ------------------------------------------------------------
// Two jobs, one system:
//
//   1. THE LEDGER. player.money is the single source of truth; this system is
//      the only thing that should mutate it (other systems call our api). Every
//      change emits money:changed {delta, total, reason} so the HUD and missions
//      can react. If ctx.config.persist is on, we mirror the balance + a tiny
//      stats blob to localStorage (wrapped in try/catch so a locked-down browser
//      or private-mode quota error can never brick a frame).
//
//   2. THE PICKUP MANAGER. Any system that wants a collectible to appear in the
//      world emits 'spawnPickup' {kind,value,pos}; we build a small original
//      low-poly mesh for it, float/spin it, and on player proximity apply the
//      effect + emit 'pickup'. Cash drops itself; health/armor/ammo defer to the
//      combat system (null-checked — combat may not be loaded yet). We pool the
//      meshes, cap the live count, and expire stale ones with a fade.
//
// All art is generated in code (Box/Cylinder/Cone/Sphere + MeshStandardMaterial).
// No textures, no loaders, no external URLs, no third-party IP.
//
// Decoupling rules honoured:
//   * we never reach into another system's internals — only ctx.systems.x.api,
//     always null-checked because load order varies and siblings may be absent.
//   * we never throw out of init/update/reset — everything is guarded so one bad
//     frame can't take the host down.
//   * no per-frame allocation on the hot path — scratch vectors at module scope,
//     pooled meshes reused rather than created/destroyed.
// ============================================================
import { GTA, GU } from './core.js';

// ---- tunables --------------------------------------------------------------
const MAX_PICKUPS   = 40;      // hard cap on simultaneously-live pickups
const PICKUP_RADIUS = 1.6;     // XZ collection radius (metres)
const PICKUP_TTL    = 45;      // seconds before a pickup expires
const FADE_TIME     = 1.2;     // seconds of shrink/fade on expiry or collection
const BOB_AMP       = 0.22;    // vertical bob amplitude (metres)
const BOB_FREQ      = 2.0;     // bob cycles (radians/sec base)
const SPIN_SPEED    = 1.6;     // spin (radians/sec)
const FLOAT_BASE    = 0.85;    // resting height of a pickup centre above ground
const LANDMARK_DROPS = 7;      // demo cash drops seeded near landmarks on init

const LS_MONEY = 'gta.money';
const LS_STATS = 'gta.stats';

// colour palette per pickup kind (original art; no brand colours implied)
const KIND_COLOR = {
  cash:   0x3fbf6a,
  health: 0xdd3b3b,
  armor:  0x3f7adf,
  ammo:   0x9aa0a8,
};

// ---- module-scope scratch (no per-frame allocation) ------------------------
let _THREE = null;
let _scratch = null;                 // THREE.Vector3 scratch (reserved for math)
let _scratch2 = null;                // THREE.Vector3 scratch (reserved for math)

// ============================================================
// SHARED GEOMETRY / MATERIAL CACHES
// ------------------------------------------------------------
// Built once in init(); reused across every pickup mesh so we never allocate a
// new BufferGeometry/Material per spawn. Keyed by kind where it matters.
// ============================================================
const geo = {};   // geometry cache
const mat = {};   // material cache (per kind)

function buildCaches(THREE) {
  // geometries -------------------------------------------------------------
  // cash: a flattened spinning "coin/billfold" disc + a thin band (rounder rings)
  geo.cashDisc = new THREE.CylinderGeometry(0.42, 0.42, 0.12, 32);
  geo.cashBand = new THREE.BoxGeometry(0.86, 0.16, 0.04);
  // health: a plus/cross made of two boxes on a small base
  geo.crossV   = new THREE.BoxGeometry(0.18, 0.62, 0.18);
  geo.crossH   = new THREE.BoxGeometry(0.62, 0.18, 0.18);
  geo.podium   = new THREE.CylinderGeometry(0.34, 0.4, 0.14, 28);
  // armor: a faceted shield (icosahedron) + rim
  geo.shield   = new THREE.IcosahedronGeometry(0.42, 0);
  geo.shieldRim = new THREE.CylinderGeometry(0.46, 0.46, 0.1, 28);
  // ammo: a stubby box "magazine" + a small cone tip
  geo.ammoBody = new THREE.BoxGeometry(0.42, 0.5, 0.3);
  geo.ammoTip  = new THREE.ConeGeometry(0.16, 0.22, 16);
  // shared glow base ring under every pickup (helps readability)
  geo.glowRing = new THREE.CylinderGeometry(0.5, 0.5, 0.04, 32);

  // materials --------------------------------------------------------------
  // glossy + strongly emissive so pickups read as glowing "energy" (the bloom
  // pass makes the emissive bloom). Premium metal/roughness for a AAA sheen.
  for (const kind of Object.keys(KIND_COLOR)) {
    const col = KIND_COLOR[kind];
    mat[kind] = new THREE.MeshStandardMaterial({
      color: col,
      emissive: col,
      emissiveIntensity: 1.1,
      roughness: 0.28,
      metalness: 0.6,
      envMapIntensity: 0.9,
      transparent: true,
      opacity: 1,
    });
  }
  // accents reused across kinds
  mat.dark  = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.45, metalness: 0.5, transparent: true, opacity: 1 });
  mat.light = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, emissive: 0xffffff, emissiveIntensity: 1.0, roughness: 0.3, transparent: true, opacity: 1 });
}

// Build the visual group for a given kind. Each pool slot gets ONE group whose
// children we swap visibility on by kind, so a pooled mesh can represent any
// kind without rebuilding geometry. Returns {group, parts} where parts maps
// kind -> child group to show.
function buildPickupGroup(THREE) {
  const group = new THREE.Group();
  group.name = 'gta-pickup';

  // Per-slot CLONED materials. Each pooled pickup gets its own material
  // instances so per-pickup fade never mutates the shared cache (which is
  // reused by every other live pickup). Geometry stays shared. We collect
  // every cloned material on the group so opacity can be applied/reset per
  // instance, and remember per-kind colour materials for re-tinting on reuse.
  const ringMat   = mat.dark.clone();   // glow base ring (its own clone)
  const cashMat   = mat.cash.clone();
  const healthMat = mat.health.clone();
  const armorMat  = mat.armor.clone();
  const ammoMat   = mat.ammo.clone();
  const podiumMat = mat.dark.clone();   // health podium accent
  // mat.light is shared across cash band, armor rim and ammo tip; give each
  // its own clone so a fade on one pickup can't bleed into the others.
  const cashLightMat  = mat.light.clone();
  const armorLightMat = mat.light.clone();
  const ammoLightMat  = mat.light.clone();
  const ownMats = [
    ringMat, cashMat, healthMat, armorMat, ammoMat, podiumMat,
    cashLightMat, armorLightMat, ammoLightMat,
  ];
  for (const mm of ownMats) mm.transparent = true;

  // glow base ring shared by all kinds (its colour is tinted at render time)
  const ring = new THREE.Mesh(geo.glowRing, ringMat);
  ring.position.y = -FLOAT_BASE + 0.03;
  group.add(ring);

  const parts = {};

  // --- cash ---------------------------------------------------------------
  const cash = new THREE.Group();
  const disc = new THREE.Mesh(geo.cashDisc, cashMat);
  disc.rotation.x = Math.PI / 2;
  const band = new THREE.Mesh(geo.cashBand, cashLightMat);
  cash.add(disc, band);
  parts.cash = cash;

  // --- health -------------------------------------------------------------
  const health = new THREE.Group();
  const podium = new THREE.Mesh(geo.podium, podiumMat);
  podium.position.y = -0.22;
  const cv = new THREE.Mesh(geo.crossV, healthMat);
  const ch = new THREE.Mesh(geo.crossH, healthMat);
  cv.position.y = 0.06; ch.position.y = 0.06;
  health.add(podium, cv, ch);
  parts.health = health;

  // --- armor --------------------------------------------------------------
  const armor = new THREE.Group();
  const shield = new THREE.Mesh(geo.shield, armorMat);
  shield.scale.set(1, 1.15, 0.55);
  const rim = new THREE.Mesh(geo.shieldRim, armorLightMat);
  rim.rotation.x = Math.PI / 2;
  rim.scale.set(1, 1, 0.5);
  rim.position.z = -0.02;
  armor.add(shield, rim);
  parts.armor = armor;

  // --- ammo ---------------------------------------------------------------
  const ammo = new THREE.Group();
  const body = new THREE.Mesh(geo.ammoBody, ammoMat);
  const tip = new THREE.Mesh(geo.ammoTip, ammoLightMat);
  tip.position.y = 0.36;
  ammo.add(body, tip);
  parts.ammo = ammo;

  group.add(cash, health, armor, ammo);
  group.userData.ring = ring;
  group.userData.parts = parts;
  // per-kind colour material this slot owns (for resetting colour on reuse)
  group.userData.kindMats = { cash: cashMat, health: healthMat, armor: armorMat, ammo: ammoMat };
  // every cloned material this slot owns (for per-instance opacity + reset)
  group.userData.ownMats = ownMats;
  GTA.shadowize(group, true, false);
  return group;
}

// ============================================================
// THE SYSTEM
// ============================================================
const economy = {
  name: 'economy',
  deps: [],

  // live state
  _ctx: null,
  _root: null,           // THREE.Group parent for all pickup meshes
  _pool: null,           // GTA.makePool of pickup groups
  _pickups: [],          // active pickup records
  _stats: { kills: 0, cashEarned: 0, cashSpent: 0, pickups: 0, busts: 0, deaths: 0 },
  _unsub: [],            // bus unsubscribers
  _seeded: false,        // have we dropped the demo landmark cash yet
  _persist: true,

  // ----------------------------------------------------------
  // INIT — build caches/meshes, restore persisted money, wire the bus.
  // ----------------------------------------------------------
  init(ctx) {
    try {
      this._ctx = ctx;
      _THREE = ctx.THREE;
      this._persist = !!(ctx.config && ctx.config.persist);

      _scratch = new _THREE.Vector3();
      _scratch2 = new _THREE.Vector3();

      // build shared geometry/material caches once
      if (!geo.glowRing) buildCaches(_THREE);

      // a dedicated parent group keeps the scene graph tidy + cheap to hide
      if (!this._root) {
        this._root = new _THREE.Group();
        this._root.name = 'gta-economy-pickups';
        if (ctx.scene) ctx.scene.add(this._root);
      }

      // mesh pool — factory builds one multi-kind pickup group per slot
      if (!this._pool) {
        this._pool = GTA.makePool(() => buildPickupGroup(_THREE), this._root);
      }

      // ---- restore persisted money + stats -------------------------------
      this._loadPersisted(ctx);

      // ---- wire bus listeners (idempotent: clear old subs first) ----------
      this._wireBus(ctx);

      // ---- seed a few demo cash pickups around landmarks -----------------
      // Only once per process; reset() does not re-seed.
      if (!this._seeded) {
        this._seedLandmarkCash(ctx);
        this._seeded = true;
      }
    } catch (e) {
      console.error('[economy] init failed', e);
    }
  },

  _wireBus(ctx) {
    // drop any prior subscriptions (re-init / hot reload safety)
    for (const off of this._unsub) { try { off(); } catch (_) { /* ignore */ } }
    this._unsub.length = 0;

    const bus = ctx.bus || GTA.bus;
    if (!bus) return;

    // a system requested a world pickup
    this._unsub.push(bus.on('spawnPickup', (p) => this._onSpawnPickup(p)));

    // bookkeeping for stats (best-effort, never fatal)
    this._unsub.push(bus.on('entityKilled', (p) => {
      try { if (p && p.byPlayer) this._stats.kills++; this._saveStats(); } catch (_) { /* ignore */ }
    }));
    this._unsub.push(bus.on('playerBusted', () => {
      try { this._stats.busts++; this._saveStats(); } catch (_) { /* ignore */ }
    }));
    this._unsub.push(bus.on('playerWasted', () => {
      try { this._stats.deaths++; this._saveStats(); } catch (_) { /* ignore */ }
    }));
  },

  // ----------------------------------------------------------
  // UPDATE — bob/spin pickups, handle collection + expiry.
  // ----------------------------------------------------------
  update(dt, ctx) {
    try {
      const player = ctx.player;
      const list = this._pickups;
      if (!list.length) { if (this._pool) this._pool.end(); return; }

      const t = (ctx.time && ctx.time.t) || 0;
      const px = player ? player.pos.x : 0;
      const pz = player ? player.pos.z : 0;
      const playerAlive = !player || player.alive !== false;

      this._pool.begin();

      for (let i = list.length - 1; i >= 0; i--) {
        const pk = list[i];
        pk.age += dt;

        // ---- expiry / collection fade handling -------------------------
        if (pk.fading) {
          pk.fade -= dt;
          if (pk.fade <= 0) {
            // fully gone — remove record (its pool slot is just not re-got)
            list.splice(i, 1);
            continue;
          }
        } else if (pk.age >= PICKUP_TTL) {
          // begin a graceful fade-out instead of popping
          pk.fading = true;
          pk.fade = FADE_TIME;
          pk.collected = false;
        }

        // ---- collection test (skip if already fading/dead-player) -------
        if (!pk.fading && playerAlive) {
          const d = GU.dist2D(px, pz, pk.pos.x, pk.pos.z);
          if (d <= PICKUP_RADIUS) {
            this._collect(pk, ctx);
            // start collection fade (pop animation), keep rendering it briefly
            pk.fading = true;
            pk.fade = Math.min(FADE_TIME, 0.45);
            pk.collected = true;
          }
        }

        // ---- draw via pool ---------------------------------------------
        const m = this._pool.get();
        this._renderPickup(m, pk, t, dt);
      }

      this._pool.end();
    } catch (e) {
      console.error('[economy] update failed', e);
      try { if (this._pool) this._pool.end(); } catch (_) { /* ignore */ }
    }
  },

  // position/animate one pooled mesh to represent a pickup record
  _renderPickup(m, pk, t, dt) {
    const parts = m.userData.parts;
    // show only the matching kind sub-group
    for (const k in parts) parts[k].visible = (k === pk.kind);

    // This pool slot may have just been re-got for a different pickup/kind, so
    // reset its OWN cloned materials to opaque + correct kind colour first.
    // (Per-instance clones — never the shared cache — so other live pickups are
    // unaffected.)
    const kindMats = m.userData.kindMats;
    if (kindMats) {
      for (const k in kindMats) {
        const km = kindMats[k];
        if (km && km.color) km.color.setHex(KIND_COLOR[k]);
        if (km) km.opacity = 1;
      }
    }

    // tint the glow ring to the kind colour
    const ring = m.userData.ring;
    if (ring && ring.material) {
      const col = KIND_COLOR[pk.kind] || 0xffffff;
      if (ring.material.color) ring.material.color.setHex(col);
      ring.material.opacity = 0.35;
    }

    // bob + spin
    const phase = t * BOB_FREQ + pk.phase;
    const bob = Math.sin(phase) * BOB_AMP;
    m.position.set(pk.pos.x, FLOAT_BASE + bob, pk.pos.z);
    m.rotation.y = (t * SPIN_SPEED + pk.phase) % (Math.PI * 2);

    // fade / pop scale
    let scale = 1;
    let opacity = 1;
    if (pk.fading) {
      const f = GU.clamp(pk.fade / FADE_TIME, 0, 1);
      if (pk.collected) {
        // collection: quick pop upward + shrink
        scale = 1 + (1 - f) * 0.6;
        opacity = f;
        m.position.y += (1 - f) * 0.8;
      } else {
        // expiry: sink + shrink
        scale = f;
        opacity = f;
      }
    }
    m.scale.setScalar(GU.clamp(scale, 0.001, 2));

    // apply opacity to THIS slot's own cloned materials only (kind body +
    // light/dark accents). The shared cache is never touched, so fading one
    // pickup can't make every other pickup flicker transparent.
    this._applyOpacity(m, pk.kind, opacity);
  },

  // Write per-instance fade opacity onto the pool slot's OWN cloned materials.
  // The glow ring keeps its independently-set opacity (0.35) set in render.
  _applyOpacity(m, kind, opacity) {
    const own = m.userData.ownMats;
    if (!own) return;
    const ring = m.userData.ring;
    const ringMat = ring && ring.material;
    for (const mm of own) {
      // leave the ring's own clone at the 0.35 set in _renderPickup
      if (mm === ringMat) continue;
      mm.opacity = opacity;
    }
  },

  // ----------------------------------------------------------
  // RESET — called on respawn/re-enter. Keep money; clear EXPIRED pickups and
  // any that are mid-fade. Live ones stay so the world doesn't blink empty.
  // Per-pickup fade now lives on each slot's CLONED materials (reset to opaque
  // on reuse in _renderPickup), so the shared cache never needs un-fading.
  // ----------------------------------------------------------
  reset(ctx) {
    try {
      // drop fading/collected pickups so they don't linger after a respawn
      const list = this._pickups;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].fading) list.splice(i, 1);
      }
      // hide the tail of the pool (no pickups drawn until next update)
      if (this._pool) { this._pool.begin(); this._pool.end(); }
    } catch (e) {
      console.error('[economy] reset failed', e);
    }
  },

  // ============================================================
  // PICKUP SPAWN / COLLECT INTERNALS
  // ============================================================
  _onSpawnPickup(p) {
    try {
      if (!p) return;
      const kind = KIND_COLOR[p.kind] !== undefined ? p.kind : 'cash';
      const value = Number.isFinite(p.value) ? p.value : (kind === 'cash' ? 50 : 25);
      const pos = p.pos || (this._ctx && this._ctx.player ? this._ctx.player.pos : null);
      if (!pos) return;
      this._addPickup(kind, value, pos.x, pos.z);
    } catch (e) {
      console.error('[economy] spawnPickup handler failed', e);
    }
  },

  _addPickup(kind, value, x, z) {
    // enforce the cap by evicting the OLDEST non-fading pickup
    if (this._pickups.length >= MAX_PICKUPS) {
      let oldestIdx = -1, oldestAge = -1;
      for (let i = 0; i < this._pickups.length; i++) {
        const pk = this._pickups[i];
        if (!pk.fading && pk.age > oldestAge) { oldestAge = pk.age; oldestIdx = i; }
      }
      if (oldestIdx >= 0) this._pickups.splice(oldestIdx, 1);
      else this._pickups.shift(); // all fading — drop head
    }
    this._pickups.push({
      kind,
      value,
      pos: { x, z },
      age: 0,
      phase: (this._ctx && this._ctx.rng ? this._ctx.rng() : Math.random()) * Math.PI * 2,
      fading: false,
      fade: 0,
      collected: false,
    });
  },

  _collect(pk, ctx) {
    try {
      const combat = ctx.systems && ctx.systems.combat ? ctx.systems.combat.api : null;
      switch (pk.kind) {
        case 'cash':
          this.api.add(pk.value, 'pickup');
          break;
        case 'health':
          if (combat && typeof combat.heal === 'function') combat.heal(pk.value);
          else if (ctx.player) {
            // graceful fallback if combat isn't loaded: bump health directly
            const max = ctx.player.maxHealth || 100;
            ctx.player.health = GU.clamp((ctx.player.health || 0) + pk.value, 0, max);
          }
          break;
        case 'armor':
          if (combat && typeof combat.addArmor === 'function') combat.addArmor(pk.value);
          else if (ctx.player) ctx.player.armor = GU.clamp((ctx.player.armor || 0) + pk.value, 0, 100);
          break;
        case 'ammo':
          if (combat && typeof combat.addAmmo === 'function') {
            const wid = (ctx.player && ctx.player.weapon) || 'pistol';
            combat.addAmmo(wid, pk.value);
          }
          break;
        default:
          break;
      }
      this._stats.pickups++;
      this._saveStats();

      const bus = ctx.bus || GTA.bus;
      if (bus) bus.emit('pickup', { kind: pk.kind, value: pk.value, pos: { x: pk.pos.x, y: FLOAT_BASE, z: pk.pos.z } });
    } catch (e) {
      console.error('[economy] collect failed', e);
    }
  },

  // ----------------------------------------------------------
  // DEMO SEED — scatter a few cash pickups near landmarks so a freshly-booted
  // standalone demo has things to grab. Best-effort; skipped if no world.
  // ----------------------------------------------------------
  _seedLandmarkCash(ctx) {
    try {
      const world = ctx.systems && ctx.systems.world ? ctx.systems.world.api : (ctx.world || null);
      const rng = ctx.rng || Math.random;
      if (world && typeof world.landmarks === 'function') {
        const lms = world.landmarks() || [];
        if (lms.length) {
          for (let i = 0; i < LANDMARK_DROPS; i++) {
            const lm = GU.pick(rng, lms);
            if (!lm || !lm.pos) continue;
            // jitter onto a free walkable spot near the landmark
            let x = lm.pos.x + GU.rand(rng, -8, 8);
            let z = lm.pos.z + GU.rand(rng, -8, 8);
            // avoid spawning inside a building if world can tell us
            if (typeof world.isInside === 'function' && world.isInside(x, z, 0.8)) {
              x = lm.pos.x + GU.rand(rng, -3, 3);
              z = lm.pos.z + GU.rand(rng, -3, 3);
            }
            const value = 25 + (rng() * 6 | 0) * 25;   // 25..150 in 25 steps
            this._addPickup('cash', value, x, z);
          }
          return;
        }
      }
      // no world available — drop a couple near the player so the demo isn't bare
      const px = ctx.player ? ctx.player.pos.x : 0;
      const pz = ctx.player ? ctx.player.pos.z : 0;
      for (let i = 0; i < 3; i++) {
        this._addPickup('cash', 50, px + GU.rand(rng, -6, 6), pz + GU.rand(rng, -6, 6));
      }
    } catch (e) {
      console.error('[economy] seed failed', e);
    }
  },

  // ============================================================
  // PERSISTENCE (localStorage; fully guarded)
  // ============================================================
  _loadPersisted(ctx) {
    const player = ctx.player;
    if (!player) return;
    if (!this._persist) {
      // not persisting — money stays whatever the host seeded (likely 0)
      return;
    }
    try {
      const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(LS_MONEY) : null;
      if (raw != null) {
        const v = parseInt(raw, 10);
        if (Number.isFinite(v) && v >= 0) player.money = v;
      }
    } catch (_) { /* storage blocked — ignore */ }
    try {
      const rawS = (typeof localStorage !== 'undefined') ? localStorage.getItem(LS_STATS) : null;
      if (rawS) {
        const obj = JSON.parse(rawS);
        if (obj && typeof obj === 'object') Object.assign(this._stats, obj);
      }
    } catch (_) { /* ignore */ }
  },

  _saveMoney() {
    if (!this._persist) return;
    try {
      const player = this._ctx && this._ctx.player;
      if (!player) return;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LS_MONEY, String(Math.max(0, Math.floor(player.money || 0))));
      }
    } catch (_) { /* quota/blocked — ignore */ }
  },

  _saveStats() {
    if (!this._persist) return;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LS_STATS, JSON.stringify(this._stats));
      }
    } catch (_) { /* ignore */ }
  },

  // ============================================================
  // PUBLIC API
  // ============================================================
  api: {
    // add money (negative = spend); floors balance at 0; emits money:changed.
    // Returns the new balance.
    add(amount, reason) {
      try {
        const ctx = economy._ctx;
        const player = ctx && ctx.player;
        if (!player) return 0;
        let delta = Number(amount);
        if (!Number.isFinite(delta)) delta = 0;
        delta = Math.round(delta);

        const prev = Math.max(0, Math.floor(player.money || 0));
        let next = prev + delta;
        if (next < 0) {
          // can't go below zero; clamp the effective delta
          delta = -prev;
          next = 0;
        }
        player.money = next;

        // stats bookkeeping
        if (delta > 0) economy._stats.cashEarned += delta;
        else if (delta < 0) economy._stats.cashSpent += -delta;

        economy._saveMoney();
        economy._saveStats();

        const bus = (ctx && ctx.bus) || GTA.bus;
        if (bus) bus.emit('money:changed', { delta, total: next, reason: reason || '' });
        return next;
      } catch (e) {
        console.error('[economy] add failed', e);
        return economy.api.balance();
      }
    },

    // spend if affordable; returns true on success, false if too poor.
    spend(amount, reason) {
      try {
        let n = Number(amount);
        if (!Number.isFinite(n)) n = 0;
        n = Math.abs(Math.round(n));
        if (!economy.api.canAfford(n)) return false;
        economy.api.add(-n, reason || 'spend');
        return true;
      } catch (e) {
        console.error('[economy] spend failed', e);
        return false;
      }
    },

    balance() {
      const player = economy._ctx && economy._ctx.player;
      return player ? Math.max(0, Math.floor(player.money || 0)) : 0;
    },

    canAfford(n) {
      let v = Number(n);
      if (!Number.isFinite(v)) v = 0;
      return economy.api.balance() >= Math.abs(Math.round(v));
    },

    // ---- extras other systems may find handy (all read-only / safe) ------
    stats() { return Object.assign({}, economy._stats); },

    // manually request a pickup (thin wrapper over the bus event)
    dropPickup(kind, value, pos) {
      try {
        const bus = (economy._ctx && economy._ctx.bus) || GTA.bus;
        if (bus) bus.emit('spawnPickup', { kind, value, pos });
      } catch (_) { /* ignore */ }
    },

    pickupCount() { return economy._pickups.length; },
  },
};

GTA.register(economy);
export default economy;
