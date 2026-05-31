// ============================================================
// gta/onfoot-heist.js — THE BANK HEIST (the game's main mission)
// ------------------------------------------------------------
// Smeaglodin's job: get to the BANK, break into the VAULT and grab the GOOP,
// then ESCAPE IN A CAR to the getaway point. Grabbing the goop trips the alarm
// (wanted level spikes) and the cops swarm — you can outrun them or fight your
// way out (the combat + police systems handle that). You WIN by reaching the
// getaway marker while driving, with the goop.
//
// Registers as the HUD's 'missions' provider so hud-radar shows the objective
// text + the radar marker. Self-contained; builds the bank via onfoot-bank.js.
// ============================================================
import { GTA, GU } from './core.js';
import { buildBank } from './onfoot-bank.js';

// distances
const REACH_BANK = 5.0;     // trigger "inside" near the door
const REACH_VAULT = 3.2;    // grab the goop
const REACH_GETAWAY = 7.0;  // escape (must be in a vehicle)
const PAYOUT = 5000;        // heist completion reward ($)

// vault-crack dwell: you must STAY within REACH_VAULT this long to crack the
// vault and grab the goop (no more instant-grab teleport feel).
const CRACK_TIME = 1.6;     // seconds of dwell to crack the vault

// vault guards (a real encounter at the loot): a handful of dark-suited shooters
// that defend the goop. They are pushed into ctx.targets so combat.js can raycast
// + onHit them, and they periodically request 'damage' on the player while alive
// and within LOS range.
const GUARD_COUNT = 3;          // guards spawned at the vault
const GUARD_HP = 60;            // hp per guard (combat differentiates weapon dmg for free)
const GUARD_RANGE = 12;         // metres: guards only shoot when this close (LOS proxy)
const GUARD_FIRE_EVERY = 0.8;   // seconds between guard shots
const GUARD_DMG = 6;            // damage per guard shot (drains armor/health)
const GUARD_HEIGHT = 1.7;
const GUARD_RADIUS = 0.6;

let bank = null;            // {position, doorPos, vaultPos, footprints}
let goopMesh = null, beacon = null, getawayMesh = null;
let winEl = null;
let guards = [];            // active vault guards (ctx.targets entries + per-guard sim state)
const GETAWAY = { x: 36, z: 36 };   // open street intersection (k*24+12)

const heist = {
  name: 'heist', deps: ['world'],
  state: 'toBank',          // toBank -> grabGoop -> escape -> won
  hasGoop: false,
  built: false,
  _crackT: 0,               // vault-crack dwell progress (seconds)
  _wiredDeath: false,       // one-time playerWasted/playerBusted subscription guard

  init(ctx) {
    const THREE = ctx.THREE;
    this._ctx = ctx;

    // DROP-THE-GOOP ON DEATH: if the player dies (wasted) or is arrested
    // (busted) while carrying the goop (state==='escape'), they lose it and the
    // heist reverts to 'grabGoop' — the goop reappears at the vault. Wired once;
    // survives respawns (subscriptions persist across reset()).
    if (!this._wiredDeath && ctx.bus && typeof ctx.bus.on === 'function') {
      const drop = () => { try { this._dropGoop(); } catch (e) {} };
      ctx.bus.on('playerWasted', drop);
      ctx.bus.on('playerBusted', drop);
      this._wiredDeath = true;
    }

    if (!this.built) {
      // build the bank + register its walls for collision
      try {
        bank = buildBank(THREE, ctx.scene, {});
      } catch (e) {
        console.error('[heist] buildBank failed; using a fallback marker', e);
        bank = { position: { x: 0, z: -42 }, doorPos: { x: 0, z: -30 }, vaultPos: { x: 0, z: -48 }, footprints: [] };
      }
      try {
        const aabbs = (ctx.systems.world && ctx.systems.world.aabbs) || null;
        if (aabbs && Array.isArray(bank.footprints)) for (const f of bank.footprints) aabbs.push(f);
      } catch (e) {}

      // the GOOP — a glowing green blob on the vault pedestal
      const goopMat = new THREE.MeshStandardMaterial({ color: 0x6cff5a, emissive: 0x2bd11a, emissiveIntensity: 0.9, roughness: 0.3 });
      goopMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), goopMat);
      goopMesh.position.set(bank.vaultPos.x, 1.7, bank.vaultPos.z);   // rest on the (ground-level) vault pedestal top
      goopMesh.castShadow = true; ctx.scene.add(goopMesh);

      // objective beacon (a glowing pillar repositioned to the current marker)
      beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 30, 12, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffd23a, transparent: true, opacity: 0.18, side: THREE.DoubleSide }));
      beacon.position.set(bank.doorPos.x, 15, bank.doorPos.z); ctx.scene.add(beacon);

      // getaway pad (built but hidden until you have the goop)
      const padMat = new THREE.MeshBasicMaterial({ color: 0x5aff8a, transparent: true, opacity: 0.22, side: THREE.DoubleSide });
      getawayMesh = new THREE.Mesh(new THREE.CylinderGeometry(REACH_GETAWAY, REACH_GETAWAY, 24, 18, 1, true), padMat);
      getawayMesh.position.set(GETAWAY.x, 12, GETAWAY.z); getawayMesh.visible = false; ctx.scene.add(getawayMesh);

      this.built = true;
    }
    this._restart();
  },

  _restart() {
    this.state = 'toBank';
    this.hasGoop = false;
    this._crackT = 0;
    this._clearGuards();
    if (goopMesh) goopMesh.visible = true;
    if (beacon && bank) { beacon.position.x = bank.doorPos.x; beacon.position.z = bank.doorPos.z; beacon.material.color.setHex(0xffd23a); }
    if (getawayMesh) getawayMesh.visible = false;
  },

  reset() { /* keep heist progress across deaths/respawns; a full restart happens via forceRestart() on re-enter */ },

  // ----- VAULT GUARDS -------------------------------------------------------
  // Spawn GUARD_COUNT shootable guards around the vault pedestal. Each is a
  // ctx.targets entry (so combat.js raycasts + onHit them) plus per-guard sim
  // state (fire cadence). Meshes are built only when !ctx.headless; the
  // targeting + damage logic runs headless so the sim exercises it.
  _spawnGuards(ctx) {
    if (guards.length) return;            // already spawned for this attempt
    if (!bank) return;
    const THREE = ctx.THREE;
    const vx = bank.vaultPos.x, vz = bank.vaultPos.z;
    for (let i = 0; i < GUARD_COUNT; i++) {
      // arc the guards across the front of the vault chamber, toward the player
      const a = (i - (GUARD_COUNT - 1) / 2) * 0.7;   // fan out in X
      const pos = new THREE.Vector3(vx + Math.sin(a) * 2.6, 0, vz + 1.6 + Math.cos(a) * 0.4);
      const guard = {
        pos,
        height: GUARD_HEIGHT,
        radius: GUARD_RADIUS,
        kind: 'guard',
        dead: false,
        hp: GUARD_HP,
        mesh: null,
        _fireT: GUARD_FIRE_EVERY * (0.4 + i * 0.25),   // stagger first shots
        onHit(dmg) {
          if (this.dead) return;
          this.hp -= dmg;
          if (this.hp <= 0) {
            this.dead = true;
            if (this.mesh) this.mesh.visible = false;
            // count as a 'cop' kill so combat/stat tracking treats it as a hostile down
            GTA.bus.emit('entityKilled', { entity: this, kind: 'cop', pos: this.pos, byPlayer: true });
          }
        },
      };
      if (!ctx.headless) {
        try {
          guard.mesh = buildGuard(THREE);
          guard.mesh.position.set(pos.x, 0, pos.z);
          ctx.scene.add(guard.mesh);
        } catch (e) { guard.mesh = null; }
      }
      guards.push(guard);
      if (Array.isArray(ctx.targets)) ctx.targets.push(guard);
    }
  },

  // remove guards from ctx.targets, mark dead, hide/drop meshes
  _clearGuards() {
    const ctx = this._ctx;
    if (guards.length && ctx && Array.isArray(ctx.targets)) {
      // splice in place (don't reassign — other systems push onto this same array)
      for (let i = ctx.targets.length - 1; i >= 0; i--) {
        if (guards.indexOf(ctx.targets[i]) >= 0) ctx.targets.splice(i, 1);
      }
    }
    for (const g of guards) {
      g.dead = true;
      if (g.mesh) {
        g.mesh.visible = false;
        try { if (g.mesh.parent) g.mesh.parent.remove(g.mesh); } catch (e) {}
        g.mesh = null;
      }
    }
    guards = [];
  },

  // per-frame guard behaviour: living guards within GUARD_RANGE of the player
  // periodically request 'damage' on the player.
  _updateGuards(dt, ctx) {
    if (!guards.length) return;
    const p = ctx.player.pos;
    for (const g of guards) {
      if (g.dead) continue;
      const d = Math.hypot(g.pos.x - p.x, g.pos.z - p.z);
      if (d > GUARD_RANGE) { g._fireT = Math.min(g._fireT, GUARD_FIRE_EVERY); continue; }
      g._fireT -= dt;
      if (g._fireT <= 0) {
        g._fireT = GUARD_FIRE_EVERY;
        GTA.bus.emit('damage', { target: 'player', amount: GUARD_DMG, kind: 'guard', pos: g.pos });
      }
    }
  },

  // DROP THE GOOP: revert escape -> grabGoop, re-show the goop at the vault,
  // hide the getaway pad, re-point the beacon to the vault.
  _dropGoop() {
    if (this.state !== 'escape') return;
    this.state = 'grabGoop';
    this.hasGoop = false;
    this._crackT = 0;
    this._alarm = null;
    if (goopMesh) goopMesh.visible = true;
    if (getawayMesh) getawayMesh.visible = false;
    if (beacon && bank) { beacon.position.x = bank.vaultPos.x; beacon.position.z = bank.vaultPos.z; beacon.material.color.setHex(0xffd23a); }
    GTA.bus.emit('toast', { html: 'You <b>dropped the goop</b>! Get back to the vault and grab it again.', ms: 6000 });
  },

  update(dt, ctx) {
    if (!bank) return;
    const p = ctx.player.pos;
    const t = ctx.time.t;

    if (goopMesh && goopMesh.visible) { goopMesh.rotation.y += dt * 1.5; goopMesh.position.y = 1.7 + Math.sin(t * 2.5) * 0.12; }
    if (beacon) beacon.material.opacity = 0.14 + Math.sin(t * 3) * 0.06;

    if (this.state === 'toBank') {
      if (dist(p, bank.doorPos) < REACH_BANK) {
        this.state = 'grabGoop';
        this._crackT = 0;
        this._spawnGuards(ctx);   // the vault is defended — guards spawn on entry
        if (beacon) { beacon.position.x = bank.vaultPos.x; beacon.position.z = bank.vaultPos.z; }
        GTA.bus.emit('toast', { html: 'Inside the bank. Fight to the <b>vault</b> and crack it — the guards are armed.', ms: 4500 });
      }
    } else if (this.state === 'grabGoop') {
      // guards defend the loot while you work
      this._updateGuards(dt, ctx);

      // VAULT-CRACK DWELL: you must STAY within REACH_VAULT for CRACK_TIME to
      // crack the vault. Leaving the radius resets the progress.
      if (dist(p, bank.vaultPos) < REACH_VAULT) {
        const wasCracking = this._crackT > 0;
        this._crackT += dt;
        const pct = Math.min(100, Math.round((this._crackT / CRACK_TIME) * 100));
        if (!wasCracking) GTA.bus.emit('toast', { html: 'Cracking the vault…', ms: 1200 });
        GTA.bus.emit('toast', { html: `Cracking the vault… <b>${pct}%</b>`, ms: 700 });
        if (this._crackT >= CRACK_TIME) {
          this._grabGoop(ctx);
        }
      } else if (this._crackT > 0) {
        this._crackT = 0;
        GTA.bus.emit('toast', { html: 'Vault crack interrupted — get back to the vault.', ms: 1500 });
      }
    } else if (this.state === 'escape') {
      // escalate the alarm over a couple of seconds and keep it blaring until you're clear
      if (this._alarm) {
        this._alarm.t += dt;
        try {
          const w = ctx.systems.wanted;
          if (w) {
            w.api.setSeen(true);
            if (this._alarm.beat === 0 && this._alarm.t > 0.7) { w.api.add(2); this._alarm.beat = 1; }
            else if (this._alarm.beat === 1 && this._alarm.t > 1.6) { w.api.add(3); this._alarm.beat = 2; }
          }
        } catch (e) {}
      }
      if (getawayMesh) getawayMesh.material.opacity = 0.16 + Math.sin(t * 3) * 0.08;
      if (ctx.player.inVehicle && dist(p, GETAWAY) < REACH_GETAWAY) {
        this.state = 'won';
        this._win(ctx);
      }
    }
  },

  // GRAB: the vault is cracked — take the goop, trip the alarm, start the escape.
  _grabGoop(ctx) {
    this.state = 'escape';
    this.hasGoop = true;
    this._crackT = 0;
    if (goopMesh) goopMesh.visible = false;
    if (getawayMesh) getawayMesh.visible = true;
    if (beacon) { beacon.position.x = GETAWAY.x; beacon.position.z = GETAWAY.z; beacon.material.color.setHex(0x5aff8a); }
    // ALARM — the heat RAMPS up (2.5 -> 4.5 -> 7.5 over ~1.6s) instead of
    // snapping straight to max, so you get a beat to react before the full
    // swarm. The rest of the climb happens in the 'escape' branch above.
    this._alarm = { t: 0, beat: 0 };
    try { if (ctx.systems.wanted) { ctx.systems.wanted.api.add(2.5); ctx.systems.wanted.api.setSeen(true); } } catch (e) {}
    GTA.bus.emit('shake', { amount: 1.0 });
    GTA.bus.emit('toast', { html: 'You’ve got the <b>goop</b>! Alarm’s tripped — <b>steal a car and escape</b> to the green marker.', ms: 7000 });
  },

  _win(ctx) {
    this._clearGuards();   // any guards still standing leave the encounter on the win
    let total = null;
    try { if (ctx.systems.economy) total = ctx.systems.economy.api.add(PAYOUT, 'heist'); } catch (e) {}   // add() returns the new balance
    try { if (ctx.systems.wanted) ctx.systems.wanted.api.clear(); } catch (e) {}
    if (beacon) beacon.visible = false;
    if (getawayMesh) getawayMesh.visible = false;
    showWin(total);
    const totalTxt = (typeof total === 'number' && isFinite(total)) ? ` (total $${total.toLocaleString('en-US')})` : '';
    GTA.bus.emit('toast', { html: `<b>HEIST COMPLETE</b> — escaped with the goop. +$${PAYOUT.toLocaleString('en-US')}${totalTxt}`, ms: 9000 });
  },

  api: {
    currentObjective() {
      switch (heist.state) {
        case 'toBank': return { text: 'HEIST: Get to the <b>bank</b> (yellow marker)', kind: 'goto' };
        case 'grabGoop': return { text: 'HEIST: Grab the <b>goop</b> from the vault', kind: 'collect' };
        case 'escape': return { text: 'HEIST: <b>Escape in a car</b> to the green marker', kind: 'deliver' };
        default: return null;
      }
    },
    markerPos() {
      if (!bank) return null;
      if (heist.state === 'toBank') return { x: bank.doorPos.x, z: bank.doorPos.z };
      if (heist.state === 'grabGoop') return { x: bank.vaultPos.x, z: bank.vaultPos.z };
      if (heist.state === 'escape') return { x: GETAWAY.x, z: GETAWAY.z };
      return null;
    },
    active: () => heist.state !== 'won',
    state: () => heist.state,
    hasGoop: () => heist.hasGoop,
    // no-op compatibility with the missions api surface hud/other code may probe
    start() {}, abort() {}, registerMission() {},
    forceRestart() { hideWin(); if (beacon) beacon.visible = true; heist._restart(); },
  },
};

function dist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

// A simple low-poly dark-suited "guard" box-figure (legs/torso/arms/head + a
// stubby gun). Built only when a scene exists; the heist targeting/damage logic
// runs headless without it. Origin at the feet (y=0), faces +Z by default.
function buildGuard(THREE) {
  const g = new THREE.Group();
  const suit = new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.7, metalness: 0.1 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc79a73, roughness: 0.8 });
  const gunMat = new THREE.MeshStandardMaterial({ color: 0x33373d, roughness: 0.4, metalness: 0.6 });
  const mk = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
  // legs
  mk(new THREE.BoxGeometry(0.22, 0.85, 0.26), suit, -0.16, 0.43, 0);
  mk(new THREE.BoxGeometry(0.22, 0.85, 0.26), suit, 0.16, 0.43, 0);
  // torso
  mk(new THREE.BoxGeometry(0.62, 0.78, 0.34), suit, 0, 1.22, 0);
  // arms (right arm forward, holding the gun)
  mk(new THREE.BoxGeometry(0.18, 0.7, 0.2), suit, -0.42, 1.2, 0);
  mk(new THREE.BoxGeometry(0.18, 0.5, 0.2), suit, 0.42, 1.15, 0.18);
  // head
  mk(new THREE.BoxGeometry(0.3, 0.34, 0.3), skin, 0, 1.78, 0);
  // stubby gun out front
  mk(new THREE.BoxGeometry(0.12, 0.12, 0.55), gunMat, 0.42, 1.05, 0.45);
  return g;
}

function showWin(total) {
  const frame = document.getElementById('frame') || document.body;
  if (!winEl) {
    winEl = document.createElement('div');
    winEl.id = 'gta-win';
    winEl.style.cssText = 'position:absolute;inset:0;z-index:40;display:grid;place-items:center;text-align:center;'
      + 'background:radial-gradient(circle at 50% 40%, rgba(20,40,24,0.4), rgba(0,0,0,0.78));'
      + 'font-family:Georgia,serif;color:#eafbe6;pointer-events:none;opacity:0;transition:opacity .8s;';
    winEl.innerHTML = '<div><div style="font-size:clamp(34px,8vw,92px);font-weight:900;letter-spacing:6px;color:#7ee27e;text-shadow:0 4px 24px rgba(0,0,0,.8)">HEIST COMPLETE</div>'
      + '<div id="gta-win-take" style="margin-top:14px;font-size:clamp(14px,2.4vw,22px);color:#dfead9"></div>'
      + '<div style="margin-top:10px;font-size:13px;color:#9fb89a">Press <b>P</b> to quit the mode</div></div>';
    frame.appendChild(winEl);
  }
  const take = winEl.querySelector('#gta-win-take');
  if (take) {
    const totalTxt = (typeof total === 'number' && isFinite(total)) ? ` &nbsp;·&nbsp; Total <b>$${total.toLocaleString('en-US')}</b>` : '';
    take.innerHTML = `Smeaglodin escaped with the goop. &nbsp;<b>+$${PAYOUT.toLocaleString('en-US')}</b>${totalTxt}`;
  }
  winEl.style.display = 'grid';
  requestAnimationFrame(() => { if (winEl) winEl.style.opacity = '1'; });
}

function hideWin() { if (winEl) { winEl.style.opacity = '0'; winEl.style.display = 'none'; } }

GTA.register(heist);
// Claim the HUD's 'missions' slot (hud-radar reads ctx.systems.missions.api) only
// if no real missions framework is present, so a stray gta/missions.js import can
// never silently clobber the main mission.
if (!GTA.systems.missions) GTA.register({ name: 'missions', deps: ['world'], api: heist.api, init() {}, update() {}, reset() {} });
export default heist;
