// ============================================================
// gta/tools/traffic-check.mjs — headless test of the ambient traffic AI: cars
// spawn toward a cap, actually drive, are tagged + mirrored to ctx.traffic, and
// hand off when the player jacks one. Boots gta/traffic.js on the stub harness.
// ============================================================
import '../traffic.js';
import { makeHarness } from './_harness.mjs';

let ok = true;
const fail = (m) => { ok = false; console.log('FAIL ' + m); };

const h = await makeHarness({ seed: 3 });
const { GTA, ctx } = h;
const traffic = GTA.systems.traffic;

// 1) spawns toward the cap
h.tick(1 / 60, 300);
const n = traffic.api.count();
if (!(n > 0)) fail('no traffic spawned');
if (n > traffic.api.max()) fail('traffic exceeded its cap (' + n + ' > ' + traffic.api.max() + ')');
console.log('spawned ' + n + '/' + traffic.api.max() + ' cars');

// 2) cars actually drive
const cars = traffic.api.cars();
const before = cars.map((v) => ({ x: v.pos.x, z: v.pos.z }));
h.tick(1 / 60, 180);
let moved = 0;
cars.forEach((v, i) => { if (Math.hypot(v.pos.x - before[i].x, v.pos.z - before[i].z) > 0.5) moved++; });
if (!(moved > 0)) fail('no traffic car moved over 3s');
else console.log('moved ' + moved + '/' + n + ' cars');

// 3) tagged + mirrored to ctx.traffic (so internals.traffic exposes them)
if (!cars.every((v) => v.isTraffic)) fail('a traffic car is not tagged isTraffic');
if (ctx.traffic.length !== n) fail('ctx.traffic length (' + ctx.traffic.length + ') != count (' + n + ')');

// 4) jacking hands the car off — traffic stops driving an occupied car
const car = cars[0];
car.occupied = true;
const p0 = { x: car.pos.x, z: car.pos.z };
h.tick(1 / 60, 60);
if (Math.hypot(car.pos.x - p0.x, car.pos.z - p0.z) > 0.01) fail('traffic kept driving a jacked (occupied) car');
else console.log('handoff: occupied car left to the host ✓');

console.log(ok ? '\nTRAFFIC-CHECK PASS ✅' : '\nTRAFFIC-CHECK FAIL ❌');
process.exit(ok ? 0 : 1);
