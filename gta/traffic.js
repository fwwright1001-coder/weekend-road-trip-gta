// ============================================================
// gta/traffic.js — ambient NPC traffic AI (Lane D).
// ------------------------------------------------------------
// A self-registered system that brings the streets to life: it spawns a small,
// capped fleet of NPC cars and drives them along the road grid (axis-aligned
// lane-following with 90° turns at intersections / when blocked), braking for
// the player. Cars that drift far are RECYCLED to a fresh road spawn near the
// player (the host has no vehicle-removal API, so recycling is how we keep the
// count capped without leaking meshes).
//
// It builds NOTHING itself — it calls the host's spawnVehicle (via the vehicles
// shim), so it automatically uses Lane A's car meshes. Each car it owns is tagged
// `v.isTraffic = true` and mirrored into `ctx.traffic` (and internals.traffic).
// The player can still jack a traffic car; while occupied we hand it off.
//
// Pure math over the shared world shim — fully headless-safe, so the node sim
// spawns + drives traffic and the smoke suite asserts it.
// ============================================================
import { GTA, GU } from './core.js';

const TRAFFIC_MAX    = 6;     // hard cap on ambient cars (perf)
const SPAWN_INTERVAL = 0.6;   // seconds between spawns while under the cap
const SPAWN_MIN_DIST = 24;    // spawn this far from the player at least
const SPAWN_MAX_DIST = 85;
const RECYCLE_DIST   = 150;   // relocate a car that drifts past this (cheap despawn)
const CRUISE_SPEED   = 9;     // m/s
const HALF = Math.PI / 2;
const COLORS = [0x9aa0a6, 0x2f6f8f, 0xb5432e, 0xece8df, 0x3a3f4a, 0x2b6b3a, 0xc8a24a];

const traffic = {
  name: 'traffic',
  deps: ['world', 'vehicles'],
  _ctx: null,
  _cars: [],          // fleet: { v: hostVehicle, heading, speed, turnCd }
  _spawnT: 0,
  _rng: null,
  _built: false,

  init(ctx) {
    this._ctx = ctx;
    this._rng = (GU && GU.makeRng) ? GU.makeRng(0x7AFF1C ^ 0x33) : Math.random;
    if (Array.isArray(ctx.traffic)) ctx.traffic.length = 0;
    this._built = true;
  },

  update(dt, ctx) {
    if (!this._built) return;
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    const world = ctx.systems && ctx.systems.world && ctx.systems.world.api;
    const vehApi = ctx.systems && ctx.systems.vehicles && ctx.systems.vehicles.api;
    const player = ctx.player;
    if (!player || !player.pos) return;
    const px = player.pos.x, pz = player.pos.z;

    // spawn toward the cap on a cadence (one per tick to avoid a hitch)
    this._spawnT -= dt;
    if (this._cars.length < TRAFFIC_MAX && this._spawnT <= 0 && vehApi) {
      this._spawnT = SPAWN_INTERVAL;
      this._spawnCar(ctx, world, vehApi, px, pz);
    }

    for (const tc of this._cars) {
      if (!tc.v || !tc.v.pos) continue;
      if (tc.v.occupied) continue;     // the player jacked it — leave it to the host
      this._driveCar(tc, dt, world, px, pz);
    }
  },

  reset() { /* keep the fleet circulating across respawns */ },

  _roadHeading(dir) { return (Math.abs((dir || 0) - HALF) < 0.1) ? HALF : 0; },

  _spawnCar(ctx, world, vehApi, px, pz) {
    const rng = this._rng;
    let sx = px, sz = pz, dir = 0, found = false;
    for (let a = 0; a < 8; a++) {
      if (world && world.randomRoadSpawn) {
        const o = {}; world.randomRoadSpawn(rng, o); sx = o.x; sz = o.z; dir = o.dir || 0;
      } else {
        const ang = rng() * Math.PI * 2, r = GU.rand(rng, SPAWN_MIN_DIST, SPAWN_MAX_DIST);
        sx = px + Math.cos(ang) * r; sz = pz + Math.sin(ang) * r;
      }
      if (GU.dist2D(sx, sz, px, pz) >= SPAWN_MIN_DIST && GU.dist2D(sx, sz, px, pz) <= SPAWN_MAX_DIST) { found = true; break; }
    }
    if (!found) return;
    const heading = this._roadHeading(dir);
    const opts = { heading, color: COLORS[(rng() * COLORS.length) | 0] };
    // prefer Lane A's civilian NPC-car factory (spawnTraffic) when wired; the
    // headless harness only has spawnAt, so fall back to it there.
    const v = vehApi.spawnTraffic ? vehApi.spawnTraffic(sx, sz, opts) : vehApi.spawnAt(sx, sz, opts);
    if (!v) return;
    v.isTraffic = true;
    const tc = { v, heading, speed: CRUISE_SPEED * GU.rand(rng, 0.8, 1.15), turnCd: GU.rand(rng, 2, 6) };
    this._cars.push(tc);
    if (Array.isArray(ctx.traffic)) ctx.traffic.push(v);
    if (ctx.bus) ctx.bus.emit('traffic:spawned', { vehicle: v, pos: { x: sx, y: 0, z: sz } });
  },

  _driveCar(tc, dt, world, px, pz) {
    const v = tc.v, pos = v.pos;
    if (GU.dist2D(pos.x, pos.z, px, pz) > RECYCLE_DIST) { this._recycle(tc, world, px, pz); return; }

    const fx = Math.sin(tc.heading), fz = Math.cos(tc.heading);
    let speed = tc.speed;
    // brake if the player is close ahead (cheap collision-avoidance)
    if (GU.dist2D(pos.x + fx * 4, pos.z + fz * 4, px, pz) < 3.5) speed *= 0.2;

    const bx = pos.x, bz = pos.z;
    pos.x += fx * speed * dt; pos.z += fz * speed * dt;
    if (world && world.resolve) world.resolve(pos, 1.4);
    else { pos.x = GU.clamp(pos.x, -118, 118); pos.z = GU.clamp(pos.z, -118, 118); }

    // blocked (building/edge ate the move) or a turn is due → pick a new road axis
    tc.turnCd -= dt;
    if (GU.dist2D(pos.x, pos.z, bx, bz) < speed * dt * 0.4 || tc.turnCd <= 0) {
      this._turn(tc, world, pos);
      tc.turnCd = GU.rand(this._rng, 3, 7);
    }

    if (v.mesh) { v.mesh.position.copy(pos); v.mesh.rotation.y = tc.heading; }
    v.heading = tc.heading; v.speed = speed;
    if (v.wheels) for (const w of v.wheels) w.rotation.x -= speed * dt * 0.6;
  },

  _turn(tc, world, pos) {
    tc.heading = (((tc.heading + (this._rng() < 0.5 ? HALF : -HALF)) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (world && world.nearestRoad) { const o = {}; world.nearestRoad(pos.x, pos.z, o); pos.x = GU.lerp(pos.x, o.x, 0.5); pos.z = GU.lerp(pos.z, o.z, 0.5); }
  },

  _recycle(tc, world, px, pz) {
    const rng = this._rng;
    let sx = px, sz = pz, dir = 0, found = false;
    for (let a = 0; a < 8; a++) {
      if (world && world.randomRoadSpawn) { const o = {}; world.randomRoadSpawn(rng, o); sx = o.x; sz = o.z; dir = o.dir || 0; }
      if (GU.dist2D(sx, sz, px, pz) >= SPAWN_MIN_DIST && GU.dist2D(sx, sz, px, pz) <= SPAWN_MAX_DIST) { found = true; break; }
    }
    if (!found) return;
    tc.v.pos.set(sx, 0, sz);
    tc.heading = this._roadHeading(dir);
    const ctx = this._ctx;
    if (ctx && ctx.bus) ctx.bus.emit('traffic:despawned', { vehicle: tc.v });
  },

  api: {
    count() { return traffic._cars.length; },
    cars() { return traffic._cars.map((t) => t.v); },
    max() { return TRAFFIC_MAX; },
  },
};

GTA.register(traffic);
export default traffic;
export { traffic };
