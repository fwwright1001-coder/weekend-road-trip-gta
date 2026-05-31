// ============================================================
// gta/tools/pickups-check.mjs — headless test of the health/armor respawn system
// (gta/pickups.js): collecting a seeded pickup re-drops it after a timer, only
// the right kind respawns, and nothing fires early. Boots pickups on the harness.
// ============================================================
import '../pickups.js';
import { makeHarness } from './_harness.mjs';

let ok = true;
const fail = (m) => { ok = false; console.log('FAIL ' + m); };

const h = await makeHarness({ seed: 1 });
const { GTA } = h;
const api = GTA.systems.pickups.api;

// seed a health + an armor respawn point
api.seed('health', 40, 12, 12);
api.seed('armor', 100, 4, -8);
if (api.seedCount() !== 2) fail('seedCount != 2');

const spawned = []; GTA.bus.on('spawnPickup', (p) => spawned.push(p));
const respawned = []; GTA.bus.on('pickup:respawn', (p) => respawned.push(p));

// collecting the health pickup arms its respawn timer (only that one)
GTA.bus.emit('pickup', { kind: 'health', value: 40, pos: { x: 12, y: 0, z: 12 } });
if (api.pending() !== 1) fail('collecting health did not arm exactly one respawn (pending=' + api.pending() + ')');

// nothing re-drops before the timer elapses
h.tick(1 / 60, 120);   // ~2s
if (spawned.length !== 0) fail('a pickup respawned too early');

// after the respawn time, the health pickup re-drops at its seed point
const T = api.respawnTime();
h.tick(1, Math.ceil(T) + 1);   // step in 1s increments past T
const reH = spawned.find((p) => p.kind === 'health');
if (!reH) fail('health pickup did not respawn after ' + T + 's');
else if (Math.hypot((reH.pos.x || 0) - 12, (reH.pos.z || 0) - 12) > 0.01) fail('health respawned at the wrong spot');
if (!respawned.some((p) => p.kind === 'health')) fail('pickup:respawn not emitted');
if (api.pending() !== 0) fail('respawn timer not cleared after firing');
// the armor seed (never collected) must NOT have respawned
if (spawned.some((p) => p.kind === 'armor')) fail('armor respawned without being collected');

if (ok) console.log(`respawn: health re-dropped at its seed after ${T}s; armor untouched; pending=${api.pending()}`);
console.log(ok ? '\nPICKUPS-CHECK PASS ✅' : '\nPICKUPS-CHECK FAIL ❌');
process.exit(ok ? 0 : 1);
