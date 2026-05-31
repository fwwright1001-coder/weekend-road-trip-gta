// ============================================================
// gta/pickups.js — health/armor pickup RESPAWN scheduler (Lane D).
// ------------------------------------------------------------
// economy.js still owns rendering the pickup mesh + APPLYING the effect
// (heal/addArmor) and emits a 'pickup' event when one is collected. This tiny
// system owns only the STATEFUL respawn: when a seeded health/armor pickup is
// taken, it re-emits 'spawnPickup' at the same spot after a timer, so the world
// doesn't run dry on a long fight. (Lane A may ship nicer pickup meshes — that's
// orthogonal; this just re-fires the same spawn event economy already consumes.)
//
// Seeds are registered by the bridge (placePickups) via api.seed(). Pure events
// + timers — no THREE, no DOM — so it's fully headless-safe and the sim/tests
// drive it directly.
// ============================================================
import { GTA } from './core.js';

const RESPAWN_T = 25;        // seconds before a collected health/armor pickup re-seeds
const MATCH_R2 = 9;          // (metres)^2 — match a 'pickup' event to the nearest seed

const pickups = {
  name: 'pickups',
  deps: [],
  _seeds: [],                // { kind, value, x, z, timer }  timer>0 = counting down to respawn
  _unsub: [],
  _ctx: null,

  init(ctx) {
    this._ctx = ctx;
    if (this._unsub.length) return;   // subscribe once
    const onPickup = (p) => { try { this._onCollected(p); } catch (e) {} };
    this._unsub.push(ctx.bus.on('pickup', onPickup));
  },

  update(dt) {
    if (!(dt > 0)) return;
    const seeds = this._seeds;
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i];
      if (s.timer <= 0) continue;
      s.timer -= dt;
      if (s.timer <= 0) {
        s.timer = 0;
        GTA.bus.emit('spawnPickup', { kind: s.kind, value: s.value, pos: { x: s.x, y: 0, z: s.z } });
        GTA.bus.emit('pickup:respawn', { kind: s.kind, pos: { x: s.x, y: 0, z: s.z } });
      }
    }
  },

  // a respawn clears nothing here (timers keep running across respawns)
  reset() {},

  _onCollected(p) {
    if (!p || (p.kind !== 'health' && p.kind !== 'armor')) return;   // only health/armor respawn
    const pos = p.pos || {};
    const px = pos.x || 0, pz = pos.z || 0;
    // arm the nearest live (timer<=0) seed of the same kind
    let best = null, bd = MATCH_R2;
    for (const s of this._seeds) {
      if (s.kind !== p.kind || s.timer > 0) continue;
      const d = (s.x - px) * (s.x - px) + (s.z - pz) * (s.z - pz);
      if (d < bd) { bd = d; best = s; }
    }
    if (best) best.timer = RESPAWN_T;
  },

  api: {
    // register a respawning pickup point (called by the bridge's placePickups)
    seed(kind, value, x, z) {
      pickups._seeds.push({ kind, value, x, z, timer: 0 });
    },
    // diagnostics / tests
    seedCount() { return pickups._seeds.length; },
    pending() { return pickups._seeds.filter((s) => s.timer > 0).length; },
    respawnTime() { return RESPAWN_T; },
    clearSeeds() { pickups._seeds.length = 0; },
  },
};

GTA.register(pickups);
export default pickups;
export { pickups };
