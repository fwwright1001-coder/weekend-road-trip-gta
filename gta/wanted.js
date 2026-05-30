// ============================================================
// gta/wanted.js — the 0..5 star "wanted level" / police-heat system
// ------------------------------------------------------------
// Classic crime-sandbox MECHANIC (not copyrightable): committing crimes raises
// a continuous "heat" meter; heat maps to 0..5 stars. While the police can SEE
// you, the level holds (and only rises). Once you break line-of-sight, the
// level "flashes" for a grace window and then decays one bracket at a time —
// the familiar lose-the-cops-by-hiding loop. A respray / bribe / bust / respawn
// instantly clears it.
//
// This system owns NO meshes (it is pure state + events). It is intentionally
// decoupled: it only listens to 'crime' / 'playerRespawn' and emits
// 'wanted:changed' + 'toast'. Police read api.stars() and call api.setSeen(true)
// each frame they have LOS; the HUD reads api.stars()/api.heat().
//
// Coordinate convention is irrelevant here (no spatial sim) except that we keep
// the last crime position so police can spawn / converge on it (api.pos()).
// ============================================================
import { GTA, GU } from './core.js';

// ---- tunables --------------------------------------------------------------
// Bracket floors on the continuous heat axis. heat >= THRESH[n] => at least n
// stars. THRESH[0]=0 is the "no wanted" floor. The top entry caps the scale.
const THRESH = [0, 1, 2.5, 4.5, 7, 10];   // 6 entries => stars 0..5
const MAX_STARS = THRESH.length - 1;        // 5
const HEAT_CAP = 11;                        // clamp ceiling a touch above top bracket

// Base heat added per crime kind (before difficulty scaling). severity (default
// 1) multiplies on top. 'evading' is deliberately tiny — a slow simmer that
// keeps the meter warm while you run but never alone escalates fast.
const CRIME_WEIGHT = {
  propertyDamage: 0.25,
  gunfire: 0.5,
  assault: 1.0,
  vehicleTheft: 1.0,
  copAssault: 1.5,
  copKilled: 2.5,
  evading: 0.06,
};
const DEFAULT_WEIGHT = 0.5;   // unknown crime kinds get a moderate bump

// Timing (seconds).
const COOLDOWN = 6.0;     // crime-free time before decay may even begin
const SEEN_GRACE = 0.6;   // how long "seen" lingers after the last setSeen(true)
const FLASH_TIME = 8.0;   // once unseen+cooled, how long the level "flashes"
                          // before it starts dropping (per remaining drop step)
const DECAY_STEP = 4.0;   // seconds to bleed down one bracket once decay starts

// ============================================================
// SYSTEM
// ============================================================
const wanted = {
  name: 'wanted',
  deps: [],

  // ---- live state (seeded in init/reset) ----
  heat: 0,
  stars: 0,
  prevStars: 0,
  lastCrimeKind: null,
  lastCrimeT: -1e9,     // ctx.time.t of the most recent crime
  hasCrimePos: false,
  seenTimer: 0,         // counts down; >0 means police currently see us
  flashTimer: 0,        // counts down the "flashing" grace before a drop
  decayAccum: 0,        // accumulates toward the next bracket drop
  _diff: 1,             // cached difficulty multiplier
  _unsub: [],           // bus unsubscribers (so reset/re-init is clean)

  init(ctx) {
    const THREE = ctx && ctx.THREE;
    // last-crime position is reusable; create once, never per-frame.
    if (!this._lastPos) {
      this._lastPos = THREE ? new THREE.Vector3() : { x: 0, y: 0, z: 0, set() {} };
    }
    this._diff = (ctx && ctx.config && +ctx.config.difficulty) || 1;
    if (!(this._diff > 0)) this._diff = 1;

    this._seedClean();

    // (Re)subscribe defensively: clear any prior subs first so a live
    // re-register (core.js supports it) doesn't double-handle events.
    this._teardown();
    const bus = ctx && ctx.bus;
    if (bus && typeof bus.on === 'function') {
      this._unsub.push(bus.on('crime', (p) => this._onCrime(p, ctx)));
      this._unsub.push(bus.on('playerRespawn', () => this.api.clear()));
      this._unsub.push(bus.on('playerBusted', () => this.api.clear()));
      this._unsub.push(bus.on('playerWasted', () => this.api.clear()));
    }
  },

  update(dt, ctx) {
    if (!(dt > 0)) return;
    const t = (ctx && ctx.time && ctx.time.t) || 0;

    // tick down the "seen" lingering window — police set it back to SEEN_GRACE
    // every frame they have LOS via api.setSeen(true).
    if (this.seenTimer > 0) this.seenTimer = Math.max(0, this.seenTimer - dt);
    const seen = this.seenTimer > 0;

    const sinceCrime = t - this.lastCrimeT;
    const cooled = sinceCrime >= COOLDOWN;

    if (this.heat <= 0) {
      // already clean — keep timers idle.
      this.flashTimer = 0;
      this.decayAccum = 0;
      this._syncStars(ctx);
      return;
    }

    // Sub-1-star residual heat with no active wanted level: if we're cooled and
    // unseen, just bleed it to nothing (so the HUD meter empties and a tiny new
    // crime doesn't instantly re-trigger a star off leftover heat).
    if (this.stars <= 0) {
      if (!seen && cooled) {
        this.heat = 0;
        this.flashTimer = 0;
        this.decayAccum = 0;
        this.hasCrimePos = false;
      }
      this._syncStars(ctx);
      return;
    }

    if (seen || !cooled) {
      // Held: visible to police, or recently committed a crime. While held we
      // keep the meter where it is (no passive rise; rises come from crimes),
      // and we reset the flashing grace so losing them later starts fresh.
      this.flashTimer = FLASH_TIME;
      this.decayAccum = 0;
      this._syncStars(ctx);
      return;
    }

    // Hidden + cooled: first burn the flashing grace, then bleed heat down
    // toward the floor of the bracket BELOW the current star count, one bracket
    // per DECAY_STEP seconds (the classic "flashing then drop a star" feel).
    if (this.flashTimer > 0) {
      this.flashTimer = Math.max(0, this.flashTimer - dt);
      this._syncStars(ctx);
      return;
    }

    // target = floor of the bracket one star below current; if we reach it,
    // continue toward the next bracket down on the following step.
    const targetStar = Math.max(0, this.stars - 1);
    const targetHeat = THRESH[targetStar];
    this.decayAccum += dt;
    if (this.decayAccum >= DECAY_STEP || this.heat <= targetHeat + 1e-4) {
      // drop a bracket
      this.heat = targetHeat;
      this.decayAccum = 0;
      this.flashTimer = FLASH_TIME;   // re-arm flashing before the next drop
      if (this.heat <= 0) { this.heat = 0; this.flashTimer = 0; }
    } else {
      // smooth bleed within the step so the HUD meter visibly drains
      const span = Math.max(1e-3, DECAY_STEP);
      const from = THRESH[this.stars];           // top of current visual bracket-ish
      const rate = (Math.max(from, this.heat) - targetHeat) / span;
      this.heat = Math.max(targetHeat, this.heat - rate * dt);
    }
    // once we've drained below the 1-star floor there is nothing left to lose —
    // snap fully clean so the HUD meter empties and no residual heat lingers.
    if (this.heat < THRESH[1] - 1e-6 && this.stars <= 0) {
      this.heat = 0;
      this.flashTimer = 0;
      this.decayAccum = 0;
      this.hasCrimePos = false;
    }
    this._syncStars(ctx);
  },

  reset(ctx) {
    // respawn / re-enter: lose the wanted level, keep subscriptions + state shape.
    this.api.clear();
    if (ctx && ctx.config) {
      const d = +ctx.config.difficulty;
      this._diff = d > 0 ? d : 1;
    }
  },

  // ============================================================
  // internals
  // ============================================================
  _seedClean() {
    this.heat = 0;
    this.stars = 0;
    this.prevStars = 0;
    this.lastCrimeKind = null;
    this.lastCrimeT = -1e9;
    this.hasCrimePos = false;
    this.seenTimer = 0;
    this.flashTimer = 0;
    this.decayAccum = 0;
    if (this._lastPos && this._lastPos.set) this._lastPos.set(0, 0, 0);
  },

  _teardown() {
    if (this._unsub && this._unsub.length) {
      for (const off of this._unsub) { try { if (typeof off === 'function') off(); } catch (e) { /* ignore */ } }
    }
    this._unsub = [];
  },

  // map current heat -> star count (highest bracket whose floor we meet).
  _starsForHeat(h) {
    let s = 0;
    for (let i = 1; i < THRESH.length; i++) {
      if (h >= THRESH[i] - 1e-9) s = i; else break;
    }
    return s > MAX_STARS ? MAX_STARS : s;
  },

  // recompute stars from heat; if the count changed, emit wanted:changed and,
  // on first reaching 1 star, a helpful toast.
  _syncStars(ctx) {
    const ns = this._starsForHeat(this.heat);
    if (ns !== this.stars) {
      this.prevStars = this.stars;
      this.stars = ns;
      const bus = ctx && ctx.bus;
      if (bus && typeof bus.emit === 'function') {
        bus.emit('wanted:changed', { level: this.stars, prev: this.prevStars, heat: this.heat });
        if (this.prevStars === 0 && this.stars >= 1) {
          bus.emit('toast', { html: "You've attracted police attention.", ms: 3500 });
        } else if (this.stars === 0 && this.prevStars >= 1) {
          bus.emit('toast', { html: 'You lost the police.', ms: 2500 });
        }
      }
    }
  },

  _onCrime(p, ctx) {
    if (!p) return;
    const kind = p.kind;
    let w = CRIME_WEIGHT[kind];
    if (w == null) w = DEFAULT_WEIGHT;
    let sev = +p.severity;
    if (!(sev > 0)) sev = 1;
    const add = w * sev * (this._diff > 0 ? this._diff : 1);
    if (add > 0) {
      this.heat = GU.clamp(this.heat + add, 0, HEAT_CAP);
    }
    this.lastCrimeKind = kind || 'unknown';
    this.lastCrimeT = (ctx && ctx.time && ctx.time.t) || 0;
    // remember where it happened so police can converge / spawn there.
    const pos = p.pos;
    if (pos && this._lastPos && this._lastPos.set) {
      const x = +pos.x, y = +(pos.y || 0), z = +pos.z;
      if (Number.isFinite(x) && Number.isFinite(z)) {
        this._lastPos.set(x, Number.isFinite(y) ? y : 0, z);
        this.hasCrimePos = true;
      }
    }
    // committing a crime re-arms the flashing grace and stops any decay in flight.
    this.flashTimer = FLASH_TIME;
    this.decayAccum = 0;
    this._syncStars(ctx);
  },

  // ============================================================
  // PUBLIC API (police + hud + economy/missions call these)
  // ============================================================
  api: {
    // integer star count 0..5
    stars() { return wanted.stars | 0; },
    // alias (spec calls level() an alias of stars())
    level() { return wanted.stars | 0; },

    // normalized 0..1 progress for the HUD. Within the current star bracket we
    // report fractional fill toward the next bracket; at max stars we report
    // fill toward the heat cap. Clamped to [0,1].
    heat() {
      const s = wanted.stars | 0;
      const lo = THRESH[s] || 0;
      const hi = s < MAX_STARS ? THRESH[s + 1] : HEAT_CAP;
      const span = hi - lo;
      if (span <= 1e-6) return s >= MAX_STARS ? 1 : 0;
      return GU.clamp((wanted.heat - lo) / span, 0, 1);
    },

    // raw continuous heat (handy for debugging / other systems that want it).
    heatRaw() { return wanted.heat; },

    // add wanted heat. Accepts either a crime KIND string (uses its weight) or a
    // raw NUMBER (added directly). Routes through the same path as bus 'crime'
    // so toasts/wanted:changed fire identically.
    add(crimeOrAmount, severity) {
      const ctx = GTA.ctx;
      if (typeof crimeOrAmount === 'number') {
        if (Number.isFinite(crimeOrAmount) && crimeOrAmount !== 0) {
          wanted.heat = GU.clamp(wanted.heat + crimeOrAmount, 0, HEAT_CAP);
          wanted.lastCrimeT = (ctx && ctx.time && ctx.time.t) || wanted.lastCrimeT;
          wanted.flashTimer = FLASH_TIME;
          wanted.decayAccum = 0;
          wanted._syncStars(ctx);
        }
        return wanted.stars | 0;
      }
      // string crime kind
      wanted._onCrime({ kind: crimeOrAmount, severity: severity }, ctx);
      return wanted.stars | 0;
    },

    // instant total clear — used by respray/bribe, bust, wasted, respawn.
    clear() {
      const ctx = GTA.ctx;
      const had = wanted.stars;
      wanted.heat = 0;
      wanted.seenTimer = 0;
      wanted.flashTimer = 0;
      wanted.decayAccum = 0;
      wanted.lastCrimeT = -1e9;
      wanted.hasCrimePos = false;
      if (had !== 0) {
        wanted.prevStars = had;
        wanted.stars = 0;
        const bus = ctx && ctx.bus;
        if (bus && typeof bus.emit === 'function') {
          bus.emit('wanted:changed', { level: 0, prev: had, heat: 0 });
        }
      } else {
        wanted.stars = 0;
        wanted.prevStars = 0;
      }
    },

    // police call this every frame they have line-of-sight on the player.
    setSeen(v) {
      if (v) wanted.seenTimer = SEEN_GRACE;
      else wanted.seenTimer = 0;   // explicit false snaps the seen window shut
    },

    // is the player currently considered "seen" by police?
    seen() { return wanted.seenTimer > 0; },

    // last crime position (for police spawn/converge), or null if none pending.
    pos() {
      if (!wanted.hasCrimePos || wanted.heat <= 0) return null;
      return wanted._lastPos;
    },

    // kind of the most recent crime (or null).
    lastCrime() { return wanted.lastCrimeKind; },
  },
};

GTA.register(wanted);
export default wanted;
