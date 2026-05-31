// ============================================================
// gta/fx.js — "juice" layer for the on-foot / GTA mode (Lane B: polish & feel)
// ------------------------------------------------------------
// A self-contained FEEL system: GPU particles (impact sparks, dust puffs, blood
// mist + a ground decal hint, brake/skid dust, muzzle smoke), a trauma-based 3D
// CAMERA SHAKE, a damage VIGNETTE, and a tiny procedural AUDIO engine (per-weapon
// gun reports, footsteps, an ambient city bed, UI clicks, impact thuds). Nothing
// here touches game.js's audio or render3d.js's scene — like the rest of the
// crime layer it only reacts to shared state + GTA.bus events.
//
// INTEGRATION (per Lane D's seam — see wrt-gta-orchestration/REQUESTS.md):
//   * Registers itself as a GTA system on import: GTA.register({name:'fx', ...}).
//     Lane D dynamic-imports this file and GTA inits it live. No index.html / no
//     bridge edits needed; it also exports install(ctx, GTA) as a fallback.
//   * Reads ctx.THREE / ctx.scene / ctx.camera (falls back to ONFOOT.internals).
//   * Reacts to bus events it gets for free — shake, crime{gunfire}, playerHurt,
//     entityKilled, weapon:changed — plus the optional precise-point events Lane A
//     emits: fx:impact / fx:muzzle / fx:explosion / fx:spawn.
//   * Per-frame work happens in update(dt, ctx); it NEVER sets OF.renderHook (that
//     is reserved for the realism composer). Camera shake is applied in update,
//     which the host runs after the camera is placed and before the render hook.
//   * Headless-safe: all DOM / WebGL / WebAudio work is guarded by ctx.headless
//     (and typeof window/document checks), so the node smoke test ticks fx for
//     free without throwing. Every public method is additionally try/caught — a
//     failure here can never brick the base on-foot mode or the driving game.
//
// Imperative API (also on ctx.systems.fx.api and window.ONFOOT_FX):
//   fx.spawnImpact(pos,{kind,normal,scale,audio})  kind: world|metal|flesh|wood
//   fx.spawnBlood(pos,{scale}) · fx.skidDust(pos,{vx,vz}) · fx.muzzleSmoke(pos)
//   fx.shake(amount) · fx.flash({color,intensity}) · fx.gunReport(weaponId)
//   fx.footstep({run}) · fx.ambient(on) · fx.uiClick() · fx.impactThud(kind)
//   fx.setMuted(b) · fx.setVolume(v) · fx.reset()
// ============================================================
import { GTA } from './core.js';

// ---- tunables --------------------------------------------------------------
const SPARK_CAP = 220;        // max live spark points (one additive draw call)
const SMOKE_CAP = 220;        // max live dust/blood/decal points (one alpha draw call)
const SHAKE_MAX = 1.6;        // trauma ceiling
const SHAKE_DECAY = 1.7;      // trauma units shed per second
const SHAKE_POS = 0.22;       // world-units of camera translation at full shake
const SHAKE_ROLL = 0.035;     // radians of camera roll at full shake
const STRIDE = 2.15;          // world-units between footstep sounds while walking
const PGRAV = 16;             // particle gravity (units/s^2)

// surface presets for spawnImpact — colour + behaviour per material hit
const SURFACES = {
  world: { spark: 0xffd27a, sparkN: 7, dust: 0xb9b2a6, dustN: 5, thud: 'world' },
  metal: { spark: 0xfff3c0, sparkN: 12, dust: 0x9aa0a6, dustN: 2, thud: 'metal' },
  wood:  { spark: 0xc79a5b, sparkN: 4, dust: 0x8a6a45, dustN: 6, thud: 'world' },
  flesh: { spark: 0xff5060, sparkN: 0, dust: 0x8e1f24, dustN: 9, thud: 'flesh', blood: true },
};
// slot (1..5) -> weapon id, so weapon:changed without an explicit id still maps
const SLOT_WEAPON = { 1: 'fists', 2: 'pistol', 3: 'ak47', 4: 'smg', 5: 'shotgun' };

// ---- module state ----------------------------------------------------------
let THREE = null;
let _ctx = null, _scene = null, _camera = null;
let _built = false;           // particle systems live in the scene
let _particlesOk = true;      // false if the shader failed → particle spawns no-op
let _headless = false;        // true under the node smoke test (no DOM/WebGL/WebAudio)
let _trauma = 0;              // current camera-shake energy (decays toward 0)
let _curWeapon = 'pistol';    // tracked from weapon:changed, for gun report audio

// two pooled Points systems — sparks (additive) and smoke/dust/blood (alpha)
let _spark = null, _smoke = null;

// footstep pacing
let _lastFoot = null;         // {x,z} player pos at last footstep sample
let _strideAccum = 0;
let _wasGrounded = true;

// damage vignette (DOM; created lazily)
let _vignette = null;

// ---- audio engine ----------------------------------------------------------
let _ac = null;               // AudioContext (lazy)
let _master = null;           // master gain
let _muted = false, _vol = 0.8;
let _noiseBuf = null;         // reusable 1s white-noise buffer
let _ambient = null;          // the running city bed, or null

// ============================================================
// AUDIO
// ============================================================
function audioReady() {
  try {
    if (_headless || typeof window === 'undefined') return false;
    if (!_ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      _ac = new AC();
      _master = _ac.createGain();
      _master.gain.value = _muted ? 0 : _vol;
      _master.connect(_ac.destination);
    }
    if (_ac.state === 'suspended') _ac.resume();   // recover from autoplay/visibility suspension
    return true;
  } catch (e) { return false; }
}
function noiseBuffer() {
  if (_noiseBuf) return _noiseBuf;
  const n = _ac.sampleRate;                 // ~1s of white noise, reused as one-shot sources
  _noiseBuf = _ac.createBuffer(1, n, n);
  const d = _noiseBuf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return _noiseBuf;
}
// a filtered noise burst with an exponential decay envelope
function noiseBurst(t, dur, gain, filterType, freq, q) {
  const src = _ac.createBufferSource(); src.buffer = noiseBuffer();
  src.loop = true; src.playbackRate.value = 0.85 + Math.random() * 0.3;
  const f = _ac.createBiquadFilter(); f.type = filterType || 'bandpass';
  f.frequency.value = freq; if (q != null) f.Q.value = q;
  const g = _ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(_master);
  src.start(t); src.stop(t + dur + 0.02);
}
// a pitch-swept oscillator "thump" (the body of a gunshot / footstep)
function tone(t, type, f0, f1, dur, gain) {
  const o = _ac.createOscillator(); o.type = type || 'sine';
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  const g = _ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(_master);
  o.start(t); o.stop(t + dur + 0.02);
}

// Per-weapon gun report: a layered crack (HF noise) + body (LF thump) + tail,
// tuned so the four guns read distinctly by ear.
const GUN = {
  pistol:  { crackG: 0.45, crackF: 2400, crackD: 0.05, bodyF0: 320, bodyF1: 70, bodyD: 0.10, bodyG: 0.32, tailD: 0.08, tailG: 0.10 },
  ak47:    { crackG: 0.55, crackF: 1600, crackD: 0.07, bodyF0: 260, bodyF1: 52, bodyD: 0.16, bodyG: 0.42, tailD: 0.18, tailG: 0.16 },
  smg:     { crackG: 0.40, crackF: 3000, crackD: 0.035, bodyF0: 360, bodyF1: 95, bodyD: 0.07, bodyG: 0.24, tailD: 0.05, tailG: 0.07 },
  shotgun: { crackG: 0.60, crackF: 1100, crackD: 0.12, bodyF0: 200, bodyF1: 40, bodyD: 0.22, bodyG: 0.52, tailD: 0.26, tailG: 0.22 },
};
function gunReport(weaponId) {
  try {
    if (!audioReady()) return;
    if (weaponId === 'fists') { tone(_ac.currentTime, 'sine', 180, 60, 0.07, 0.18); return; }
    const p = GUN[weaponId] || GUN.pistol;
    const t = _ac.currentTime;
    noiseBurst(t, p.crackD, p.crackG, 'highpass', p.crackF, 0.7);          // sharp crack
    tone(t, 'square', p.bodyF0, p.bodyF1, p.bodyD, p.bodyG);               // chest thump
    noiseBurst(t + 0.005, p.tailD, p.tailG, 'lowpass', 700, 0.4);         // smoky tail
  } catch (e) { /* audio is optional */ }
}

function footstep(opts) {
  try {
    if (!audioReady()) return;
    const t = _ac.currentTime, run = opts && opts.run;
    tone(t, 'sine', run ? 150 : 120, 48, 0.06, run ? 0.10 : 0.06);        // heel thud
    noiseBurst(t, 0.035, run ? 0.05 : 0.03, 'bandpass', 2600, 1.2);       // scuff
  } catch (e) { /* optional */ }
}

function impactThud(kind) {
  try {
    if (!audioReady()) return;
    const t = _ac.currentTime;
    if (kind === 'metal') { noiseBurst(t, 0.05, 0.16, 'bandpass', 4200, 6); tone(t, 'triangle', 1400, 600, 0.05, 0.10); }
    else if (kind === 'flesh') { tone(t, 'sine', 220, 70, 0.09, 0.16); noiseBurst(t, 0.05, 0.06, 'lowpass', 900, 0.6); }
    else { tone(t, 'sine', 160, 55, 0.07, 0.12); noiseBurst(t, 0.04, 0.05, 'lowpass', 1500, 0.5); }   // world/wood
  } catch (e) { /* optional */ }
}

function uiClick() {
  try { if (audioReady()) tone(_ac.currentTime, 'triangle', 880, 660, 0.03, 0.08); }
  catch (e) { /* optional */ }
}

function ambient(on) {
  try {
    if (on === false) {
      if (_ambient) { try { _ambient.gain.gain.value = 0; _ambient.src.stop(); _ambient.hum.stop(); } catch (e) {} _ambient = null; }
      return;
    }
    if (!audioReady() || _ambient) return;
    const src = _ac.createBufferSource(); src.buffer = noiseBuffer(); src.loop = true;
    src.playbackRate.value = 0.18;                          // slow it down → low rumble
    const lp = _ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220; lp.Q.value = 0.2;
    const g = _ac.createGain(); g.gain.value = 0.0001;
    g.gain.linearRampToValueAtTime(0.05, _ac.currentTime + 1.5);   // fade the bed in
    const hum = _ac.createOscillator(); hum.type = 'sine'; hum.frequency.value = 58;   // faint mains hum
    const hg = _ac.createGain(); hg.gain.value = 0.012; hum.connect(hg).connect(_master);
    src.connect(lp).connect(g).connect(_master);
    src.start(); hum.start();
    _ambient = { src, gain: g, hum };
  } catch (e) { /* optional */ }
}

function setMuted(b) { _muted = !!b; if (_master) _master.gain.value = _muted ? 0 : _vol; }
function setVolume(v) { _vol = Math.max(0, Math.min(1, v)); if (_master && !_muted) _master.gain.value = _vol; }

// ============================================================
// PARTICLES — two pooled THREE.Points systems
// ============================================================
function makeSystem(cap, additive) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(cap * 3);
  const col = new Float32Array(cap * 3);
  const psize = new Float32Array(cap);
  const alpha = new Float32Array(cap);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('pcolor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('psize', new THREE.BufferAttribute(psize, 1));
  geo.setAttribute('palpha', new THREE.BufferAttribute(alpha, 1));
  // minimal point shader: per-point distance-attenuated size + per-point alpha,
  // with a soft round falloff. The caller wraps construction in try/catch.
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexShader: `
      attribute vec3 pcolor; attribute float psize; attribute float palpha;
      varying vec3 vCol; varying float vA;
      void main() {
        vCol = pcolor; vA = palpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = psize * (320.0 / max(0.1, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      precision mediump float;
      varying vec3 vCol; varying float vA;
      void main() {
        vec2 d = gl_PointCoord - vec2(0.5);
        float r = dot(d, d);
        float a = smoothstep(0.25, 0.02, r) * vA;
        if (a <= 0.003) discard;
        gl_FragColor = vec4(vCol, a);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;   // positions move wildly; never cull the whole batch
  points.renderOrder = 5;
  return {
    points, geo, mat,
    aPos: geo.attributes.position, aCol: geo.attributes.pcolor,
    aSize: geo.attributes.psize, aAlpha: geo.attributes.palpha,
    vel: new Float32Array(cap * 3),
    life: new Float32Array(cap),
    maxLife: new Float32Array(cap),
    drag: new Float32Array(cap),
    grav: new Float32Array(cap),
    base: new Float32Array(cap),     // base size
    cap, head: 0,
  };
}

function buildParticles() {
  if (_built || !_particlesOk || _headless) return;
  if (!THREE || !_scene) return;
  try {
    _spark = makeSystem(SPARK_CAP, true);
    _smoke = makeSystem(SMOKE_CAP, false);
    _scene.add(_spark.points); _scene.add(_smoke.points);
    _built = true;
  } catch (e) {
    console.warn('[FX] particle shader unavailable; running audio + shake only', e);
    _particlesOk = false; _spark = _smoke = null;
  }
}

// emit one particle into a system (ring-buffer; overwrites the oldest)
function emit(sys, x, y, z, vx, vy, vz, size, life, r, g, b, drag, grav) {
  if (!sys) return;
  const i = sys.head; sys.head = (sys.head + 1) % sys.cap;
  const p3 = i * 3;
  sys.aPos.array[p3] = x; sys.aPos.array[p3 + 1] = y; sys.aPos.array[p3 + 2] = z;
  sys.vel[p3] = vx; sys.vel[p3 + 1] = vy; sys.vel[p3 + 2] = vz;
  sys.aCol.array[p3] = r; sys.aCol.array[p3 + 1] = g; sys.aCol.array[p3 + 2] = b;
  sys.aCol.needsUpdate = true;     // colour only changes on spawn, but it MUST be re-uploaded — each
                                   // BufferAttribute has its own GPU version; flagging pos/size/alpha
                                   // does not re-upload colour (else every point renders zero=black).
  sys.base[i] = size; sys.aSize.array[i] = size; sys.aAlpha.array[i] = 1;
  sys.life[i] = life; sys.maxLife[i] = life; sys.drag[i] = drag; sys.grav[i] = grav;
}

function stepSystem(sys, dt) {
  if (!sys) return;
  const posA = sys.aPos.array, sizeA = sys.aSize.array, alphaA = sys.aAlpha.array;
  for (let i = 0; i < sys.cap; i++) {
    if (sys.life[i] <= 0) { if (alphaA[i] !== 0) { alphaA[i] = 0; sizeA[i] = 0; } continue; }
    sys.life[i] -= dt;
    const p3 = i * 3;
    const dragK = Math.exp(-sys.drag[i] * dt);            // drag + gravity
    sys.vel[p3] *= dragK; sys.vel[p3 + 2] *= dragK;
    sys.vel[p3 + 1] = sys.vel[p3 + 1] * dragK - sys.grav[i] * dt;
    posA[p3] += sys.vel[p3] * dt;
    posA[p3 + 1] += sys.vel[p3 + 1] * dt;
    posA[p3 + 2] += sys.vel[p3 + 2] * dt;
    if (posA[p3 + 1] < 0.02) { posA[p3 + 1] = 0.02; sys.vel[p3 + 1] = 0; sys.vel[p3] *= 0.6; sys.vel[p3 + 2] *= 0.6; }   // settle
    const f = Math.max(0, sys.life[i] / sys.maxLife[i]);   // 1 → 0 over lifetime
    if (sys.life[i] <= 0) { alphaA[i] = 0; sizeA[i] = 0; }
    else { alphaA[i] = f * f; sizeA[i] = sys.base[i] * (0.4 + 0.6 * f); }   // fade + shrink
  }
  sys.aPos.needsUpdate = true; sys.aSize.needsUpdate = true; sys.aAlpha.needsUpdate = true;
}

// ============================================================
// PUBLIC: SPAWNERS  (no-op until particles are built)
// ============================================================
function spawnImpact(pos, opts) {
  try {
    if (!_particlesOk || !_spark || !pos) return;
    opts = opts || {};
    const s = SURFACES[opts.kind] || SURFACES.world;
    const x = pos.x, y = (pos.y != null ? pos.y : 0), z = pos.z;
    if (x == null || z == null) return;
    const scale = opts.scale || 1;
    const nx = opts.normal ? opts.normal.x : 0, ny = opts.normal ? opts.normal.y : 0.6, nz = opts.normal ? opts.normal.z : 0;
    const sc = new THREE.Color(s.spark);
    for (let i = 0; i < s.sparkN * scale; i++) {            // sparks — fast, bright, additive
      const sp = 4 + Math.random() * 7;
      emit(_spark, x, y, z,
        (Math.random() * 2 - 1) * sp + nx * 2, Math.random() * sp * 0.8 + ny * 2, (Math.random() * 2 - 1) * sp + nz * 2,
        0.06 + Math.random() * 0.05, 0.22 + Math.random() * 0.2,
        sc.r, sc.g, sc.b, 1.2, PGRAV);
    }
    const dc = new THREE.Color(s.dust);
    for (let i = 0; i < s.dustN * scale; i++) {             // dust — slow, soft, alpha
      const sp = 0.6 + Math.random() * 1.6;
      emit(_smoke, x, y + 0.05, z,
        (Math.random() * 2 - 1) * sp + nx, Math.random() * 0.8 + 0.3 + ny, (Math.random() * 2 - 1) * sp + nz,
        0.18 + Math.random() * 0.16, 0.4 + Math.random() * 0.35,
        dc.r, dc.g, dc.b, 3.5, 1.5);
    }
    if (s.blood) spawnBlood(pos, { scale });
    if (opts.audio !== false) impactThud(s.thud);
  } catch (e) { /* never throw out of FX */ }
}

function spawnBlood(pos, opts) {
  try {
    if (!_particlesOk || !_smoke || !pos) return;
    opts = opts || {}; const scale = opts.scale || 1;
    const x = pos.x, y = (pos.y != null ? pos.y : 1.0), z = pos.z;
    if (x == null || z == null) return;
    const mist = new THREE.Color(0x9e1418);
    for (let i = 0; i < 8 * scale; i++) {
      const sp = 1.2 + Math.random() * 2.4;
      emit(_smoke, x, y, z,
        (Math.random() * 2 - 1) * sp, Math.random() * 1.6, (Math.random() * 2 - 1) * sp,
        0.1 + Math.random() * 0.12, 0.3 + Math.random() * 0.25,
        mist.r, mist.g, mist.b, 2.0, 7);
    }
    const dc = new THREE.Color(0x4a0a0c);                   // dark flat ground "decal hint"
    for (let i = 0; i < 3; i++) {
      const r = Math.random() * 0.5, a = Math.random() * Math.PI * 2;
      emit(_smoke, x + Math.cos(a) * r, 0.03, z + Math.sin(a) * r,
        0, 0, 0, 0.5 + Math.random() * 0.4, 2.2 + Math.random() * 1.5,
        dc.r, dc.g, dc.b, 6, 0);
    }
  } catch (e) { /* optional */ }
}

function skidDust(pos, opts) {
  try {
    if (!_particlesOk || !_smoke || !pos) return;
    opts = opts || {};
    const x = pos.x, y = (pos.y != null ? pos.y : 0) + 0.06, z = pos.z;
    if (x == null || z == null) return;
    const c = new THREE.Color(0xb6b0a4);
    for (let i = 0; i < 4; i++) {
      const sp = 0.5 + Math.random() * 1.4;
      emit(_smoke, x, y,
        z, (Math.random() * 2 - 1) * sp - (opts.vx || 0) * 0.2, Math.random() * 0.7 + 0.2, (Math.random() * 2 - 1) * sp - (opts.vz || 0) * 0.2,
        0.22 + Math.random() * 0.2, 0.5 + Math.random() * 0.4,
        c.r, c.g, c.b, 2.8, 1.0);
    }
  } catch (e) { /* optional */ }
}

function muzzleSmoke(pos) {
  try {
    if (!_particlesOk || !_smoke || !pos) return;
    if (pos.x == null || pos.z == null) return;
    const c = new THREE.Color(0xcfcabf);
    for (let i = 0; i < 3; i++) {
      emit(_smoke, pos.x, pos.y != null ? pos.y : 1.2, pos.z,
        (Math.random() * 2 - 1) * 0.4, Math.random() * 0.5 + 0.3, (Math.random() * 2 - 1) * 0.4,
        0.08 + Math.random() * 0.08, 0.3 + Math.random() * 0.2,
        c.r, c.g, c.b, 3, 0.4);
    }
  } catch (e) { /* optional */ }
}

// ============================================================
// PUBLIC: CAMERA SHAKE + VIGNETTE
// ============================================================
function shake(amount) { _trauma = Math.min(SHAKE_MAX, _trauma + (amount || 0)); }

function flash(opts) {
  try {
    if (_headless || typeof document === 'undefined') return;
    opts = opts || {};
    if (!_vignette) {
      const frame = document.getElementById('frame') || document.body;
      if (!frame) return;
      _vignette = document.createElement('div');
      _vignette.id = 'gta-fx-vignette';
      _vignette.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:23;opacity:0;';
      frame.appendChild(_vignette);
    }
    const col = opts.color || '190,20,20';
    const inten = opts.intensity != null ? opts.intensity : 0.42;
    _vignette.style.background = `radial-gradient(ellipse at 50% 58%, rgba(${col},0) 40%, rgba(${col},0.7) 100%)`;
    _vignette.style.transition = 'none';
    _vignette.style.opacity = String(inten);
    requestAnimationFrame(() => { if (_vignette) { _vignette.style.transition = 'opacity .5s ease-out'; _vignette.style.opacity = '0'; } });
  } catch (e) { /* optional */ }
}

// apply current trauma as a transient camera offset — called from update() AFTER
// the host has placed the camera this frame and BEFORE the render hook. The host
// re-derives camera.position from its smoothed value next frame, so this never
// accumulates / drifts.
function applyShake(dt) {
  if (!_camera || !_camera.position) return;
  _trauma = Math.max(0, _trauma - SHAKE_DECAY * dt);
  if (_trauma <= 0.0001) return;
  const s = _trauma * _trauma;                       // perceptual curve
  _camera.position.x += (Math.random() * 2 - 1) * SHAKE_POS * s;
  _camera.position.y += (Math.random() * 2 - 1) * SHAKE_POS * s;
  _camera.position.z += (Math.random() * 2 - 1) * SHAKE_POS * s;
  if (_camera.rotation) _camera.rotation.z += (Math.random() * 2 - 1) * SHAKE_ROLL * s;   // transient roll (lookAt resets it next frame)
}

// ============================================================
// LIFECYCLE  (GTA system: init / update / reset)
// ============================================================
function resolveHandles(ctx) {
  const I = (typeof window !== 'undefined' && window.ONFOOT && window.ONFOOT.internals) || null;
  THREE = (ctx && ctx.THREE) || (I && I.THREE) || THREE;
  _scene = (ctx && ctx.scene) || (I && I.scene) || _scene;
  _camera = (ctx && ctx.camera) || (I && I.camera) || _camera;
}

function init(ctx) {
  try {
    _ctx = ctx || _ctx;
    _headless = !!(ctx && ctx.headless) || typeof document === 'undefined';
    resolveHandles(ctx);
    buildParticles();
    subscribe(ctx);
    if (!_headless) ambient(true);   // start the low city bed (resumes on first gesture)
  } catch (e) { console.warn('[FX] init failed (non-fatal)', e); }
}

let _subscribed = false;
function subscribe(ctx) {
  try {
    const bus = (ctx && ctx.bus) || GTA.bus;
    if (!bus || _subscribed) return;
    _subscribed = true;
    // feedback we get for free from combat / police / the bridge
    bus.on('shake', (p) => shake((p && p.amount) || 0));
    bus.on('playerHurt', (p) => { shake(0.25); flash({ intensity: 0.3 + Math.min(0.3, ((p && p.amount) || 0) / 60) }); });
    bus.on('playerRespawn', () => reset(_ctx));
    bus.on('weapon:changed', (p) => {
      if (!p) return;
      const w = p.weapon;
      _curWeapon = (w && (w.id || w.weaponId)) || SLOT_WEAPON[p.slot] || _curWeapon;
    });
    bus.on('crime', (p) => { if (p && p.kind === 'gunfire') gunReport(_curWeapon); });   // per-shot report
    bus.on('entityKilled', (p) => {                                                       // a kill → blood (ped/cop) or sparks (vehicle)
      if (!p || !p.pos) return;
      // peers emit kinds beyond the core catalog (police.js emits kind:'vehicle' for a
      // wrecked cruiser) — whitelist living things for blood; spark other props; never the player.
      if (p.kind === 'ped' || p.kind === 'cop') spawnImpact(p.pos, { kind: 'flesh', audio: false });
      else if (p.kind === 'vehicle') spawnImpact(p.pos, { kind: 'metal', scale: 1.5, audio: false });
    });
    // optional precise-point events Lane A emits where it knows the exact hit
    bus.on('fx:impact', (p) => { if (p && p.pos) spawnImpact(p.pos, { kind: p.kind || 'world', normal: p.normal, scale: p.scale }); });
    bus.on('fx:muzzle', (p) => { if (p && p.pos) muzzleSmoke(p.pos); });
    bus.on('fx:explosion', (p) => { if (p && p.pos) { spawnImpact(p.pos, { kind: 'metal', scale: 3 }); shake(1.0); } });
    bus.on('fx:spawn', (p) => { if (p && p.pos) spawnImpact(p.pos, { kind: p.kind || 'world', scale: p.scale }); });
    bus.on('pickup', () => uiClick());
  } catch (e) { /* optional */ }
}

function update(dt, ctx) {
  try {
    if (ctx) _ctx = ctx;
    if (!dt || dt < 0) dt = 0.016; else if (dt > 0.05) dt = 0.05;
    if (!_built) { resolveHandles(_ctx); buildParticles(); }   // lazy attach if the scene appeared late
    else { _camera = (_ctx && _ctx.camera) || _camera; }       // keep the camera ref fresh
    if (_particlesOk) { stepSystem(_spark, dt); stepSystem(_smoke, dt); }
    autoFootsteps(dt);
    applyShake(dt);
  } catch (e) { /* never throw out of the frame loop */ }
}

// drive footstep audio off the player's actual movement so nobody has to wire it.
function autoFootsteps(dt) {
  try {
    const pl = _ctx && _ctx.player;
    if (!pl || pl.inVehicle || pl.alive === false || !pl.pos) { _lastFoot = null; return; }
    const p = pl.pos;
    const grounded = pl.grounded !== false;
    if (!_lastFoot) { _lastFoot = { x: p.x, z: p.z }; _strideAccum = 0; _wasGrounded = grounded; return; }
    const moved = Math.hypot(p.x - _lastFoot.x, p.z - _lastFoot.z);
    _lastFoot.x = p.x; _lastFoot.z = p.z;
    if (grounded && !_wasGrounded) footstep({ run: true });   // landing thud
    _wasGrounded = grounded;
    if (!grounded) return;
    const keys = _ctx.input && _ctx.input.keys;
    const running = !!(keys && (keys.has('ShiftLeft') || keys.has('ShiftRight')));
    _strideAccum += moved;
    if (_strideAccum >= (running ? STRIDE * 1.25 : STRIDE)) { _strideAccum = 0; footstep({ run: running }); }
  } catch (e) { /* optional */ }
}

function reset(ctx) {
  try {
    if (ctx) _ctx = ctx;
    _trauma = 0; _lastFoot = null; _strideAccum = 0;
    for (const sys of [_spark, _smoke]) {
      if (!sys) continue;
      for (let i = 0; i < sys.cap; i++) { sys.life[i] = 0; sys.aAlpha.array[i] = 0; sys.aSize.array[i] = 0; }
      sys.aAlpha.needsUpdate = true; sys.aSize.needsUpdate = true;
    }
    if (_vignette) _vignette.style.opacity = '0';
  } catch (e) { /* optional */ }
}

// ============================================================
// REGISTRATION + EXPORTS
// ============================================================
const fxSystem = {
  name: 'fx',
  init, update, reset,
  api: {
    spawnImpact, spawnBlood, skidDust, muzzleSmoke,
    shake, flash, gunReport, footstep, ambient, uiClick, impactThud,
    setMuted, setVolume, reset,
  },
};

// register as a GTA system on import (Lane D's preferred seam)
try { GTA.register(fxSystem); } catch (e) { console.warn('[FX] GTA.register failed', e); }

// fallback seam: D may instead call install(ctx, GTA)
function install(ctx, gta) { try { (gta || GTA).register(fxSystem); } catch (e) {} if (ctx) init(ctx); return fxSystem; }

// console / cross-module convenience handle
if (typeof window !== 'undefined') window.ONFOOT_FX = fxSystem.api;

export default fxSystem;
export { fxSystem, install };
export const fx = fxSystem.api;
