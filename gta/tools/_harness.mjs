// ============================================================
// gta/tools/_harness.mjs — minimal headless harness for SYSTEM unit tests.
// Real three.js + a stub world/vehicles shim + a fake scene + GTA.boot, so a
// single system (police/traffic/pickups/...) can be exercised in isolation
// without the full onfoot3d host. Not a smoke "check" itself (underscore name).
//
// Usage:
//   import '../wanted.js'; import '../police.js';   // register systems first
//   import { makeHarness } from './_harness.mjs';
//   const h = await makeHarness({ seed: 1 });
//   h.raiseStars(5); h.tick(1/60, 400);
// ============================================================
import { GTA, GU } from '../core.js';
const THREE = await import('three');

const BLOCK = 24, ROAD_OFFSET = 12, BOUND = 58;

export async function makeHarness(opts = {}) {
  // a 5x5 grid of building footprints (with a plaza/corridor gap), like the host
  const aabbs = [];
  for (let gx = -2; gx <= 2; gx++) for (let gz = -2; gz <= 2; gz++) {
    if (gx === 0 && (gz === 0 || gz === -1)) continue;
    const cx = gx * BLOCK, cz = gz * BLOCK;
    aabbs.push({ minX: cx - 6, maxX: cx + 6, minZ: cz - 6, maxZ: cz + 6 });
  }
  const inside = (x, z, pad = 0) => { for (const a of aabbs) if (x > a.minX - pad && x < a.maxX + pad && z > a.minZ - pad && z < a.maxZ + pad) return a; return null; };
  const resolve = (pos, pad = 0.4) => {
    for (const a of aabbs) if (pos.x > a.minX - pad && pos.x < a.maxX + pad && pos.z > a.minZ - pad && pos.z < a.maxZ + pad) {
      const dl = pos.x - (a.minX - pad), dr = (a.maxX + pad) - pos.x, db = pos.z - (a.minZ - pad), df = (a.maxZ + pad) - pos.z;
      const m = Math.min(dl, dr, db, df);
      if (m === dl) pos.x = a.minX - pad; else if (m === dr) pos.x = a.maxX + pad; else if (m === db) pos.z = a.minZ - pad; else pos.z = a.maxZ + pad;
    }
    pos.x = GU.clamp(pos.x, -BOUND, BOUND); pos.z = GU.clamp(pos.z, -BOUND, BOUND);
  };
  const worldApi = {
    bound: BOUND, blockSize: BLOCK, roadHalf: 5, roadOffset: ROAD_OFFSET,
    isInside: (x, z, pad = 0) => !!inside(x, z, pad),
    resolve: (pos, pad = 0.4) => { resolve(pos, pad); return pos; },
    onRoad: (x, z) => !inside(x, z, 0) && Math.abs(x) <= BOUND && Math.abs(z) <= BOUND,
    nearestRoad(x, z, out = {}) {
      const sx = Math.round((x - ROAD_OFFSET) / BLOCK) * BLOCK + ROAD_OFFSET;
      const sz = Math.round((z - ROAD_OFFSET) / BLOCK) * BLOCK + ROAD_OFFSET;
      if (Math.abs(x - sx) < Math.abs(z - sz)) { out.x = GU.clamp(sx, -BOUND, BOUND); out.z = GU.clamp(z, -BOUND, BOUND); out.dir = 0; }
      else { out.x = GU.clamp(x, -BOUND, BOUND); out.z = GU.clamp(sz, -BOUND, BOUND); out.dir = Math.PI / 2; }
      return out;
    },
    randomRoadSpawn(rng, out = {}) {
      const r = rng || Math.random;
      const k = Math.round((r() * 2 - 1) * (BOUND / BLOCK) - 0.5);
      const line = GU.clamp(k * BLOCK + ROAD_OFFSET, -BOUND, BOUND);
      const along = (r() * 2 - 1) * (BOUND - 6);
      if (r() < 0.5) { out.x = line; out.z = along; out.dir = 0; } else { out.x = along; out.z = line; out.dir = Math.PI / 2; }
      return out;
    },
    randomLandmark: () => ({ pos: { x: 0, z: 8 } }),
  };
  const world = { name: 'world', deps: [], aabbs, api: worldApi, init(c) { c.world = worldApi; }, update() {}, reset() {} };

  const vehicles = [];
  const vehApi = {
    count: () => vehicles.length,
    spawnAt(x, z, o) {
      const v = { pos: new THREE.Vector3(x, 0, z), heading: (o && o.heading) || 0, speed: 0, occupied: false, mesh: new THREE.Group(), wheels: [], isTraffic: false };
      vehicles.push(v); return v;
    },
    nearestEnterable: () => null, playerVehicle: () => null, forceExit() {},
  };
  const vehiclesSys = { name: 'vehicles', deps: [], api: vehApi, init() {}, update() {}, reset() {} };

  if (!GTA.systems.world) GTA.register(world);
  if (!GTA.systems.vehicles) GTA.register(vehiclesSys);

  const ctx = {
    THREE, headless: true,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000),
    renderer: { render() {} },
    player: { pos: new THREE.Vector3(opts.px || 0, 0, opts.pz || 0), vel: new THREE.Vector3(), inVehicle: false, health: 100, maxHealth: 100, armor: 0, money: 0, alive: true },
    input: { keys: new Set(), pressed: () => false, consume: () => false, held: () => false },
    world: null, targets: [], traffic: [],
    time: { t: 0, dt: 0 }, rng: GU.makeRng(opts.seed || 1),
    config: { difficulty: 1, pedDensity: 1, persist: false, mode: 'onfoot' },
  };
  GTA.boot(ctx, { mode: 'onfoot' });

  return {
    GTA, ctx, THREE, vehicles, aabbs, worldApi,
    tick(dt, n = 1) { for (let i = 0; i < n; i++) GTA.tick(dt, ctx); },
    raiseStars(n) { const w = ctx.systems.wanted && ctx.systems.wanted.api; if (w) w.add(50); },   // saturate heat -> 5 stars
    movePlayer(x, z) { ctx.player.pos.set(x, 0, z); },
  };
}
