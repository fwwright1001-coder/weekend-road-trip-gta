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
let _amb = null;                // { traffic, wind, windLfo, nodes:[...] }
let _nextSiren = 0;             // ac-time of the next distant siren

// radio scheduler (lookahead step sequencer)
let _station = 0;               // index into STATIONS (0 = OFF)
let _step = 0;                  // 0..15 sixteenth-step
let _nextNoteT = 0;             // ac-time the next step should fire
let _schedSeeded = false;
const LOOKAHEAD = 0.16;         // seconds of audio scheduled ahead of the clock

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
    _amb = { nodes };
    _nextSiren = _ac.currentTime + 12 + Math.random() * 16;
  } catch (e) { /* optional */ }
}
function stopAmbient() {
  try {
    if (!_amb) return;
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
  } catch (e) { /* never throw out of the frame loop */ }
}
function reset(ctx) {
  try {
    _schedSeeded = false; _step = 0; _bar = 0;
    if (_ac) _nextSiren = _ac.currentTime + 12 + Math.random() * 16;
  } catch (e) { /* optional */ }
}

// ============================================================
// REGISTRATION + EXPORTS
// ============================================================
const audioSystem = {
  name: 'audio',
  init, update, reset,
  api: { cycleStation, setStation, station, stations, setMusicVolume, setAmbientVolume, setMuted, ambient, reset },
};
try { GTA.register(audioSystem); } catch (e) { console.warn('[AUDIO] GTA.register failed', e); }
function install(ctx, gta) { try { (gta || GTA).register(audioSystem); } catch (e) {} if (ctx) init(ctx); return audioSystem; }
if (typeof window !== 'undefined') window.ONFOOT_AUDIO = audioSystem.api;

export default audioSystem;
export { audioSystem, install };
export const audio = audioSystem.api;
