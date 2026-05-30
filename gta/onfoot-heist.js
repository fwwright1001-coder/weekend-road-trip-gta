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

let bank = null;            // {position, doorPos, vaultPos, footprints}
let goopMesh = null, beacon = null, getawayMesh = null;
let winEl = null;
const GETAWAY = { x: 36, z: 36 };   // open street intersection (k*24+12)

const heist = {
  name: 'heist', deps: ['world'],
  state: 'toBank',          // toBank -> grabGoop -> escape -> won
  hasGoop: false,
  built: false,

  init(ctx) {
    const THREE = ctx.THREE;
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
    if (goopMesh) goopMesh.visible = true;
    if (beacon && bank) { beacon.position.x = bank.doorPos.x; beacon.position.z = bank.doorPos.z; beacon.material.color.setHex(0xffd23a); }
    if (getawayMesh) getawayMesh.visible = false;
  },

  reset() { /* keep heist progress across deaths/respawns; a full restart happens via forceRestart() on re-enter */ },

  update(dt, ctx) {
    if (!bank) return;
    const p = ctx.player.pos;
    const t = ctx.time.t;

    if (goopMesh && goopMesh.visible) { goopMesh.rotation.y += dt * 1.5; goopMesh.position.y = 1.7 + Math.sin(t * 2.5) * 0.12; }
    if (beacon) beacon.material.opacity = 0.14 + Math.sin(t * 3) * 0.06;

    if (this.state === 'toBank') {
      if (dist(p, bank.doorPos) < REACH_BANK) {
        this.state = 'grabGoop';
        if (beacon) { beacon.position.x = bank.vaultPos.x; beacon.position.z = bank.vaultPos.z; }
        GTA.bus.emit('toast', { html: 'Inside the bank. Get to the <b>vault</b> and grab the goop.', ms: 4500 });
      }
    } else if (this.state === 'grabGoop') {
      if (dist(p, bank.vaultPos) < REACH_VAULT) {
        this.state = 'escape';
        this.hasGoop = true;
        if (goopMesh) goopMesh.visible = false;
        if (getawayMesh) getawayMesh.visible = true;
        if (beacon) { beacon.position.x = GETAWAY.x; beacon.position.z = GETAWAY.z; beacon.material.color.setHex(0x5aff8a); }
        // ALARM — the heat RAMPS up (~2 -> ~3 -> 5 stars over ~2s) instead of
        // snapping straight to max, so you get a beat to react before the full
        // swarm. The rest of the climb happens in the 'escape' branch below.
        this._alarm = { t: 0, beat: 0 };
        try { if (ctx.systems.wanted) { ctx.systems.wanted.api.add(2.5); ctx.systems.wanted.api.setSeen(true); } } catch (e) {}
        GTA.bus.emit('shake', { amount: 1.0 });
        GTA.bus.emit('toast', { html: 'You’ve got the <b>goop</b>! Alarm’s tripped — <b>steal a car and escape</b> to the green marker.', ms: 7000 });
      }
    } else if (this.state === 'escape') {
      // escalate the alarm over a couple of seconds and keep it blaring until you're clear
      if (this._alarm) {
        this._alarm.t += dt;
        try {
          const w = ctx.systems.wanted;
          if (w) {
            w.setSeen(true);
            if (this._alarm.beat === 0 && this._alarm.t > 0.7) { w.add(2); this._alarm.beat = 1; }
            else if (this._alarm.beat === 1 && this._alarm.t > 1.6) { w.add(3); this._alarm.beat = 2; }
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

  _win(ctx) {
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
