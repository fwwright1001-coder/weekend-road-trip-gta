// ============================================================
// collision-probe.mjs — ground-truth test of the bank's wall physics.
// Runs the REAL onfoot3d.resolveCollision (extracted from source) against the
// REAL bank footprints (from onfoot-bank.js, built with real three.js) and
// marches a virtual walker / car at the bank from every angle to see what
// actually leaks. XZ only (resolveCollision is 2D); vertical phasing is reasoned
// about separately.
// ============================================================
import * as THREE from 'three';
import fs from 'fs';
import { buildBank } from '../onfoot-bank.js';

// ---- host constants (mirror onfoot3d.js) -----------------------------------
const BOUND = 58, PLAYER_R = 0.45, CAR_RADIUS = 1.9, WALK = 4.4, RUN = 7.6, CAR_MAX_SPEED = 36;

// ---- extract the REAL resolveCollision from onfoot3d.js ---------------------
const src = fs.readFileSync(new URL('../../onfoot3d.js', import.meta.url), 'utf8');
function extract(sig) {
  const i = src.indexOf(sig); if (i < 0) throw new Error('not found ' + sig);
  let j = src.indexOf('{', i), depth = 0, k = j;
  for (; k < src.length; k++) { const c = src[k]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { k++; break; } } }
  return src.slice(i, k);
}
// resolveCollision + insideBuilding both close over `aabbs` and `BOUND`.
const makeColliders = new Function('aabbs', 'BOUND',
  extract('function insideBuilding(x, z, pad) {') + '\n' +
  extract('function resolveCollision(pos, pad) {') + '\n' +
  'return { insideBuilding, resolveCollision };');

// ---- build the real bank, collect footprints --------------------------------
const stubScene = { add() {} };
const bank = buildBank(THREE, stubScene, {});
const aabbs = bank.footprints.slice();
const { resolveCollision, insideBuilding } = makeColliders(aabbs, BOUND);

const cx = bank.position.x, cz = bank.position.z;       // 0, -42
const HALF_W = 11, HALF_D = 8, WALL_T = 0.7;
// interior = inside the inner faces of the perimeter wall ring
function isInterior(p) {
  return p.x > cx - HALF_W + WALL_T && p.x < cx + HALF_W - WALL_T
      && p.z > cz - HALF_D + WALL_T && p.z < cz + HALF_D - WALL_T;
}

// march a point from `start` along unit `dir` at `speed`, resolving each frame
function march(start, dir, speed, dt, frames, pad) {
  const p = { x: start.x, z: start.z };
  for (let i = 0; i < frames; i++) {
    p.x += dir.x * speed * dt;
    p.z += dir.z * speed * dt;
    resolveCollision(p, pad);
  }
  return p;
}
function unit(dx, dz) { const l = Math.hypot(dx, dz) || 1; return { x: dx / l, z: dz / l }; }

let pass = 0, fail = 0;
function check(name, cond, detail) {
  (cond ? (pass++) : (fail++));
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

console.log('bank center', cx, cz, '| doorPos', bank.doorPos, '| footprints', aabbs.length, '\n');

// T1 — door entry works (walk straight in along x=0)
{
  const end = march({ x: cx, z: cz + 12 }, unit(0, -1), WALK, 1 / 60, 1200, PLAYER_R);
  check('door entry reaches interior', isInterior(end), `end=(${end.x.toFixed(2)},${end.z.toFixed(2)})`);
}
// T2 — front wall blocks an OFF-door approach (x=-7 lines up with the left jamb)
{
  const end = march({ x: cx - 7, z: cz + 12 }, unit(0, -1), RUN, 1 / 60, 1200, PLAYER_R);
  check('front jamb blocks off-door walker', !isInterior(end), `end=(${end.x.toFixed(2)},${end.z.toFixed(2)})`);
}
// T3 — side walls block (push straight through the left wall, WALK + RUN, normal + worst-case dt)
for (const [spd, name] of [[WALK, 'WALK'], [RUN, 'RUN']]) {
  for (const dt of [1 / 60, 0.05]) {
    const end = march({ x: cx - 18, z: cz }, unit(1, 0), spd, dt, 1600, PLAYER_R);
    check(`left wall blocks ${name} dt=${dt.toFixed(3)}`, !isInterior(end), `end=(${end.x.toFixed(2)},${end.z.toFixed(2)})`);
  }
}
// T4 — back wall blocks
{
  const end = march({ x: cx, z: cz - 16 }, unit(0, 1), RUN, 0.05, 1600, PLAYER_R);
  check('back wall blocks RUN dt=0.050', !isInterior(end), `end=(${end.x.toFixed(2)},${end.z.toFixed(2)})`);
}
// T5 — CAR ramming the side wall at top speed (tests tunneling for the heavier/faster body)
{
  const end = march({ x: cx - 18, z: cz }, unit(1, 0), CAR_MAX_SPEED, 0.05, 400, CAR_RADIUS);
  check('car does NOT tunnel side wall at top speed', !isInterior(end), `end=(${end.x.toFixed(2)},${end.z.toFixed(2)})`);
}

console.log(`\n${fail === 0 ? 'COLLISION-PROBE PASS ✅' : 'COLLISION-PROBE: ' + fail + ' LEAK(S) ❌'}  (${pass} pass / ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
