// ============================================================
// gta/audio.js — atmosphere & music for the on-foot / GTA mode (Lane B)
// ------------------------------------------------------------
// A self-contained ATMOSPHERE system, sibling to gta/fx.js: a cyclable set of
// procedurally-synthesised RADIO STATIONS (no audio files — everything is built
// from oscillators + noise at runtime) plus a layered AMBIENT CITY BED (traffic
// hum, gusting wind, the occasional distant siren) that sits UNDER fx.js's
// gunfire/footsteps/impacts. It never touches game.js's audio or render3d.js.
//
// SPLIT WITH fx.js: fx.js = SFX (guns, footsteps, impacts, explosions). audio.js
// = MUSIC + AMBIENCE. They run on separate AudioContexts/gains so the settings
// menu can mix "music" and "sfx" independently. On init audio.js silences fx.js's
// simple round-1 city bed (window.ONFOOT_FX.ambient(false)) and plays the richer
// one here, so they never double up.
//
// INTEGRATION (same seam as fx.js — Lane D wires it):
//   * Registers a GTA system on import: GTA.register({name:'audio', init,update,reset}).
//     D dynamic-imports this file (index.html + bridge) exactly like fx.js; it also
//     exports install(ctx, GTA) and self-registers on window.ONFOOT_AUDIO.
//   * Headless-safe: all WebAudio is behind ctx.headless + typeof window checks, so
//     `npm run smoke` ticks it without a sound card. Every method is try/caught.
//   * Station cycling: call cycleStation()/setStation(i) OR emit 'radio:next' /
//     'radio:set' on GTA.bus. Lane D binds a key (proposed: B) — see REQUESTS.md.
//
// API (also on ctx.systems.audio.api + window.ONFOOT_AUDIO):
//   cycleStation() → name · setStation(i) · station() → {index,name} · stations() → [names]
//   setMusicVolume(v) · setAmbientVolume(v) · setMuted(b) · ambient(on) · reset()
// ============================================================
import { GTA } from './core.js';

// ---- module state ----------------------------------------------------------
let _ac = null;                 // AudioContext (lazy, shared by music + ambience)
let _master = null;             // master gain
let _musicGain = null, _ambGain = null;
let _headless = false, _muted = false, _inited = false;
let _musicVol = 0.45, _ambVol = 0.6;
let _noiseBuf = null;

// ambient bed nodes (kept so we can stop/restart cleanly)
let _amb = null;                // { nodes:[...], wind, windBase, lfoG, lfoBase, rain }
let _nextSiren = 0;             // ac-time of the next distant siren
let _weather = 'clear';         // last weather kind from 'world:weather' (clear|rain|fog)

// radio scheduler (lookahead step sequencer)
let _station = 0;               // index into STATIONS (0 = OFF)
let _step = 0;                  // 0..15 sixteenth-step
let _nextNoteT = 0;             // ac-time the next step should fire
let _schedSeeded = false;
const LOOKAHEAD = 0.16;         // seconds of audio scheduled ahead of the clock

// ---- reactive soundscape (engine / tire screech / sirens / music duck) -----
// All three persistent layers hang off a shared _reactGain under the master, so
// they obey volume + mute alongside the rest of the mix. Each is its own small
// sub-module with an idempotent startX() (mirrors the _amb '_inited'-style guard:
// "if (… || _engine) return") and a cheap per-frame updateX(ctx) that only writes
// AudioParam targets on already-built nodes — NO node allocation in the hot path.
let _reactGain = null;          // bus for engine + screech + sirens (under _master)
let _engine = null;             // { osc1, osc2, lp, gain, sub, subG } drone nodes
let _screech = null;            // { src, bp, gain } filtered-noise tire screech
let _sirens = null;             // { oscHi, oscLo, lp, gain, lfo } two-tone wail bed
let _wantedStars = 0;           // last stars from 'wanted:changed' (gates sirens)
let _combatHeat = 0;            // 0..1 decaying envelope; gunfire/blasts bump it
let _duckPending = 0;           // bumped combat heat to apply on the next update tick

// ============================================================
// CORE AUDIO
// ============================================================
function audioReady() {
  try {
    if (_headless || typeof window === 'undefined') return false;
    if (!_ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      _ac = new AC();
      _master = _ac.createGain(); _master.gain.value = _muted ? 0 : 1; _master.connect(_ac.destination);
      _musicGain = _ac.createGain(); _musicGain.gain.value = _musicVol; _musicGain.connect(_master);
      _ambGain = _ac.createGain(); _ambGain.gain.value = _ambVol; _ambGain.connect(_master);
      // reactive layers (engine/screech/sirens) share this bus under the master,
      // so they honour mute + master volume. Sits just under the ambient bed.
      _reactGain = _ac.createGain(); _reactGain.gain.value = 0.9; _reactGain.connect(_master);
    }
    if (_ac.state === 'suspended') _ac.resume();   // recover from autoplay/visibility suspension
    return true;
  } catch (e) { return false; }
}
function noiseBuffer() {
  if (_noiseBuf) return _noiseBuf;
  const n = _ac.sampleRate;
  _noiseBuf = _ac.createBuffer(1, n, n);
  const d = _noiseBuf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return _noiseBuf;
}

// ============================================================
// AMBIENT CITY BED — traffic hum + gusting wind (+ scheduled distant sirens)
// ============================================================
function startAmbient() {
  try {
    if (!audioReady() || _amb) return;
    const nodes = [];
    // traffic hum: looped noise, slowed + lowpassed into a low rumble
    const traf = _ac.createBufferSource(); traf.buffer = noiseBuffer(); traf.loop = true; traf.playbackRate.value = 0.16;
    const tlp = _ac.createBiquadFilter(); tlp.type = 'lowpass'; tlp.frequency.value = 180; tlp.Q.value = 0.3;
    const tg = _ac.createGain(); tg.gain.value = 0.0001; tg.gain.linearRampToValueAtTime(0.5, _ac.currentTime + 2);
    traf.connect(tlp).connect(tg).connect(_ambGain); traf.start();
    // a faint mains/electrical hum under it
    const hum = _ac.createOscillator(); hum.type = 'sine'; hum.frequency.value = 60;
    const hg = _ac.createGain(); hg.gain.value = 0.02; hum.connect(hg).connect(_ambGain); hum.start();
    // wind: bandpassed noise with a slow LFO swelling its gain
    const wind = _ac.createBufferSource(); wind.buffer = noiseBuffer(); wind.loop = true; wind.playbackRate.value = 0.5;
    const wbp = _ac.createBiquadFilter(); wbp.type = 'bandpass'; wbp.frequency.value = 520; wbp.Q.value = 0.7;
    const wg = _ac.createGain(); wg.gain.value = 0.05;
    const lfo = _ac.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.07;
    const lfoG = _ac.createGain(); lfoG.gain.value = 0.045;
    lfo.connect(lfoG).connect(wg.gain); wind.connect(wbp).connect(wg).connect(_ambGain); wind.start(); lfo.start();
    nodes.push(traf, hum, wind, lfo);
    // keep the wind gain (and its dry baseline) so weather can swell it; rain is a
    // separate layer started on demand by setWeather('rain').
    _amb = { nodes, wind: wg, windBase: 0.05, lfoG, lfoBase: 0.045, rain: null };
    _nextSiren = _ac.currentTime + 12 + Math.random() * 16;
    // re-apply any pending weather state captured before the bed existed
    if (_weather && _weather !== 'clear') applyWeather(_weather);
  } catch (e) { /* optional */ }
}
function stopAmbient() {
  try {
    if (!_amb) return;
    if (_amb.rain && _amb.rain.src) { try { _amb.rain.src.stop(); } catch (e) {} }
    for (const n of _amb.nodes) { try { n.stop(); } catch (e) {} }
    _amb = null;
  } catch (e) { /* optional */ }
}
// a distant two-tone siren wail, lowpassed + quiet so it reads as "blocks away"
function playSiren(t) {
  try {
    const o = _ac.createOscillator(); o.type = 'triangle';
    const lp = _ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100; lp.Q.value = 0.4;
    const g = _ac.createGain(); g.gain.value = 0.0001;
    o.connect(lp).connect(g).connect(_ambGain);
    const wails = 5, span = 0.7;
    for (let i = 0; i < wails; i++) {
      o.frequency.setValueAtTime(660, t + i * span);
      o.frequency.linearRampToValueAtTime(880, t + i * span + span * 0.5);
      o.frequency.linearRampToValueAtTime(660, t + i * span + span);
    }
    const dur = wails * span;
    g.gain.linearRampToValueAtTime(0.05, t + 0.4);
    g.gain.setValueAtTime(0.05, t + dur - 0.5);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.05);
  } catch (e) { /* optional */ }
}

// ============================================================
// WEATHER — scale the wind bed + add a light rain-hiss layer when it rains.
// Driven by the 'world:weather' bus event {kind:'clear'|'rain'|'fog'}; dormant
// and harmless until the host emits it. Headless-safe (all WebAudio behind
// audioReady()). Idempotent: re-applying the same kind is a no-op on the layers.
// ============================================================
function setWeather(kind) {
  _weather = (kind === 'rain' || kind === 'fog') ? kind : 'clear';
  applyWeather(_weather);
}
function applyWeather(kind) {
  try {
    if (!audioReady() || !_amb) return;   // applied later by startAmbient() once the bed exists
    const now = _ac.currentTime;
    // wind picks up in rain, sits a touch heavier in fog, calm when clear
    const windScale = kind === 'rain' ? 2.2 : kind === 'fog' ? 1.4 : 1;
    if (_amb.wind && _amb.wind.gain) {
      _amb.wind.gain.cancelScheduledValues(now);
      _amb.wind.gain.linearRampToValueAtTime(_amb.windBase * windScale, now + 2);
    }
    if (_amb.lfoG && _amb.lfoG.gain) {     // gustier swell in rain
      _amb.lfoG.gain.cancelScheduledValues(now);
      _amb.lfoG.gain.linearRampToValueAtTime(_amb.lfoBase * (kind === 'rain' ? 1.6 : 1), now + 2);
    }
    if (kind === 'rain') startRain(); else stopRain();
  } catch (e) { /* never throw out of an event handler */ }
}
// a soft rain hiss: highpassed looped noise faded in under the bed
function startRain() {
  try {
    if (!audioReady() || !_amb || _amb.rain) return;
    const src = _ac.createBufferSource(); src.buffer = noiseBuffer(); src.loop = true; src.playbackRate.value = 1.0;
    const hp = _ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1600; hp.Q.value = 0.5;
    const lp = _ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 8000;
    const g = _ac.createGain(); g.gain.value = 0.0001;
    g.gain.linearRampToValueAtTime(0.07, _ac.currentTime + 2.5);   // fade the hiss in
    src.connect(hp).connect(lp).connect(g).connect(_ambGain); src.start();
    _amb.rain = { src, gain: g };
  } catch (e) { /* optional */ }
}
function stopRain() {
  try {
    if (!_amb || !_amb.rain) return;
    const r = _amb.rain; _amb.rain = null;
    try { r.gain.gain.linearRampToValueAtTime(0.0001, _ac.currentTime + 1.2); } catch (e) {}
    try { r.src.stop(_ac.currentTime + 1.4); } catch (e) {}
  } catch (e) { /* optional */ }
}

// ============================================================
// RADIO — procedural stations + a lookahead step sequencer
// ============================================================
// Each station: a 16-step pattern over a chord progression. freqs are derived from
// a root MIDI note + scale offsets; drums/bass/lead are synthesised per step.
const SCALE_MIN = [0, 2, 3, 5, 7, 8, 10];      // natural minor
const SCALE_MAJ = [0, 2, 4, 5, 7, 9, 11];      // major
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
function deg(rootMidi, scale, d) {              // scale degree -> frequency
  const oct = Math.floor(d / scale.length), i = ((d % scale.length) + scale.length) % scale.length;
  return midi(rootMidi + scale[i] + 12 * oct);
}
// X = hit, . = rest
const STATIONS = [
  { name: 'RADIO OFF', off: true },
  {
    name: 'NIGHT DRIVE 88.5', bpm: 102, scale: SCALE_MIN, root: 45 /* A2 */,
    prog: [0, 0, 5, 3],                          // chord roots (scale degrees) per bar — one per 4 steps
    bassWave: 'sawtooth', leadWave: 'square', bassG: 0.16, leadG: 0.09,
    bass: 'X..X..X.X..X..X.', lead: 'X.x.X.x.X.x.X.xx',
    kick: 'X...X...X...X...', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.',
  },
  {
    name: 'LO-FI 101', bpm: 78, scale: SCALE_MAJ, root: 48 /* C3 */,
    prog: [0, 3, 4, 3],
    bassWave: 'triangle', leadWave: 'triangle', bassG: 0.14, leadG: 0.07,
    bass: 'X.......X.......', lead: '..X...X...X...X.',
    kick: 'X.......X.....X.', snare: '....X.......X...', hat: 'x..xx..xx..xx..x',
  },
  {
    name: 'PULSE FM', bpm: 124, scale: SCALE_MIN, root: 50 /* D3 */,
    prog: [0, 5, 6, 4],
    bassWave: 'sawtooth', leadWave: 'sawtooth', bassG: 0.15, leadG: 0.08,
    bass: 'X.XX..X.X.XX..X.', lead: 'X.X.XxX.X.X.XxXx',
    kick: 'X...X...X...X...', snare: '....X.......X...', hat: 'xxxxxxxxxxxxxxxx',
  },
];

function envNote(freq, t, dur, type, gain, dest, glideTo) {
  const o = _ac.createOscillator(); o.type = type || 'sawtooth';
  o.frequency.setValueAtTime(freq, t);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), t + dur);
  const g = _ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(dest);
  o.start(t); o.stop(t + dur + 0.02);
}
function drumKick(t, dest) {
  const o = _ac.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  const g = _ac.createGain(); g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
  o.connect(g).connect(dest); o.start(t); o.stop(t + 0.18);
}
function drumSnare(t, dest) {
  const s = _ac.createBufferSource(); s.buffer = noiseBuffer(); s.loop = true;
  const bp = _ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
  const g = _ac.createGain(); g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.25, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
  s.connect(bp).connect(g).connect(dest); s.start(t); s.stop(t + 0.16);
}
function drumHat(t, dest) {
  const s = _ac.createBufferSource(); s.buffer = noiseBuffer(); s.loop = true;
  const hp = _ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
  const g = _ac.createGain(); g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.12, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  s.connect(hp).connect(g).connect(dest); s.start(t); s.stop(t + 0.06);
}

let _bar = 0;
function scheduleStep(st, stepIdx, t) {
  const beat = (60 / st.bpm) / 4;                 // sixteenth-note duration
  const chord = st.prog[(_bar) % st.prog.length]; // current chord root (scale degree)
  if (st.kick[stepIdx] !== '.') drumKick(t, _musicGain);
  if (st.snare[stepIdx] !== '.') drumSnare(t, _musicGain);
  if (st.hat[stepIdx] !== '.') drumHat(t, _musicGain);
  const bc = st.bass[stepIdx];
  if (bc !== '.') {
    const f = deg(st.root, st.scale, chord);
    envNote(f, t, beat * (bc === 'X' ? 1.6 : 0.8), st.bassWave, st.bassG, _musicGain);
  }
  const lc = st.lead[stepIdx];
  if (lc !== '.') {
    // an arpeggio over the chord: root / third / fifth picked by step
    const tone = chord + [0, 2, 4, 4, 2, 0, 2, 4][stepIdx % 8] + 7;   // up an octave
    const f = deg(st.root, st.scale, tone);
    envNote(f, t, beat * (lc === 'X' ? 1.2 : 0.6), st.leadWave, st.leadG, _musicGain);
  }
}
function runScheduler() {
  if (!_ac || _ac.state !== 'running') return;
  const st = STATIONS[_station];
  if (!st || st.off) return;
  if (!_schedSeeded) { _nextNoteT = _ac.currentTime + 0.06; _step = 0; _bar = 0; _schedSeeded = true; }
  // if RAF stalled (tab backgrounded) while the AudioContext kept running, _nextNoteT
  // falls far behind — DROP the backlog instead of replaying hundreds of past-start notes.
  if (_nextNoteT < _ac.currentTime) { _nextNoteT = _ac.currentTime + 0.06; _step = 0; _bar = 0; }
  const beat = (60 / st.bpm) / 4;
  let guard = 0;
  while (_nextNoteT < _ac.currentTime + LOOKAHEAD && guard++ < 64) {
    scheduleStep(st, _step, _nextNoteT);
    _nextNoteT += beat;
    _step = (_step + 1) % 16;
    if (_step % 4 === 0) _bar++;                  // advance the chord every 4 steps (one beat)
  }
}

// ============================================================
// REACTIVE SOUNDSCAPE — engine / tire screech / sirens / music duck
// ------------------------------------------------------------
// Four gameplay-reactive layers, all synthesised (oscillators + noise + filters),
// all headless-safe (every node build is behind audioReady()), all idempotent
// (startX() bails if its sub-module already exists), and all per-frame-cheap
// (updateX() only writes AudioParam targets — no allocation in the hot loop).
// Engine + screech + sirens share _reactGain (under the master → obey mute/vol);
// the duck rides _musicGain.
// ============================================================

// ---- helpers shared by the reactive updaters -------------------------------
// pull the live vehicle speed magnitude (u/s); fields may be undefined → 0.
function vehSpeed(ctx) {
  const v = ctx && ctx.player && ctx.player.vehicle;
  const s = v && v.speed;
  return Number.isFinite(s) ? Math.abs(s) : 0;
}
function vehSlip(ctx) {
  const v = ctx && ctx.player && ctx.player.vehicle;
  const s = v && v.slip;
  return Number.isFinite(s) ? Math.abs(s) : 0;
}

// 1) ENGINE — two detuned saws + a sub through a lowpass; pitch & gain track speed
function startEngine() {
  try {
    if (!audioReady() || _engine) return;
    const now = _ac.currentTime;
    const lp = _ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380; lp.Q.value = 4;
    const gain = _ac.createGain(); gain.gain.value = 0.0001;          // silent until update fades it in
    lp.connect(gain).connect(_reactGain);
    const osc1 = _ac.createOscillator(); osc1.type = 'sawtooth'; osc1.frequency.value = 42; osc1.connect(lp);
    const osc2 = _ac.createOscillator(); osc2.type = 'sawtooth'; osc2.frequency.value = 42; osc2.detune.value = 11; osc2.connect(lp);
    const sub = _ac.createOscillator(); sub.type = 'sine'; sub.frequency.value = 21;       // an octave-down rumble
    const subG = _ac.createGain(); subG.gain.value = 0.5; sub.connect(subG).connect(lp);
    osc1.start(now); osc2.start(now); sub.start(now);
    _engine = { osc1, osc2, sub, subG, lp, gain };
  } catch (e) { /* optional */ }
}
function stopEngine() {
  try {
    if (!_engine) return;
    const e = _engine; _engine = null;
    try { e.gain.gain.cancelScheduledValues(_ac.currentTime); e.gain.gain.setTargetAtTime(0.0001, _ac.currentTime, 0.15); } catch (er) {}
    const stopAt = _ac.currentTime + 0.6;
    try { e.osc1.stop(stopAt); e.osc2.stop(stopAt); e.sub.stop(stopAt); } catch (er) {}
  } catch (e) { /* optional */ }
}
function updateEngine(ctx) {
  try {
    if (!_ac || _ac.state !== 'running') return;
    const inVeh = !!(ctx && ctx.player && ctx.player.inVehicle);
    if (inVeh) {
      if (!_engine) startEngine();
      if (!_engine) return;
      const now = _ac.currentTime;
      const spd = vehSpeed(ctx);                 // ~0..42 u/s
      const norm = Math.min(1, spd / 42);
      // idle rumble at rest → rising pitch with speed (base ~38Hz up to ~150Hz)
      const baseHz = 38 + norm * 112;
      const filtHz = 320 + norm * 1700;          // open the lowpass as it revs
      const lvl = 0.14 + norm * 0.20;            // a touch louder at speed
      _engine.osc1.frequency.setTargetAtTime(baseHz, now, 0.08);
      _engine.osc2.frequency.setTargetAtTime(baseHz, now, 0.08);
      _engine.sub.frequency.setTargetAtTime(baseHz * 0.5, now, 0.08);
      _engine.lp.frequency.setTargetAtTime(filtHz, now, 0.1);
      _engine.gain.gain.setTargetAtTime(lvl, now, 0.12);
    } else if (_engine) {
      stopEngine();                              // fade out + stop when out of the car
    }
  } catch (e) { /* never throw out of the frame loop */ }
}

// 2) TIRE SCREECH — bandpassed looped noise that fades in on high slip
function startScreech() {
  try {
    if (!audioReady() || _screech) return;
    const src = _ac.createBufferSource(); src.buffer = noiseBuffer(); src.loop = true; src.playbackRate.value = 1.4;
    const bp = _ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 6;
    const gain = _ac.createGain(); gain.gain.value = 0.0001;
    src.connect(bp).connect(gain).connect(_reactGain); src.start();
    _screech = { src, bp, gain };
  } catch (e) { /* optional */ }
}
function updateScreech(ctx) {
  try {
    if (!_ac || _ac.state !== 'running') return;
    const inVeh = !!(ctx && ctx.player && ctx.player.inVehicle);
    const slip = inVeh ? vehSlip(ctx) : 0;       // ~0..15; only screech while driving
    if (slip > 5) {
      if (!_screech) startScreech();
      if (!_screech) return;
      const now = _ac.currentTime;
      const t = Math.min(1, (slip - 5) / 8);     // 5..13 maps to 0..1 intensity
      _screech.gain.gain.setTargetAtTime(0.04 + t * 0.18, now, 0.04);
      _screech.bp.frequency.setTargetAtTime(2200 + t * 1400, now, 0.05);
    } else if (_screech) {
      _screech.gain.gain.setTargetAtTime(0.0001, _ac.currentTime, 0.08);   // fade out, keep nodes (idempotent)
    }
  } catch (e) { /* never throw out of the frame loop */ }
}

// 3) SIRENS — a two-tone police wail bed; density/loudness scale with stars
function startSirens() {
  try {
    if (!audioReady() || _sirens) return;
    const lp = _ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; lp.Q.value = 0.6;
    const gain = _ac.createGain(); gain.gain.value = 0.0001;
    lp.connect(gain).connect(_reactGain);
    // two detuned square tones give the classic hi/lo wail body
    const oscHi = _ac.createOscillator(); oscHi.type = 'square'; oscHi.frequency.value = 760; oscHi.connect(lp);
    const oscLo = _ac.createOscillator(); oscLo.type = 'square'; oscLo.frequency.value = 600; oscLo.connect(lp);
    // an LFO sweeps both pitches up/down for the wail motion
    const lfo = _ac.createOscillator(); lfo.type = 'triangle'; lfo.frequency.value = 0.7;
    const lfoG = _ac.createGain(); lfoG.gain.value = 120;
    lfo.connect(lfoG); lfoG.connect(oscHi.frequency); lfoG.connect(oscLo.frequency);
    const now = _ac.currentTime;
    oscHi.start(now); oscLo.start(now); lfo.start(now);
    _sirens = { oscHi, oscLo, lp, gain, lfo, lfoG };
  } catch (e) { /* optional */ }
}
function stopSirens() {
  try {
    if (!_sirens) return;
    const s = _sirens; _sirens = null;
    try { s.gain.gain.cancelScheduledValues(_ac.currentTime); s.gain.gain.setTargetAtTime(0.0001, _ac.currentTime, 0.4); } catch (er) {}
    const stopAt = _ac.currentTime + 1.4;
    try { s.oscHi.stop(stopAt); s.oscLo.stop(stopAt); s.lfo.stop(stopAt); } catch (er) {}
  } catch (e) { /* optional */ }
}
function updateSirens() {
  try {
    if (!_ac || _ac.state !== 'running') return;
    if (_wantedStars >= 2) {
      if (!_sirens) startSirens();
      if (!_sirens) return;
      const now = _ac.currentTime;
      const t = Math.min(1, (_wantedStars - 2) / 3);   // 2..5 stars → 0..1 density
      // kept well UNDER the music: peaks ~0.10 at 5 stars
      _sirens.gain.gain.setTargetAtTime(0.045 + t * 0.055, now, 0.5);
      _sirens.lfo.frequency.setTargetAtTime(0.6 + t * 0.7, now, 0.5);    // more frantic with heat
      _sirens.lfoG.gain.setTargetAtTime(110 + t * 120, now, 0.5);       // wider wail at high stars
    } else if (_sirens) {
      stopSirens();                                // fully out at 0/1 star
    }
  } catch (e) { /* never throw out of the frame loop */ }
}

// 4) MUSIC DUCK — gunfire/explosions bump a decaying heat envelope; while hot we
// pull _musicGain down ~6 dB and smoothly restore (~2s) once combat goes quiet.
const DUCK_DB = 0.5;            // ~ -6 dB target multiplier on the music gain
function bumpCombatHeat(amount) { _duckPending = Math.min(1, _duckPending + amount); }
function updateDuck(dt) {
  try {
    if (!_ac || !_musicGain) return;
    if (_duckPending > 0) { _combatHeat = Math.min(1, _combatHeat + _duckPending); _duckPending = 0; }
    // decay heat toward 0 over ~2s of quiet (frame-rate independent)
    if (_combatHeat > 0) {
      _combatHeat *= Math.exp(-dt / 0.7);
      if (_combatHeat < 0.001) _combatHeat = 0;
    }
    // duck = lerp from full music gain down to DUCK_DB*vol by heat
    const target = _musicVol * (1 - (1 - DUCK_DB) * Math.min(1, _combatHeat));
    _musicGain.gain.setTargetAtTime(target, _ac.currentTime, 0.12);
  } catch (e) { /* never throw out of the frame loop */ }
}
// tear down every reactive layer (used on reset)
function stopReactive() { stopEngine(); stopSirens(); try { if (_screech) { _screech.gain.gain.setTargetAtTime(0.0001, _ac.currentTime, 0.05); } } catch (e) {} _combatHeat = 0; _duckPending = 0; }

// ============================================================
// PUBLIC API
// ============================================================
function stations() { return STATIONS.map((s) => s.name); }
function station() { return { index: _station, name: STATIONS[_station].name }; }
function setStation(i) {
  try {
    if (typeof i !== 'number') return station();
    _station = ((i % STATIONS.length) + STATIONS.length) % STATIONS.length;
    _schedSeeded = false;                          // re-seed the sequencer for the new tempo
    audioReady();
    if (typeof window !== 'undefined' && window.GTA && window.GTA.bus) {
      try { window.GTA.bus.emit('toast', { html: `📻 <b>${STATIONS[_station].name}</b>`, ms: 1600 }); } catch (e) {}
    }
    return station();
  } catch (e) { return station(); }
}
function cycleStation() { return setStation(_station + 1); }
function setMusicVolume(v) { v = Number(v); if (!Number.isFinite(v)) return; _musicVol = Math.max(0, Math.min(1, v)); if (_musicGain) _musicGain.gain.value = _musicVol; }
function setAmbientVolume(v) { v = Number(v); if (!Number.isFinite(v)) return; _ambVol = Math.max(0, Math.min(1, v)); if (_ambGain) _ambGain.gain.value = _ambVol; }
function setMuted(b) { _muted = !!b; if (_master) _master.gain.value = _muted ? 0 : 1; }
function ambient(on) { if (on === false) stopAmbient(); else startAmbient(); }

// ============================================================
// LIFECYCLE (GTA system)
// ============================================================
function init(ctx) {
  try {
    if (_inited) return; _inited = true;   // the bridge's register + install both reach init(); subscribe only once
    _headless = !!(ctx && ctx.headless) || typeof document === 'undefined';
    if (_headless) return;
    // we own the city bed now — silence fx.js's simpler round-1 ambient so they don't stack
    try { if (window.ONFOOT_FX && window.ONFOOT_FX.ambient) window.ONFOOT_FX.ambient(false); } catch (e) {}
    startAmbient();
    // start on a station so there's music once the context resumes (first gesture)
    if (_station === 0) _station = 1;
    // Lane D binds [ / ] and emits audio:station {dir:+1|-1}; also accept audio:mute
    // and the simpler radio:* events (menu button / console).
    const bus = (ctx && ctx.bus) || GTA.bus;
    if (bus && bus.on) {
      bus.on('audio:station', (p) => setStation(_station + ((p && p.dir) || 1)));
      bus.on('audio:mute', (p) => setMuted(!!(p && p.muted)));
      bus.on('radio:next', () => cycleStation());
      bus.on('radio:set', (p) => { if (p && typeof p.index === 'number') setStation(p.index); });
      // atmosphere: a wanted-level spike pulls a distant siren in sooner (tension)
      bus.on('wanted:changed', (p) => {
        try { if (p && p.level > (p.prev || 0) && _ac && _amb) _nextSiren = Math.min(_nextSiren, _ac.currentTime + 2 + Math.random() * 3); } catch (e) {}
      });
      // reactive: track stars for the police siren bed (updateSirens reacts next frame)
      bus.on('wanted:changed', (p) => { try { const lvl = (ctx && ctx.systems && ctx.systems.wanted && ctx.systems.wanted.api && ctx.systems.wanted.api.stars && ctx.systems.wanted.api.stars()); _wantedStars = Number.isFinite(lvl) ? lvl : ((p && p.level) || 0); } catch (e) {} });
      // reactive: combat heat ducks the music — gunfire is a small bump, blasts bigger
      bus.on('crime', (p) => { try { if (p && p.kind === 'gunfire') bumpCombatHeat(0.5); } catch (e) {} });
      bus.on('fx:explosion', () => { try { bumpCombatHeat(1); } catch (e) {} });
      // weather: host (Lane C) emits 'world:weather' {kind:'clear'|'rain'|'fog'};
      // scale the wind bed + fade a light rain hiss in/out. Dormant until emitted.
      bus.on('world:weather', (p) => { try { setWeather(p && p.kind); } catch (e) {} });
    }
  } catch (e) { console.warn('[AUDIO] init failed (non-fatal)', e); }
}
function update(dt, ctx) {
  try {
    if (_headless) return;
    if (!_ac) return;                              // nothing until the first gesture creates+resumes the context
    if (_ac.state === 'suspended') _ac.resume();   // self-heal from a visibility/autoplay re-suspend
    runScheduler();
    if (_amb && _ac.state === 'running' && _ac.currentTime >= _nextSiren) {
      playSiren(_ac.currentTime + 0.1);
      _nextSiren = _ac.currentTime + 20 + Math.random() * 28;
    }
    // reactive soundscape (all guarded; only touch params on built nodes)
    updateEngine(ctx);
    updateScreech(ctx);
    updateSirens();
    updateDuck(dt);
  } catch (e) { /* never throw out of the frame loop */ }
}
function reset(ctx) {
  try {
    _schedSeeded = false; _step = 0; _bar = 0;
    if (_ac) _nextSiren = _ac.currentTime + 12 + Math.random() * 16;
    // drop the reactive layers + heat; they re-arm from the next update/event
    _wantedStars = 0;
    if (_ac) stopReactive();
  } catch (e) { /* optional */ }
}

// ============================================================
// REGISTRATION + EXPORTS
// ============================================================
const audioSystem = {
  name: 'audio',
  init, update, reset,
  api: { cycleStation, setStation, station, stations, setMusicVolume, setAmbientVolume, setMuted, ambient, setWeather, reset },
};
try { GTA.register(audioSystem); } catch (e) { console.warn('[AUDIO] GTA.register failed', e); }
function install(ctx, gta) { try { (gta || GTA).register(audioSystem); } catch (e) {} if (ctx) init(ctx); return audioSystem; }
if (typeof window !== 'undefined') window.ONFOOT_AUDIO = audioSystem.api;

export default audioSystem;
export { audioSystem, install };
export const audio = audioSystem.api;
