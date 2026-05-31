// ============================================================
// gta/tools/onfoot-smoke.mjs — the canonical headless self-verify for the GTA
// on-foot systems layer. ONE command (`npm run smoke`, from gta/) that any lane
// can run to confirm its changes didn't break the integrated stack.
//
// It runs every inspector/test in tools/ as a subprocess (so a throw in one
// can't take down the others) plus the end-to-end mission sim across a spread of
// seeds, then prints a PASS/FAIL/SKIP table and exits non-zero iff a real check
// failed.
//
// GRACEFUL DEGRADATION (this is the point): checks that depend on a SIBLING
// lane's not-yet-landed artifact — e.g. aim-check/actor-check need Lane A's
// assets/models/Soldier.glb — are SKIPPED, not failed, when that artifact is
// absent. So Lane D (and anyone) can self-verify before A/B/C have merged. As
// each lane lands its asset, its check flips from SKIP to PASS automatically.
//
//   node tools/onfoot-smoke.mjs [-v|--verbose] [--seeds=1,2,7]
// ============================================================
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // .../gta/tools
const GTA = path.resolve(HERE, '..');                       // .../gta
const ROOT = path.resolve(GTA, '..');                       // repo root
const NODE = process.execPath;

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('-v') || argv.includes('--verbose');
const seedArg = argv.find((a) => a.startsWith('--seeds='));
const SIM_SEEDS = seedArg
  ? seedArg.slice('--seeds='.length).split(',').map((s) => parseInt(s, 10)).filter(Number.isFinite)
  : [1, 2, 7, 42, 99];

// ---- artifacts other lanes own (gate SKIP vs RUN) --------------------------
const SOLDIER = path.join(ROOT, 'assets', 'models', 'Soldier.glb');   // Lane A
const FX_JS = path.join(GTA, 'fx.js');                                 // Lane B
const THREE_INSTALLED = existsSync(path.join(GTA, 'node_modules', 'three'));

// each check: a tool to run; `need` (if set and missing) turns RUN into SKIP.
const CHECKS = [
  { name: 'mesh-check',      file: 'mesh-check.mjs',      what: 'procedural person/car meshes honor their contracts' },
  { name: 'collision-probe', file: 'collision-probe.mjs', what: 'real resolveCollision holds the bank walls (no tunneling)' },
  { name: 'physics-check',   file: 'physics-check.mjs',   what: 'car-vs-building impact: speed loss + crash events + FP wiring' },
  { name: 'police-check',    file: 'police-check.mjs',    what: 'cop AI: gang faction + cover + backup waves + flanking' },
  { name: 'traffic-check',   file: 'traffic-check.mjs',   what: 'ambient NPC traffic spawns, drives, caps, hands off when jacked' },
  { name: 'pickups-check',   file: 'pickups-check.mjs',   what: 'health/armor pickups re-seed on a timer after collection' },
  { name: 'ped-check',       file: 'ped-check.mjs',       what: 'pedestrian panic/cower/scatter/loiter reactions' },
  { name: 'scene-stats',     file: 'scene-stats.mjs',     what: 'full scene builds headlessly (draw-call audit)' },
  { name: 'aim-check',       file: 'aim-check.mjs',       what: 'gun/aim rig wires to the Soldier skeleton',
    need: SOLDIER, needLabel: 'assets/models/Soldier.glb (Lane A)' },
  { name: 'actor-check',     file: 'actor-check.mjs',     what: 'rigged actor loads/skins/animates/clones',
    need: SOLDIER, needLabel: 'assets/models/Soldier.glb (Lane A)' },
];

function hr() { console.log('-'.repeat(78)); }
const pad = (s, n) => String(s).padEnd(n);

// ---- preflight: three.js must be installed for any check to run ------------
if (!THREE_INSTALLED) {
  console.error('\n[smoke] three.js is not installed — every check imports it.');
  console.error('[smoke] run `npm install` from gta/ first, then `npm run smoke`.\n');
  process.exit(2);
}

function runTool(file) {
  const r = spawnSync(NODE, [path.join('tools', file)], { cwd: GTA, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), err: r.error };
}

const results = [];   // {name, status:'pass'|'fail'|'skip', detail}

// ---- 1. inspector/unit checks ---------------------------------------------
console.log('\n=== GTA on-foot smoke — inspector checks ===\n');
for (const c of CHECKS) {
  if (c.need && !existsSync(c.need)) {
    results.push({ name: c.name, status: 'skip', detail: `needs ${c.needLabel}` });
    console.log(`SKIP  ${pad(c.name, 16)} — ${c.what}\n        (waiting on ${c.needLabel})`);
    continue;
  }
  const r = runTool(c.file);
  const ok = r.code === 0 && !r.err;
  results.push({ name: c.name, status: ok ? 'pass' : 'fail', detail: c.what });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${pad(c.name, 16)} — ${c.what}`);
  if ((!ok || VERBOSE) && r.out) {
    const tail = r.out.trimEnd().split('\n').slice(VERBOSE ? -20 : -8);
    for (const ln of tail) console.log('        | ' + ln);
  }
}

// ---- 2. end-to-end mission sim across seeds (the core integration test) ----
console.log('\n=== end-to-end heist sim ===');
console.log(existsSync(FX_JS)
  ? '(gta/fx.js present — exercised through the bridge import below)\n'
  : '(gta/fx.js not yet landed by Lane B — sim runs without it)\n');
let simPass = 0, simFail = 0;
for (const seed of SIM_SEEDS) {
  const r = spawnSync(NODE, [path.join('tools', 'onfoot-sim.mjs'), String(seed)], { cwd: GTA, encoding: 'utf8' });
  const ok = r.status === 0;
  ok ? simPass++ : simFail++;
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('SIMRESULT')) || '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  sim seed=${pad(seed, 4)} ${line.replace('SIMRESULT ', '')}`);
  if (!ok) {
    const tail = ((r.stdout || '') + (r.stderr || '')).trimEnd().split('\n').slice(-12);
    for (const ln of tail) console.log('        | ' + ln);
  }
}
results.push({ name: `sim (${SIM_SEEDS.length} seeds)`, status: simFail === 0 ? 'pass' : 'fail', detail: `${simPass}/${SIM_SEEDS.length} won` });

// ---- summary ---------------------------------------------------------------
const pass = results.filter((r) => r.status === 'pass').length;
const fail = results.filter((r) => r.status === 'fail').length;
const skip = results.filter((r) => r.status === 'skip').length;

console.log('\n');
hr();
console.log('SMOKE SUMMARY');
hr();
for (const r of results) {
  const tag = r.status === 'pass' ? 'PASS ✅' : r.status === 'fail' ? 'FAIL ❌' : 'SKIP ⏭';
  console.log(`  ${pad(tag, 8)} ${pad(r.name, 18)} ${r.detail}`);
}
hr();
console.log(`  ${pass} passed · ${fail} failed · ${skip} skipped`);
if (skip) console.log('  (skips are sibling-lane artifacts not landed yet — not failures)');
hr();

process.exit(fail === 0 ? 0 : 1);
