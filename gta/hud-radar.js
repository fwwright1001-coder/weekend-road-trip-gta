// ============================================================
// gta/hud-radar.js — the HUD + minimap "radar" view system
// ------------------------------------------------------------
// PURE VIEW LAYER. This system OWNS no game state of its own — it READS the live
// world/player/combat/wanted/missions state every frame and PAINTS it into:
//   * the DOM HUD overlay (#gta-hud and friends, already in index.html), and
//   * the round, player-centred, player-up minimap canvas (#gta-radar).
//
// It is the single most "GTA"-feeling piece of chrome in the layer, so the radar
// is drawn carefully: a dark disc, a rotating road grid, faint building blocks,
// coloured blips for peds/cops/vehicles from the shared hittable registry, the
// active mission marker, and the player as a white triangle pointing up.
//
// Hard constraints honoured here:
//   * Every cross-system api may be MISSING (parallel build, varying load order):
//     we null-check everything and never throw. The host already try/catches each
//     system, but defence in depth keeps one bad frame from blanking the HUD.
//   * No per-frame allocation in the hot path: scratch objects live at module
//     scope and are reused; cached DOM lookups; no array churn.
//   * All art is procedural canvas 2D — no images, no loaders, no external URLs.
//   * update() is called every frame by the host loop. We do NOT schedule our own
//     requestAnimationFrame.
// ============================================================
import { GTA, GU } from './core.js';

// ------------------------------------------------------------
// Tunables for the radar projection.
// ------------------------------------------------------------
const RADAR_SIZE = 220;                 // canvas backing-store px (matches #gta-radar width/height)
const RADAR_WORLD_SPAN = 110;           // world units across the FULL radar diameter
const BLIP_MAX_RANGE = RADAR_WORLD_SPAN * 0.62; // hide blips past this (world units) to keep edge clean

// Blip colours.
const COL_PED = 'rgba(210,214,220,0.92)';
const COL_COP = 'rgba(86,150,255,0.96)';
const COL_VEHICLE = 'rgba(80,224,232,0.96)';
const COL_MISSION = '#f5d76e';
const COL_PLAYER = '#ffffff';

// ------------------------------------------------------------
// Weapon display names (fallbacks if combat.api.currentWeapon() is absent or
// returns only an id). combat.js is the source of truth when present.
// ------------------------------------------------------------
const WEAPON_NAMES = {
  fists: 'FISTS',
  pistol: 'PISTOL',
  ak47: 'AK-47',
  smg: 'SMG',
  shotgun: 'SHOTGUN',
  rifle: 'RIFLE',
};
const MELEE_IDS = new Set(['fists']);

// ============================================================
// MODULE-SCOPE SCRATCH (reused every frame — zero hot-path allocation)
// ============================================================
const _v3a = { x: 0, z: 0 };            // plain scratch, avoids THREE.Vector3 churn
const _markerScratch = { x: 0, z: 0, has: false };

const sys = {
  name: 'hud-radar',
  deps: [],

  // cached DOM nodes (looked up once in init)
  _el: {
    stars: null,
    money: null,
    healthFill: null,
    armorFill: null,
    weapon: null,
    ammo: null,
    objective: null,
    crosshair: null,
    toast: null,
    radar: null,
  },
  _ctx2d: null,
  _starSpans: [],          // the 5 <span class="star"> nodes
  _builtStars: false,

  // transient HUD animation/bookkeeping (NOT gameplay state)
  _moneyBumpUntil: 0,      // ctx.time.t at which to remove .bump
  _lastMoneyShown: null,   // dedupe textContent writes
  _toastHideAt: 0,         // ctx.time.t at which to hide the toast (0 = hidden)
  _starsLitShown: -1,      // dedupe .lit toggling
  _starsFlashShown: null,
  _ammoEmptyShown: null,
  _objectiveTextShown: null,
  _objectiveHidden: null,
  _weaponNameShown: null,
  _ammoTextShown: null,
  _healthWidthShown: -1,
  _armorWidthShown: -1,
  _crosshairHiddenShown: null,
  _lowHpShown: null,            // dedupe body.gta-lowhp + health-bar .low toggling
  _ammoLowShown: null,          // dedupe ammo .low toggling
  _weaponSwapUntil: 0,          // ctx.time.t at which to remove the weapon .swap flash
  _crosshairAimShown: null,     // dedupe crosshair .aim toggling
  _crosshairEmptyShown: null,   // dedupe crosshair .empty toggling

  // pause / settings overlay (Lane B)
  _menu: null,
  _menuOpen: false,
  _menuStationShown: null,
  _menuWired: false,
  _settingsApplied: false,      // re-apply persisted volumes once audio.js/fx.js are loaded

  _unsubs: [],

  // --------------------------------------------------------
  init(ctx) {
    const d = (typeof document !== 'undefined') ? document : null;
    if (d) {
      const el = this._el;
      el.stars = d.getElementById('gta-stars');
      el.money = d.getElementById('gta-money');
      el.healthFill = d.getElementById('gta-health-fill');
      el.armorFill = d.getElementById('gta-armor-fill');
      el.weapon = d.getElementById('gta-weapon');
      el.ammo = d.getElementById('gta-ammo');
      el.objective = d.getElementById('gta-objective');
      el.crosshair = d.getElementById('gta-crosshair');
      el.toast = d.getElementById('gta-toast');
      el.radar = d.getElementById('gta-radar');

      // If Lane D has added our dedicated #gta-crosshair, flag the body so CSS
      // can suppress the legacy on-foot plus-crosshair (no double reticle). When
      // the element is absent we leave the legacy crosshair alone — no regression.
      if (el.crosshair && d.body) d.body.classList.add('gta-xh');

      // build the 5 star spans exactly once
      if (el.stars && !this._builtStars) {
        // clear any prior content (e.g. on re-init / hot-swap)
        while (el.stars.firstChild) el.stars.removeChild(el.stars.firstChild);
        this._starSpans.length = 0;
        for (let i = 0; i < 5; i++) {
          const sp = d.createElement('span');
          sp.className = 'star';
          sp.textContent = '★'; // ★
          el.stars.appendChild(sp);
          this._starSpans.push(sp);
        }
        this._builtStars = true;
      }

      // radar 2D context
      if (el.radar && el.radar.getContext) {
        try { this._ctx2d = el.radar.getContext('2d'); }
        catch (e) { this._ctx2d = null; }
        // make sure the backing store matches our projection assumptions
        if (el.radar.width !== RADAR_SIZE) el.radar.width = RADAR_SIZE;
        if (el.radar.height !== RADAR_SIZE) el.radar.height = RADAR_SIZE;
      }
    }

    // ---- bus subscriptions (HUD-only flourishes) ----
    const bus = ctx && ctx.bus;
    if (bus && typeof bus.on === 'function') {
      this._unsubs.push(bus.on('money:changed', () => {
        // bump the cash readout briefly
        const t = (ctx.time && ctx.time.t) || 0;
        this._moneyBumpUntil = t + 0.35;
        if (this._el.money) this._el.money.classList.add('bump');
      }));
      this._unsubs.push(bus.on('toast', (p) => this._showToast(ctx, p)));
    }

    // pause / settings overlay
    try { this._buildMenu(); } catch (e) { /* never block HUD init */ }
  },

  // ========================================================
  // PAUSE / SETTINGS MENU (Lane B) — a self-contained DOM overlay built here so
  // index.html (Lane D) needs no changes. Opens on Esc; sets window.ONFOOT.paused
  // (onfoot3d gates clicks on it); mixes music (audio.js) + sfx (fx.js), screen
  // shake, FP, and restart. Settings persist in localStorage.
  // ========================================================
  _settingsKey: 'wrt.gta.settings',
  _loadSettings() {
    try { return Object.assign({ music: 45, sfx: 80, shakeOn: true, shake: 100, fp: false }, JSON.parse(localStorage.getItem(this._settingsKey) || '{}')); }
    catch (e) { return { music: 45, sfx: 80, shakeOn: true, shake: 100, fp: false }; }
  },
  _saveSettings(s) { try { localStorage.setItem(this._settingsKey, JSON.stringify(s)); } catch (e) {} },
  _applySettings(s) {
    try {
      const A = (typeof window !== 'undefined') && window.ONFOOT_AUDIO;
      const F = (typeof window !== 'undefined') && window.ONFOOT_FX;
      if (A && A.setMusicVolume) A.setMusicVolume(s.music / 100);
      if (F && F.setVolume) F.setVolume(s.sfx / 100);
      if (F && F.setShakeEnabled) F.setShakeEnabled(!!s.shakeOn);
      if (F && F.setShakeScale) F.setShakeScale(s.shake / 100);
    } catch (e) { /* systems may not be loaded yet; re-applied on open */ }
  },
  _buildMenu() {
    if (this._menu || typeof document === 'undefined') return;
    const frame = document.getElementById('frame') || document.body;
    if (!frame) return;
    const s = this._loadSettings();
    const m = document.createElement('div');
    m.id = 'gta-menu';
    m.className = 'hidden';
    m.innerHTML =
      '<div class="gta-menu-panel" role="dialog" aria-label="Settings menu">' +
      '<h2>SETTINGS</h2>' +
      '<div class="gta-menu-row"><span>📻 Radio</span><button class="gta-menu-radio" data-act="radio"><b id="gta-menu-station">—</b> ▸</button></div>' +
      '<div class="gta-menu-row"><label for="gta-m-music">Music</label><input id="gta-m-music" type="range" min="0" max="100"></div>' +
      '<div class="gta-menu-row"><label for="gta-m-sfx">SFX</label><input id="gta-m-sfx" type="range" min="0" max="100"></div>' +
      '<div class="gta-menu-row"><label for="gta-m-shakeon">Screen shake</label><input id="gta-m-shakeon" type="checkbox"></div>' +
      '<div class="gta-menu-row"><label for="gta-m-shake">Shake intensity</label><input id="gta-m-shake" type="range" min="0" max="100"></div>' +
      '<div class="gta-menu-row"><label for="gta-m-fp">First-person (V)</label><input id="gta-m-fp" type="checkbox"></div>' +
      '<div class="gta-menu-actions"><button class="gta-menu-btn primary" data-act="resume">RESUME</button>' +
      '<button class="gta-menu-btn" data-act="restart">RESTART</button></div>' +
      '<p class="gta-menu-hint"><b>Esc</b> opens this &middot; <b>RESUME</b> to play &middot; <b>[ ]</b> cycle radio</p>' +
      '</div>';
    frame.appendChild(m);
    this._menu = m;

    const $ = (id) => m.querySelector(id);
    const music = $('#gta-m-music'), sfx = $('#gta-m-sfx'), shakeOn = $('#gta-m-shakeon'), shake = $('#gta-m-shake'), fp = $('#gta-m-fp');
    music.value = s.music; sfx.value = s.sfx; shakeOn.checked = !!s.shakeOn; shake.value = s.shake; fp.checked = !!s.fp;
    this._applySettings(s);

    const persist = () => {
      const cur = { music: +music.value, sfx: +sfx.value, shakeOn: shakeOn.checked, shake: +shake.value, fp: fp.checked };
      this._applySettings(cur); this._saveSettings(cur);
    };
    music.addEventListener('input', persist);
    sfx.addEventListener('input', persist);
    shakeOn.addEventListener('change', persist);
    shake.addEventListener('input', persist);
    fp.addEventListener('change', () => {
      // Lane D owns the firstPerson flag, but a settings checkbox writing the same bool is benign.
      try { if (window.ONFOOT) window.ONFOOT.firstPerson = fp.checked; } catch (e) {}
      persist();
    });
    // don't let clicks inside the panel bubble to the canvas (belt-and-suspenders; onMouseDown is also OF.paused-gated)
    m.addEventListener('mousedown', (e) => e.stopPropagation());
    m.addEventListener('click', (e) => {
      const act = e.target && e.target.getAttribute && e.target.closest('[data-act]') && e.target.closest('[data-act]').getAttribute('data-act');
      if (act === 'resume') this._closeMenu();
      else if (act === 'restart') { try { location.reload(); } catch (e2) {} }
      else if (act === 'radio') { try { if (window.ONFOOT_AUDIO && window.ONFOOT_AUDIO.cycleStation) window.ONFOOT_AUDIO.cycleStation(); } catch (e2) {} this._syncStation(); }
    });

    if (!this._menuWired) {
      this._menuWired = true;
      // onfoot3d.onKeyDown stopImmediatePropagation()s every key while active, so a
      // keydown listener here is dead. Instead drive the menu off pointer-lock: pressing
      // Esc (or losing focus) releases the lock → open the menu; re-locking closes it.
      document.addEventListener('pointerlockchange', () => {
        try {
          const OF = (typeof window !== 'undefined') && window.ONFOOT;
          if (!OF || !OF.active) return;
          const locked = !!document.pointerLockElement;
          if (locked) { if (this._menuOpen) this._closeMenu(); }
          else if (!this._menuOpen && OF.internals && OF.internals.mode === 'foot') this._openMenu();   // foot only (car-entry unlock has mode 'drive')
        } catch (e) { /* optional */ }
      }, false);
    }
  },
  _syncStation() {
    try {
      const lbl = this._menu && this._menu.querySelector('#gta-menu-station');
      const st = window.ONFOOT_AUDIO && window.ONFOOT_AUDIO.station && window.ONFOOT_AUDIO.station();
      const name = st ? st.name : '—';
      if (lbl && name !== this._menuStationShown) { lbl.textContent = name; this._menuStationShown = name; }
    } catch (e) { /* optional */ }
  },
  _openMenu() {
    if (!this._menu || this._menuOpen) return;
    this._menuOpen = true;
    try { if (window.ONFOOT) window.ONFOOT.paused = true; } catch (e) {}
    // stop residual movement + release the mouse so the cursor is usable
    try { const I = window.ONFOOT && window.ONFOOT.internals; if (I && I.keys) I.keys.clear(); } catch (e) {}
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {}
    // re-sync controls from the persisted state + the live station (systems are loaded by now)
    try {
      const s = this._loadSettings(); const m = this._menu;
      m.querySelector('#gta-m-music').value = s.music; m.querySelector('#gta-m-sfx').value = s.sfx;
      m.querySelector('#gta-m-shakeon').checked = !!s.shakeOn; m.querySelector('#gta-m-shake').value = s.shake;
      m.querySelector('#gta-m-fp').checked = !!(window.ONFOOT && window.ONFOOT.firstPerson);
      this._applySettings(s);
    } catch (e) {}
    this._syncStation();
    this._menu.classList.remove('hidden');
    if (typeof document !== 'undefined') document.body.classList.add('gta-menu-open');
  },
  _closeMenu() {
    if (!this._menu || !this._menuOpen) return;
    this._menuOpen = false;
    this._menu.classList.add('hidden');
    if (typeof document !== 'undefined') document.body.classList.remove('gta-menu-open');
    try { if (window.ONFOOT) window.ONFOOT.paused = false; } catch (e) {}
    // best-effort re-lock so the player drops straight back into the action
    try { const I = window.ONFOOT && window.ONFOOT.internals; if (I && I.canvas && I.canvas.requestPointerLock) I.canvas.requestPointerLock(); } catch (e) {}
  },

  // --------------------------------------------------------
  // reset() — clean transient HUD state on respawn. Do NOT rebuild meshes/DOM.
  // --------------------------------------------------------
  reset(ctx) {
    this._moneyBumpUntil = 0;
    this._toastHideAt = 0;
    const el = this._el;
    if (el.money) el.money.classList.remove('bump');
    if (el.toast) el.toast.classList.add('hidden');
    // force re-write of memoised values next frame
    this._lastMoneyShown = null;
    this._starsLitShown = -1;
    this._starsFlashShown = null;
    this._ammoEmptyShown = null;
    this._objectiveTextShown = null;
    this._objectiveHidden = null;
    this._weaponNameShown = null;
    this._ammoTextShown = null;
    this._healthWidthShown = -1;
    this._armorWidthShown = -1;
    this._crosshairHiddenShown = null;
    this._weaponSwapUntil = 0;
    this._crosshairAimShown = null;
    this._crosshairEmptyShown = null;
    // clear low-state classes outright (respawn restores full health/ammo)
    if (typeof document !== 'undefined') document.body.classList.remove('gta-lowhp');
    if (el.healthFill && el.healthFill.parentElement) el.healthFill.parentElement.classList.remove('low');
    if (el.weapon) el.weapon.classList.remove('swap');
    if (el.ammo) el.ammo.classList.remove('low');
    this._lowHpShown = null;
    this._ammoLowShown = null;
  },

  // --------------------------------------------------------
  // update() — paint everything from current state.
  // --------------------------------------------------------
  update(dt, ctx) {
    if (!ctx) return;
    // persisted volumes apply once audio.js/fx.js have registered their window.* api
    // (they load AFTER this HUD inits, so the build-time apply may have no-op'd).
    if (!this._settingsApplied && typeof window !== 'undefined' && window.ONFOOT_AUDIO && window.ONFOOT_FX) {
      try { this._applySettings(this._loadSettings()); } catch (e) {}
      this._settingsApplied = true;
    }
    // each painter is independently guarded so a problem with one HUD piece
    // never blanks the others or throws into the host loop.
    try { this._paintStars(ctx); } catch (e) { /* swallow */ }
    try { this._paintMoney(ctx); } catch (e) { /* swallow */ }
    try { this._paintVitals(ctx); } catch (e) { /* swallow */ }
    try { this._paintWeapon(ctx); } catch (e) { /* swallow */ }
    try { this._paintObjective(ctx); } catch (e) { /* swallow */ }
    try { this._paintCrosshair(ctx); } catch (e) { /* swallow */ }
    try { this._tickToast(ctx); } catch (e) { /* swallow */ }
    try { this._paintRadar(ctx); } catch (e) { /* swallow */ }
    if (this._menuOpen) { try { this._syncStation(); } catch (e) { /* swallow */ } }
  },

  // ========================================================
  // HUD: WANTED STARS
  // ========================================================
  _paintStars(ctx) {
    const el = this._el;
    if (!el.stars || !this._builtStars) return;
    const wantedApi = this._api(ctx, 'wanted');

    let stars = 0;
    if (wantedApi && typeof wantedApi.stars === 'function') {
      const s = wantedApi.stars();
      stars = (typeof s === 'number' && isFinite(s)) ? GU.clamp(s | 0, 0, 5) : 0;
    }

    // toggle .lit on the right number of spans (deduped)
    if (stars !== this._starsLitShown) {
      for (let i = 0; i < this._starSpans.length; i++) {
        const lit = i < stars;
        const sp = this._starSpans[i];
        if (lit) sp.classList.add('lit'); else sp.classList.remove('lit');
      }
      this._starsLitShown = stars;
    }

    // "flash" the container while wanted and actively seen/pursued.
    // seen-ness: prefer wanted heat (active pursuit) — > 0 means heat is on.
    let seen = false;
    if (stars > 0) {
      seen = true; // having stars at all is "active"; intensify if heat present
      if (wantedApi && typeof wantedApi.heat === 'function') {
        const h = wantedApi.heat();
        // still flash even at low heat, but this confirms an active state
        seen = (typeof h === 'number') ? true : seen;
      }
    }
    const flash = stars > 0 && seen;
    if (flash !== this._starsFlashShown) {
      if (flash) el.stars.classList.add('flash'); else el.stars.classList.remove('flash');
      this._starsFlashShown = flash;
    }
  },

  // ========================================================
  // HUD: MONEY
  // ========================================================
  _paintMoney(ctx) {
    const el = this._el;
    if (!el.money) return;
    const player = ctx.player;
    let money = 0;
    // prefer economy.balance() (authoritative) else player.money mirror
    const econ = this._api(ctx, 'economy');
    if (econ && typeof econ.balance === 'function') {
      const b = econ.balance();
      if (typeof b === 'number' && isFinite(b)) money = b;
      else if (player && typeof player.money === 'number') money = player.money;
    } else if (player && typeof player.money === 'number') {
      money = player.money;
    }
    money = money | 0;

    const txt = '$' + money.toLocaleString('en-US');
    if (txt !== this._lastMoneyShown) {
      el.money.textContent = txt;
      this._lastMoneyShown = txt;
    }

    // clear the .bump class once its window elapses
    const t = (ctx.time && ctx.time.t) || 0;
    if (this._moneyBumpUntil && t >= this._moneyBumpUntil) {
      el.money.classList.remove('bump');
      this._moneyBumpUntil = 0;
    }
  },

  // ========================================================
  // HUD: HEALTH + ARMOR BARS
  // ========================================================
  _paintVitals(ctx) {
    const el = this._el;
    const player = ctx.player || {};
    const maxH = (typeof player.maxHealth === 'number' && player.maxHealth > 0) ? player.maxHealth : 100;

    if (el.healthFill) {
      const h = (typeof player.health === 'number') ? player.health : maxH;
      let pct = GU.clamp((h / maxH) * 100, 0, 100);
      // round to whole % to avoid sub-pixel thrash and dedupe writes
      pct = Math.round(pct);
      if (pct !== this._healthWidthShown) {
        el.healthFill.style.width = pct + '%';
        this._healthWidthShown = pct;
      }
      // low-health feedback: pulse the bar + a red screen-edge vignette (CSS).
      // Evaluated every frame (independent threshold), deduped on the boolean.
      const low = pct <= 25 && player.alive !== false;
      if (low !== this._lowHpShown) {
        const bar = el.healthFill.parentElement;
        if (bar) { if (low) bar.classList.add('low'); else bar.classList.remove('low'); }
        if (typeof document !== 'undefined') {
          if (low) document.body.classList.add('gta-lowhp'); else document.body.classList.remove('gta-lowhp');
        }
        this._lowHpShown = low;
      }
    }
    if (el.armorFill) {
      const a = (typeof player.armor === 'number') ? player.armor : 0;
      let pct = GU.clamp(a, 0, 100);
      pct = Math.round(pct);
      if (pct !== this._armorWidthShown) {
        el.armorFill.style.width = pct + '%';
        this._armorWidthShown = pct;
      }
    }
  },

  // ========================================================
  // HUD: WEAPON + AMMO
  // ========================================================
  _paintWeapon(ctx) {
    const el = this._el;
    const combat = this._api(ctx, 'combat');
    const player = ctx.player || {};

    let name = 'FISTS';
    let melee = true;
    let clip = 0, reserve = 0;

    let w = null;
    if (combat && typeof combat.currentWeapon === 'function') {
      try { w = combat.currentWeapon(); } catch (e) { w = null; }
    }

    if (w && typeof w === 'object') {
      melee = !!w.melee;
      if (typeof w.name === 'string' && w.name) name = w.name.toUpperCase();
      else if (typeof w.id === 'string') name = (WEAPON_NAMES[w.id] || w.id.toUpperCase());
      if (typeof w.clip === 'number') clip = w.clip | 0;
      if (typeof w.reserve === 'number') reserve = w.reserve | 0;
    } else {
      // fall back to player.weapon id when combat isn't up yet
      const id = (typeof player.weapon === 'string' && player.weapon) ? player.weapon : 'fists';
      name = WEAPON_NAMES[id] || id.toUpperCase();
      melee = MELEE_IDS.has(id);
    }

    const t = (ctx.time && ctx.time.t) || 0;
    if (el.weapon && name !== this._weaponNameShown) {
      const first = this._weaponNameShown === null;   // don't flash the initial paint
      el.weapon.textContent = name || 'FISTS';
      this._weaponNameShown = name || 'FISTS';
      if (!first) { el.weapon.classList.add('swap'); this._weaponSwapUntil = t + 0.35; }   // brief pop on swap
    }
    if (this._weaponSwapUntil && t >= this._weaponSwapUntil) {
      if (el.weapon) el.weapon.classList.remove('swap');
      this._weaponSwapUntil = 0;
    }

    if (el.ammo) {
      const txt = melee ? '—' : (clip + ' / ' + reserve);
      if (txt !== this._ammoTextShown) {
        el.ammo.textContent = txt;
        this._ammoTextShown = txt;
      }
      const empty = !melee && clip === 0;
      if (empty !== this._ammoEmptyShown) {
        if (empty) el.ammo.classList.add('empty'); else el.ammo.classList.remove('empty');
        this._ammoEmptyShown = empty;
      }
      // low (but not empty) clip → amber warning to prompt a reload
      const low = !melee && clip > 0 && clip <= 5;
      if (low !== this._ammoLowShown) {
        if (low) el.ammo.classList.add('low'); else el.ammo.classList.remove('low');
        this._ammoLowShown = low;
      }
    }
  },

  // ========================================================
  // HUD: MISSION OBJECTIVE BANNER
  // ========================================================
  _paintObjective(ctx) {
    const el = this._el;
    if (!el.objective) return;
    const missions = this._api(ctx, 'missions');

    let text = null;
    if (missions && typeof missions.currentObjective === 'function') {
      let obj = null;
      try { obj = missions.currentObjective(); } catch (e) { obj = null; }
      if (obj && typeof obj === 'object' && typeof obj.text === 'string' && obj.text.trim()) {
        text = obj.text;
      }
    }

    if (text) {
      if (this._objectiveHidden !== false) {
        el.objective.classList.remove('hidden');
        this._objectiveHidden = false;
      }
      if (text !== this._objectiveTextShown) {
        el.objective.innerHTML = text;
        this._objectiveTextShown = text;
      }
    } else {
      if (this._objectiveHidden !== true) {
        el.objective.classList.add('hidden');
        this._objectiveHidden = true;
        this._objectiveTextShown = null;
      }
    }
  },

  // ========================================================
  // HUD: CROSSHAIR (only when aiming a non-melee weapon while pointer-locked)
  // ========================================================
  _paintCrosshair(ctx) {
    const el = this._el;
    if (!el.crosshair) return;
    const input = ctx.input;
    const locked = !!(input && input.pointerLocked);

    let melee = true, clipEmpty = false;
    const combat = this._api(ctx, 'combat');
    if (combat && typeof combat.currentWeapon === 'function') {
      let w = null;
      try { w = combat.currentWeapon(); } catch (e) { w = null; }
      if (w && typeof w === 'object') { melee = !!w.melee; clipEmpty = !melee && w.clip === 0; }
      else {
        const id = (ctx.player && typeof ctx.player.weapon === 'string') ? ctx.player.weapon : 'fists';
        melee = MELEE_IDS.has(id);
      }
    } else {
      const id = (ctx.player && typeof ctx.player.weapon === 'string') ? ctx.player.weapon : 'fists';
      melee = MELEE_IDS.has(id);
    }

    const show = locked && !melee;
    const hidden = !show;
    if (hidden !== this._crosshairHiddenShown) {
      if (hidden) el.crosshair.classList.add('hidden'); else el.crosshair.classList.remove('hidden');
      this._crosshairHiddenShown = hidden;
    }
    // crosshair STATE: tighten when aiming down (shared window.ONFOOT.aiming flag),
    // tint red when the clip is empty. Both deduped; harmless if D hasn't wired aim.
    const aiming = typeof window !== 'undefined' && !!(window.ONFOOT && window.ONFOOT.aiming);
    if (aiming !== this._crosshairAimShown) {
      if (aiming) el.crosshair.classList.add('aim'); else el.crosshair.classList.remove('aim');
      this._crosshairAimShown = aiming;
    }
    if (clipEmpty !== this._crosshairEmptyShown) {
      if (clipEmpty) el.crosshair.classList.add('empty'); else el.crosshair.classList.remove('empty');
      this._crosshairEmptyShown = clipEmpty;
    }
  },

  // ========================================================
  // HUD: TOAST
  // ========================================================
  _showToast(ctx, p) {
    const el = this._el;
    if (!el.toast || !p) return;
    const html = (typeof p.html === 'string') ? p.html : '';
    const ms = (typeof p.ms === 'number' && p.ms > 0) ? p.ms : 4500;
    el.toast.innerHTML = html;
    el.toast.classList.remove('hidden');
    el.toast.style.opacity = '1';
    const t = (ctx.time && ctx.time.t) || 0;
    this._toastHideAt = t + ms / 1000;
  },

  _tickToast(ctx) {
    const el = this._el;
    if (!el.toast) return;
    if (this._toastHideAt > 0) {
      const t = (ctx.time && ctx.time.t) || 0;
      if (t >= this._toastHideAt) {
        el.toast.classList.add('hidden');
        this._toastHideAt = 0;
      }
    }
  },

  // ========================================================
  // THE RADAR / MINIMAP
  // ------------------------------------------------------------
  // Player-centred, player-up. We rotate the whole world by -player.yaw so the
  // direction the player faces always points to the top of the disc, then
  // translate by -player.pos. Everything is clipped to a circle.
  // ========================================================
  _paintRadar(ctx) {
    const g = this._ctx2d;
    if (!g) return;
    const player = ctx.player;
    if (!player || !player.pos) return;

    const size = RADAR_SIZE;
    const cx = size / 2;
    const cy = size / 2;
    const R = size / 2 - 3;                 // disc radius in px (leave a hair of margin)
    // world units -> px scale: full diameter spans RADAR_WORLD_SPAN world units
    const scale = (size) / RADAR_WORLD_SPAN; // px per world unit
    const px = player.pos.x;
    const pz = player.pos.z;
    // player-up: world +Z (north-ish) rotates by -yaw. We map world (x,z) so that
    // the player's facing yaw points to screen-up (-y in canvas).
    const yaw = (typeof player.yaw === 'number') ? player.yaw : 0;
    const cosA = Math.cos(yaw);
    const sinA = Math.sin(yaw);

    g.save();
    g.clearRect(0, 0, size, size);

    // --- circular clip ---
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.closePath();
    g.clip();

    // --- dark disc background ---
    g.fillStyle = 'rgba(10,14,20,0.82)';
    g.fillRect(0, 0, size, size);
    // subtle radial vignette for depth
    let grad = null;
    try {
      grad = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R);
      grad.addColorStop(0, 'rgba(30,40,54,0.55)');
      grad.addColorStop(1, 'rgba(8,11,16,0.85)');
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
    } catch (e) { /* createRadialGradient unsupported — fine without */ }

    // ============================================================
    // Helper: world (wx,wz) -> radar pixel (out.x,out.z)
    // rotate by -yaw so facing is up, then place at centre.
    // canvas y grows downward; world +Z forward must map to screen up,
    // so screen_y = cy - (rotated world-forward component) * scale.
    // ============================================================
    const project = (wx, wz, out) => {
      const rx = wx - px;
      const rz = wz - pz;
      // rotate world-space by -yaw:
      //   forward (along facing) = rz*cos + rx*sin   -> up
      //   side                    = rx*cos - rz*sin   -> right
      const fwd = rz * cosA + rx * sinA;
      const side = rx * cosA - rz * sinA;
      out.x = cx + side * scale;
      out.z = cy - fwd * scale;
      return out;
    };

    const worldApi = this._api(ctx, 'world');
    const bound = (worldApi && typeof worldApi.bound === 'number')
      ? worldApi.bound
      : (worldApi && typeof worldApi.bound === 'function' ? worldApi.bound() : 120);
    const block = (worldApi && typeof worldApi.blockSize === 'number') ? worldApi.blockSize : 40;
    const roadHalf = (worldApi && typeof worldApi.roadHalf === 'number') ? worldApi.roadHalf : 5;
    const roadOff = (worldApi && typeof worldApi.roadOffset === 'number') ? worldApi.roadOffset : 0;

    // ============================================================
    // ROAD GRID — draw the asphalt strips that lie within view.
    // Roads are centred on x=k*block and z=k*block, half-width roadHalf.
    // We only need lines whose centre is within ~span/2 + block of the player.
    // ============================================================
    const reach = RADAR_WORLD_SPAN * 0.62; // a touch beyond the visible radius
    // road strips: vertical roads (constant x = k*block, run along Z) then horizontal
    this._drawGridRoads(g, project, px, pz, block, bound, reach, roadHalf, scale, true, roadOff);
    this._drawGridRoads(g, project, px, pz, block, bound, reach, roadHalf, scale, false, roadOff);

    // ============================================================
    // BUILDING BLOCKS — faint filled rects from world.aabbs.
    // We draw each AABB as a rotated quad (4 projected corners).
    // ============================================================
    const worldSys = ctx.systems && ctx.systems.world;
    const aabbs = (worldSys && Array.isArray(worldSys.aabbs)) ? worldSys.aabbs : null;
    if (aabbs && aabbs.length) {
      g.fillStyle = 'rgba(120,130,145,0.22)';
      g.beginPath();
      for (let i = 0; i < aabbs.length; i++) {
        const b = aabbs[i];
        // cheap cull: skip blocks whose centre is far outside view
        const bcx = (b.minX + b.maxX) * 0.5;
        const bcz = (b.minZ + b.maxZ) * 0.5;
        if (Math.abs(bcx - px) > reach + block || Math.abs(bcz - pz) > reach + block) continue;
        project(b.minX, b.minZ, _v3a); const x0 = _v3a.x, y0 = _v3a.z;
        project(b.maxX, b.minZ, _v3a); const x1 = _v3a.x, y1 = _v3a.z;
        project(b.maxX, b.maxZ, _v3a); const x2 = _v3a.x, y2 = _v3a.z;
        project(b.minX, b.maxZ, _v3a); const x3 = _v3a.x, y3 = _v3a.z;
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
        g.lineTo(x2, y2);
        g.lineTo(x3, y3);
        g.closePath();
      }
      g.fill();
    }

    // ============================================================
    // MAP-EDGE RING — show the world boundary if it's within view, so the
    // player can feel the edge of the playable space (a GTA touch).
    // ============================================================
    // (kept lightweight: only the inner disc edge is the meaningful frame)

    // ============================================================
    // BLIPS from the shared hittable registry (ctx.targets).
    // ped = light grey, cop = blue, vehicle = cyan. Skip dead/out-of-range.
    // ============================================================
    const targets = Array.isArray(ctx.targets) ? ctx.targets : null;
    if (targets && targets.length) {
      for (let i = 0; i < targets.length; i++) {
        const e = targets[i];
        if (!e || e.dead || !e.pos) continue;
        const ex = e.pos.x, ez = e.pos.z;
        const d = Math.hypot(ex - px, ez - pz);
        if (d > BLIP_MAX_RANGE) continue;
        project(ex, ez, _v3a);
        // skip if the projected point fell outside the disc (rotation can push corners out)
        const ddx = _v3a.x - cx, ddy = _v3a.z - cy;
        if (ddx * ddx + ddy * ddy > R * R) continue;
        let col = COL_PED, rad = 2.2;
        if (e.kind === 'cop') { col = COL_COP; rad = 2.8; }
        else if (e.kind === 'vehicle') { col = COL_VEHICLE; rad = 3.0; }
        g.fillStyle = col;
        g.beginPath();
        g.arc(_v3a.x, _v3a.z, rad, 0, Math.PI * 2);
        g.fill();
      }
    }

    // ============================================================
    // MISSION OBJECTIVE MARKER — yellow diamond. Source priority:
    //   1) missions.currentObjective().marker {x,z} (or .pos)
    //   2) missions.api.markerPos() if exposed
    // If none exposed, skip silently.
    // ============================================================
    if (this._resolveMissionMarker(ctx, _markerScratch) && _markerScratch.has) {
      project(_markerScratch.x, _markerScratch.z, _v3a);
      // clamp marker to the disc edge if off-screen so it still points the way
      let mx = _v3a.x, my = _v3a.z;
      const dx = mx - cx, dy = my - cy;
      const dist = Math.hypot(dx, dy);
      const edge = R - 6;
      if (dist > edge && dist > 0.0001) {
        mx = cx + (dx / dist) * edge;
        my = cy + (dy / dist) * edge;
      }
      this._drawDiamond(g, mx, my, 4.2, COL_MISSION);
    }

    // ============================================================
    // WANTED SEARCH AREA — if police are hunting, draw a faint pulsing ring at
    // the last-known position (wanted.api.pos()), GTA-style "search radius".
    // ============================================================
    const wantedApi = this._api(ctx, 'wanted');
    if (wantedApi && typeof wantedApi.stars === 'function') {
      let stars = 0;
      try { stars = wantedApi.stars() | 0; } catch (e) { stars = 0; }
      if (stars > 0 && typeof wantedApi.pos === 'function') {
        let wp = null;
        try { wp = wantedApi.pos(); } catch (e) { wp = null; }
        if (wp && typeof wp.x === 'number' && typeof wp.z === 'number') {
          project(wp.x, wp.z, _v3a);
          const t = (ctx.time && ctx.time.t) || 0;
          const pulse = 0.4 + 0.25 * (0.5 + 0.5 * Math.sin(t * 3));
          g.strokeStyle = 'rgba(255,90,90,' + pulse.toFixed(3) + ')';
          g.lineWidth = 1.5;
          g.beginPath();
          g.arc(_v3a.x, _v3a.z, Math.max(6, 10 + stars * 2), 0, Math.PI * 2);
          g.stroke();
        }
      }
    }

    g.restore(); // remove circular clip before drawing the player + frame

    // ============================================================
    // PLAYER — white triangle at centre, pointing up (player is always up).
    // Drawn OUTSIDE the clip so it's always fully crisp at the centre.
    // ============================================================
    g.save();
    g.translate(cx, cy);
    g.fillStyle = COL_PLAYER;
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, -6.5);      // nose (up)
    g.lineTo(4.6, 5);       // back-right
    g.lineTo(0, 2.6);       // tail notch
    g.lineTo(-4.6, 5);      // back-left
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();

    // ============================================================
    // NORTH TICK — small marker on the disc edge showing world-north (+Z),
    // which rotates as the player turns. Subtle, classic minimap detail.
    // ============================================================
    g.save();
    // north direction in radar space: world +Z forward when yaw aligns.
    // north vector (0,+Z) projected: fwd = cosA, side = -sinA
    const nFwd = cosA;       // world +Z component along facing
    const nSide = -sinA;     // world +Z component along side
    const nLen = Math.hypot(nFwd, nSide) || 1;
    const nx = cx + (nSide / nLen) * (R - 2);
    const ny = cy - (nFwd / nLen) * (R - 2);
    g.fillStyle = 'rgba(245,215,110,0.9)';
    g.beginPath();
    g.arc(nx, ny, 2, 0, Math.PI * 2);
    g.fill();
    g.restore();
  },

  // --------------------------------------------------------
  // Draw the road strips for one orientation across the visible window.
  // `vertical=true` => roads at constant x = k*block (run along world Z).
  // We render them as thin rotated quads via project().
  // --------------------------------------------------------
  _drawGridRoads(g, project, px, pz, block, bound, reach, roadHalf, scale, vertical, offset = 0) {
    if (block <= 0) return;
    g.fillStyle = 'rgba(58,64,74,0.6)';
    // range of grid lines that could intersect the view window
    const halfReach = reach + block;
    // the along-axis extent we draw (clamped to map bounds)
    const aMin = -bound;
    const aMax = bound;
    g.beginPath();
    if (vertical) {
      const kMin = Math.ceil((px - halfReach - offset) / block);
      const kMax = Math.floor((px + halfReach - offset) / block);
      for (let k = kMin; k <= kMax; k++) {
        const lineX = k * block + offset;
        if (Math.abs(lineX) > bound + 1) continue;
        const x0 = lineX - roadHalf, x1 = lineX + roadHalf;
        // a long strip along Z from aMin..aMax, as a quad of 4 corners
        project(x0, aMin, _v3a); const ax = _v3a.x, ay = _v3a.z;
        project(x1, aMin, _v3a); const bx = _v3a.x, by = _v3a.z;
        project(x1, aMax, _v3a); const cxp = _v3a.x, cyp = _v3a.z;
        project(x0, aMax, _v3a); const dx = _v3a.x, dy = _v3a.z;
        g.moveTo(ax, ay); g.lineTo(bx, by); g.lineTo(cxp, cyp); g.lineTo(dx, dy); g.closePath();
      }
    } else {
      const kMin = Math.ceil((pz - halfReach - offset) / block);
      const kMax = Math.floor((pz + halfReach - offset) / block);
      for (let k = kMin; k <= kMax; k++) {
        const lineZ = k * block + offset;
        if (Math.abs(lineZ) > bound + 1) continue;
        const z0 = lineZ - roadHalf, z1 = lineZ + roadHalf;
        project(aMin, z0, _v3a); const ax = _v3a.x, ay = _v3a.z;
        project(aMax, z0, _v3a); const bx = _v3a.x, by = _v3a.z;
        project(aMax, z1, _v3a); const cxp = _v3a.x, cyp = _v3a.z;
        project(aMin, z1, _v3a); const dx = _v3a.x, dy = _v3a.z;
        g.moveTo(ax, ay); g.lineTo(bx, by); g.lineTo(cxp, cyp); g.lineTo(dx, dy); g.closePath();
      }
    }
    g.fill();
  },

  _drawDiamond(g, x, y, r, col) {
    g.save();
    g.fillStyle = col;
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y - r);
    g.lineTo(x + r, y);
    g.lineTo(x, y + r);
    g.lineTo(x - r, y);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  },

  // --------------------------------------------------------
  // Try a few documented/likely shapes for a mission map marker; never throw.
  // Writes out.x/out.z and out.has. Returns out.
  // --------------------------------------------------------
  _resolveMissionMarker(ctx, out) {
    out.has = false; out.x = 0; out.z = 0;
    const missions = this._api(ctx, 'missions');
    if (!missions) return out;

    // 1) explicit marker accessor
    if (typeof missions.markerPos === 'function') {
      let m = null;
      try { m = missions.markerPos(); } catch (e) { m = null; }
      if (m && typeof m.x === 'number' && typeof m.z === 'number') {
        out.x = m.x; out.z = m.z; out.has = true; return out;
      }
    }

    // 2) currentObjective().marker / .pos
    if (typeof missions.currentObjective === 'function') {
      let obj = null;
      try { obj = missions.currentObjective(); } catch (e) { obj = null; }
      if (obj && typeof obj === 'object') {
        const cand = obj.marker || obj.pos || obj.target || null;
        if (cand && typeof cand.x === 'number' && typeof cand.z === 'number') {
          out.x = cand.x; out.z = cand.z; out.has = true; return out;
        }
      }
    }
    return out;
  },

  // --------------------------------------------------------
  // Safe accessor for another system's api (handles missing system / api).
  // --------------------------------------------------------
  _api(ctx, name) {
    const sysmap = ctx && ctx.systems;
    const s = sysmap && sysmap[name];
    return (s && s.api) ? s.api : null;
  },

  // PURE VIEW — no public api needed.
  api: {},
};

GTA.register(sys);
export default sys;
