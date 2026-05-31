// ============================================================
// gta/tools/police-check.mjs — headless test of the round-3 cop AI: a rival-gang
// faction, cover-seeking, backup waves, and flank-spread approach. Boots wanted +
// police against the shared stub harness, escalates to a full wanted level, and
// asserts each new behaviour. Pure logic over real three.js — headless-safe.
// ============================================================
import '../wanted.js';
import '../police.js';
import { makeHarness } from './_harness.mjs';

let ok = true;
const fail = (m) => { ok = false; console.log('FAIL ' + m); };

const h = await makeHarness({ seed: 7 });
const { GTA, ctx } = h;
const police = GTA.systems.police;
const wanted = ctx.systems.wanted.api;

let backupEvt = 0, factionFight = 0;
GTA.bus.on('police:backup', () => backupEvt++);
GTA.bus.on('faction:fight', () => factionFight++);

// 1) escalate to a full wanted level, let the squad spawn + converge
h.raiseStars();
if (!(wanted.stars() >= 4)) fail('wanted did not escalate (stars=' + wanted.stars() + ')');
h.tick(1 / 60, 600);
const copCount = police.api.copCount();
if (!(copCount > 0)) fail('no cops spawned at high stars');
console.log(`spawned: cops=${copCount} cars=${police.api.carCount()} gang=${police.api.gangCount()}`);

// 2) flanking — cops get spread flank lanes (-1/0/+1) so they surround
const flanks = new Set(police._cops.map((c) => c.flank));
if (!(flanks.has(-1) && flanks.has(1))) fail('cops not flanking (lanes: ' + [...flanks].join(',') + ')');
else console.log('flanking: lanes = {' + [...flanks].sort().join(',') + '}');

// 3) cover — _findCover returns a spot the building actually occludes from the target.
//    cop sits just east of the building at x∈[18,30]; the target is at the origin.
{
  const cover = police._findCover({ pos: { x: 33, z: 0 } }, 0, 0, h.worldApi);
  if (!cover) fail('cover: _findCover found nothing behind a building');
  else if (police._lineOfSight(h.worldApi, 0, 0, cover.x, cover.z) !== false) fail('cover spot is not occluded from the target');
  else console.log(`cover: occluded spot (${cover.x.toFixed(1)},${cover.z.toFixed(1)})`);
  if (!police._cops.some((c) => c.usesCover)) fail('no cop is flagged to use cover');
}

// 4) backup wave — escalation fired one; an officer-down fires another + opens the window
{
  const before = backupEvt;
  const victim = police._cops.find((c) => !c.dead);
  if (victim && victim.entry) victim.entry.onHit(999, 'bullet', { x: victim.pos.x, y: 1, z: victim.pos.z });
  if (!(backupEvt > before)) fail('officer-down did not emit police:backup');
  if (!police.api.backupActive()) fail('backup window not active after officer down');
  else console.log(`backup: police:backup x${backupEvt}, active=${police.api.backupActive()}`);
}

// 5) rival gang faction — present at 5 stars + takes cop damage (the faction-fight path)
{
  if (!(police.api.gangCount() > 0)) fail('no gangsters at 5 stars');
  else {
    const g = police._gang[0], h0 = g.health;
    police._damageGang(g, 15, ctx);
    if (!(g.health < h0)) fail('cop damage to a gangster had no effect');
    else console.log(`faction: gang=${police.api.gangCount()}, cop→gang dmg ${h0}->${g.health}, faction:fight x${factionFight}`);
  }
}

// 6) sustained run with cops + gang + cover + flank all live must not throw
try { h.tick(1 / 60, 600); } catch (e) { fail('threw during sustained pursuit: ' + (e.stack || e)); }

console.log(ok ? '\nPOLICE-CHECK PASS ✅' : '\nPOLICE-CHECK FAIL ❌');
process.exit(ok ? 0 : 1);
