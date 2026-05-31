// ============================================================
// gta/tools/physics-check.mjs — headless unit test for gta/physics.js, the
// dynamic car-vs-building impact response. Drives a stub car into a "wall" at
// several angles/speeds and asserts the momentum response + feedback events:
//   * a real hit LOSES SPEED (not a dead stop) and EMITS an impact event
//   * a hard head-on bounces back; a slow hit bleeds; a tiny scrape neither
//     crashes nor spams events
//   * crumple damage accumulates + clamps; the body jolt sets then decays
// Plus a source-level guard that onfoot3d.js's updateDriving actually calls
// OF.carImpact (the wiring), so the host hand-off can't silently rot.
// Pure math + GTA.bus — no DOM, no three.js: proves headless-safety by running.
// ============================================================
import fs from 'fs';
import { GTA } from '../core.js';
import { carImpact, system } from '../physics.js';

let ok = true;
const fail = (m) => { ok = false; console.log('FAIL ' + m); };
const events = [];
GTA.bus.on('shake', (p) => events.push(['shake', p]));
GTA.bus.on('fx:impact', (p) => events.push(['fx:impact', p]));
GTA.bus.on('fx:crash', (p) => events.push(['fx:crash', p]));

const mkCar = (speed) => ({ pos: { x: 0, y: 0, z: 0 }, heading: 0, speed, mesh: {} });
// a head-on hit: the car wanted to travel `intended` but moved ~0; the push-out
// vector points back along -travel (the wall normal).
const headOnInfo = (speed, dt = 1 / 60) => ({ speed, dt, dirx: 0, dirz: 1, intended: Math.abs(speed) * dt, moved: 0, pushX: 0, pushZ: -Math.abs(speed) * dt });

// T1 — fast head-on: big speed loss, bounce-back, all three feedback events, jolt+damage
{
  events.length = 0;
  const v = mkCar(30);
  const sev = carImpact(v, headOnInfo(30));
  if (!(Math.abs(v.speed) < 30)) fail('fast head-on did not reduce speed: ' + v.speed);
  if (!(v.speed < 0)) fail('fast head-on did not bounce back (speed should flip negative): ' + v.speed);
  if (!(sev > 0.5)) fail('fast head-on severity too low: ' + sev);
  if (!events.some((e) => e[0] === 'fx:crash')) fail('fast head-on did not emit fx:crash');
  if (!events.some((e) => e[0] === 'fx:impact')) fail('fast head-on did not emit fx:impact');
  if (!events.some((e) => e[0] === 'shake')) fail('fast head-on did not emit shake');
  if (!(v.crashJolt > 0)) fail('fast head-on did not set a body jolt');
  if (!(v.damage > 0)) fail('fast head-on did not accumulate damage');
  const imp = events.find((e) => e[0] === 'fx:impact')[1];
  if (!imp.pos || !imp.normal) fail('fx:impact payload missing pos/normal');
  console.log(`fast head-on: 30 -> ${v.speed.toFixed(2)} (bounce) sev=${sev.toFixed(2)} jolt=${v.crashJolt.toFixed(3)} dmg=${v.damage.toFixed(2)} events=${events.length}`);
}

// T2 — slow head-on: still loses speed + emits a crash, but does NOT bounce
{
  events.length = 0;
  const v = mkCar(5);
  const sev = carImpact(v, headOnInfo(5));
  if (!(v.speed >= 0 && v.speed < 5)) fail('slow head-on should bleed forward speed (no bounce): ' + v.speed);
  if (!events.some((e) => e[0] === 'fx:crash')) fail('slow head-on did not emit fx:crash');
  console.log(`slow head-on: 5 -> ${v.speed.toFixed(2)} sev=${sev.toFixed(2)} (no bounce, crash emitted)`);
}

// T3 — tiny scrape: below the crash threshold → slides, sheds a little, NO crash events
{
  events.length = 0;
  const v = mkCar(1.2);
  const sev = carImpact(v, headOnInfo(1.2));
  if (events.length !== 0) fail('tiny scrape should emit no crash/shake events, got ' + events.length);
  if (!(v.speed > 0 && v.speed <= 1.2)) fail('tiny scrape should keep most speed: ' + v.speed);
  if (sev >= 0.1) fail('tiny scrape severity should be near zero: ' + sev);
  console.log(`tiny scrape: 1.2 -> ${v.speed.toFixed(2)} sev=${sev.toFixed(3)} (no events — correct)`);
}

// T4 — crumple damage accumulates across hits and clamps at 1
{
  const v = mkCar(30);
  for (let i = 0; i < 8; i++) { v.speed = 30; carImpact(v, headOnInfo(30)); }
  if (!(v.damage > 0.5)) fail('repeated impacts should pile up damage: ' + v.damage);
  if (v.damage > 1) fail('damage should clamp at 1: ' + v.damage);
  console.log(`crumple after 8 hits: damage=${v.damage.toFixed(2)} (clamped <=1)`);
}

// T5 — body jolt decays back to rest via the system update()
{
  const v = mkCar(30);
  carImpact(v, headOnInfo(30));
  const j0 = v.crashJolt;
  for (let i = 0; i < 120; i++) system.update(1 / 60);
  if (!(j0 > 0)) fail('jolt should be set after impact');
  if (!(Math.abs(v.crashJolt) < 1e-3)) fail('jolt did not decay to ~0: ' + v.crashJolt);
  console.log(`jolt decay: ${j0.toFixed(3)} -> ${v.crashJolt.toFixed(4)} over ~2s`);
}

// T7 — height-aware crash (Lane C's data): a tall tower crashes harder than a low
//      house at the same speed — more shake + more crumple, same speed response
{
  const low = mkCar(30); let shakeLow = 0;
  let off = GTA.bus.on('shake', (p) => { shakeLow = p.amount; });
  carImpact(low, { ...headOnInfo(30), buildingHeight: 5 }); off();
  const tall = mkCar(30); let shakeTall = 0;
  off = GTA.bus.on('shake', (p) => { shakeTall = p.amount; });
  carImpact(tall, { ...headOnInfo(30), buildingHeight: 27 }); off();
  if (!(shakeTall > shakeLow)) fail(`tall building should shake more (${shakeTall} vs ${shakeLow})`);
  if (!(tall.damage > low.damage)) fail(`tall building should crumple more (${tall.damage} vs ${low.damage})`);
  if (Math.abs(low.speed - tall.speed) > 1e-9) fail('building height must NOT change the speed response');
  console.log(`height-aware: house(h5) shake=${shakeLow.toFixed(2)} dmg=${low.damage.toFixed(2)} | tower(h27) shake=${shakeTall.toFixed(2)} dmg=${tall.damage.toFixed(2)}`);
}

// T6 — wiring guards on the host (onfoot3d.js): physics + FP must be plumbed in
{
  const src = fs.readFileSync(new URL('../../onfoot3d.js', import.meta.url), 'utf8');
  const i = src.indexOf('function updateDriving');
  const drv = i >= 0 ? src.slice(i, src.indexOf('\nfunction ', i + 1)) : '';
  if (!drv.includes('OF.carImpact')) fail('updateDriving does not call OF.carImpact — physics not wired');
  else console.log('wiring: updateDriving calls OF.carImpact ✓');
  // first-person: flag declared, V key handled, toggle notifies the systems layer
  if (!/firstPerson\s*:/.test(src)) fail('onfoot3d.js does not declare OF.firstPerson');
  const k = src.indexOf('function onKeyDown');
  const kd = k >= 0 ? src.slice(k, src.indexOf('\nfunction ', k + 1)) : '';
  if (!kd.includes("'KeyV'")) fail('onKeyDown does not handle the V (first-person) key');
  if (!src.includes('OF.onFpToggle')) fail('onfoot3d.js does not call OF.onFpToggle on toggle');
  else console.log('wiring: V toggles OF.firstPerson + calls OF.onFpToggle ✓');
}

console.log(ok ? '\nPHYSICS-CHECK PASS ✅' : '\nPHYSICS-CHECK FAIL ❌');
process.exit(ok ? 0 : 1);
