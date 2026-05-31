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

const TRAFFIC_MAX    = 16;    // hard cap on ambient cars (perf)
const SPAWN_INTERVAL = 0.3;   // seconds between spawns while under the cap
const SPAWN_MIN_DIST = 24;    // spawn this far from the player at least
const SPAWN_MAX_DIST = 85;
const RECYCLE_DIST   = 150;   // relocate a car that drifts past this (cheap despawn)
const CRUISE_SPEED   = 9;     // m/s
const HALF = Math.PI / 2;

// car-to-car avoidance: scan a short forward cone and brake/steer off any car ahead
const AVOID_RANGE    = 6;     // m — only cars within this distance matter
const AVOID_RANGE_SQ = AVOID_RANGE * AVOID_RANGE;
const AVOID_DOT      = 0.7;   // cos of the half-cone: only count cars roughly ahead
// flee-from-violence: gunfire/explosions scare nearby cars into a brief sprint away
const FLEE_RADIUS    = 22;    // m — events within this spook a car
const FLEE_RADIUS_SQ = FLEE_RADIUS * FLEE_RADIUS;
const FLEE_TIME      = 3;     // s of panic before decaying back to cruising
const FLEE_SPEED_MUL = 1.9;   // target-speed boost while fleeing
// road-grid lane following: ease the heading onto the road axis at the car and
// bias it into the right-hand lane (offset from the centerline).
const LANE_OFFSET    = 2.5;   // m — right-of-centerline lane bias (≈ roadHalf/2)
const TRACK_LAMBDA   = 4;     // exponential approach rate for heading → road axis
const LANE_LAMBDA    = 2.2;   // gentler approach for the lateral lane-centering nudge
// intersections sit where an X-road and a Z-road cross (block corners). Cars slow
// on approach and may commit to a 90° turn there (gated by the existing turnCd).
const ISECT_SLOW_R   = 7;     // m — start slowing within this of an intersection center
const ISECT_SLOW_MUL = 0.55;  // speed scale while creeping through an intersection
// brake for soft targets ahead (player + peds) in the forward cone
const PED_BRAKE_R    = 5.5;   // m — peds within this (and ahead) trigger a brake
const PED_BRAKE_R_SQ = PED_BRAKE_R * PED_BRAKE_R;
const PED_BRAKE_DOT  = 0.6;   // cos of the half-cone for soft targets ahead
const COLORS = [0x9aa0a6, 0x2f6f8f, 0xb5432e, 0xece8df, 0x3a3f4a, 0x2b6b3a, 0xc8a24a];

const traffic = {
  name: 'traffic',
  deps: ['world', 'vehicles'],
  _ctx: null,
  _cars: [],          // fleet: { v: hostVehicle, heading, speed, turnCd }
  _spawnT: 0,
  _rng: null,
  _built: false,
  _road: null,        // reusable scratch for world.nearestRoad(x,z,out) — no per-frame alloc

  init(ctx) {
    this._ctx = ctx;
    this._rng = (GU && GU.makeRng) ? GU.makeRng(0x7AFF1C ^ 0x33) : Math.random;
    if (Array.isArray(ctx.traffic)) ctx.traffic.length = 0;

    // REACT TO VIOLENCE: gunfire and explosions scare nearby cars into a brief
    // flee state (raised target speed + steer away from the event). Cheap: just
    // tag cars in radius; _driveCar applies + decays the panic.
    const bus = ctx.bus;
    if (bus) {
      bus.on('crime', (e) => { if (e && e.kind === 'gunfire') this._scare(e.pos); });
      bus.on('fx:explosion', (e) => { if (e) this._scare(e.pos, 1.4); });
    }
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
    const tc = { v, heading, speed: CRUISE_SPEED * GU.rand(rng, 0.8, 1.15), turnCd: GU.rand(rng, 2, 6), fleeT: 0, fleeX: 0, fleeZ: 0 };
    this._cars.push(tc);
    if (Array.isArray(ctx.traffic)) ctx.traffic.push(v);
    if (ctx.bus) ctx.bus.emit('traffic:spawned', { vehicle: v, pos: { x: sx, y: 0, z: sz } });
  },

  _driveCar(tc, dt, world, px, pz) {
    const v = tc.v, pos = v.pos;
    if (GU.dist2D(pos.x, pos.z, px, pz) > RECYCLE_DIST) { this._recycle(tc, world, px, pz); return; }

    let speed = tc.speed;
    const fleeing = tc.fleeT > 0;

    // FLEE: while panicking, floor it and steer the heading away from the event,
    // then decay the panic back to cruising. Steering nudges heading toward the
    // away-vector before it snaps to the road axis on the next turn. Flee wins
    // over lane-following so a scared car will cut across the grid to escape.
    if (fleeing) {
      tc.fleeT -= dt;
      speed = tc.speed * FLEE_SPEED_MUL;
      const ax = pos.x - tc.fleeX, az = pos.z - tc.fleeZ;
      if (ax || az) {
        const away = Math.atan2(ax, az);
        tc.heading = GU.lerpAngle(tc.heading, away, Math.min(1, dt * 3));
      }
    } else if (world && world.nearestRoad) {
      // ROAD-GRID LANE FOLLOWING: snap the *intent* onto the road axis at the car
      // and bias toward the right-hand lane, then ease the heading there with a
      // shortest-arc lerp so the car tracks the grid smoothly instead of snapping.
      // Guarded on world.nearestRoad so the headless stub (or a world without it)
      // simply skips this and the car cruises on its existing heading.
      const r = this._road || (this._road = {});
      world.nearestRoad(pos.x, pos.z, r);
      // the road runs along Z (dir≈0) or X (dir≈PI/2); pick the travel direction
      // (forward / reverse along that axis) that best matches the current heading.
      const axis = (Math.abs((r.dir || 0) - HALF) < 0.1) ? HALF : 0;
      const afx = Math.sin(axis), afz = Math.cos(axis);
      const cfx = Math.sin(tc.heading), cfz = Math.cos(tc.heading);
      const sign = (cfx * afx + cfz * afz) >= 0 ? 1 : -1;
      const tfx = afx * sign, tfz = afz * sign;     // unit travel direction on the road
      // right-hand lane: offset the centerline laterally to the car's right
      // (right of travel = travel vector rotated -90° → (fz, -fx)).
      const rgtx = tfz, rgtz = -tfx;
      let targetHeading = Math.atan2(tfx, tfz);
      // lateral correction: how far off the (lane-offset) centerline are we?
      // r.x/r.z is the centerline point; the lane sits LANE_OFFSET to its right.
      const laneX = r.x + rgtx * LANE_OFFSET, laneZ = r.z + rgtz * LANE_OFFSET;
      const offX = laneX - pos.x, offZ = laneZ - pos.z;
      // project the lateral error onto the right vector → signed distance off-lane,
      // and fold a small steering correction toward the lane into the target heading.
      const lat = offX * rgtx + offZ * rgtz;
      const corr = GU.clamp(lat * 0.25, -0.6, 0.6);   // radians of steer toward lane
      targetHeading += corr;
      tc.heading = GU.lerpAngle(tc.heading, targetHeading, 1 - Math.exp(-TRACK_LAMBDA * dt));
      // gentle direct lateral pull so cars settle into the lane even on a straightaway
      const pull = 1 - Math.exp(-LANE_LAMBDA * dt);
      pos.x += offX * pull * 0.5; pos.z += offZ * pull * 0.5;

      // INTERSECTION HANDLING: an intersection center is a block corner where both
      // an X-road and a Z-road cross — i.e. both coords are near a grid line. Slow
      // on approach; if a turn is due (turnCd elapsed) commit to a 90° turn here so
      // the car turns AT the junction and doesn't jitter mid-block.
      const bs = (world.blockSize || 24), off = (world.roadOffset != null ? world.roadOffset : 12);
      const dgx = Math.abs(((pos.x - off) % bs + bs * 1.5) % bs - bs * 0.5);
      const dgz = Math.abs(((pos.z - off) % bs + bs * 1.5) % bs - bs * 0.5);
      if (dgx < ISECT_SLOW_R && dgz < ISECT_SLOW_R) {
        speed *= ISECT_SLOW_MUL;            // creep through the junction
        if (tc.turnCd <= 0) { this._turn(tc, world, pos); tc.turnCd = GU.rand(this._rng, 3, 7); }
      }
    }

    const fx = Math.sin(tc.heading), fz = Math.cos(tc.heading);

    // brake if the player is close ahead (cheap collision-avoidance)
    if (GU.dist2D(pos.x + fx * 4, pos.z + fz * 4, px, pz) < 3.5) speed *= 0.2;

    // BRAKE FOR PEDS: peds are mirrored into ctx.targets by the bridge (kind:'ped');
    // brake for any live one sitting close ahead in the forward cone. Sourced from
    // ctx.targets (no global) so it's a cheap no-op in the headless stub (empty list).
    const targets = this._ctx && this._ctx.targets;
    if (targets && targets.length) {
      for (const t of targets) {
        if (!t || t.kind !== 'ped' || t.dead || !t.pos) continue;
        const dx = t.pos.x - pos.x, dz = t.pos.z - pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > PED_BRAKE_R_SQ || d2 < 1e-6) continue;
        const inv = 1 / Math.sqrt(d2);
        if ((dx * inv) * fx + (dz * inv) * fz <= PED_BRAKE_DOT) continue;  // not ahead
        speed *= 0.15; break;               // someone on foot ahead → brake hard
      }
    }

    // CAR-TO-CAR AVOIDANCE: brake (and lightly steer off) any live car sitting in
    // a short forward cone. O(n^2) over ~16 cars — cheap and headless-safe.
    let nudge = 0;
    for (const oc of this._cars) {
      if (oc === tc) continue;
      const ov = oc.v; if (!ov || !ov.pos) continue;
      const dx = ov.pos.x - pos.x, dz = ov.pos.z - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > AVOID_RANGE_SQ || d2 < 1e-6) continue;
      const inv = 1 / Math.sqrt(d2);
      const dot = (dx * inv) * fx + (dz * inv) * fz;   // forward · toOther
      if (dot <= AVOID_DOT) continue;                  // not ahead → ignore
      speed *= 0.15;                                   // someone's ahead → brake hard
      // steer away from its side: sign of the cross product (forward × toOther)
      nudge += (fx * dz - fz * dx) < 0 ? 0.6 : -0.6;
    }
    if (nudge) tc.heading += nudge * dt;

    const bx = pos.x, bz = pos.z;
    pos.x += fx * speed * dt; pos.z += fz * speed * dt;
    if (world && world.resolve) world.resolve(pos, 1.4);
    else { pos.x = GU.clamp(pos.x, -118, 118); pos.z = GU.clamp(pos.z, -118, 118); }

    // pick a new road axis when BLOCKED (a building/edge ate the move). When NOT
    // road-following (no world / fleeing) also turn on the timer so cars still
    // wander; while road-following, turns are committed AT intersections (above)
    // so a mid-block timer turn doesn't fight the lane-follower and jitter.
    tc.turnCd -= dt;
    const blocked = GU.dist2D(pos.x, pos.z, bx, bz) < speed * dt * 0.4;
    const roadFollowing = !fleeing && world && world.nearestRoad;
    if (blocked || (!roadFollowing && tc.turnCd <= 0)) {
      this._turn(tc, world, pos);
      tc.turnCd = GU.rand(this._rng, 3, 7);
    }

    if (v.mesh) { v.mesh.position.copy(pos); v.mesh.rotation.y = tc.heading; }
    v.heading = tc.heading; v.speed = speed;
    if (v.wheels) for (const w of v.wheels) w.rotation.x -= speed * dt * 0.6;
  },

  // tag every car within FLEE_RADIUS of a violent event so _driveCar makes it bolt.
  _scare(pos, mul = 1) {
    if (!pos) return;
    const ex = pos.x || 0, ez = pos.z || 0;
    for (const tc of this._cars) {
      const v = tc.v; if (!v || !v.pos || v.occupied) continue;
      const dx = v.pos.x - ex, dz = v.pos.z - ez;
      if (dx * dx + dz * dz > FLEE_RADIUS_SQ * mul * mul) continue;
      tc.fleeT = FLEE_TIME;
      tc.fleeX = ex; tc.fleeZ = ez;
    }
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
