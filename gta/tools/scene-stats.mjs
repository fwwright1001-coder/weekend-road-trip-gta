// ============================================================
// scene-stats.mjs — headless scene-cost audit. Builds (with real three.js)
// everything the GTA on-foot scene puts in the world — town buildings, the bank,
// world-detail props, pedestrians, cars, the player — and reports mesh counts
// (≈ draw calls), unique geometries/materials (GPU buffers), and lights, with a
// per-source breakdown so we know exactly where the draw-call budget goes.
// ============================================================
import * as THREE from 'three';
import fs from 'fs';
import { buildBank } from '../onfoot-bank.js';
import { buildWorldDetail } from '../onfoot-detail.js';

const src = fs.readFileSync(new URL('../../onfoot3d.js', import.meta.url), 'utf8');
function extract(sig) {
  const i = src.indexOf(sig); if (i < 0) throw new Error('not found ' + sig);
  let j = src.indexOf('{', i), depth = 0, k = j;
  for (; k < src.length; k++) { const c = src[k]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { k++; break; } } }
  return src.slice(i, k);
}
const buildPerson = new Function('THREE', extract('function buildPerson(colors, armed) {') + '\n return buildPerson;')(THREE);
const buildBuilding = new Function('THREE',
  extract('function buildBuilding(rng) {') + '\n return buildBuilding;')(THREE);
const mkrng = (s) => { let x = s >>> 0 || 1; return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296; };
const buildCarMesh = new Function('THREE', extract('function buildCarMesh(bodyColor) {') + '\n return buildCarMesh;')(THREE);

function stat(obj) {
  let meshes = 0, instanced = 0, instCount = 0, lights = 0;
  const geos = new Set(), mats = new Set();
  obj.traverse((o) => {
    if (o.isInstancedMesh) { instanced++; instCount += o.count; geos.add(o.geometry.uuid); if (o.material) mats.add(o.material.uuid); }
    else if (o.isMesh) { meshes++; if (o.geometry) geos.add(o.geometry.uuid); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m.uuid)); }
    if (o.isLight) lights++;
  });
  // draw calls ≈ regular meshes + 1 per instanced batch
  return { meshes, instanced, instCount, draws: meshes + instanced, geos: geos.size, mats: mats.size, lights };
}
function merge(a, b) { return { meshes: a.meshes + b.meshes, instanced: a.instanced + b.instanced, instCount: a.instCount + b.instCount, draws: a.draws + b.draws, geos: a.geos + b.geos, mats: a.mats + b.mats, lights: a.lights + b.lights }; }

const rows = [];
function row(name, n, s) { rows.push({ name, n, ...s }); }

// --- town buildings (host builds ~20 on a 5x5 grid minus plaza/corridor/empties)
{
  let agg = { meshes: 0, instanced: 0, instCount: 0, draws: 0, geos: 0, mats: 0, lights: 0 };
  const N = 20;
  const rng = mkrng(0x51EAD7);
  for (let i = 0; i < N; i++) { const b = buildBuilding(rng); agg = merge(agg, stat(b.mesh || b)); }
  row('town buildings (~20)', N, agg);
}
// --- bank
{ const b = buildBank(THREE, { add() {} }, {}); row('bank', 1, stat(b.group)); }
// --- world detail props
{ const root = buildWorldDetail(THREE, { add() {} }, { exclude: [{ x: 0, z: -42, r: 16 }] }); row('world detail', root.userData.detail.props, stat(root)); }
// --- pedestrians (host spawns NPC_COUNT = 16)
{
  let agg = { meshes: 0, instanced: 0, instCount: 0, draws: 0, geos: 0, mats: 0, lights: 0 };
  for (let i = 0; i < 16; i++) agg = merge(agg, stat(buildPerson({ skin: 0xd9a679, shirt: 0x2f6f8f, pants: 0x2b2b33, hair: 0x3a2a1a }, false)));
  row('pedestrians (16)', 16, agg);
}
// --- cars (host spawns 6)
{
  let agg = { meshes: 0, instanced: 0, instCount: 0, draws: 0, geos: 0, mats: 0, lights: 0 };
  for (let i = 0; i < 6; i++) { const c = buildCarMesh(0xd8392e); agg = merge(agg, stat(c.group)); }
  row('cars (6)', 6, agg);
}
// --- player
{ row('player', 1, stat(buildPerson({ skin: 0xd9a679, shirt: 0x2f6f8f, pants: 0x2b2b33, hair: 0x3a2a1a }, true))); }

// ---- report ----
const tot = rows.reduce((a, r) => merge(a, r), { meshes: 0, instanced: 0, instCount: 0, draws: 0, geos: 0, mats: 0, lights: 0 });
const pad = (s, n) => String(s).padEnd(n);
const padN = (s, n) => String(s).padStart(n);
console.log('\nSCENE COST AUDIT (GTA on-foot world; ≈ draw calls = meshes + instanced batches)\n');
console.log(pad('source', 24), padN('count', 6), padN('meshes', 8), padN('draws', 7), padN('geos', 6), padN('mats', 6), padN('lights', 7));
console.log('-'.repeat(70));
for (const r of rows) console.log(pad(r.name, 24), padN(r.n, 6), padN(r.meshes, 8), padN(r.draws, 7), padN(r.geos, 6), padN(r.mats, 6), padN(r.lights, 7));
console.log('-'.repeat(70));
console.log(pad('TOTAL', 24), padN('', 6), padN(tot.meshes, 8), padN(tot.draws, 7), padN(tot.geos, 6), padN(tot.mats, 6), padN(tot.lights, 7));
console.log('\nNote: geos/mats are summed per-source (dedup is within a source). Draw calls are\nthe FPS-relevant figure; SSAO + the base render each traverse all of them.');
