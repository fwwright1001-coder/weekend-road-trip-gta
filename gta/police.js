// ============================================================
// gta/police.js — police response that scales with the wanted level
// ------------------------------------------------------------
// A self-registered crime-sandbox system. It owns a population of foot cops and
// (at 3+ stars) cruisers that converge on the player, scaled by the wanted
// level and ctx.config.difficulty. Cops are HITTABLE (pushed into ctx.targets
// so combat.js can raycast them), run a small seek/engage/arrest state machine,
// fire pistol-like shots at the player (via the 'damage' bus request), and keep
// the player "seen" so heat won't decay while cornered.
//
// All art is generated in code (original low-poly, no external assets). Every
// cross-system call is null-guarded because load order varies and sibling
// systems (wanted/combat/economy/vehicles) may not have initialised yet.
//
// Coordinate convention: right-handed, Y up. Cops walk the XZ plane; feet at
// Y=0; Y is height.
// ============================================================
import { GTA, GU } from './core.js';

// ---- tunables --------------------------------------------------------------
const COP_HEALTH       = 60;       // foot-cop hit points
const COP_RADIUS       = 0.5;      // hittable radius
const COP_HEIGHT       = 1.9;      // hittable height (aim point = pos.y + h*0.6)
const COP_SPEED        = 6.4;      // m/s seek speed
const COP_SPEED_HI     = 7.6;      // m/s at high stars (more aggressive)
const ENGAGE_RANGE     = 18;       // start shooting within this distance + LOS
const ENGAGE_RANGE_HI  = 26;       // wider engage band at high stars
const ARREST_RANGE     = 2.0;      // bust the player within this distance
const ARREST_TIME      = 0.8;      // player must be ~still this long to be busted
const ARREST_MAX_STARS = 2;        // no arrests above this many stars
const SEEN_RANGE       = 60;       // keep wanted "seen" within this distance + LOS
const FIRE_CADENCE     = 1.15;     // seconds between shots (1 star)
const FIRE_CADENCE_HI  = 0.7;      // seconds between shots (high stars)
const SHOT_DMG_MIN     = 6;        // bullet damage range -> 'damage' request
const SHOT_DMG_MAX     = 10;
const SHOT_RANGE       = 32;       // max distance a cop will actually hit at
const SHOT_HIT_FLOOR   = 0.5;      // min per-shot hit chance at long range (raised so any wanted level reliably FEELS dangerous)
const SHOT_GRAZE_MIN   = 2;        // a "miss" still grazes the player for a little HP...
const SHOT_GRAZE_MAX   = 3;        // ...so being shot at with LOS always chips health (no free misses)
const SPAWN_MIN_DIST   = 26;       // spawn cops at least this far from player
const SPAWN_MAX_DIST   = 90;       // ...and no further than this
const DESPAWN_DIST     = 170;      // cull wanderers that drift way off
const TRACER_LIFE      = 0.06;     // seconds a muzzle/tracer flash is visible
const CRUISER_SPEED    = 14;       // m/s pursuit cruiser speed
const CRUISER_STAR_MIN = 3;        // cruisers appear at 3+ stars
const MAX_COPS         = 16;       // hard cap on foot cops (safety)
const MAX_CARS         = 4;        // hard cap on cruisers (safety)
// ---- round-3: cover / flanking / backup / factions -------------------------
const FLANK_SPREAD     = 7;        // metres a flanking cop aims to the side of the player
const COVER_SEARCH     = 24;       // look for cover within this radius of the cop
const COVER_OFFSET     = 1.6;      // stand this far off a building edge when in cover
const COVER_REEVAL     = 1.6;      // re-pick a cover spot at most this often (s)
const COVER_CHANCE_LO  = 0.4;      // fraction of cops that use cover (low stars)
const COVER_CHANCE_HI  = 0.7;      // ...at high stars (more tactical)
const BACKUP_WINDOW    = 4.0;      // seconds of accelerated spawning after an officer-down / escalation
const GANG_STAR_MIN    = 3;        // a rival gang shows up in the chaos at 3+ stars
const GANG_MAX         = 4;        // hard cap on gang members
const GANG_HEALTH      = 45;       // gangster hit points
const GANG_SPEED       = 6.0;      // m/s
const GANG_ENGAGE      = 20;       // gang opens fire within this + LOS
const GANG_FIRE_CAD    = 1.0;      // gang shot cadence (s)
const GANG_SHOT_DMG    = 7;        // gang bullet damage (to player or a cop)
const GANG_SHOT_RANGE  = 30;

// star -> {foot cops, cruisers} base targets (scaled by difficulty)
const WAVE_TABLE = [
  { foot: 0,  cars: 0 },  // 0 stars
  { foot: 2,  cars: 0 },  // 1
  { foot: 4,  cars: 0 },  // 2
  { foot: 6,  cars: 1 },  // 3
  { foot: 8,  cars: 2 },  // 4
  { foot: 10, cars: 3 },  // 5 (swarm)
];

// ---- module-scope scratch (NO per-frame allocation) ------------------------
const _v1 = { x: 0, z: 0 };
const _spawn = { x: 0, z: 0, dir: 0 };
const _road = { x: 0, z: 0, dir: 0 };
let _Vec3 = null;            // THREE.Vector3 ctor cache (set in init)
let _tmpA = null;            // scratch Vector3
let _tmpB = null;            // scratch Vector3
let _tmpHit = null;          // scratch Vector3 for hit positions

const police = {
  name: 'police',
  deps: ['world', 'wanted'],

  // live state
  _ctx: null,
  _root: null,                // scene group holding all cop/cruiser meshes
  _cops: [],                  // active foot cops
  _cars: [],                  // active cruisers
  _copPool: null,             // mesh pool (foot cops)
  _carPool: null,             // mesh pool (cruisers)
  _gang: [],                  // rival-faction gangsters (fight player AND cops)
  _gangPool: null,            // mesh pool (gangsters)
  _targetFoot: 0,             // desired foot-cop population
  _targetCars: 0,             // desired cruiser population
  _targetGang: 0,             // desired gangster population
  _stars: 0,                  // last-seen wanted level
  _rng: null,                 // sub-stream rng
  _seenThisFrame: false,
  _backupT: 0,                // >0: accelerated spawning after officer-down / escalation
  _flankCycle: 0,             // round-robin flank assignment (-1/0/+1)
  _built: false,
  _unsub: [],                 // bus unsubscribers

  // ============================================================
  // INIT
  // ============================================================
  init(ctx) {
    if (this._built) { this._ctx = ctx; return; }
    this._ctx = ctx;
    const THREE = ctx.THREE;
    if (!THREE) return;     // defensive: cannot build without three

    _Vec3 = THREE.Vector3;
    _tmpA = new _Vec3();
    _tmpB = new _Vec3();
    _tmpHit = new _Vec3();

    this._rng = (GU && GU.makeRng) ? GU.makeRng(0x901CE5 ^ 0x5a17) : (ctx.rng || Math.random);

    const root = new THREE.Group();
    root.name = 'gta-police';
    if (ctx.scene) ctx.scene.add(root);
    this._root = root;

    // mesh pools — reuse meshes instead of create/destroy each spawn
    this._copPool = GTA.makePool((i) => buildCop(THREE, i), root);
    this._carPool = GTA.makePool((i) => buildCruiser(THREE, i), root);
    this._gangPool = GTA.makePool((i) => buildThug(THREE, i), root);

    // subscribe to wanted changes -> recompute target population
    const onWanted = (p) => {
      try { this._onWantedChanged(p); } catch (e) { /* never brick the host */ }
    };
    this._unsub.push(ctx.bus.on('wanted:changed', onWanted));

    // a full respawn clears the heat — clear all cops
    const onRespawn = () => { try { this.clear(); } catch (e) {} };
    this._unsub.push(ctx.bus.on('playerRespawn', onRespawn));

    // a rival faction can be requested explicitly (scripted events / other systems)
    const onFaction = (p) => { try { if (p && p.faction === 'gang') this._targetGang = GU.clamp((p.count | 0) || 1, 0, GANG_MAX); } catch (e) {} };
    this._unsub.push(ctx.bus.on('faction:spawn', onFaction));

    // seed from current wanted level if the wanted system is already up
    const wapi = ctx.systems && ctx.systems.wanted && ctx.systems.wanted.api;
    let startStars = 0;
    if (wapi && typeof wapi.stars === 'function') {
      try { startStars = wapi.stars() | 0; } catch (e) { startStars = 0; }
    }
    this._setStars(startStars);

    this._built = true;
  },

  // ============================================================
  // PER-FRAME UPDATE
  // ============================================================
  update(dt, ctx) {
    if (!this._built || !ctx) return;
    const player = ctx.player;
    if (!player) return;

    // dt safety (host clamps, but guard anyway)
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;

    const world = ctx.systems && ctx.systems.world && ctx.systems.world.api;
    const px = player.pos ? player.pos.x : 0;
    const pz = player.pos ? player.pos.z : 0;

    // keep population matched to the wanted target (spawn/despawn gradually)
    this._maintainPopulation(ctx, world, px, pz);

    this._seenThisFrame = false;

    // ---- update foot cops ----
    for (let i = this._cops.length - 1; i >= 0; i--) {
      const cop = this._cops[i];
      if (!cop) continue;   // list can be emptied mid-loop: a cop's shot can kill the player -> respawn -> GTA.reset -> police.clear()
      if (cop.dead) { this._retireCop(i); continue; }
      this._updateCop(cop, dt, ctx, world, player, px, pz);
    }

    // ---- update cruisers ----
    for (let i = this._cars.length - 1; i >= 0; i--) {
      const car = this._cars[i];
      if (!car) continue;   // same: clear() can empty this mid-loop
      if (car.dead) { this._retireCar(i); continue; }
      this._updateCar(car, dt, ctx, world, player, px, pz);
    }

    // ---- update gangsters (rival faction — fight the player AND the cops) ----
    for (let i = this._gang.length - 1; i >= 0; i--) {
      const g = this._gang[i];
      if (!g) continue;
      if (g.dead) { this._retireGang(i); continue; }
      this._updateGang(g, dt, ctx, world, player, px, pz);
    }

    if (this._backupT > 0) this._backupT = Math.max(0, this._backupT - dt);

    // tell the wanted system whether the player is currently observed
    const wapi = ctx.systems && ctx.systems.wanted && ctx.systems.wanted.api;
    if (wapi && typeof wapi.setSeen === 'function') {
      try { wapi.setSeen(this._seenThisFrame); } catch (e) {}
    }
  },

  // ============================================================
  // RESET (respawn / re-enter) — clean state, keep the meshes
  // ============================================================
  reset(ctx) {
    if (ctx) this._ctx = ctx;
    try { this.clear(); } catch (e) {}
  },

  // ============================================================
  // WANTED-LEVEL DRIVEN POPULATION
  // ============================================================
  _onWantedChanged(p) {
    const level = p && typeof p.level === 'number' ? p.level : (p && p.stars) || 0;
    this._setStars(level | 0);
  },

  _setStars(stars) {
    stars = GU.clamp(stars | 0, 0, 5);
    const prev = this._stars;
    this._stars = stars;
    const ctx = this._ctx;
    const diff = (ctx && ctx.config && typeof ctx.config.difficulty === 'number')
      ? ctx.config.difficulty : 1;
    const row = WAVE_TABLE[stars] || WAVE_TABLE[0];
    // scale foot cops by difficulty (cars scale gently, capped)
    this._targetFoot = Math.min(MAX_COPS, Math.round(row.foot * GU.clamp(diff, 0.5, 2)));
    this._targetCars = Math.min(MAX_CARS, Math.round(row.cars * GU.clamp(diff, 0.5, 1.5)));
    // a rival gang turns up in the chaos at high heat (one more per star over the floor)
    this._targetGang = stars >= GANG_STAR_MIN ? GU.clamp(stars - GANG_STAR_MIN + 1, 0, GANG_MAX) : 0;
    if (stars === 0) { this._targetFoot = 0; this._targetCars = 0; this._targetGang = 0; this.clear(); }
    else if (stars > prev) this._callBackup('escalation');   // heating up → call backup
  },

  // open a window of accelerated spawning + announce the incoming wave. The
  // surge lasts longer when the wanted system reports a hotter situation.
  _callBackup(reason) {
    const ctx = this._ctx;
    const w = ctx && ctx.systems && ctx.systems.wanted && ctx.systems.wanted.api;
    const esc = (w && typeof w.escalation === 'function') ? w.escalation() : 0;
    this._backupT = BACKUP_WINDOW * (1 + esc);
    if (ctx && ctx.bus) ctx.bus.emit('police:backup', { stars: this._stars, reason });
  },

  // gradually spawn toward target / despawn the excess
  _maintainPopulation(ctx, world, px, pz) {
    // FOOT COPS — a backup wave spawns several per frame so they converge fast
    const burst = this._backupT > 0 ? 3 : 1;
    for (let n = 0; n < burst && this._cops.length < this._targetFoot; n++) {
      this._spawnCop(ctx, world, px, pz);
    }
    if (this._cops.length > this._targetFoot) {
      this._despawnFarthestCop(px, pz);   // remove the cop furthest from the player
    }

    // CRUISERS
    if (this._cars.length < this._targetCars) {
      this._spawnCar(ctx, world, px, pz);
    } else if (this._cars.length > this._targetCars) {
      this._despawnFarthestCar(px, pz);
    }

    // GANGSTERS (rival faction)
    if (this._gang.length < this._targetGang) {
      this._spawnGang(ctx, world, px, pz);
    } else if (this._gang.length > this._targetGang) {
      this._despawnFarthestGang(px, pz);
    }
  },

  // ============================================================
  // FOOT COP — spawn / retire
  // ============================================================
  _spawnCop(ctx, world, px, pz) {
    if (this._cops.length >= MAX_COPS) return;
    const rng = this._rng;

    // find a road spawn that's at a sensible distance from the player
    let sx = px, sz = pz, found = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (world && typeof world.randomRoadSpawn === 'function') {
        world.randomRoadSpawn(rng, _spawn);
        sx = _spawn.x; sz = _spawn.z;
      } else {
        // fallback ring around the player
        const a = rng() * Math.PI * 2;
        const r = GU.rand(rng, SPAWN_MIN_DIST, SPAWN_MAX_DIST);
        sx = px + Math.cos(a) * r;
        sz = pz + Math.sin(a) * r;
      }
      const d = GU.dist2D(sx, sz, px, pz);
      if (d >= SPAWN_MIN_DIST && d <= SPAWN_MAX_DIST) { found = true; break; }
    }
    if (!found) {
      // last-resort: push a fallback point onto the ring
      const a = rng() * Math.PI * 2;
      sx = px + Math.cos(a) * (SPAWN_MIN_DIST + 8);
      sz = pz + Math.sin(a) * (SPAWN_MIN_DIST + 8);
    }

    const mesh = this._copPool.get();
    mesh.visible = true;
    mesh.position.set(sx, 0, sz);
    if (mesh.userData) { mesh.userData.phase = rng() * Math.PI * 2; this._setMuzzleFlash(mesh, false); }

    const highStars = this._stars >= 4;
    const cop = {
      mesh,
      pos: mesh.position,                  // alias: hittable uses this Vector3
      health: COP_HEALTH,
      maxHealth: COP_HEALTH,
      dead: false,
      state: 'seek',
      faction: 'police',
      fireT: GU.rand(rng, 0.2, FIRE_CADENCE), // stagger first shots
      arrestT: 0,
      flashT: 0,
      facing: 0,
      target: null,
      // round-3 tactics: a flank lane (spread around the player) + cover use
      flank: [-1, 0, 1][(this._flankCycle++) % 3],
      usesCover: rng() < (highStars ? COVER_CHANCE_HI : COVER_CHANCE_LO),
      cover: null, coverT: 0, atCover: false,
    };

    // shared hittable registry entry (combat.js raycasts these)
    const entry = {
      pos: mesh.position,
      height: COP_HEIGHT,
      radius: COP_RADIUS,
      kind: 'cop',
      dead: false,
      onHit: (amount, srcKind, hitPos) => this._onCopHit(cop, entry, amount, srcKind, hitPos),
    };
    cop.entry = entry;

    if (Array.isArray(ctx.targets)) ctx.targets.push(entry);
    this._cops.push(cop);
  },

  // remove a cop by index from the active list, hittable registry, and pool
  _retireCop(i) {
    const cop = this._cops[i];
    if (!cop) return;
    this._removeTarget(cop.entry);
    if (cop.mesh) {
      cop.mesh.visible = false;
      this._setMuzzleFlash(cop.mesh, false);
    }
    this._cops.splice(i, 1);
  },

  _despawnFarthestCop(px, pz) {
    let worst = -1, worstD = -1;
    for (let i = 0; i < this._cops.length; i++) {
      const c = this._cops[i];
      const d = GU.dist2D(c.pos.x, c.pos.z, px, pz);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst >= 0) this._retireCop(worst);
  },

  // ============================================================
  // FOOT COP — onHit (called by combat via the shared registry)
  // ============================================================
  _onCopHit(cop, entry, amount, srcKind, hitPos) {
    if (cop.dead) return;
    cop.health -= (amount || 0);
    cop.flashT = 0.08;          // brief hurt flash handled in update
    if (cop.health <= 0) {
      cop.dead = true;
      entry.dead = true;
      const ctx = this._ctx;
      let pos;
      if (hitPos && hitPos.x !== undefined) pos = _tmpHit.set(hitPos.x, hitPos.y != null ? hitPos.y : cop.pos.y, hitPos.z);
      else pos = _tmpHit.set(cop.pos.x, cop.pos.y, cop.pos.z);
      const byPlayer = srcKind !== 'gang';   // a gang-killed cop isn't the player's crime
      if (ctx && ctx.bus) {
        ctx.bus.emit('entityKilled', { entity: cop, kind: 'cop', pos: pos.clone(), byPlayer });
        // killing a cop is a big-heat crime — but only when the PLAYER did it
        if (byPlayer) ctx.bus.emit('crime', { kind: 'copKilled', pos: pos.clone(), severity: 5, source: 'player' });
        // chance to drop ammo
        if (GU.chance(this._rng, 0.5)) {
          ctx.bus.emit('spawnPickup', { kind: 'ammo', value: 1, pos: pos.clone() });
        }
      }
      // officer down → call in a backup wave (accelerated spawning + heads-up)
      this._callBackup('officerDown');
    }
  },

  // ============================================================
  // FOOT COP — per-frame AI
  // ============================================================
  _updateCop(cop, dt, ctx, world, player, px, pz) {
    const pos = cop.pos;
    const distToPlayer = GU.dist2D(pos.x, pos.z, px, pz);
    const highStars = this._stars >= 4;
    const engageRange = highStars ? ENGAGE_RANGE_HI : ENGAGE_RANGE;
    const speed = highStars ? COP_SPEED_HI : COP_SPEED;

    // visibility vs the player keeps the wanted level "seen"
    const playerOnFoot = player && !player.inVehicle;
    let hasLOSplayer = false;
    if (distToPlayer <= SEEN_RANGE) {
      hasLOSplayer = this._lineOfSight(world, pos.x, pos.z, px, pz);
      if (hasLOSplayer) this._seenThisFrame = true;
    }

    // ---- pick a target: the player, or a nearer gangster (faction fight) ----
    let tx = px, tz = pz, gangTgt = null;
    const gang = this._nearestLiving(this._gang, pos.x, pos.z);
    if (gang) {
      const dg = GU.dist2D(pos.x, pos.z, gang.pos.x, gang.pos.z);
      if (dg < engageRange && dg < distToPlayer) { tx = gang.pos.x; tz = gang.pos.z; gangTgt = gang; }
    }
    const distTgt = gangTgt ? GU.dist2D(pos.x, pos.z, tx, tz) : distToPlayer;
    const hasLOStgt = gangTgt ? this._lineOfSight(world, pos.x, pos.z, tx, tz) : hasLOSplayer;

    // ---- choose state ----
    if (!gangTgt && distToPlayer <= ARREST_RANGE && playerOnFoot &&
        this._stars > 0 && this._stars <= ARREST_MAX_STARS) {
      cop.state = 'arrest';
    } else if (distTgt <= engageRange && hasLOStgt) {
      cop.state = cop.usesCover ? 'cover' : 'engage';
    } else {
      cop.state = 'seek';
    }

    // ---- behaviour ----
    if (cop.state === 'seek') {
      this._approach(cop, dt, speed, tx, tz, world);    // flank-spread approach
      cop.arrestT = 0; cop.atCover = false; cop.cover = null;
    } else if (cop.state === 'cover') {
      this._coverBehaviour(cop, dt, ctx, world, tx, tz, distTgt, hasLOStgt, speed, player, gangTgt);
      cop.arrestT = 0;
    } else if (cop.state === 'engage') {
      if (distTgt > engageRange * 0.55) this._approach(cop, dt, speed * 0.85, tx, tz, world);
      else cop.moving = false;
      this._faceTarget(cop, tx, tz, dt);
      this._fire(cop, dt, ctx, distTgt, hasLOStgt, player, tx, tz, gangTgt);
      cop.arrestT = 0; cop.atCover = false; cop.cover = null;
    } else if (cop.state === 'arrest') {
      this._faceTarget(cop, px, pz, dt);
      // player must be roughly still to be cuffed
      const pv = player.vel ? Math.hypot(player.vel.x || 0, player.vel.z || 0) : 0;
      const stillish = pv < 1.4;
      if (stillish) {
        cop.arrestT += dt;
        if (cop.arrestT >= ARREST_TIME) {
          cop.arrestT = 0;
          if (ctx.bus) {
            ctx.bus.emit('playerBusted', { pos: player.pos ? player.pos.clone() : new _Vec3() });
          }
        }
      } else {
        cop.arrestT = 0;
      }
    }

    // hurt flash decay + muzzle flash decay
    if (cop.flashT > 0) cop.flashT = Math.max(0, cop.flashT - dt);
    if (cop.mesh && cop.mesh.userData) {
      if (cop.flashT > 0) this._tintCop(cop.mesh, true);
      else this._tintCop(cop.mesh, false);
      if (cop.mesh.userData.muzzleFlashT > 0) {
        cop.mesh.userData.muzzleFlashT -= dt;
        if (cop.mesh.userData.muzzleFlashT <= 0) this._setMuzzleFlash(cop.mesh, false);
      }
    }

    // cull cops that drift absurdly far (shouldn't happen, but be safe)
    if (distToPlayer > DESPAWN_DIST) cop.dead = true;

    // sync mesh transform + walk anim
    this._syncCopMesh(cop, dt, speed);
  },

  // simple steering toward a point, with world collision resolve
  _steerToward(cop, dt, speed, tx, tz, world) {
    const pos = cop.pos;
    let dx = tx - pos.x, dz = tz - pos.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    cop.facing = Math.atan2(dx, dz);
    pos.x += dx * speed * dt;
    pos.z += dz * speed * dt;
    // push out of buildings + clamp to map bounds
    if (world && typeof world.resolve === 'function') {
      world.resolve(pos, COP_RADIUS);
    } else {
      pos.x = GU.clamp(pos.x, -118, 118);
      pos.z = GU.clamp(pos.z, -118, 118);
    }
    cop.moving = true;
  },

  _faceTarget(cop, tx, tz, dt) {
    const dx = tx - cop.pos.x, dz = tz - cop.pos.z;
    const want = Math.atan2(dx, dz);
    cop.facing = GU.lerpAngle(cop.facing, want, GU.clamp(10 * dt, 0, 1));
    cop.moving = false;
  },

  // a flank-spread approach: steer at a point offset to the side of the target so
  // a squad surrounds rather than stacks (the offset shrinks as the cop closes in)
  _approach(cop, dt, speed, tx, tz, world) {
    const pos = cop.pos;
    let dx = tx - pos.x, dz = tz - pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const perpX = -dz / d, perpZ = dx / d;
    const spread = (cop.flank || 0) * FLANK_SPREAD * GU.clamp(d / 18, 0, 1);
    this._steerToward(cop, dt, speed, tx + perpX * spread, tz + perpZ * spread, world);
  },

  // fire a pistol-like shot at the current target (the player OR a rival gangster)
  _fire(cop, dt, ctx, dist, hasLOS, player, tx, tz, gangTgt) {
    cop.fireT -= dt;
    const cadence = this._stars >= 4 ? FIRE_CADENCE_HI : FIRE_CADENCE;
    if (cop.fireT > 0) return;
    cop.fireT = cadence * GU.rand(this._rng, 0.85, 1.2);
    if (!hasLOS || dist > SHOT_RANGE) return;

    this._setMuzzleFlash(cop.mesh, true);

    const diff = (ctx.config && typeof ctx.config.difficulty === 'number') ? ctx.config.difficulty : 1;
    const falloff = GU.clamp(1 - (dist / SHOT_RANGE) * 0.45, 0.4, 1);
    let amount = GU.rand(this._rng, SHOT_DMG_MIN, SHOT_DMG_MAX) * falloff;
    if (this._stars >= 4) amount *= 1.2;
    amount *= GU.clamp(diff, 0.5, 2);
    // hit-chance floor raised toward 0.5 so a cop with LOS lands solid shots often.
    const hitChance = GU.clamp(1 - (dist / SHOT_RANGE) * 0.6, SHOT_HIT_FLOOR, 0.95);
    const miss = this._rng() > hitChance;

    if (gangTgt) {
      // cop vs gangster — a clean miss is a clean miss (faction fight, no graze).
      if (miss) return;
      this._damageGang(gangTgt, Math.round(amount), ctx);
      if (ctx.bus) ctx.bus.emit('faction:fight', { a: 'police', b: 'gang', pos: { x: tx, y: 1, z: tz } });
    } else if (ctx.bus) {
      // vs the PLAYER: a hit deals full damage; a "miss" still grazes for a couple
      // HP so being shot at with LOS always FEELS dangerous (no free misses). Both
      // route through 'damage', which itself emits a scaled shake — so we don't.
      const dealt = miss
        ? Math.round(GU.rand(this._rng, SHOT_GRAZE_MIN, SHOT_GRAZE_MAX) * GU.clamp(diff, 0.5, 2))
        : Math.round(amount);
      if (dealt <= 0) return;
      const hp = player.pos ? _tmpA.copy(player.pos) : _tmpA.set(tx, 1, tz);
      ctx.bus.emit('damage', { target: 'player', amount: dealt, kind: miss ? 'graze' : 'bullet', pos: hp.clone(), source: 'cop' });
      // a clean hit gets an extra kick on top of the damage-driven shake; a graze
      // rides only the small shake 'damage' emits, so near-misses feel lighter.
      if (!miss) ctx.bus.emit('shake', { amount: 0.9 });
    }
  },

  // ============================================================
  // COVER — take up a position with a building between the cop and the target,
  // then peek-fire from it (round-3 tactical behaviour)
  // ============================================================
  _coverBehaviour(cop, dt, ctx, world, tx, tz, dist, hasLOS, speed, player, gangTgt) {
    cop.coverT -= dt;
    if (!cop.cover || cop.coverT <= 0) { cop.cover = this._findCover(cop, tx, tz, world); cop.coverT = COVER_REEVAL; }
    const cover = cop.cover;
    if (cover) {
      const dc = GU.dist2D(cop.pos.x, cop.pos.z, cover.x, cover.z);
      if (dc > 1.3) {                       // still moving to cover
        this._steerToward(cop, dt, speed, cover.x, cover.z, world);
        cop.atCover = false;
      } else {                              // at cover — face out + peek-fire
        cop.atCover = true; cop.moving = false;
        this._faceTarget(cop, tx, tz, dt);
        this._fire(cop, dt, ctx, dist, hasLOS, player, tx, tz, gangTgt);
      }
    } else {                                // no cover nearby — behave like an engager
      if (dist > 6) this._approach(cop, dt, speed * 0.85, tx, tz, world); else cop.moving = false;
      this._faceTarget(cop, tx, tz, dt);
      this._fire(cop, dt, ctx, dist, hasLOS, player, tx, tz, gangTgt);
    }
  },

  // building AABBs from the world shim (C's geometry-matched colliders)
  _aabbs() {
    const ctx = this._ctx;
    const w = ctx && ctx.systems && ctx.systems.world;
    return (w && w.aabbs) || null;
  },

  // find a spot just behind a nearby building, relative to the target, that the
  // building actually occludes (so the cop is shielded). Returns {x,z} or null.
  _findCover(cop, tx, tz, world) {
    const aabbs = this._aabbs();
    if (!aabbs || !aabbs.length) return null;
    const cx = cop.pos.x, cz = cop.pos.z;
    let best = null, bestD = Infinity;
    for (const b of aabbs) {
      const bcx = (b.minX + b.maxX) * 0.5, bcz = (b.minZ + b.maxZ) * 0.5;
      if (GU.dist2D(bcx, bcz, cx, cz) > COVER_SEARCH) continue;
      // a point just past the face of the box on the side AWAY from the target
      let dirx = bcx - tx, dirz = bcz - tz;
      const dl = Math.hypot(dirx, dirz) || 1; dirx /= dl; dirz /= dl;
      const hx = (b.maxX - b.minX) * 0.5 + COVER_OFFSET, hz = (b.maxZ - b.minZ) * 0.5 + COVER_OFFSET;
      const pX = bcx + dirx * hx, pZ = bcz + dirz * hz;
      // only counts as cover if the building blocks the target → point line
      if (this._lineOfSight(world, tx, tz, pX, pZ)) continue;
      const dd = GU.dist2D(pX, pZ, cx, cz);
      if (dd < bestD) { bestD = dd; best = { x: pX, z: pZ }; }
    }
    return best;
  },

  _nearestLiving(list, x, z) {
    let best = null, bd = Infinity;
    for (const e of list) {
      if (!e || e.dead || !e.pos) continue;
      const d = GU.dist2D(e.pos.x, e.pos.z, x, z);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  },

  // ============================================================
  // RIVAL GANG FACTION — fights the player AND the cops
  // ============================================================
  _spawnGang(ctx, world, px, pz) {
    if (this._gang.length >= GANG_MAX) return;
    const rng = this._rng;
    let sx = px, sz = pz, found = false;
    for (let a = 0; a < 8; a++) {
      if (world && typeof world.randomRoadSpawn === 'function') { world.randomRoadSpawn(rng, _spawn); sx = _spawn.x; sz = _spawn.z; }
      else { const ang = rng() * Math.PI * 2, r = GU.rand(rng, SPAWN_MIN_DIST, SPAWN_MAX_DIST); sx = px + Math.cos(ang) * r; sz = pz + Math.sin(ang) * r; }
      const d = GU.dist2D(sx, sz, px, pz);
      if (d >= SPAWN_MIN_DIST && d <= SPAWN_MAX_DIST) { found = true; break; }
    }
    if (!found) { const ang = rng() * Math.PI * 2; sx = px + Math.cos(ang) * (SPAWN_MIN_DIST + 8); sz = pz + Math.sin(ang) * (SPAWN_MIN_DIST + 8); }

    const mesh = this._gangPool.get();
    mesh.visible = true; mesh.position.set(sx, 0, sz);
    if (mesh.userData) this._setMuzzleFlash(mesh, false);

    const g = {
      mesh, pos: mesh.position, health: GANG_HEALTH, maxHealth: GANG_HEALTH, dead: false,
      faction: 'gang', state: 'seek', fireT: GU.rand(rng, 0.2, GANG_FIRE_CAD), flashT: 0, facing: 0, moving: false,
    };
    const entry = {
      pos: mesh.position, height: COP_HEIGHT, radius: COP_RADIUS, kind: 'gang', dead: false,
      onHit: (amount, srcKind, hitPos) => this._onGangHit(g, entry, amount, srcKind, hitPos),
    };
    g.entry = entry;
    if (Array.isArray(ctx.targets)) ctx.targets.push(entry);
    this._gang.push(g);
  },

  _retireGang(i) {
    const g = this._gang[i];
    if (!g) return;
    this._removeTarget(g.entry);
    if (g.mesh) { g.mesh.visible = false; this._setMuzzleFlash(g.mesh, false); }
    this._gang.splice(i, 1);
  },

  _despawnFarthestGang(px, pz) {
    let worst = -1, worstD = -1;
    for (let i = 0; i < this._gang.length; i++) {
      const d = GU.dist2D(this._gang[i].pos.x, this._gang[i].pos.z, px, pz);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst >= 0) this._retireGang(worst);
  },

  // the player (or a cop) shot a gangster
  _onGangHit(g, entry, amount, srcKind, hitPos) {
    if (g.dead) return;
    g.health -= (amount || 0);
    g.flashT = 0.08;
    if (g.health <= 0) {
      g.dead = true; entry.dead = true;
      const ctx = this._ctx;
      if (ctx && ctx.bus) {
        const pos = (hitPos && hitPos.x !== undefined) ? _tmpHit.set(hitPos.x, hitPos.y != null ? hitPos.y : g.pos.y, hitPos.z) : _tmpHit.set(g.pos.x, g.pos.y, g.pos.z);
        ctx.bus.emit('entityKilled', { entity: g, kind: 'gang', pos: pos.clone(), byPlayer: srcKind !== 'cop' });
      }
    }
  },

  // a cop dealt damage to a gangster directly (faction fight, not a player raycast)
  _damageGang(g, amount, ctx) {
    if (!g || g.dead) return;
    g.health -= amount; g.flashT = 0.08;
    if (g.health <= 0) {
      g.dead = true; if (g.entry) g.entry.dead = true;
      if (ctx && ctx.bus) ctx.bus.emit('entityKilled', { entity: g, kind: 'gang', pos: _tmpHit.set(g.pos.x, g.pos.y, g.pos.z).clone(), byPlayer: false });
    }
  },

  _updateGang(g, dt, ctx, world, player, px, pz) {
    const pos = g.pos;
    // nearest hostile = the player, or the nearest cop (whichever is closer)
    const cop = this._nearestLiving(this._cops, pos.x, pos.z);
    const dP = GU.dist2D(pos.x, pos.z, px, pz);
    let tx = px, tz = pz, copTgt = null;
    if (cop) {
      const dC = GU.dist2D(pos.x, pos.z, cop.pos.x, cop.pos.z);
      if (dC < dP) { tx = cop.pos.x; tz = cop.pos.z; copTgt = cop; }
    }
    const dist = GU.dist2D(pos.x, pos.z, tx, tz);
    const hasLOS = this._lineOfSight(world, pos.x, pos.z, tx, tz);
    if (dist <= GANG_ENGAGE && hasLOS) {
      g.state = 'engage';
      this._faceTarget(g, tx, tz, dt);
      this._gangFire(g, dt, ctx, dist, hasLOS, player, tx, tz, copTgt);
    } else {
      g.state = 'seek';
      this._steerToward(g, dt, GANG_SPEED, tx, tz, world);
    }

    if (g.flashT > 0) g.flashT = Math.max(0, g.flashT - dt);
    if (g.mesh && g.mesh.userData) {
      this._tintCop(g.mesh, g.flashT > 0);
      if (g.mesh.userData.muzzleFlashT > 0) { g.mesh.userData.muzzleFlashT -= dt; if (g.mesh.userData.muzzleFlashT <= 0) this._setMuzzleFlash(g.mesh, false); }
    }
    if (dP > DESPAWN_DIST) g.dead = true;
    this._syncCopMesh(g, dt, GANG_SPEED);   // shares the cop rig (same userData keys)
  },

  _gangFire(g, dt, ctx, dist, hasLOS, player, tx, tz, copTgt) {
    g.fireT -= dt;
    if (g.fireT > 0) return;
    g.fireT = GANG_FIRE_CAD * GU.rand(this._rng, 0.8, 1.25);
    if (!hasLOS || dist > GANG_SHOT_RANGE) return;
    this._setMuzzleFlash(g.mesh, true);
    const hitChance = GU.clamp(1 - (dist / GANG_SHOT_RANGE) * 0.6, 0.3, 0.9);
    if (this._rng() > hitChance) return;
    const amount = Math.round(GANG_SHOT_DMG * GU.rand(this._rng, 0.7, 1.2));
    if (copTgt && copTgt.entry && copTgt.entry.onHit) {
      copTgt.entry.onHit(amount, 'gang', { x: copTgt.pos.x, y: copTgt.pos.y, z: copTgt.pos.z });   // gang vs cop
      if (ctx.bus) ctx.bus.emit('faction:fight', { a: 'gang', b: 'police', pos: { x: tx, y: 1, z: tz } });
    } else if (ctx.bus) {
      const hp = player.pos ? _tmpA.copy(player.pos) : _tmpA.set(tx, 1, tz);
      ctx.bus.emit('damage', { target: 'player', amount, kind: 'bullet', pos: hp.clone(), source: 'gang' });
      ctx.bus.emit('shake', { amount: 0.7 });
    }
  },

  // ============================================================
  // CRUISER (3+ stars) — a fast road pursuer
  // ============================================================
  _spawnCar(ctx, world, px, pz) {
    if (this._cars.length >= MAX_CARS) return;
    if (this._stars < CRUISER_STAR_MIN) return;
    const rng = this._rng;

    let sx = px, sz = pz, dir = 0, found = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (world && typeof world.randomRoadSpawn === 'function') {
        world.randomRoadSpawn(rng, _spawn);
        sx = _spawn.x; sz = _spawn.z; dir = _spawn.dir || 0;
      } else {
        const a = rng() * Math.PI * 2;
        const r = GU.rand(rng, SPAWN_MIN_DIST + 10, SPAWN_MAX_DIST);
        sx = px + Math.cos(a) * r; sz = pz + Math.sin(a) * r; dir = a;
      }
      const d = GU.dist2D(sx, sz, px, pz);
      if (d >= SPAWN_MIN_DIST + 6 && d <= SPAWN_MAX_DIST + 20) { found = true; break; }
    }
    if (!found) {
      const a = rng() * Math.PI * 2;
      sx = px + Math.cos(a) * (SPAWN_MIN_DIST + 18);
      sz = pz + Math.sin(a) * (SPAWN_MIN_DIST + 18);
    }

    const mesh = this._carPool.get();
    mesh.visible = true;
    mesh.position.set(sx, 0, sz);
    mesh.rotation.y = dir;

    const car = {
      mesh,
      pos: mesh.position,
      facing: dir,
      health: 140,
      maxHealth: 140,
      dead: false,
      sirenT: 0,
    };

    // cruisers are hittable too (kind:'vehicle')
    const entry = {
      pos: mesh.position,
      height: 1.4,
      radius: 1.4,
      kind: 'vehicle',
      dead: false,
      onHit: (amount, srcKind, hitPos) => this._onCarHit(car, entry, amount, srcKind, hitPos),
    };
    car.entry = entry;
    if (Array.isArray(ctx.targets)) ctx.targets.push(entry);

    this._cars.push(car);
  },

  _onCarHit(car, entry, amount, srcKind, hitPos) {
    if (car.dead) return;
    car.health -= (amount || 0);
    if (car.health <= 0) {
      car.dead = true;
      entry.dead = true;
      const ctx = this._ctx;
      if (ctx && ctx.bus) {
        const pos = _tmpHit.set(car.pos.x, car.pos.y, car.pos.z).clone();
        ctx.bus.emit('entityKilled', { entity: car, kind: 'vehicle', pos, byPlayer: true });
        ctx.bus.emit('crime', { kind: 'propertyDamage', pos, severity: 3, source: 'player' });
        if (GU.chance(this._rng, 0.4)) {
          ctx.bus.emit('spawnPickup', { kind: 'ammo', value: 1, pos: pos.clone() });
        }
      }
    }
  },

  _retireCar(i) {
    const car = this._cars[i];
    if (!car) return;
    this._removeTarget(car.entry);
    if (car.mesh) car.mesh.visible = false;
    this._cars.splice(i, 1);
  },

  _despawnFarthestCar(px, pz) {
    let worst = -1, worstD = -1;
    for (let i = 0; i < this._cars.length; i++) {
      const c = this._cars[i];
      const d = GU.dist2D(c.pos.x, c.pos.z, px, pz);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst >= 0) this._retireCar(worst);
  },

  _updateCar(car, dt, ctx, world, player, px, pz) {
    const pos = car.pos;
    const dist = GU.dist2D(pos.x, pos.z, px, pz);

    // drive toward the player, snapping toward road centrelines so it stays on
    // the street where possible (simple, no full pathfinding)
    let tx = px, tz = pz;
    if (world && typeof world.nearestRoad === 'function') {
      // aim for the road point nearest the player so the cruiser hugs streets
      world.nearestRoad(px, pz, _road);
      // blend between the road snap and the raw player position
      tx = GU.lerp(_road.x, px, 0.35);
      tz = GU.lerp(_road.z, pz, 0.35);
    }

    let dx = tx - pos.x, dz = tz - pos.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const want = Math.atan2(dx, dz);
    car.facing = GU.lerpAngle(car.facing, want, GU.clamp(4 * dt, 0, 1));

    // move along facing (so it turns rather than strafes)
    const fx = Math.sin(car.facing), fz = Math.cos(car.facing);
    const speed = CRUISER_SPEED;
    pos.x += fx * speed * dt;
    pos.z += fz * speed * dt;

    if (world && typeof world.resolve === 'function') world.resolve(pos, 1.4);
    else { pos.x = GU.clamp(pos.x, -118, 118); pos.z = GU.clamp(pos.z, -118, 118); }

    // close-range ram: shove the player's vehicle (or push the player)
    if (dist < 3.2) {
      this._ramPlayer(ctx, player, pos, px, pz, dt);
    }

    // visibility from cruiser also counts
    if (dist <= SEEN_RANGE && this._lineOfSight(world, pos.x, pos.z, px, pz)) {
      this._seenThisFrame = true;
    }

    // siren light blink
    car.sirenT += dt;
    this._blinkSiren(car.mesh, car.sirenT);

    // sync transform
    car.mesh.position.copy(pos);
    car.mesh.rotation.y = car.facing;

    if (dist > DESPAWN_DIST) car.dead = true;
  },

  // push the player (or their car) away on a ram, request a little damage + shake
  _ramPlayer(ctx, player, carPos, px, pz, dt) {
    let dx = px - carPos.x, dz = pz - carPos.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const shove = 6 * dt;
    if (player.pos) { player.pos.x += dx * shove; player.pos.z += dz * shove; }
    if (player.vel) { player.vel.x += dx * 2; player.vel.z += dz * 2; }
    if (ctx.bus) {
      ctx.bus.emit('shake', { amount: 1.1 });
      // light contact damage on a soft cadence (don't spam every frame)
      if (this._rng() < 0.04) {
        ctx.bus.emit('damage', {
          target: 'player', amount: 4, kind: 'collision',
          pos: player.pos ? player.pos.clone() : carPos.clone(), source: 'cop',
        });
      }
    }
  },

  // ============================================================
  // LINE OF SIGHT — cheap occlusion test against world AABBs
  // ============================================================
  _lineOfSight(world, ax, az, bx, bz) {
    if (!world || typeof world.isInside !== 'function') return true; // no world => assume visible
    const dx = bx - ax, dz = bz - az;
    const dist = Math.hypot(dx, dz) || 1;
    const steps = Math.min(20, Math.max(3, Math.floor(dist / 4)));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const sx = ax + dx * t, sz = az + dz * t;
      if (world.isInside(sx, sz, 0.2)) return false;
    }
    return true;
  },

  // ============================================================
  // MESH SYNC / VISUALS
  // ============================================================
  _syncCopMesh(cop, dt, speed) {
    const m = cop.mesh;
    if (!m) return;
    m.position.copy(cop.pos);
    m.rotation.y = cop.facing;
    // raise the gun arm when engaging/arresting/peeking from cover (fresh this frame)
    const raise = (cop.state === 'engage' || cop.state === 'arrest' || (cop.state === 'cover' && cop.atCover));
    cop.armRaised = raise;
    // walk animation
    const u = m.userData;
    if (u && u.legL) {
      const moving = !!cop.moving;
      u.phase = (u.phase || 0) + (moving ? speed * dt * 1.9 : 0);
      const sw = moving ? Math.sin(u.phase) * 0.5 : 0;
      u.legL.rotation.x = sw; u.legR.rotation.x = -sw;
      // gate the swinging gun arm on the freshly-computed `raise`, not the stale value
      if (u.armL && !raise) { u.armL.rotation.x = -sw; u.armR.rotation.x = sw; }
    }
    if (u && u.armR) {
      if (raise) {
        u.armR.rotation.x = -1.35;
      } else {
        // not aiming: actively drive the gun arm back toward neutral so it
        // resumes the normal walk-swing instead of staying locked raised
        u.armR.rotation.x = GU.lerp(u.armR.rotation.x, 0, GU.clamp(8 * dt, 0, 1));
      }
    }
    cop.moving = false; // reset; set true again by steer next frame
  },

  _setMuzzleFlash(mesh, on) {
    if (!mesh || !mesh.userData) return;
    const fl = mesh.userData.flash;
    if (!fl) return;
    fl.visible = !!on;
    mesh.userData.muzzleFlashT = on ? TRACER_LIFE : 0;
  },

  _tintCop(mesh, hurt) {
    if (!mesh || !mesh.userData) return;
    const torso = mesh.userData.torsoMat;
    if (!torso) return;
    if (hurt) {
      if (!torso._origEmissive) torso._origEmissive = torso.emissive ? torso.emissive.getHex() : 0x000000;
      if (torso.emissive) torso.emissive.setHex(0x661111);
    } else {
      if (torso.emissive && torso._origEmissive !== undefined) torso.emissive.setHex(torso._origEmissive);
    }
  },

  _blinkSiren(mesh, t) {
    if (!mesh || !mesh.userData) return;
    const red = mesh.userData.sirenRed, blue = mesh.userData.sirenBlue;
    const phase = Math.floor(t * 5) % 2;
    if (red) red.visible = phase === 0;
    if (blue) blue.visible = phase === 1;
  },

  // ============================================================
  // REGISTRY HELPERS
  // ============================================================
  _removeTarget(entry) {
    if (!entry) return;
    const ctx = this._ctx;
    if (ctx && Array.isArray(ctx.targets)) {
      const idx = ctx.targets.indexOf(entry);
      if (idx >= 0) ctx.targets.splice(idx, 1);
    }
  },

  // ============================================================
  // PUBLIC API
  // ============================================================
  api: {
    // number of living foot cops
    copCount() { return police._cops.length; },

    // force-spawn a full wave at the current star level (debug / scripted)
    spawnWave() {
      const ctx = police._ctx;
      if (!ctx) return;
      const world = ctx.systems && ctx.systems.world && ctx.systems.world.api;
      const player = ctx.player || { pos: { x: 0, z: 0 } };
      const px = player.pos ? player.pos.x : 0;
      const pz = player.pos ? player.pos.z : 0;
      // top up to target in one go (respect caps)
      let guard = 0;
      while (police._cops.length < police._targetFoot && guard++ < MAX_COPS) {
        police._spawnCop(ctx, world, px, pz);
      }
      guard = 0;
      while (police._cars.length < police._targetCars && guard++ < MAX_CARS) {
        police._spawnCar(ctx, world, px, pz);
      }
    },

    // despawn everything (full clear)
    clear() { police.clear(); },

    // number of active cruisers (handy for HUD / debug)
    carCount() { return police._cars.length; },

    // round-3 diagnostics (HUD / tests)
    gangCount() { return police._gang.length; },
    coverCount() { return police._cops.filter((c) => c.atCover).length; },
    backupActive() { return police._backupT > 0; },
  },

  // ============================================================
  // CLEAR — despawn all cops + cruisers, scrub the registry
  // ============================================================
  clear() {
    for (let i = this._cops.length - 1; i >= 0; i--) this._retireCop(i);
    for (let i = this._cars.length - 1; i >= 0; i--) this._retireCar(i);
    for (let i = this._gang.length - 1; i >= 0; i--) this._retireGang(i);
    this._cops.length = 0;
    this._cars.length = 0;
    this._gang.length = 0;
    this._backupT = 0;
  },
};

// ============================================================
// MESH FACTORIES (original low-poly art, built in code)
// ============================================================

// a person in a navy police uniform — proportions match the host's civilians
function buildCop(THREE, idx) {
  const g = new THREE.Group();
  g.name = 'cop';

  const navy   = 0x1c2a55;   // uniform
  const navyDk = 0x141d3a;   // pants
  const skin   = 0xcf9c70;
  const cap     = 0x101830;
  const badge   = 0xe8c84a;

  const mkMat = (col, rough = 0.85) =>
    new THREE.MeshStandardMaterial({ color: col, roughness: rough });
  const mk = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  };

  const pantsMat = mkMat(navyDk);
  const shirtMat = mkMat(navy);
  const skinMat  = mkMat(skin);
  const capMat   = mkMat(cap, 0.6);
  const badgeMat = new THREE.MeshStandardMaterial({ color: badge, emissive: 0x8a6e10, emissiveIntensity: 0.4, roughness: 0.4 });

  const legL = mk(new THREE.BoxGeometry(0.26, 0.8, 0.28), pantsMat); legL.position.set(-0.16, 0.4, 0);
  const legR = mk(new THREE.BoxGeometry(0.26, 0.8, 0.28), pantsMat); legR.position.set(0.16, 0.4, 0);
  const torso = mk(new THREE.BoxGeometry(0.64, 0.74, 0.38), shirtMat); torso.position.set(0, 1.16, 0);
  const armL = mk(new THREE.BoxGeometry(0.18, 0.66, 0.2), shirtMat); armL.position.set(-0.43, 1.18, 0);
  const armR = mk(new THREE.BoxGeometry(0.18, 0.66, 0.2), shirtMat); armR.position.set(0.43, 1.18, 0);
  const head = mk(new THREE.BoxGeometry(0.34, 0.36, 0.34), skinMat); head.position.set(0, 1.72, 0);
  const capMesh = mk(new THREE.BoxGeometry(0.38, 0.16, 0.38), capMat); capMesh.position.set(0, 1.96, 0);
  const brim = mk(new THREE.BoxGeometry(0.4, 0.05, 0.18), capMat); brim.position.set(0, 1.9, 0.24);
  // chest badge
  const badgeMesh = mk(new THREE.BoxGeometry(0.12, 0.12, 0.04), badgeMat); badgeMesh.position.set(-0.14, 1.3, 0.2);

  // a small pistol in the right hand
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.5, metalness: 0.3 });
  const gun = mk(new THREE.BoxGeometry(0.1, 0.12, 0.34), gunMat);
  gun.position.set(0, -0.2, 0.18); gun.rotation.x = 0.2;
  armR.add(gun);

  // muzzle flash sprite-ish quad (hidden until firing) + a muzzle anchor
  const flashMat = new THREE.MeshBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0.95 });
  const flash = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), flashMat);
  flash.position.set(0, -0.2, 0.4);
  flash.visible = false;
  armR.add(flash);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0.43, 1.0, 0.5);
  g.add(muzzle);

  g.add(legL, legR, torso, armL, armR, head, capMesh, brim, badgeMesh);

  g.userData.legL = legL; g.userData.legR = legR;
  g.userData.armL = armL; g.userData.armR = armR;
  g.userData.muzzle = muzzle;
  g.userData.flash = flash;
  g.userData.torsoMat = shirtMat;
  g.userData.muzzleFlashT = 0;
  g.userData.phase = 0;

  g.visible = false;     // pooled; shown on spawn
  return g;
}

// a rival gangster — same proportions + userData rig as a cop (so it reuses the
// shared mesh-sync/flash/tint), but street colours: dark hoodie, no cap/badge.
function buildThug(THREE, idx) {
  const g = new THREE.Group();
  g.name = 'thug';

  const hoodie = [0x3a2230, 0x223a2a, 0x2a2a32, 0x402a1c][idx % 4];   // varied dark tops
  const pants  = 0x222428;
  const skin   = [0xcf9c70, 0x9c6b43, 0xe8c9a0][idx % 3];
  const hair   = 0x161412;

  const mkMat = (col, rough = 0.9) => new THREE.MeshStandardMaterial({ color: col, roughness: rough });
  const mk = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; return m; };

  const pantsMat = mkMat(pants);
  const topMat   = mkMat(hoodie);
  const skinMat  = mkMat(skin);
  const hairMat  = mkMat(hair, 0.7);

  const legL = mk(new THREE.BoxGeometry(0.26, 0.8, 0.28), pantsMat); legL.position.set(-0.16, 0.4, 0);
  const legR = mk(new THREE.BoxGeometry(0.26, 0.8, 0.28), pantsMat); legR.position.set(0.16, 0.4, 0);
  const torso = mk(new THREE.BoxGeometry(0.62, 0.74, 0.36), topMat); torso.position.set(0, 1.16, 0);
  const armL = mk(new THREE.BoxGeometry(0.18, 0.66, 0.2), topMat); armL.position.set(-0.42, 1.18, 0);
  const armR = mk(new THREE.BoxGeometry(0.18, 0.66, 0.2), topMat); armR.position.set(0.42, 1.18, 0);
  const head = mk(new THREE.BoxGeometry(0.34, 0.36, 0.34), skinMat); head.position.set(0, 1.72, 0);
  const hairMesh = mk(new THREE.BoxGeometry(0.36, 0.12, 0.36), hairMat); hairMesh.position.set(0, 1.9, 0);

  // a small SMG-ish gun in the right hand
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x101012, roughness: 0.5, metalness: 0.3 });
  const gun = mk(new THREE.BoxGeometry(0.1, 0.14, 0.4), gunMat);
  gun.position.set(0, -0.2, 0.2); gun.rotation.x = 0.18;
  armR.add(gun);

  const flashMat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.95 });
  const flash = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), flashMat);
  flash.position.set(0, -0.2, 0.44); flash.visible = false;
  armR.add(flash);

  const muzzle = new THREE.Object3D(); muzzle.position.set(0.42, 1.0, 0.5); g.add(muzzle);
  g.add(legL, legR, torso, armL, armR, head, hairMesh);

  g.userData.legL = legL; g.userData.legR = legR;
  g.userData.armL = armL; g.userData.armR = armR;
  g.userData.muzzle = muzzle;
  g.userData.flash = flash;
  g.userData.torsoMat = topMat;
  g.userData.muzzleFlashT = 0;
  g.userData.phase = 0;

  g.visible = false;
  return g;
}

// a low-poly police cruiser (distinct blocky cruiser with a roof light bar)
function buildCruiser(THREE, idx) {
  const g = new THREE.Group();
  g.name = 'cruiser';

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x20305f, roughness: 0.6, metalness: 0.2 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xeef1f5, roughness: 0.7 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x14202c, roughness: 0.2, metalness: 0.5 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x111317, roughness: 0.9 });
  const redMat = new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0xff2020, emissiveIntensity: 1.2, roughness: 0.4 });
  const blueMat = new THREE.MeshStandardMaterial({ color: 0x2a6bff, emissive: 0x2050ff, emissiveIntensity: 1.2, roughness: 0.4 });

  const mk = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  };

  // lower body
  const body = mk(new THREE.BoxGeometry(2.0, 0.7, 4.2), bodyMat);
  body.position.set(0, 0.55, 0);
  // white side stripe (door panels)
  const stripeL = mk(new THREE.BoxGeometry(0.04, 0.26, 3.0), trimMat); stripeL.position.set(-1.01, 0.55, 0);
  const stripeR = mk(new THREE.BoxGeometry(0.04, 0.26, 3.0), trimMat); stripeR.position.set(1.01, 0.55, 0);
  // cabin
  const cabin = mk(new THREE.BoxGeometry(1.7, 0.6, 2.0), bodyMat);
  cabin.position.set(0, 1.1, -0.1);
  // windshield / windows
  const glass = mk(new THREE.BoxGeometry(1.72, 0.5, 2.02), glassMat);
  glass.position.set(0, 1.12, -0.1); glass.scale.set(0.98, 0.9, 0.98);

  // light bar on the roof
  const barBase = mk(new THREE.BoxGeometry(1.1, 0.12, 0.4), trimMat);
  barBase.position.set(0, 1.48, -0.1);
  const sirenRed = mk(new THREE.BoxGeometry(0.5, 0.14, 0.36), redMat);
  sirenRed.position.set(-0.3, 1.55, -0.1);
  const sirenBlue = mk(new THREE.BoxGeometry(0.5, 0.14, 0.36), blueMat);
  sirenBlue.position.set(0.3, 1.55, -0.1);

  // wheels
  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 12);
  const wheelPos = [[-0.95, 0.42, 1.3], [0.95, 0.42, 1.3], [-0.95, 0.42, -1.3], [0.95, 0.42, -1.3]];
  for (const wp of wheelPos) {
    const w = mk(wheelGeo, tireMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(wp[0], wp[1], wp[2]);
    g.add(w);
  }

  // headlights
  const hlMat = new THREE.MeshStandardMaterial({ color: 0xfff4c0, emissive: 0xffe080, emissiveIntensity: 0.8 });
  const hlL = mk(new THREE.BoxGeometry(0.3, 0.18, 0.1), hlMat); hlL.position.set(-0.6, 0.6, 2.1);
  const hlR = mk(new THREE.BoxGeometry(0.3, 0.18, 0.1), hlMat); hlR.position.set(0.6, 0.6, 2.1);

  g.add(body, stripeL, stripeR, cabin, glass, barBase, sirenRed, sirenBlue, hlL, hlR);

  g.userData.sirenRed = sirenRed;
  g.userData.sirenBlue = sirenBlue;

  g.visible = false;
  return g;
}

GTA.register(police);
export default police;
