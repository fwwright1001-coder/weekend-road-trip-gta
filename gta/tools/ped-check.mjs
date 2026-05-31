// ============================================================
// gta/tools/ped-check.mjs — headless test of the round-3 pedestrian reactions.
// Extracts the pure panicPed() from onfoot3d.js (real source, via new Function)
// and checks the panic state machine, plus source-asserts the rest of the wiring
// (cower/scatter/loiter states, varied gait, startleNearby routing, internals).
// ============================================================
import fs from 'fs';

const src = fs.readFileSync(new URL('../../onfoot3d.js', import.meta.url), 'utf8');
function extract(sig) {
  const i = src.indexOf(sig); if (i < 0) throw new Error('not found ' + sig);
  let j = src.indexOf('{', i), depth = 0, k = j;
  for (; k < src.length; k++) { const c = src[k]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { k++; break; } } }
  return src.slice(i, k);
}

let ok = true;
const fail = (m) => { ok = false; console.log('FAIL ' + m); };

// panicPed closes over nothing but Math + the ped object — safe to extract & run
const panicPed = new Function(extract('function panicPed(p, tx, tz, mode) {') + '\n return panicPed;')();
const mk = (x, z) => ({ pos: { x, z }, threat: { set() {} }, state: 'wander', dead: false });

// a threat right on top + mode 'cower' → cower
{ const p = mk(0, 0); panicPed(p, 1, 0, 'cower'); if (p.state !== 'cower') fail('close cower → expected cower, got ' + p.state); }
// a far 'cower' threat → downgrade to flee (run, don't freeze across the map)
{ const p = mk(0, 0); panicPed(p, 20, 0, 'cower'); if (p.state !== 'flee') fail('far cower → expected flee, got ' + p.state); }
// scatter / flee modes set their states
{ const p = mk(0, 0); panicPed(p, 5, 0, 'scatter'); if (p.state !== 'scatter') fail('scatter → got ' + p.state); }
{ const p = mk(0, 0); panicPed(p, 5, 0, 'flee'); if (p.state !== 'flee') fail('flee → got ' + p.state); }
// a dead ped never panics
{ const p = mk(0, 0); p.dead = true; panicPed(p, 1, 0, 'cower'); if (p.state !== 'wander') fail('dead ped should not panic'); }
if (ok) console.log('panicPed: cower/flee/scatter transitions + dead-guard OK');

// source-level wiring guards (updatePed states + reactions can't run headless)
const checks = [
  [/p\.state === 'cower'/, 'updatePed handles cower'],
  [/p\.state === 'scatter'/, 'updatePed handles scatter'],
  [/'loiter'/, 'updatePed handles loiter'],
  [/speedMul/, 'peds have varied wander speed (speedMul)'],
  [/function nearestThreatVehicle/, 'peds sense fast vehicles (nearestThreatVehicle)'],
  [/panicArea\(player\.pos\.x/, 'startleNearby routes through panicArea'],
  [/panicPeds:/, 'internals exposes panicPeds'],
];
for (const [re, label] of checks) if (!re.test(src)) fail('source: ' + label + ' missing');
if (ok) console.log('wiring: cower/scatter/loiter + varied gait + vehicle-sense + panicPeds export ✓');

console.log(ok ? '\nPED-CHECK PASS ✅' : '\nPED-CHECK FAIL ❌');
process.exit(ok ? 0 : 1);
