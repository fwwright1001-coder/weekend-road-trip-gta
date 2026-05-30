/* ============================================================
 * Weekend Road Trip — single-player 2D side-scroller
 * ENGR 5513 Applied AI in Engineering · Lipscomb MSAI · Summer 2026
 * Forrest Wright
 *
 * Drive Marty's convertible from the city to the coast in one tank
 * of gas. Jump potholes, duck under stop signs, grab fuel & snacks.
 * Don't run out of gas before you reach the ocean.
 *
 * Architecture (single-file, no dependencies, no build step):
 *   - Canvas 2D rendering, requestAnimationFrame loop
 *   - State machine: title, playing, paused, gameover, win, initials, scores,
 *     achievements, settings, ghost race, help
 *   - HTML/CSS overlays handle all menus + HUD (crisp typography)
 *   - 5-layer parallax + procedural per-biome scenery
 *   - Obstacle/collectible spawner + AABB collision
 *   - Particle pool (smoke, sparks, dust, pickup bursts)
 *   - Screen shake on impact
 *   - High scores, achievements, settings, and ghost replays persisted to localStorage
 * ============================================================ */

(() => {
  'use strict';

  // ============================================================
  // CONFIG
  // ============================================================
  // --- Logical coordinate space (device-independent) ----------------------
  // VIEW_W/VIEW_H are the single source of truth for the game's coordinate
  // space. ALL gameplay + draw math is authored in this fixed 960x540 space;
  // the canvas backing store is sized separately for the device's pixels (see
  // resizeCanvas) and a setTransform scales logical -> device every frame, so
  // nothing below ever has to know the real pixel resolution.
  const VIEW_W = 960;
  const VIEW_H = 540;
  // Legacy short aliases — kept so existing W/H references stay unchanged.
  const W = VIEW_W;
  const H = VIEW_H;
  const GROUND_Y = 432;      // top of road surface
  const GRAVITY = 0.78;
  const JUMP_V = -16;
  const PLAYER_X = 170;
  const BASE_SPEED = 5;
  const MAX_SPEED = 9.5;
  const SPEED_ACCEL = 0.07;
  const SPEED_BRAKE = 0.16;
  const SPEED_DRAG = 0.018;
  const FUEL_MAX = 100;
  const FUEL_DRAIN_PER_SEC = 1.4;
  const HIT_FUEL_PENALTY = 12;
  const SNACK_POINTS = 50;
  const FUEL_PICKUP_BONUS = 25;
  const FUEL_PICKUP_REFILL = 22;
  const BIOME_BONUS = 500;
  const STORAGE_KEY = 'wrt.highscores.v2';
  const SETTINGS_KEY = 'wrt.settings.v1';
  const ACHIEVEMENTS_KEY = 'wrt.achievements.v1';
  const GHOST_KEY = 'wrt.ghost.v1';
  const MAX_SCORES = 5;
  const GHOST_SAMPLE_STEP = 0.08;
  const GHOST_DISTANCE_SCALE = 0.28;

  // Each biome covers a stretch of the road. Total trip = 20000 units.
  // Lengths are paced so each biome reads as a distinct "leg" of the drive.
  // Each biome has its own palette (sky, sun, ground) and time-of-day.
  //
  // === EXTENSION POINT: BIOMES ===
  // Add a new biome by pushing another object to this array (see CONTRIBUTING.md).
  // You'll also want to add a `case 'YOURNAME':` branch in drawMidScenery()
  // for biome-specific scenery.
  const BIOMES = [
    {
      name: 'CITY',
      end: 5000,
      timeOfDay: 'dawn',
      sky: ['#fbb87d', '#fde4b8', '#9bc3e0'],
      sunColor: '#fff0c0',
      sunY: 130,
      mountainColor: '#5a5670',
      ground: '#3a3a40',
      grass: '#3a5a3a',
      road: '#222226',
      dashColor: '#ffea88',
      spawnMul: 1.0,    // baseline difficulty
      birdColor: '#222222'
    },
    {
      name: 'FOREST',
      end: 10000,
      timeOfDay: 'morning',
      sky: ['#7ec3e8', '#bce0f0', '#e8f4ec'],
      sunColor: '#fff6d8',
      sunY: 95,
      mountainColor: '#3a5a3a',
      ground: '#2d4a2d',
      grass: '#456f3a',
      road: '#222226',
      dashColor: '#ffea88',
      spawnMul: 0.85,   // slightly tighter
      birdColor: '#5a3a1f'  // hawks
    },
    {
      name: 'DESERT',
      end: 15000,
      timeOfDay: 'afternoon',
      sky: ['#f5b27a', '#f9d6a0', '#cce0e8'],
      sunColor: '#ffd680',
      sunY: 110,
      mountainColor: '#a67050',
      ground: '#c69065',
      grass: '#b88a5a',
      road: '#3a3338',
      dashColor: '#ffea88',
      spawnMul: 0.7,    // tougher
      birdColor: '#3a3a3a'  // vultures
    },
    {
      name: 'COAST',
      end: 20000,
      timeOfDay: 'sunset',
      sky: ['#ff7e3a', '#ffb37a', '#ffd9a8'],
      sunColor: '#ffe0a0',
      sunY: 200,
      mountainColor: '#a06a8a',
      ground: '#e8c890',
      grass: '#c8a880',
      road: '#2a2a30',
      dashColor: '#ffea88',
      spawnMul: 0.55,   // final-biome chaos
      birdColor: '#eeeeee'  // seagulls
    }
  ];
  const TRIP_TOTAL = BIOMES[BIOMES.length - 1].end;

  const SCREEN = {
    TITLE: 'title',
    PLAYING: 'playing',
    PAUSED: 'paused',
    GAMEOVER: 'gameover',
    WIN: 'win',
    INITIALS: 'initials',
    SCORES: 'scores',
    ACHIEVEMENTS: 'achievements',
    GHOST: 'ghost',
    SETTINGS: 'settings',
    HELP: 'help'
  };

  const DEFAULT_SETTINGS = {
    screenShake: true,
    colorblind: false,
    ghostVisible: true
  };

  const ACHIEVEMENTS = [
    { id: 'start', title: 'PTO Approved', desc: 'Start a weekend run.' },
    { id: 'first-jump', title: 'Clearance Check', desc: 'Jump over your first hazard.' },
    { id: 'first-hit', title: 'Rental Insurance', desc: 'Survive your first collision.' },
    { id: 'snack', title: 'Roadside Calories', desc: 'Collect a snack pickup.' },
    { id: 'fuel', title: 'Tank Top-Off', desc: 'Collect a fuel can.' },
    { id: 'pitstop', title: 'Full-Service Stop', desc: 'Pull through a pit stop.' },
    { id: 'combo-5', title: 'Perfect Snack Line', desc: 'Build a 5x pickup combo.' },
    { id: 'max-speed', title: 'Cruise Control Hero', desc: 'Reach top speed.' },
    { id: 'low-fuel', title: 'Running on Fumes', desc: 'Keep driving below 15 percent fuel.' },
    { id: 'forest', title: 'Into the Pines', desc: 'Reach the forest biome.' },
    { id: 'desert', title: 'Desert Heat', desc: 'Reach the desert biome.' },
    { id: 'coast', title: 'Coastbound', desc: 'Reach the coast biome.' },
    { id: 'halfway', title: 'Halfway There', desc: 'Drive past the midpoint.' },
    { id: 'score-3000', title: 'Scoreboard Material', desc: 'Score at least 3,000 points.' },
    { id: 'finish', title: 'Ocean View', desc: 'Finish the coast-to-coast trip.' },
    { id: 'clean-finish', title: 'No-Deductible Drive', desc: 'Finish without hitting an obstacle.' },
    { id: 'ghost-save', title: 'Ghost Writer', desc: 'Save a replay ghost from a run.' },
    { id: 'ghost-race', title: 'Race the Replay', desc: 'Start a run with a ghost loaded.' }
  ];

  // ============================================================
  // STATE
  // ============================================================
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  // ============================================================
  // DEVICE-PIXEL-RATIO-AWARE RENDERING
  // ------------------------------------------------------------
  // The canvas keeps its CSS size (driven entirely by styles.css), but its
  // backing store is sized to CSS-pixels * devicePixelRatio so HiDPI / Retina
  // displays and large windows render at native resolution instead of being
  // upscaled (blurry) by the browser. The game itself never leaves the fixed
  // VIEW_W x VIEW_H logical space — applyViewTransform() maps that space onto
  // whatever the real backing store happens to be, once per frame.
  //
  // Why imageSmoothingEnabled is left at its default (true): this game draws
  // only flat-vector shapes, gradients, and text — none of which are affected
  // by the smoothing flag (it only governs drawImage/pattern scaling, of which
  // there are none here). Gradients/backgrounds therefore stay smooth and
  // shapes/text stay crisp purely because setTransform — not CSS — performs the
  // upscale. If photographic background images are ever added, keep smoothing
  // true for those draws and the rest will remain sharp.
  const MAX_DPR = 3;   // clamp: beyond ~3x the extra fill cost buys nothing

  // Size the backing store to the canvas's real on-screen CSS size * DPR.
  // No-ops safely when the canvas is zero-sized (hidden tab / display:none)
  // so we never produce a 0-dimension buffer or a NaN transform.
  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return; // hidden — keep last good size
    const dpr = Math.max(1, Math.min(MAX_DPR, window.devicePixelRatio || 1));
    const targetW = Math.round(rect.width * dpr);
    const targetH = Math.round(rect.height * dpr);
    // Only touch the backing store when it actually changed — assigning
    // canvas.width/height clears the canvas and resets the 2D context state.
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    // CSS size is intentionally NOT set here — styles.css owns it (width/height
    // 100% of the aspect-locked #frame), so the canvas is never CSS-stretched.
  }

  // Re-establish the logical->device transform. Called at the very top of every
  // frame because setTransform replaces the whole matrix and the per-frame
  // save()/translate(shake)/restore() in render() all hang off this base.
  function applyViewTransform() {
    const sx = canvas.width / VIEW_W;
    const sy = canvas.height / VIEW_H;
    if (sx > 0 && sy > 0 && isFinite(sx) && isFinite(sy)) {
      ctx.setTransform(sx, 0, 0, sy, 0, 0);
    }
  }

  // Coalesce bursts of resize/orientation events into a single relayout.
  let resizeRaf = 0;
  let resizeDebounce = 0;
  function scheduleResize() {
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(resizeCanvas);
    }, 100);
  }

  // Fire resizeCanvas when the DPR itself changes (e.g. dragging the window to
  // a monitor with a different scale factor, or OS zoom). A media query bound
  // to the current dppx stops matching the instant DPR changes; we re-arm it
  // after each change since the threshold moves with the new ratio.
  function watchDpr() {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const onChange = () => { resizeCanvas(); watchDpr(); };
    if (mq.addEventListener) {
      mq.addEventListener('change', onChange, { once: true });
    } else if (mq.addListener) { // legacy Safari/old Edge
      const legacy = () => { mq.removeListener(legacy); onChange(); };
      mq.addListener(legacy);
    }
  }

  window.addEventListener('resize', scheduleResize);
  window.addEventListener('orientationchange', scheduleResize);
  window.addEventListener('load', resizeCanvas); // re-measure once layout settles
  resizeCanvas();  // size correctly before the first frame is drawn
  watchDpr();

  const state = {
    screen: SCREEN.TITLE,
    prevScreen: SCREEN.TITLE,
    keys: new Set(),
    pad: {},
    padPrev: {},
    padConnected: false,
    settings: loadSettings(),
    achievements: loadAchievements(),
    achievementToast: null,
    // gameplay
    distance: 0,
    score: 0,
    speed: 0,
    fuel: FUEL_MAX,
    biomeIdx: 0,
    biomeAnnounced: -1,
    obstacles: [],
    collectibles: [],
    particles: [],
    spawnTimer: 0,
    flashTimer: 0,
    shakeT: 0,
    shakeMag: 0,
    // player
    player: {
      y: GROUND_Y,
      vy: 0,
      ducking: false,
      jumping: false,
      tilt: 0,
      wheelAngle: 0,
      bob: 0
    },
    // initials entry
    initials: ['A', 'A', 'A'],
    initialsIdx: 0,
    pendingScore: 0,
    // combo system
    combo: 0,
    comboTimer: 0,
    comboPopupT: 0,
    // floating "+50" texts
    scorePopups: [],
    runTime: 0,
    runStats: { hits: 0, pickups: 0, fuel: 0, snacks: 0, pitstops: 0 },
    // mini-events
    semis: [],
    nextSemiAt: 8,
    nextPitstopAt: 2200,
    // birds
    birds: [],
    nextBirdAt: 3,
    // asynchronous ghost race
    ghostLoaded: loadGhost(),
    ghostRecording: null,
    ghostSampleTimer: 0,
    ghostMessage: '',
    // scores
    scores: []
  };
  const COMBO_WINDOW = 4.0;  // seconds since last pickup before combo resets
  const COMBO_MAX = 5;

  // ============================================================
  // STORAGE
  // ============================================================
  function loadScores() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.slice(0, MAX_SCORES) : [];
    } catch (e) {
      return [];
    }
  }
  function saveScores(scores) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(scores.slice(0, MAX_SCORES)));
    } catch (e) {
      // localStorage unavailable — game still works per session
    }
  }
  function qualifies(score) {
    if (state.scores.length < MAX_SCORES) return true;
    return score > state.scores[state.scores.length - 1].score;
  }
  function insertScore(initials, score) {
    state.scores.push({
      initials: initials.join(''),
      score: Math.floor(score),
      date: new Date().toISOString().slice(0, 10)
    });
    state.scores.sort((a, b) => b.score - a.score);
    state.scores = state.scores.slice(0, MAX_SCORES);
    saveScores(state.scores);
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch (e) {
      return { ...DEFAULT_SETTINGS };
    }
  }
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch (e) {
      // Settings are optional; defaults still work.
    }
  }
  function loadAchievements() {
    try {
      const raw = localStorage.getItem(ACHIEVEMENTS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }
  function saveAchievements() {
    try {
      localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(state.achievements));
    } catch (e) {
      // localStorage unavailable: achievements still unlock for this session.
    }
  }
  function achievementById(id) {
    return ACHIEVEMENTS.find((a) => a.id === id);
  }
  function unlockAchievement(id) {
    if (state.achievements[id]) return;
    const item = achievementById(id);
    if (!item) return;
    state.achievements[id] = new Date().toISOString();
    state.achievementToast = { title: item.title, t: 3.0 };
    saveAchievements();
    if (state.screen === SCREEN.ACHIEVEMENTS) renderAchievementsList();
  }

  function loadGhost() {
    try {
      const raw = localStorage.getItem(GHOST_KEY);
      return raw ? normalizeGhost(JSON.parse(raw)) : null;
    } catch (e) {
      return null;
    }
  }
  function saveGhost(ghost) {
    try {
      localStorage.setItem(GHOST_KEY, JSON.stringify(ghost));
    } catch (e) {
      // Ghost race export still works through the text box if storage is blocked.
    }
  }
  function normalizeGhost(data) {
    if (!data || data.version !== 1 || data.game !== 'Weekend Road Trip') return null;
    if (!Array.isArray(data.frames) || data.frames.length < 2) return null;
    const frames = data.frames
      .filter((f) => Array.isArray(f) && f.length >= 5)
      .map((f) => [
        Number(f[0]) || 0,
        Number(f[1]) || 0,
        Number(f[2]) || GROUND_Y,
        Number(f[3]) || BASE_SPEED,
        Number(f[4]) || 0
      ]);
    if (frames.length < 2) return null;
    return {
      version: 1,
      game: 'Weekend Road Trip',
      created: String(data.created || new Date().toISOString()),
      outcome: data.outcome === 'win' ? 'win' : 'gameover',
      score: Math.floor(Number(data.score) || 0),
      distance: Math.max(0, Number(data.distance) || frames[frames.length - 1][1]),
      duration: Math.max(0, Number(data.duration) || frames[frames.length - 1][0]),
      frames
    };
  }

  // ============================================================
  // AUDIO (Web Audio API — procedural, no assets)
  // ============================================================
  // Engine drone is a continuous oscillator pitched by speed.
  // Pickups, hits, jumps, win/lose are short envelope shapes.
  // Muted state persists across reloads.
  const MUTE_KEY = 'wrt.muted.v1';
  const audio = {
    ctx: null,
    master: null,
    engineOsc: null,
    engineGain: null,
    muted: (() => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } })(),

    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        if (this.ctx.state === 'suspended') this.ctx.resume();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.35;
        this.master.connect(this.ctx.destination);
      } catch (e) { /* no audio available — game still works */ }
    },
    setMuted(m) {
      this.muted = m;
      try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch {}
      if (this.master) this.master.gain.value = m ? 0 : 0.35;
    },
    toggle() {
      this.setMuted(!this.muted);
      showAudioBanner(this.muted ? 'SOUND OFF' : 'SOUND ON');
    },

    // Continuous engine — pitch tied to speed
    startEngine() {
      if (!this.ctx || this.engineOsc) return;
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 90;
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 600;
      const gain = ctx.createGain();
      gain.gain.value = 0.0;
      osc.connect(filt); filt.connect(gain); gain.connect(this.master);
      osc.start();
      this.engineOsc = osc;
      this.engineGain = gain;
      this.engineFilt = filt;
      // ramp in
      gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.4);
    },
    stopEngine() {
      if (!this.engineOsc) return;
      const ctx = this.ctx;
      this.engineGain.gain.cancelScheduledValues(ctx.currentTime);
      this.engineGain.gain.linearRampToValueAtTime(0.0, ctx.currentTime + 0.2);
      const osc = this.engineOsc;
      setTimeout(() => { try { osc.stop(); } catch {} }, 260);
      this.engineOsc = null;
    },
    updateEngine(speedFrac) {
      if (!this.engineOsc) return;
      const f = 80 + speedFrac * 220;
      this.engineOsc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.05);
      this.engineFilt.frequency.setTargetAtTime(500 + speedFrac * 900, this.ctx.currentTime, 0.08);
    },

    // One-shot helpers
    blip({ freq = 600, freq2 = freq, dur = 0.12, type = 'triangle', vol = 0.25 } = {}) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq2), t + dur);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(g); g.connect(this.master);
      osc.start(t); osc.stop(t + dur + 0.02);
    },
    noiseHit(dur = 0.18) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const filt = this.ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 800;
      const g = this.ctx.createGain();
      g.gain.value = 0.4;
      src.connect(filt); filt.connect(g); g.connect(this.master);
      src.start(t);
      // Low thump alongside
      this.blip({ freq: 90, freq2: 50, dur: 0.18, type: 'sine', vol: 0.4 });
    },
    // === EXTENSION POINT: AUDIO ===
    // Add your own sound effects here. Use this.blip({freq, freq2, dur, type, vol})
    // for tone sweeps or this.noiseHit(dur) for noise bursts.
    playJump()   { this.blip({ freq: 480, freq2: 720, dur: 0.10, type: 'sine', vol: 0.16 }); },
    playSnack()  { this.blip({ freq: 880, freq2: 1320, dur: 0.10, type: 'triangle', vol: 0.22 }); },
    playFuel()   { this.blip({ freq: 660, freq2: 990, dur: 0.16, type: 'triangle', vol: 0.25 }); },
    playHit()    { this.noiseHit(); },
    playBiome()  {
      // ascending arpeggio C E G
      [523, 659, 784].forEach((f, i) => setTimeout(() =>
        this.blip({ freq: f, freq2: f, dur: 0.18, type: 'triangle', vol: 0.18 }), i * 80));
    },
    playWin() {
      [523, 659, 784, 1046].forEach((f, i) => setTimeout(() =>
        this.blip({ freq: f, freq2: f, dur: 0.28, type: 'triangle', vol: 0.24 }), i * 140));
    },
    playLose() {
      [392, 330, 277, 220].forEach((f, i) => setTimeout(() =>
        this.blip({ freq: f, freq2: f, dur: 0.26, type: 'sawtooth', vol: 0.22 }), i * 130));
    }
  };
  let audioBanner = { text: '', t: 0 };
  function showAudioBanner(text) { audioBanner = { text, t: 1.3 }; }

  // ============================================================
  // DOM REFS
  // ============================================================
  const hudEl = document.getElementById('hud');
  const overlayEl = document.getElementById('overlay');
  const screenEls = {
    [SCREEN.TITLE]: document.getElementById('screen-title'),
    [SCREEN.PAUSED]: document.getElementById('screen-paused'),
    [SCREEN.GAMEOVER]: document.getElementById('screen-gameover'),
    [SCREEN.WIN]: document.getElementById('screen-win'),
    [SCREEN.INITIALS]: document.getElementById('screen-initials'),
    [SCREEN.SCORES]: document.getElementById('screen-scores'),
    [SCREEN.ACHIEVEMENTS]: document.getElementById('screen-achievements'),
    [SCREEN.GHOST]: document.getElementById('screen-ghost'),
    [SCREEN.SETTINGS]: document.getElementById('screen-settings'),
    [SCREEN.HELP]: document.getElementById('screen-help')
  };
  const hudScore = document.getElementById('hud-score');
  const hudBiome = document.getElementById('hud-biome');
  const hudTrip = document.getElementById('hud-trip');
  const hudMph = document.getElementById('hud-mph');
  const hudFuel = document.getElementById('hud-fuel');
  const ghostTitleStatus = document.getElementById('ghost-title-status');
  const ghostPayloadEl = document.getElementById('ghost-payload');
  const ghostSummaryEl = document.getElementById('ghost-summary');
  const ghostMessageEl = document.getElementById('ghost-message');
  const settingsInputs = document.querySelectorAll('[data-setting]');

  // ============================================================
  // SCREEN MANAGEMENT
  // ============================================================
  function show(target) {
    if (state.screen !== SCREEN.HELP) state.prevScreen = state.screen;
    state.screen = target;
    applyScreen();
  }
  function applyScreen() {
    for (const key in screenEls) screenEls[key].classList.add('hidden');
    if (screenEls[state.screen]) screenEls[state.screen].classList.remove('hidden');
    overlayEl.style.display = state.screen === SCREEN.PLAYING ? 'none' : 'grid';
    hudEl.classList.toggle('hidden',
      state.screen !== SCREEN.PLAYING && state.screen !== SCREEN.PAUSED);
    if (state.screen === SCREEN.SCORES) renderScoresList();
    if (state.screen === SCREEN.ACHIEVEMENTS) renderAchievementsList();
    if (state.screen === SCREEN.GHOST) renderGhostScreen();
    if (state.screen === SCREEN.SETTINGS) renderSettings();
    if (state.screen === SCREEN.INITIALS) renderInitials();
    // Quiet the engine drone whenever we leave active play (e.g. pause).
    if (audio.engineOsc && audio.engineGain && audio.ctx) {
      const target = state.screen === SCREEN.PLAYING ? 0.18 : 0;
      audio.engineGain.gain.setTargetAtTime(target, audio.ctx.currentTime, 0.05);
    }
    updateGhostTitleStatus();
  }
  function openHelp() {
    state.prevScreen = state.screen;
    state.screen = SCREEN.HELP;
    applyScreen();
  }

  // ============================================================
  // INPUT
  // ============================================================
  const KEYMAP = {
    jump: ['Space', 'KeyW', 'ArrowUp'],
    duck: ['KeyS', 'ArrowDown'],
    accel: ['KeyD', 'ArrowRight'],
    brake: ['KeyA', 'ArrowLeft'],
    confirm: ['Enter'],
    pause: ['KeyP', 'Escape'],
    help: ['Slash']
  };
  const isAction = (action, code) => KEYMAP[action] && KEYMAP[action].includes(code);
  const actionDown = (action) =>
    (KEYMAP[action] && KEYMAP[action].some((code) => state.keys.has(code))) || !!state.pad[action];

  window.addEventListener('keydown', (e) => {
    // Don't hijack keys while typing in a form field (e.g. the ghost JSON box).
    const tag = e.target && e.target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT') return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
    state.keys.add(e.code);
    if (e.code === 'KeyM') { audio.init(); audio.toggle(); return; }
    handleKey(e.code);
  });
  window.addEventListener('keyup', (e) => {
    state.keys.delete(e.code);
    if (isAction('duck', e.code)) state.player.ducking = false;
  });

  function handleKey(code) {
    switch (state.screen) {
      case SCREEN.TITLE:
        if (isAction('confirm', code)) startRun();
        else if (code === 'KeyH') show(SCREEN.SCORES);
        else if (code === 'KeyA') show(SCREEN.ACHIEVEMENTS);
        else if (code === 'KeyG') show(SCREEN.GHOST);
        else if (code === 'KeyO') show(SCREEN.SETTINGS);
        else if (isAction('help', code)) openHelp();
        break;
      case SCREEN.PLAYING:
        if (isAction('jump', code)) tryJump();
        if (isAction('duck', code)) state.player.ducking = true;
        if (isAction('pause', code)) show(SCREEN.PAUSED);
        if (isAction('help', code)) openHelp();
        break;
      case SCREEN.PAUSED:
        if (isAction('pause', code) || isAction('confirm', code)) show(SCREEN.PLAYING);
        else if (code === 'KeyQ') { audio.stopEngine(); show(SCREEN.TITLE); }
        break;
      case SCREEN.GAMEOVER:
      case SCREEN.WIN:
        if (isAction('confirm', code)) afterRun();
        break;
      case SCREEN.INITIALS:
        handleInitialsKey(code);
        break;
      case SCREEN.SCORES:
        if (isAction('confirm', code) || code === 'KeyR') show(SCREEN.TITLE);
        break;
      case SCREEN.ACHIEVEMENTS:
      case SCREEN.GHOST:
      case SCREEN.SETTINGS:
        if (isAction('confirm', code) || isAction('pause', code)) {
          show(state.prevScreen === state.screen ? SCREEN.TITLE : state.prevScreen);
        }
        break;
      case SCREEN.HELP:
        if (isAction('help', code) || isAction('confirm', code) || isAction('pause', code)) {
          show(state.prevScreen);
        }
        break;
    }
  }

  function handleInitialsKey(code) {
    if (code === 'ArrowLeft') {
      state.initialsIdx = (state.initialsIdx + 2) % 3;
    } else if (code === 'ArrowRight') {
      state.initialsIdx = (state.initialsIdx + 1) % 3;
    } else if (code === 'ArrowUp') {
      state.initials[state.initialsIdx] = cycleChar(state.initials[state.initialsIdx], +1);
    } else if (code === 'ArrowDown') {
      state.initials[state.initialsIdx] = cycleChar(state.initials[state.initialsIdx], -1);
    } else if (isAction('confirm', code)) {
      insertScore(state.initials, state.pendingScore);
      show(SCREEN.SCORES);
      return;
    } else if (/^Key[A-Z]$/.test(code)) {
      state.initials[state.initialsIdx] = code.slice(3);
      state.initialsIdx = Math.min(2, state.initialsIdx + 1);
    } else if (code === 'Backspace') {
      state.initialsIdx = Math.max(0, state.initialsIdx - 1);
      state.initials[state.initialsIdx] = 'A';
    }
    renderInitials();
  }
  function cycleChar(c, dir) {
    let n = c.charCodeAt(0) + dir;
    if (n > 90) n = 65;
    if (n < 65) n = 90;
    return String.fromCharCode(n);
  }

  function pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = Array.from(pads).find(Boolean);
    if (!gp) {
      state.pad = {};
      state.padPrev = {};
      state.padConnected = false;
      return;
    }

    const b = (idx) => !!(gp.buttons[idx] && gp.buttons[idx].pressed);
    const axisX = gp.axes[0] || 0;
    const axisY = gp.axes[1] || 0;
    const triggerBrake = gp.buttons[6] ? gp.buttons[6].value > 0.2 : false;
    const triggerAccel = gp.buttons[7] ? gp.buttons[7].value > 0.2 : false;
    const next = {
      jump: b(0) || b(12),
      duck: b(1) || b(13) || axisY > 0.45,
      accel: triggerAccel || b(15) || axisX > 0.45,
      brake: triggerBrake || b(14) || axisX < -0.45,
      confirm: b(0),
      pause: b(9),
      help: b(8)
    };

    const prev = state.pad;
    state.padConnected = true;
    ['jump', 'confirm', 'pause', 'help'].forEach((action) => {
      if (next[action] && !prev[action]) handlePadAction(action);
    });
    state.padPrev = prev;
    state.pad = next;
  }

  function handlePadAction(action) {
    switch (state.screen) {
      case SCREEN.TITLE:
        if (action === 'confirm') startRun();
        if (action === 'help') openHelp();
        break;
      case SCREEN.PLAYING:
        if (action === 'jump') tryJump();
        if (action === 'pause') show(SCREEN.PAUSED);
        if (action === 'help') openHelp();
        break;
      case SCREEN.PAUSED:
        if (action === 'confirm' || action === 'pause') show(SCREEN.PLAYING);
        break;
      case SCREEN.GAMEOVER:
      case SCREEN.WIN:
        if (action === 'confirm') afterRun();
        break;
      case SCREEN.SCORES:
      case SCREEN.ACHIEVEMENTS:
      case SCREEN.GHOST:
      case SCREEN.SETTINGS:
      case SCREEN.HELP:
        if (action === 'confirm' || action === 'pause') {
          show(state.prevScreen === state.screen ? SCREEN.TITLE : state.prevScreen);
        }
        break;
    }
  }

  // Button wiring (mouse parity with keyboard)
  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      switch (btn.dataset.action) {
        case 'start': startRun(); break;
        case 'scores': show(SCREEN.SCORES); break;
        case 'achievements': show(SCREEN.ACHIEVEMENTS); break;
        case 'ghost': show(SCREEN.GHOST); break;
        case 'settings': show(SCREEN.SETTINGS); break;
        case 'help': openHelp(); break;
        case 'resume': show(SCREEN.PLAYING); break;
        case 'quit': audio.stopEngine(); show(SCREEN.TITLE); break;
        case 'continue': afterRun(); break;
        case 'copy-ghost': copyGhostPayload(); break;
        case 'load-ghost': loadGhostFromPayload(); break;
        case 'clear-ghost': clearGhostReplay(); break;
        case 'return':
          if ([SCREEN.ACHIEVEMENTS, SCREEN.GHOST, SCREEN.SETTINGS].includes(state.screen)) {
            show(state.prevScreen === state.screen ? SCREEN.TITLE : state.prevScreen);
          } else {
            show(SCREEN.TITLE);
          }
          break;
      }
    });
  });

  settingsInputs.forEach((input) => {
    input.addEventListener('change', () => {
      state.settings[input.dataset.setting] = input.checked;
      saveSettings();
      applySettings();
    });
  });

  // ============================================================
  // RUN LIFECYCLE
  // ============================================================
  function startRun() {
    state.distance = 0;
    state.score = 0;
    state.speed = BASE_SPEED;
    state.fuel = FUEL_MAX;
    state.biomeIdx = 0;
    state._lastBiomeIdx = 0;
    state.biomeAnnounced = -1;
    state.obstacles = [];
    state.collectibles = [];
    state.particles = [];
    state.spawnTimer = 0;
    state.flashTimer = 0;
    state.shakeT = 0;
    state.shakeMag = 0;
    state.pendingScore = 0;
    state.player.y = GROUND_Y;
    state.player.vy = 0;
    state.player.jumping = false;
    state.player.ducking = false;
    state.player.tilt = 0;
    state.player.bob = 0;
    state.combo = 0;
    state.comboTimer = 0;
    state.comboPopupT = 0;
    state.scorePopups = [];
    state.runTime = 0;
    state.runStats = { hits: 0, pickups: 0, fuel: 0, snacks: 0, pitstops: 0 };
    state.semis = [];
    state.nextSemiAt = 8;
    state.nextPitstopAt = 2200;
    state.birds = [];
    state.nextBirdAt = 3;
    state.ghostRecording = makeGhostRecording();
    state.ghostSampleTimer = 0;
    if (state.ghostLoaded) unlockAchievement('ghost-race');
    unlockAchievement('start');
    audio.init();
    audio.startEngine();
    show(SCREEN.PLAYING);
  }

  function afterRun() {
    if (qualifies(state.pendingScore || state.score)) {
      state.pendingScore = state.pendingScore || state.score;
      state.initials = ['A', 'A', 'A'];
      state.initialsIdx = 0;
      show(SCREEN.INITIALS);
    } else {
      show(SCREEN.SCORES);
    }
  }

  function renderScoresList() {
    const ol = document.getElementById('scores-list');
    state.scores = loadScores();
    ol.innerHTML = '';
    if (state.scores.length === 0) {
      ol.innerHTML = '<li class="empty"><span class="empty">NO SCORES YET — HIT THE ROAD.</span></li>';
      return;
    }
    state.scores.forEach((s, i) => {
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="rank">${i + 1}.</span>` +
        `<span class="player-initials">${s.initials}</span>` +
        `<span class="score">${pad(s.score, 6)}</span>` +
        `<span class="date">${s.date}</span>`;
      ol.appendChild(li);
    });
  }
  function renderInitials() {
    const el = document.getElementById('initials-display');
    el.innerHTML = state.initials.map((c, i) =>
      `<span class="${i === state.initialsIdx ? 'initial active' : 'initial'}">${c}</span>`
    ).join('');
    document.getElementById('initials-score').textContent = pad(state.pendingScore, 6);
  }
  function renderAchievementsList() {
    const el = document.getElementById('achievements-list');
    if (!el) return;
    el.innerHTML = '';
    ACHIEVEMENTS.forEach((item) => {
      const card = document.createElement('div');
      const unlocked = !!state.achievements[item.id];
      card.className = unlocked ? 'achievement unlocked' : 'achievement';

      const title = document.createElement('div');
      title.className = 'achievement-title';
      title.textContent = `${unlocked ? 'UNLOCKED' : 'LOCKED'} - ${item.title}`;

      const desc = document.createElement('div');
      desc.className = 'achievement-desc';
      desc.textContent = item.desc;

      card.appendChild(title);
      card.appendChild(desc);
      el.appendChild(card);
    });
  }
  function renderSettings() {
    settingsInputs.forEach((input) => {
      input.checked = !!state.settings[input.dataset.setting];
    });
    applySettings();
  }
  function applySettings() {
    document.body.classList.toggle('colorblind', !!state.settings.colorblind);
  }
  function updateGhostTitleStatus() {
    if (!ghostTitleStatus) return;
    const g = state.ghostLoaded;
    if (!g) {
      ghostTitleStatus.textContent = 'No ghost loaded yet.';
      return;
    }
    const pct = Math.min(100, Math.round((g.distance / TRIP_TOTAL) * 100));
    ghostTitleStatus.textContent =
      `Ghost loaded: ${pct}% trip, ${pad(g.score, 6)} points, ${g.duration.toFixed(1)}s.`;
  }
  function ghostPayload() {
    return state.ghostLoaded ? JSON.stringify(state.ghostLoaded) : '';
  }
  function renderGhostScreen() {
    if (!ghostPayloadEl || !ghostSummaryEl || !ghostMessageEl) return;
    const g = state.ghostLoaded;
    if (g) {
      const pct = Math.min(100, Math.round((g.distance / TRIP_TOTAL) * 100));
      ghostSummaryEl.textContent =
        `Loaded ghost: ${pct}% trip, ${pad(g.score, 6)} points, ${g.duration.toFixed(1)} seconds. Start the trip to race it.`;
      ghostPayloadEl.value = ghostPayload();
    } else {
      ghostSummaryEl.textContent =
        'Finish a run to save a transparent replay car. Paste a classmate\'s ghost JSON here to race their line.';
      if (!ghostPayloadEl.value.trim()) ghostPayloadEl.value = '';
    }
    ghostMessageEl.textContent = state.ghostMessage || '';
  }
  function copyGhostPayload() {
    const payload = ghostPayload();
    if (!payload) {
      state.ghostMessage = 'No ghost saved yet. Finish a run first.';
      renderGhostScreen();
      return;
    }
    ghostPayloadEl.value = payload;
    ghostPayloadEl.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(payload)
        .then(() => {
          state.ghostMessage = 'Ghost JSON copied to clipboard.';
          renderGhostScreen();
        })
        .catch(() => {
          state.ghostMessage = 'Ghost JSON is selected and ready to copy.';
          renderGhostScreen();
        });
    } else {
      state.ghostMessage = 'Ghost JSON is selected and ready to copy.';
      renderGhostScreen();
    }
  }
  function loadGhostFromPayload() {
    try {
      const ghost = normalizeGhost(JSON.parse(ghostPayloadEl.value));
      if (!ghost) throw new Error('Invalid ghost payload');
      state.ghostLoaded = ghost;
      saveGhost(ghost);
      state.ghostMessage = 'Ghost loaded. Start the trip to race it.';
      unlockAchievement('ghost-race');
    } catch (e) {
      state.ghostMessage = 'That ghost JSON could not be loaded.';
    }
    renderGhostScreen();
    updateGhostTitleStatus();
  }
  function clearGhostReplay() {
    try { localStorage.removeItem(GHOST_KEY); } catch (e) {}
    state.ghostLoaded = null;
    if (ghostPayloadEl) ghostPayloadEl.value = '';
    state.ghostMessage = 'Ghost replay cleared.';
    renderGhostScreen();
    updateGhostTitleStatus();
  }
  function makeGhostRecording() {
    return {
      version: 1,
      game: 'Weekend Road Trip',
      created: new Date().toISOString(),
      outcome: 'gameover',
      score: 0,
      distance: 0,
      duration: 0,
      frames: []
    };
  }
  function ghostControlsMask() {
    return (actionDown('jump') ? 1 : 0) |
      (actionDown('duck') ? 2 : 0) |
      (actionDown('accel') ? 4 : 0) |
      (actionDown('brake') ? 8 : 0);
  }
  function recordGhostFrame(force = false) {
    if (!state.ghostRecording) return;
    if (!force && state.ghostSampleTimer > 0) return;
    state.ghostSampleTimer = GHOST_SAMPLE_STEP;
    state.ghostRecording.frames.push([
      Number(state.runTime.toFixed(2)),
      Number(state.distance.toFixed(1)),
      Number(state.player.y.toFixed(1)),
      Number(state.speed.toFixed(2)),
      ghostControlsMask()
    ]);
  }
  function finalizeGhost(outcome) {
    if (!state.ghostRecording || state.ghostRecording.frames.length < 2) return;
    recordGhostFrame(true);
    const ghost = state.ghostRecording;
    ghost.outcome = outcome;
    ghost.score = Math.floor(state.pendingScore || state.score);
    ghost.distance = Number(state.distance.toFixed(1));
    ghost.duration = Number(state.runTime.toFixed(2));
    const old = state.ghostLoaded;
    const isBetter = !old || ghost.distance > old.distance || ghost.score > old.score || outcome === 'win';
    if (isBetter && ghost.distance > 300) {
      state.ghostLoaded = normalizeGhost(ghost);
      saveGhost(state.ghostLoaded);
      state.ghostMessage = 'Latest run saved as your ghost replay.';
      unlockAchievement('ghost-save');
      updateGhostTitleStatus();
    }
  }
  function pad(n, w) {
    const s = String(Math.floor(n));
    return s.length >= w ? s : '0'.repeat(w - s.length) + s;
  }

  // ============================================================
  // PLAYER
  // ============================================================
  function tryJump() {
    if (!state.player.jumping) {
      state.player.vy = JUMP_V;
      state.player.jumping = true;
      spawnDust(PLAYER_X + 30, GROUND_Y + 6, 8);
      audio.playJump();
      unlockAchievement('first-jump');
    }
  }
  function updatePlayer(dt) {
    // Frame-rate-independent vertical physics: scale by 60fps-equivalent steps
    // so hang time is identical on 60Hz and 144Hz displays.
    const f = dt * 60;
    state.player.vy += GRAVITY * f;
    state.player.y += state.player.vy * f;
    if (state.player.y >= GROUND_Y) {
      const wasJumping = state.player.jumping;
      state.player.y = GROUND_Y;
      state.player.vy = 0;
      if (wasJumping) {
        state.player.jumping = false;
        spawnDust(PLAYER_X + 24, GROUND_Y + 6, 14);
      }
    }
    // gentle body wobble — sells the suspension
    state.player.bob = Math.sin(state.distance * 0.05) * (state.speed * 0.12);
    // wheel rotation
    state.player.wheelAngle += state.speed * 0.18 * f;
    // braking/accel tilt
    const wantAccel = actionDown('accel');
    const wantBrake = actionDown('brake');
    const targetTilt = wantAccel ? -0.04 : wantBrake ? 0.06 : 0;
    state.player.tilt += (targetTilt - state.player.tilt) * 0.12;
  }
  function playerBox() {
    const h = state.player.ducking ? 32 : 52;
    const w = 76;
    const y = state.player.y - h + 10;
    return { x: PLAYER_X, y, w, h };
  }

  // ============================================================
  // OBSTACLES & COLLECTIBLES
  // ============================================================
  // === EXTENSION POINT: OBSTACLE TYPES & COLLECTIBLE TYPES ===
  // - Add a new obstacle: pick a type string, add to makeObstacle(), then
  //   draw it in drawObstacles(). Tweak spawn() to spawn it.
  // - Add a new collectible: same pattern via makeCollectible() +
  //   drawCollectibles() + handle the pickup branch in updateWorld().
  // Obstacle types so far: 'pothole', 'cone', 'sign'
  // Collectible types so far: 'fuel', 'snack', 'pitstop'
  function spawn() {
    const r = Math.random();
    if (r < 0.5) {
      const t = ['pothole', 'cone', 'pothole'][Math.floor(Math.random() * 3)];
      state.obstacles.push(makeObstacle(t));
    } else if (r < 0.72) {
      state.obstacles.push(makeObstacle('sign'));
    } else if (r < 0.90) {
      state.collectibles.push(makeCollectible('snack'));
    } else {
      state.collectibles.push(makeCollectible('fuel'));
    }
  }
  function makeObstacle(type) {
    const o = { type, x: W + 60, hit: false };
    if (type === 'pothole') {
      o.w = 64; o.h = 18; o.y = GROUND_Y + 2;
    } else if (type === 'cone') {
      o.w = 24; o.h = 36; o.y = GROUND_Y - o.h + 8;
    } else if (type === 'sign') {
      // Panel sits at standing-driver head height — must duck to pass under.
      // Hitbox = panel only; the visible post below is decorative.
      o.w = 78; o.h = 30; o.y = GROUND_Y - 60;
    }
    return o;
  }
  function makeCollectible(type) {
    return {
      type,
      x: W + 60,
      w: 28,
      h: 28,
      y: Math.random() < 0.4 ? GROUND_Y - 86 : GROUND_Y - 34,
      taken: false,
      bob: Math.random() * Math.PI * 2
    };
  }
  function makePitstop() {
    return {
      type: 'pitstop',
      x: W + 100,
      w: 64,
      h: 56,
      y: GROUND_Y - 56,
      taken: false,
      bob: 0
    };
  }
  function makeSemi() {
    return {
      x: W + 240,
      vx: -(state.speed + 2 + Math.random() * 1.5),
      color: ['#3a6aa8', '#aa3a3a', '#3aa83a', '#d4a040'][Math.floor(Math.random() * 4)]
    };
  }
  function spawnBirdFlock() {
    const fromLeft = Math.random() < 0.5;
    const size = 3 + Math.floor(Math.random() * 4); // 3..6 birds
    const baseY = 60 + Math.random() * 120;
    const speed = 0.6 + Math.random() * 0.8;
    const color = currentBiome().birdColor || '#222';
    const vx = fromLeft ? speed : -speed;
    for (let i = 0; i < size; i++) {
      state.birds.push({
        x: fromLeft ? -20 - i * 18 : W + 20 + i * 18,
        y: baseY + (i % 2 === 0 ? 0 : 6) + Math.random() * 4,
        vx,
        flap: Math.random() * Math.PI * 2,
        color
      });
    }
  }
  function updateBirds(dt) {
    for (const b of state.birds) {
      b.x += b.vx;
      b.flap += dt * 9;
    }
    state.birds = state.birds.filter((b) => b.x > -40 && b.x < W + 40);
  }
  function drawBirds() {
    ctx.save();
    for (const b of state.birds) {
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 1.6;
      const wing = Math.sin(b.flap) * 4 + 5;
      ctx.beginPath();
      ctx.moveTo(b.x - 6, b.y + wing);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(b.x + 6, b.y + wing);
      ctx.stroke();
    }
    ctx.restore();
  }

  function updateWorld(dt) {
    const move = state.speed * dt * 60;

    state.spawnTimer -= dt;
    if (state.spawnTimer <= 0) {
      spawn();
      // Faster spawns as speed climbs + per-biome difficulty multiplier
      const mul = currentBiome().spawnMul || 1;
      state.spawnTimer = Math.max(0.32,
        (0.85 + Math.random() * 0.7 - state.speed * 0.045) * mul);
    }

    // Pit stop spawns at distance milestones
    if (state.distance >= state.nextPitstopAt) {
      state.collectibles.push(makePitstop());
      state.nextPitstopAt += 4000 + Math.random() * 1500;
    }

    // Semi-truck spawns on a timer (faster than player, overtakes)
    state.nextSemiAt -= dt;
    if (state.nextSemiAt <= 0) {
      state.semis.push(makeSemi());
      state.nextSemiAt = 9 + Math.random() * 8;
    }

    // Bird flocks
    state.nextBirdAt -= dt;
    if (state.nextBirdAt <= 0) {
      spawnBirdFlock();
      state.nextBirdAt = 7 + Math.random() * 8;
    }
    updateBirds(dt);

    for (const o of state.obstacles) o.x -= move;
    for (const c of state.collectibles) { c.x -= move; c.bob += dt * 4; }
    for (const s of state.semis) s.x += s.vx;

    state.obstacles = state.obstacles.filter((o) => o.x + o.w > -30);
    state.collectibles = state.collectibles.filter((c) => c.x + c.w > -30);
    state.semis = state.semis.filter((s) => s.x > -340);

    // Collisions
    const pb = playerBox();
    for (const o of state.obstacles) {
      if (o.hit) continue;
      if (rectsOverlap(pb, o)) {
        o.hit = true;
        state.fuel -= HIT_FUEL_PENALTY;
        state.runStats.hits += 1;
        state.flashTimer = 0.3;
        screenShake(10, 0.35);
        spawnSparks(o.x + o.w / 2, o.y + o.h / 2);
        spawnScorePopup(o.x + o.w / 2, o.y - 10, '-' + HIT_FUEL_PENALTY + ' FUEL', '#ff6b3a');
        state.combo = 0; // hit breaks combo
        audio.playHit();
        unlockAchievement('first-hit');
      }
    }
    for (const c of state.collectibles) {
      if (c.taken) continue;
      if (rectsOverlap(pb, c)) {
        c.taken = true;
        // Bump combo
        state.combo = Math.min(COMBO_MAX, state.combo + 1);
        state.comboTimer = COMBO_WINDOW;
        state.comboPopupT = 0.6;
        state.runStats.pickups += 1;
        if (state.combo >= COMBO_MAX) unlockAchievement('combo-5');
        const mult = state.combo;
        if (c.type === 'fuel') {
          state.runStats.fuel += 1;
          const pts = FUEL_PICKUP_BONUS * mult;
          state.fuel = Math.min(FUEL_MAX, state.fuel + FUEL_PICKUP_REFILL);
          state.score += pts;
          spawnPickupBurst(c.x + c.w / 2, c.y + c.h / 2, '#7ee27e');
          spawnScorePopup(c.x + c.w / 2, c.y, `+${pts}` + (mult > 1 ? `  x${mult}` : ''), '#7ee27e');
          audio.playFuel();
          unlockAchievement('fuel');
        } else if (c.type === 'pitstop') {
          // Full refuel + chunky bonus
          state.runStats.pitstops += 1;
          state.fuel = FUEL_MAX;
          const pts = 500 * mult;
          state.score += pts;
          spawnPickupBurst(c.x + c.w / 2, c.y + c.h / 2, '#7ee27e');
          spawnScorePopup(c.x + c.w / 2, c.y, `PIT STOP!  +${pts}`, '#7ee27e');
          audio.playBiome(); // celebratory arpeggio
          unlockAchievement('pitstop');
        } else {
          state.runStats.snacks += 1;
          const pts = SNACK_POINTS * mult;
          state.score += pts;
          spawnPickupBurst(c.x + c.w / 2, c.y + c.h / 2, '#f5d76e');
          spawnScorePopup(c.x + c.w / 2, c.y, `+${pts}` + (mult > 1 ? `  x${mult}` : ''), '#f5d76e');
          audio.playSnack();
          unlockAchievement('snack');
        }
      }
    }
    state.collectibles = state.collectibles.filter((c) => !c.taken);
  }

  // ============================================================
  // SCORE POPUPS + COMBO
  // ============================================================
  function spawnScorePopup(x, y, text, color) {
    state.scorePopups.push({
      x, y, text, color,
      vy: -1.4,
      life: 1.0,
      max: 1.0
    });
  }
  function updateScorePopups(dt) {
    for (const p of state.scorePopups) {
      p.y += p.vy;
      p.vy *= 0.96;
      p.life -= dt;
    }
    state.scorePopups = state.scorePopups.filter((p) => p.life > 0);
  }
  function drawScorePopups() {
    ctx.save();
    ctx.font = 'bold 16px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of state.scorePopups) {
      const a = Math.min(1, p.life * 2);
      ctx.globalAlpha = a;
      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillText(p.text, p.x + 1, p.y + 1);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y);
    }
    ctx.restore();
  }
  function drawComboHud() {
    if (state.combo < 2 || state.screen !== SCREEN.PLAYING) return;
    const t = Math.min(1, state.comboPopupT * 2);
    const scale = 1 + (1 - t) * 0.4;
    const yOff = (1 - t) * -8;
    ctx.save();
    ctx.translate(W / 2, 60 + yOff);
    ctx.scale(scale, scale);
    ctx.font = 'bold 26px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(`COMBO  x${state.combo}`, 1, 1);
    ctx.fillStyle = '#f5d76e';
    ctx.fillText(`COMBO  x${state.combo}`, 0, 0);
    ctx.restore();
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ============================================================
  // PARTICLES
  // ============================================================
  // === EXTENSION POINT: PARTICLES ===
  // Spawn your own particles with state.particles.push({ x, y, vx, vy,
  //   life, max, color, size, gravity }). The render loop fades them
  //   automatically based on life/max.
  function spawnSparks(x, y) {
    for (let i = 0; i < 14; i++) {
      state.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 9,
        vy: (Math.random() - 0.5) * 7 - 3,
        life: 0.55,
        max: 0.55,
        color: Math.random() < 0.5 ? '#ff7048' : '#f5d76e',
        size: 2 + Math.random() * 2,
        gravity: 0.4
      });
    }
  }
  function spawnPickupBurst(x, y, color) {
    for (let i = 0; i < 10; i++) {
      state.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 4,
        vy: -1 - Math.random() * 4,
        life: 0.7,
        max: 0.7,
        color,
        size: 3 + Math.random() * 2,
        gravity: 0.18
      });
    }
  }
  function spawnDust(x, y, count) {
    for (let i = 0; i < count; i++) {
      state.particles.push({
        x: x + (Math.random() - 0.5) * 10,
        y,
        vx: -1 - Math.random() * 2,
        vy: -0.5 - Math.random() * 1.5,
        life: 0.5 + Math.random() * 0.3,
        max: 0.8,
        color: 'rgba(220,210,190,0.7)',
        size: 3 + Math.random() * 3,
        gravity: -0.05 // floats up a touch
      });
    }
  }
  function spawnExhaust(x, y) {
    state.particles.push({
      x, y,
      vx: -2 - Math.random() * 2,
      vy: -0.5 - Math.random() * 0.6,
      life: 0.5,
      max: 0.5,
      color: 'rgba(200,200,210,0.55)',
      size: 4 + Math.random() * 3,
      gravity: -0.04
    });
  }
  function updateParticles(dt) {
    for (const p of state.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.life -= dt;
    }
    state.particles = state.particles.filter((p) => p.life > 0);
  }

  // ============================================================
  // SCREEN SHAKE
  // ============================================================
  function screenShake(mag, duration) {
    if (!state.settings.screenShake) return;
    state.shakeMag = mag;
    state.shakeT = duration;
  }
  function shakeOffset() {
    if (!state.settings.screenShake || state.shakeT <= 0) return { x: 0, y: 0 };
    const t = state.shakeT / 0.35;
    return {
      x: (Math.random() - 0.5) * state.shakeMag * t,
      y: (Math.random() - 0.5) * state.shakeMag * t
    };
  }

  // ============================================================
  // RENDERING — sky / parallax / scenery
  // ============================================================
  function currentBiome() {
    for (let i = 0; i < BIOMES.length; i++) {
      if (state.distance < BIOMES[i].end) {
        state.biomeIdx = i;
        return BIOMES[i];
      }
    }
    state.biomeIdx = BIOMES.length - 1;
    return BIOMES[state.biomeIdx];
  }
  function nextBiome() {
    return BIOMES[Math.min(state.biomeIdx + 1, BIOMES.length - 1)];
  }
  function biomeBlend() {
    // 0 in middle of biome, → 1 in last 200 units (transition zone)
    const b = BIOMES[state.biomeIdx];
    const start = state.biomeIdx === 0 ? 0 : BIOMES[state.biomeIdx - 1].end;
    const trans = 220;
    if (b.end - state.distance < trans) {
      return 1 - (b.end - state.distance) / trans;
    }
    if (state.distance - start < trans) {
      return (state.distance - start) / trans - 1; // negative → previous-biome blend
    }
    return 0;
  }
  function lerpColor(a, b, t) {
    const ah = a.replace('#', '');
    const bh = b.replace('#', '');
    const ar = parseInt(ah.slice(0, 2), 16);
    const ag = parseInt(ah.slice(2, 4), 16);
    const ab = parseInt(ah.slice(4, 6), 16);
    const br = parseInt(bh.slice(0, 2), 16);
    const bg = parseInt(bh.slice(2, 4), 16);
    const bb = parseInt(bh.slice(4, 6), 16);
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bl = Math.round(ab + (bb - ab) * t);
    return `rgb(${r}, ${g}, ${bl})`;
  }
  function blendedBiomeColor(prop) {
    const b = currentBiome();
    const blend = biomeBlend();
    if (blend > 0) {
      const n = nextBiome();
      const ap = Array.isArray(b[prop]) ? b[prop] : [b[prop]];
      const bp = Array.isArray(n[prop]) ? n[prop] : [n[prop]];
      if (ap.length === bp.length) return ap.map((c, i) => lerpColor(c, bp[i], blend));
      return lerpColor(ap[0], bp[0], blend);
    }
    return b[prop];
  }

  function drawSky(biome) {
    const sky = blendedBiomeColor('sky');
    const colors = Array.isArray(sky) ? sky : [sky];
    const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    if (colors.length >= 3) {
      g.addColorStop(0, colors[2]);    // zenith
      g.addColorStop(0.55, colors[1]); // mid
      g.addColorStop(1.0, colors[0]);  // horizon
    } else {
      g.addColorStop(0, colors[0]);
      g.addColorStop(1, colors[0]);
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, GROUND_Y + 30);
  }

  function drawSun(biome) {
    const sunX = W - 160 + Math.sin(state.distance * 0.0002) * 30;
    const sunY = biome.sunY;
    const sunR = biome.timeOfDay === 'sunset' ? 60 : 42;
    // halo — radial fade from warm core to transparent
    const haloG = ctx.createRadialGradient(sunX, sunY, sunR * 0.4, sunX, sunY, sunR * 3);
    haloG.addColorStop(0, hexToRgba(biome.sunColor, 0.65));
    haloG.addColorStop(0.45, hexToRgba(biome.sunColor, 0.18));
    haloG.addColorStop(1, hexToRgba(biome.sunColor, 0));
    ctx.fillStyle = haloG;
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR * 3, 0, Math.PI * 2);
    ctx.fill();
    // disk
    ctx.fillStyle = biome.sunColor;
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
    ctx.fill();
  }
  function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  function gameColor(normal, highContrast) {
    return state.settings.colorblind ? highContrast : normal;
  }

  function drawClouds(biome) {
    // Cloud layer — slow parallax (0.05x)
    const off = state.distance * 0.05;
    ctx.fillStyle = biome.timeOfDay === 'sunset'
      ? 'rgba(255, 200, 160, 0.75)'
      : 'rgba(255, 255, 255, 0.78)';
    const cloudCount = 6;
    for (let i = 0; i < cloudCount; i++) {
      const baseX = (i * 320 + 100 - off) % (W + 400);
      const x = baseX < -200 ? baseX + W + 400 : baseX;
      const y = 50 + ((i * 47) % 80);
      drawCloud(x, y, 60 + (i * 17) % 40);
    }
  }
  function drawCloud(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
    ctx.arc(x + r * 0.5, y + 6, r * 0.42, 0, Math.PI * 2);
    ctx.arc(x - r * 0.5, y + 6, r * 0.42, 0, Math.PI * 2);
    ctx.arc(x - r * 0.2, y - r * 0.25, r * 0.36, 0, Math.PI * 2);
    ctx.arc(x + r * 0.3, y - r * 0.2, r * 0.32, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawFarMountains(biome) {
    // Slow-moving mountain silhouette layer (0.12x parallax)
    const off = state.distance * 0.12;
    const baseY = GROUND_Y - 70;
    ctx.fillStyle = biome.mountainColor;
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    for (let i = 0; i < 8; i++) {
      const x = ((i * 180) - (off % 180)) - 90;
      ctx.lineTo(x, baseY);
      ctx.lineTo(x + 90, baseY - 80 - (i % 3) * 12);
      ctx.lineTo(x + 180, baseY);
    }
    ctx.lineTo(W, GROUND_Y);
    ctx.closePath();
    ctx.fill();
  }

  function drawMidScenery(biome) {
    // Biome-specific mid layer (0.32x parallax)
    const off = state.distance * 0.32;
    switch (biome.name) {
      case 'CITY':  drawCitySkyline(off); break;
      case 'FOREST': drawForestMid(off); break;
      case 'DESERT': drawDesertMid(off); break;
      case 'COAST':  drawCoastMid(off); break;
    }
  }
  function drawCitySkyline(off) {
    const baseY = GROUND_Y;
    for (let i = 0; i < 12; i++) {
      const x = ((i * 120) - (off % 120)) - 60;
      const h = 90 + ((i * 47) % 110);
      ctx.fillStyle = '#2e2e44';
      ctx.fillRect(x, baseY - h, 100, h);
      // antenna
      if (i % 3 === 1) {
        ctx.fillStyle = '#1a1a26';
        ctx.fillRect(x + 48, baseY - h - 12, 4, 12);
      }
      // windows
      ctx.fillStyle = '#f5d76e';
      for (let row = 0; row < Math.floor(h / 20) - 1; row++) {
        for (let col = 0; col < 4; col++) {
          if (((i + row + col) % 3) !== 0) continue;
          ctx.fillRect(x + 12 + col * 22, baseY - h + 12 + row * 20, 10, 10);
        }
      }
    }
  }
  function drawForestMid(off) {
    const baseY = GROUND_Y;
    // Background pine wall
    for (let i = 0; i < 22; i++) {
      const x = ((i * 60) - (off % 60)) - 30;
      const h = 110 + ((i * 37) % 50);
      // trunk
      ctx.fillStyle = '#5a3a1f';
      ctx.fillRect(x + 14, baseY - 28, 6, 28);
      // pine cone
      ctx.fillStyle = '#1f3a1f';
      ctx.beginPath();
      ctx.moveTo(x - 4, baseY - 28);
      ctx.lineTo(x + 17, baseY - 28 - h);
      ctx.lineTo(x + 38, baseY - 28);
      ctx.closePath();
      ctx.fill();
      // secondary tier
      ctx.beginPath();
      ctx.moveTo(x, baseY - 28 - h * 0.4);
      ctx.lineTo(x + 17, baseY - 28 - h * 0.95);
      ctx.lineTo(x + 34, baseY - 28 - h * 0.4);
      ctx.closePath();
      ctx.fill();
    }
  }
  function drawDesertMid(off) {
    const baseY = GROUND_Y;
    // distant mesas
    for (let i = 0; i < 6; i++) {
      const x = ((i * 220) - (off % 220)) - 110;
      const w = 160;
      const h = 80 + (i % 3) * 14;
      ctx.fillStyle = '#8a5530';
      ctx.beginPath();
      ctx.moveTo(x, baseY);
      ctx.lineTo(x + 16, baseY - h);
      ctx.lineTo(x + w - 16, baseY - h);
      ctx.lineTo(x + w, baseY);
      ctx.closePath();
      ctx.fill();
      // top streak
      ctx.fillStyle = '#a96a3a';
      ctx.fillRect(x + 16, baseY - h, w - 32, 6);
    }
    // saguaros
    for (let i = 0; i < 14; i++) {
      const x = ((i * 110) - (off % 110)) - 55;
      const h = 60 + ((i * 41) % 30);
      ctx.fillStyle = '#5a8a3a';
      ctx.fillRect(x + 14, baseY - h, 12, h);
      ctx.fillRect(x + 6, baseY - h + 14, 8, 22);
      ctx.fillRect(x + 26, baseY - h + 22, 8, 18);
    }
  }
  function drawCoastMid(off) {
    const baseY = GROUND_Y;
    // ocean strip
    const oceanG = ctx.createLinearGradient(0, baseY - 60, 0, baseY - 20);
    oceanG.addColorStop(0, '#3a7eb4');
    oceanG.addColorStop(1, '#1f4e7a');
    ctx.fillStyle = oceanG;
    ctx.fillRect(0, baseY - 60, W, 40);
    // sun reflection on water
    ctx.fillStyle = 'rgba(255, 210, 140, 0.55)';
    ctx.fillRect(W - 240, baseY - 50, 80, 6);
    ctx.fillRect(W - 220, baseY - 40, 60, 4);
    // palms
    for (let i = 0; i < 8; i++) {
      const x = ((i * 160) - (off % 160)) - 80;
      const h = 100 + (i % 3) * 18;
      // trunk
      ctx.fillStyle = '#6a4a2a';
      ctx.beginPath();
      ctx.moveTo(x + 22, baseY);
      ctx.quadraticCurveTo(x + 30, baseY - h * 0.5, x + 24, baseY - h);
      ctx.lineTo(x + 28, baseY - h);
      ctx.quadraticCurveTo(x + 36, baseY - h * 0.5, x + 28, baseY);
      ctx.closePath();
      ctx.fill();
      // fronds
      ctx.fillStyle = '#2d7a3a';
      drawPalmFronds(x + 26, baseY - h);
    }
  }
  function drawPalmFronds(cx, cy) {
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2 + 0.2;
      const len = 32;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.quadraticCurveTo(
        cx + Math.cos(ang) * len * 0.5,
        cy + Math.sin(ang) * len * 0.5 - 6,
        cx + Math.cos(ang) * len,
        cy + Math.sin(ang) * len
      );
      ctx.lineWidth = 7;
      ctx.strokeStyle = '#2d7a3a';
      ctx.stroke();
    }
  }

  function drawNearScenery(biome) {
    // Near-ground details — fast parallax (0.7x)
    const off = state.distance * 0.7;
    ctx.fillStyle = biome.grass;
    // Grass tufts
    for (let i = 0; i < 28; i++) {
      const x = ((i * 50) - (off % 50)) - 25;
      const tuftY = GROUND_Y - 4;
      ctx.fillRect(x, tuftY, 3, 4);
      ctx.fillRect(x + 6, tuftY - 1, 3, 5);
      ctx.fillRect(x + 12, tuftY, 3, 4);
    }
    // Biome-specific roadside detail
    if (biome.name === 'CITY') {
      ctx.fillStyle = '#2a2a2e';
      for (let i = 0; i < 6; i++) {
        const x = ((i * 240) - (off % 240)) - 120;
        // streetlight pole + lamp
        ctx.fillRect(x, GROUND_Y - 60, 4, 60);
        ctx.fillRect(x - 12, GROUND_Y - 64, 20, 4);
        ctx.fillStyle = '#f5d76e';
        ctx.fillRect(x - 10, GROUND_Y - 60, 6, 4);
        ctx.fillStyle = '#2a2a2e';
      }
    } else if (biome.name === 'DESERT') {
      // small bushes
      ctx.fillStyle = '#7a8a3a';
      for (let i = 0; i < 12; i++) {
        const x = ((i * 110) - (off % 110)) - 55;
        ctx.beginPath();
        ctx.arc(x, GROUND_Y + 2, 6, 0, Math.PI * 2);
        ctx.arc(x + 8, GROUND_Y + 2, 5, 0, Math.PI * 2);
        ctx.arc(x - 8, GROUND_Y + 2, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawGround(biome) {
    // Grass strip
    ctx.fillStyle = biome.grass;
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
    // Road
    ctx.fillStyle = biome.road;
    ctx.fillRect(0, GROUND_Y + 12, W, 62);
    // Road edge highlight
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, GROUND_Y + 12, W, 2);
    ctx.fillRect(0, GROUND_Y + 72, W, 2);
    // Dashed center line, scrolls with distance
    ctx.fillStyle = biome.dashColor;
    const dashW = 52;
    const gap = 32;
    const cycle = dashW + gap;
    const dashOff = state.distance % cycle;
    for (let x = -dashOff; x < W; x += cycle) {
      ctx.fillRect(x, GROUND_Y + 40, dashW, 5);
    }
    // Subtle vignette on the road shoulder
    const vg = ctx.createLinearGradient(0, GROUND_Y + 12, 0, GROUND_Y + 74);
    vg.addColorStop(0, 'rgba(0,0,0,0.0)');
    vg.addColorStop(0.5, 'rgba(0,0,0,0.0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, GROUND_Y + 12, W, 62);
  }

  // ============================================================
  // RENDERING — entities
  // ============================================================
  function currentGhostFrame() {
    const g = state.ghostLoaded;
    if (!g || !state.settings.ghostVisible || state.screen !== SCREEN.PLAYING) return null;
    const frames = g.frames;
    if (!frames || frames.length < 2) return null;
    const t = state.runTime;
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (frames[mid][0] < t) lo = mid + 1;
      else hi = mid;
    }
    const b = frames[Math.min(lo, frames.length - 1)];
    const a = frames[Math.max(0, lo - 1)];
    const span = Math.max(0.001, b[0] - a[0]);
    const mix = Math.max(0, Math.min(1, (t - a[0]) / span));
    return [
      a[0] + (b[0] - a[0]) * mix,
      a[1] + (b[1] - a[1]) * mix,
      a[2] + (b[2] - a[2]) * mix,
      a[3] + (b[3] - a[3]) * mix,
      mix < 0.5 ? a[4] : b[4]
    ];
  }

  function drawGhostPlayer() {
    const frame = currentGhostFrame();
    if (!frame) return;
    const ghostDistance = frame[1];
    const diff = ghostDistance - state.distance;
    const x = PLAYER_X + diff * GHOST_DISTANCE_SCALE;
    if (x < -90 || x > W + 90) {
      drawGhostArrow(diff);
      return;
    }

    const y = frame[2];
    const ducking = !!(frame[4] & 2);
    const h = ducking ? 34 : 52;
    const w = 78;
    const top = y - h + 10;

    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.setLineDash([6, 5]);
    ctx.fillStyle = gameColor('#9be7ff', '#f0e442');
    ctx.strokeStyle = gameColor('#ffffff', '#0072b2');
    ctx.lineWidth = 2;
    roundRect(ctx, x + 4, top + 12, w - 8, h - 14, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = gameColor('#d8f7ff', '#fff7a8');
    ctx.fillRect(x + 18, top + 3, 34, 12);
    ctx.beginPath();
    ctx.arc(x + 18, top + h - 2, 9, 0, Math.PI * 2);
    ctx.arc(x + w - 18, top + h - 2, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.82;
    ctx.font = 'bold 10px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('GHOST', x + w / 2, top - 3);
    ctx.restore();
  }

  function drawGhostArrow(diff) {
    if (!state.settings.ghostVisible) return;
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = gameColor('#9be7ff', '#f0e442');
    ctx.font = 'bold 12px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = diff > 0 ? 'right' : 'left';
    ctx.textBaseline = 'middle';
    const label = `GHOST ${diff > 0 ? '+' : ''}${Math.round(diff)}`;
    ctx.fillText(label, diff > 0 ? W - 18 : 18, 96);
    ctx.restore();
  }

  function drawPlayer() {
    const { y, ducking, jumping, tilt, wheelAngle, bob } = state.player;
    const w = 80;
    const h = ducking ? 36 : 56;
    const x = PLAYER_X;
    const cy = y - h / 2 + 8 + bob;

    // Shadow (scaled with jump height)
    ctx.save();
    const shadowScale = jumping ? 0.55 + Math.min(1, (GROUND_Y - y) / 80) * 0.45 : 1;
    ctx.fillStyle = `rgba(0,0,0,${0.35 * shadowScale})`;
    ctx.beginPath();
    ctx.ellipse(x + w / 2, GROUND_Y + 18, (w / 2) * shadowScale, 7 * shadowScale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(x + w / 2, cy);
    ctx.rotate(tilt);
    ctx.translate(-(x + w / 2), -cy);

    const top = cy - h / 2;
    // Car body (red convertible)
    ctx.fillStyle = '#c81e28';
    roundRect(ctx, x + 4, top + 12, w - 8, h - 14, 6);
    ctx.fill();
    // Hood gradient highlight
    const bodyG = ctx.createLinearGradient(x, top, x, top + h);
    bodyG.addColorStop(0, 'rgba(255,255,255,0.25)');
    bodyG.addColorStop(0.4, 'rgba(255,255,255,0)');
    ctx.fillStyle = bodyG;
    roundRect(ctx, x + 4, top + 12, w - 8, h - 14, 6);
    ctx.fill();
    // White stripe accent
    ctx.fillStyle = '#fff';
    ctx.fillRect(x + 12, top + 24, w - 24, 4);
    // Windshield
    ctx.fillStyle = '#9cd0f0';
    roundRect(ctx, x + 18, top + 2, 34, 14, 3);
    ctx.fill();
    // Windshield frame
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Driver (head + visible torso)
    if (!ducking) {
      ctx.fillStyle = '#f4c891';
      ctx.beginPath();
      ctx.arc(x + 36, top + 8, 5, 0, Math.PI * 2);
      ctx.fill();
      // Sunglasses
      ctx.fillStyle = '#111';
      ctx.fillRect(x + 32, top + 6, 9, 2);
    } else {
      // ducked driver — just hair
      ctx.fillStyle = '#3a2a1a';
      ctx.fillRect(x + 32, top + 12, 12, 4);
    }
    // Headlights
    ctx.fillStyle = '#fff8a8';
    ctx.fillRect(x + w - 8, top + 22, 6, 6);
    ctx.fillStyle = 'rgba(255,248,168,0.25)';
    ctx.fillRect(x + w - 4, top + 24, 18, 3);
    // Door line
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 44, top + 14);
    ctx.lineTo(x + 44, top + h - 4);
    ctx.stroke();

    // Wheels (with rotation indicator)
    const wheelY = top + h - 2;
    drawWheel(x + 18, wheelY, wheelAngle);
    drawWheel(x + w - 18, wheelY, wheelAngle);

    ctx.restore();
  }
  function drawWheel(cx, cy, angle) {
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(cx, cy, 10, 0, Math.PI * 2);
    ctx.fill();
    // Rim
    ctx.fillStyle = '#999';
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    // Spoke indicator (shows rotation)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.fillStyle = '#666';
    ctx.fillRect(-1, -8, 2, 16);
    ctx.fillRect(-8, -1, 16, 2);
    ctx.restore();
  }

  function drawObstacles() {
    for (const o of state.obstacles) {
      if (o.type === 'pothole') {
        // Pothole shadow ring
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.beginPath();
        ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2 + 2, o.w / 2 + 2, o.h / 2 + 2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#0a0a0e';
        ctx.beginPath();
        ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, o.w / 2, o.h / 2, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (o.type === 'cone') {
        // Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath();
        ctx.ellipse(o.x + o.w / 2, o.y + o.h, o.w / 2 + 3, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        // Cone body
        ctx.fillStyle = '#e85a1a';
        ctx.beginPath();
        ctx.moveTo(o.x + o.w / 2, o.y);
        ctx.lineTo(o.x + o.w + 4, o.y + o.h);
        ctx.lineTo(o.x - 4, o.y + o.h);
        ctx.closePath();
        ctx.fill();
        // White stripes
        ctx.fillStyle = '#fff';
        ctx.fillRect(o.x - 2, o.y + o.h - 14, o.w + 4, 4);
        ctx.fillRect(o.x + 2, o.y + o.h - 22, o.w - 4, 3);
      } else if (o.type === 'sign') {
        // Vertical post (decorative — extends from panel bottom to the ground)
        ctx.fillStyle = '#6a6a70';
        ctx.fillRect(o.x + o.w / 2 - 2, o.y + o.h, 4, GROUND_Y - (o.y + o.h));
        // Sign panel — hitbox-aligned (o.x..o.x+o.w, o.y..o.y+o.h)
        ctx.fillStyle = '#d63a3a';
        roundRect(ctx, o.x, o.y, o.w, o.h, 4);
        ctx.fill();
        // White inner border
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        roundRect(ctx, o.x + 3, o.y + 3, o.w - 6, o.h - 6, 3);
        ctx.stroke();
        // STOP text
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 16px "JetBrains Mono", Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('STOP', o.x + o.w / 2, o.y + o.h / 2);
      }
    }
  }
  function drawCollectibles() {
    for (const c of state.collectibles) {
      if (c.type === 'pitstop') {
        drawPitstop(c);
        continue;
      }
      const float = Math.sin(c.bob) * 4;
      const y = c.y + float;
      if (c.type === 'fuel') {
        const fuelGlow = gameColor('rgba(126, 226, 126, 0.35)', 'rgba(0, 114, 178, 0.38)');
        const fuelBody = gameColor('#2a7a2a', '#005f8f');
        const fuelStroke = gameColor('#7ee27e', '#56b4e9');
        // Glow
        ctx.fillStyle = fuelGlow;
        ctx.beginPath();
        ctx.arc(c.x + c.w / 2, y + c.h / 2, c.w * 0.7, 0, Math.PI * 2);
        ctx.fill();
        // Can
        ctx.fillStyle = fuelBody;
        roundRect(ctx, c.x, y, c.w, c.h, 3);
        ctx.fill();
        ctx.strokeStyle = fuelStroke;
        ctx.lineWidth = 2;
        ctx.stroke();
        // F letter
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 16px "JetBrains Mono", Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('F', c.x + c.w / 2, y + c.h / 2);
      } else {
        // Snack — yellow coin
        const snackGlow = gameColor('rgba(245, 215, 110, 0.4)', 'rgba(255, 210, 63, 0.42)');
        const snackBody = gameColor('#f5d76e', '#ffd23f');
        const snackStroke = gameColor('#a86a1a', '#7a4b00');
        ctx.fillStyle = snackGlow;
        ctx.beginPath();
        ctx.arc(c.x + c.w / 2, y + c.h / 2, c.w * 0.65, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = snackBody;
        ctx.beginPath();
        ctx.arc(c.x + c.w / 2, y + c.h / 2, c.w / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = snackStroke;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = snackStroke;
        ctx.font = 'bold 16px "JetBrains Mono", Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('$', c.x + c.w / 2, y + c.h / 2);
      }
    }
  }
  function drawPitstop(c) {
    // A red-and-white awning over a fuel pump
    const x = c.x, y = c.y;
    // Glow
    ctx.fillStyle = 'rgba(126, 226, 126, 0.35)';
    ctx.beginPath();
    ctx.arc(x + c.w / 2, y + c.h / 2 + 8, c.w * 0.7, 0, Math.PI * 2);
    ctx.fill();
    // Posts
    ctx.fillStyle = '#7a6a55';
    ctx.fillRect(x + 4, y + 18, 4, c.h - 18);
    ctx.fillRect(x + c.w - 8, y + 18, 4, c.h - 18);
    // Awning (red+white stripes)
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#d63a3a' : '#fafafa';
      ctx.fillRect(x + i * (c.w / 6), y, c.w / 6 + 1, 14);
    }
    // Awning trim
    ctx.fillStyle = '#3a3a40';
    ctx.fillRect(x, y + 14, c.w, 4);
    // Pump body
    ctx.fillStyle = '#3a7a3a';
    roundRect(ctx, x + c.w / 2 - 12, y + 24, 24, c.h - 24, 3);
    ctx.fill();
    // Pump face
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(x + c.w / 2 - 8, y + 28, 16, 10);
    // "$" sign
    ctx.fillStyle = '#3a7a3a';
    ctx.font = 'bold 11px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$$', x + c.w / 2, y + 33);
    // Label
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px "JetBrains Mono", Consolas, monospace';
    ctx.fillText('PIT STOP', x + c.w / 2, y + 50);
  }

  function drawSemis() {
    for (const s of state.semis) {
      // Trailer
      ctx.fillStyle = s.color;
      roundRect(ctx, s.x, GROUND_Y - 64, 180, 56, 4);
      ctx.fill();
      // Trailer logo stripe
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(s.x + 16, GROUND_Y - 44, 148, 4);
      // Cab
      ctx.fillStyle = '#dadada';
      roundRect(ctx, s.x + 180, GROUND_Y - 52, 56, 44, 5);
      ctx.fill();
      // Cab windshield
      ctx.fillStyle = '#9cd0f0';
      ctx.fillRect(s.x + 198, GROUND_Y - 46, 28, 14);
      // Headlight (we're facing -X so it's on the left side)
      ctx.fillStyle = '#fff8a8';
      ctx.fillRect(s.x + 234, GROUND_Y - 30, 4, 6);
      // Wheels — three under trailer, one under cab
      const wheelY = GROUND_Y - 4;
      [s.x + 24, s.x + 96, s.x + 168, s.x + 220].forEach((wx) => {
        ctx.fillStyle = '#111';
        ctx.beginPath();
        ctx.arc(wx, wheelY, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#888';
        ctx.beginPath();
        ctx.arc(wx, wheelY, 3, 0, Math.PI * 2);
        ctx.fill();
      });
      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(s.x + 4, GROUND_Y + 10, 232, 4);
    }
  }

  function drawParticles() {
    for (const p of state.particles) {
      const a = Math.max(0, p.life / p.max);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  // ============================================================
  // RENDERING — overlays drawn on canvas
  // ============================================================
  function drawDamageFlash() {
    if (state.flashTimer <= 0) return;
    ctx.fillStyle = `rgba(232, 90, 26, ${state.flashTimer * 1.4})`;
    ctx.fillRect(0, 0, W, H);
  }
  function drawSpeedLines() {
    // Only at higher speeds; intensity scales with how fast above base
    const frac = (state.speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED);
    if (frac < 0.55) return;
    const intensity = (frac - 0.55) / 0.45; // 0..1
    const count = Math.floor(4 + intensity * 14);
    ctx.save();
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.15 + intensity * 0.35})`;
    ctx.lineWidth = 1.2;
    for (let i = 0; i < count; i++) {
      // pseudo-random but stable per-frame seed by state.distance for some flicker
      const seed = (i * 9301 + Math.floor(state.distance * 1.4)) % 233280;
      const r = (seed / 233280);
      const y = 100 + r * (GROUND_Y - 120);
      const len = 40 + r * 80 + intensity * 60;
      const x = (Math.floor(state.distance * 4) + i * 71) % (W + 200) - 100;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y);
      ctx.stroke();
    }
    ctx.restore();
  }
  function drawSpeedVignette() {
    const frac = (state.speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED);
    if (frac < 0.7) return;
    const intensity = (frac - 0.7) / 0.3;
    const g = ctx.createRadialGradient(W / 2, H / 2, 200, W / 2, H / 2, 540);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${0.18 * intensity})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  function drawBiomeBanner() {
    // Show biome name briefly when entering a new biome
    const b = currentBiome();
    if (state.biomeAnnounced !== state.biomeIdx) {
      state.biomeAnnounced = state.biomeIdx;
      state.bannerT = 2.2;
      state.bannerText = b.name;
    }
    if (state.bannerT > 0) {
      const a = Math.min(1, state.bannerT * 1.5);
      const leg = state.biomeIdx + 1;
      const total = BIOMES.length;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.fillStyle = 'rgba(12, 14, 24, 0.78)';
      const bw = 300, bh = 70;
      const bx = (W - bw) / 2, by = 96;
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = '#f5d76e';
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#9fb6ff';
      ctx.font = 'bold 13px "JetBrains Mono", Consolas, monospace';
      ctx.fillText(`LEG ${leg} OF ${total}`, W / 2, by + 22);
      ctx.fillStyle = '#f5d76e';
      ctx.font = 'bold 24px "JetBrains Mono", Consolas, monospace';
      ctx.fillText(`▸  ${state.bannerText}  ◂`, W / 2, by + 47);
      ctx.restore();
    }
  }

  // Checkered race gate that scrolls in during the final stretch of the coast.
  function drawFinishLine() {
    const ahead = TRIP_TOTAL - state.distance;
    if (ahead > W - PLAYER_X + 60 || ahead < -140) return;
    const x = PLAYER_X + ahead;
    const top = GROUND_Y - 150;
    const gateW = 76;
    const sq = 13;
    ctx.save();
    // checkered banner across the top of the gate
    const cols = Math.ceil(gateW / sq);
    for (let i = 0; i < cols; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#fafafa' : '#15151c';
      ctx.fillRect(x + i * sq, top, sq, 26);
    }
    ctx.strokeStyle = '#15151c';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, top, gateW, 26);
    // posts
    ctx.fillStyle = '#dcdce2';
    ctx.fillRect(x - 6, top, 6, GROUND_Y - top);
    ctx.fillRect(x + gateW, top, 6, GROUND_Y - top);
    // label
    ctx.fillStyle = '#15151c';
    ctx.font = 'bold 12px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FINISH', x + gateW / 2, top + 13);
    // checkered strip painted across the road
    for (let row = 0; row < 4; row++) {
      for (let i = 0; i < cols + 1; i++) {
        ctx.fillStyle = (i + row) % 2 === 0 ? '#fafafa' : '#15151c';
        ctx.fillRect(x - 6 + i * sq, GROUND_Y + row * 6, sq, 6);
      }
    }
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }

  // ============================================================
  // HUD
  // ============================================================
  function updateHUD() {
    const b = currentBiome();
    hudScore.textContent = pad(state.score, 6);
    hudBiome.textContent = `${b.name} ${state.biomeIdx + 1}/${BIOMES.length}`;
    hudMph.textContent = String(Math.round(state.speed * 12));
    const fuelFrac = Math.max(0, state.fuel) / FUEL_MAX;
    hudFuel.style.width = `${fuelFrac * 100}%`;
    hudFuel.classList.toggle('low', fuelFrac < 0.25);
    hudFuel.classList.toggle('mid', fuelFrac >= 0.25 && fuelFrac < 0.5);
    hudTrip.style.width = `${Math.min(100, (state.distance / TRIP_TOTAL) * 100)}%`;
  }

  function checkProgressAchievements() {
    if (state.speed >= MAX_SPEED - 0.05) unlockAchievement('max-speed');
    if (state.fuel > 0 && state.fuel <= 15) unlockAchievement('low-fuel');
    if (state.distance >= TRIP_TOTAL * 0.5) unlockAchievement('halfway');
    if (state.score >= 3000) unlockAchievement('score-3000');
  }

  // ============================================================
  // GAMEPLAY UPDATE
  // ============================================================
  let lastFrame = 0;
  let exhaustTimer = 0;

  function updateGame(dt) {
    // Speed input
    state.player.ducking = actionDown('duck');
    const wantAccel = actionDown('accel');
    const wantBrake = actionDown('brake');
    if (wantAccel) state.speed = Math.min(MAX_SPEED, state.speed + SPEED_ACCEL);
    else if (wantBrake) state.speed = Math.max(BASE_SPEED * 0.5, state.speed - SPEED_BRAKE);
    else {
      // drift toward base speed
      if (state.speed > BASE_SPEED) state.speed -= SPEED_DRAG;
      else if (state.speed < BASE_SPEED) state.speed += SPEED_DRAG;
    }

    updatePlayer(dt);
    updateWorld(dt);
    updateParticles(dt);
    updateScorePopups(dt);

    state.distance += state.speed * dt * 60;
    state.score += state.speed * dt * 8;        // small distance score
    state.fuel -= FUEL_DRAIN_PER_SEC * dt;
    state.runTime += dt;
    state.ghostSampleTimer -= dt;
    recordGhostFrame();
    state.flashTimer = Math.max(0, state.flashTimer - dt);
    state.shakeT = Math.max(0, state.shakeT - dt);
    state.bannerT = Math.max(0, (state.bannerT || 0) - dt);
    state.comboPopupT = Math.max(0, state.comboPopupT - dt);
    // Combo decay window
    if (state.combo > 0) {
      state.comboTimer -= dt;
      if (state.comboTimer <= 0) state.combo = 0;
    }

    // Biome clear bonus
    const b = currentBiome();
    if (state.biomeIdx > state._lastBiomeIdx) {
      state.score += BIOME_BONUS;
      state._lastBiomeIdx = state.biomeIdx;
      audio.playBiome();
      if (b.name === 'FOREST') unlockAchievement('forest');
      if (b.name === 'DESERT') unlockAchievement('desert');
      if (b.name === 'COAST') unlockAchievement('coast');
    }
    checkProgressAchievements();

    // Engine pitch follows speed
    audio.updateEngine((state.speed - BASE_SPEED) / (MAX_SPEED - BASE_SPEED));

    // Exhaust puffs while moving fast
    exhaustTimer -= dt;
    if (exhaustTimer <= 0 && state.speed > BASE_SPEED + 0.5) {
      spawnExhaust(PLAYER_X + 4, state.player.y - 10);
      exhaustTimer = 0.07;
    }

    // Win/lose
    if (state.distance >= TRIP_TOTAL) {
      state.pendingScore = state.score;
      finalizeGhost('win');
      audio.stopEngine();
      audio.playWin();
      unlockAchievement('finish');
      if (state.runStats.hits === 0) unlockAchievement('clean-finish');
      show(SCREEN.WIN);
      document.getElementById('win-score').textContent = pad(state.score, 6);
      const rs = state.runStats;
      const secs = Math.round(state.runTime);
      const timeStr = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      const cleanLine = rs.hits === 0
        ? '<div class="stat stat-clean">CLEAN RUN — no deductible!</div>'
        : '';
      document.getElementById('win-stats').innerHTML =
        `<div class="stat"><span>TIME</span><b>${timeStr}</b></div>` +
        `<div class="stat"><span>SNACKS</span><b>${rs.snacks}</b></div>` +
        `<div class="stat"><span>FUEL CANS</span><b>${rs.fuel}</b></div>` +
        `<div class="stat"><span>PIT STOPS</span><b>${rs.pitstops}</b></div>` +
        `<div class="stat"><span>HITS</span><b>${rs.hits}</b></div>` +
        cleanLine;
      return;
    }
    if (state.fuel <= 0) {
      state.fuel = 0;
      state.pendingScore = state.score;
      const pct = Math.round((state.distance / TRIP_TOTAL) * 100);
      document.getElementById('go-summary').textContent =
        `You made it ${pct}% of the way before the tank ran dry.`;
      document.getElementById('go-score').textContent = pad(state.score, 6);
      finalizeGhost('gameover');
      audio.stopEngine();
      audio.playLose();
      show(SCREEN.GAMEOVER);
    }
  }

  // ============================================================
  // RENDER FRAME
  // ============================================================
  function render() {
    // Optional 3D renderer (render3d.js). When enabled and ready it draws the
    // same simulation in Three.js and we skip the 2D path entirely. Any failure
    // disables it and falls back to the 2D canvas below, so the game never breaks.
    if (window.RT3D && window.RT3D.enabled && window.RT3D.ready) {
      try { window.RT3D.render(); return; }
      catch (e) { window.RT3D.enabled = false; console.error('[RT3D] render failed; falling back to 2D', e); }
    }
    // Reset the logical->device transform first so every draw below works in
    // the fixed VIEW_W x VIEW_H space regardless of the real backing-store size.
    applyViewTransform();
    const b = currentBiome();
    const shake = state.screen === SCREEN.PLAYING ? shakeOffset() : { x: 0, y: 0 };

    ctx.save();
    ctx.translate(shake.x, shake.y);

    drawSky(b);
    drawSun(b);
    drawClouds(b);
    drawBirds();
    drawFarMountains(b);
    drawMidScenery(b);
    drawGround(b);
    drawNearScenery(b);

    if (state.screen === SCREEN.PLAYING || state.screen === SCREEN.PAUSED) {
      drawSemis();
      drawCollectibles();
      drawObstacles();
      drawFinishLine();
      drawSpeedLines();
      drawGhostPlayer();
      drawPlayer();
      drawParticles();
      drawScorePopups();
    }

    ctx.restore();

    if (state.screen === SCREEN.PLAYING || state.screen === SCREEN.PAUSED) {
      drawSpeedVignette();
      drawBiomeBanner();
      drawComboHud();
      drawDamageFlash();
    }
    drawAudioBanner();
    drawAchievementToast();
  }

  function drawAudioBanner() {
    if (audioBanner.t <= 0) return;
    const a = Math.min(1, audioBanner.t * 2);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(12,14,24,0.85)';
    const bw = 180, bh = 36;
    ctx.fillRect(W - bw - 20, 20, bw, bh);
    ctx.strokeStyle = '#f5d76e';
    ctx.lineWidth = 1;
    ctx.strokeRect(W - bw - 20, 20, bw, bh);
    ctx.fillStyle = '#f5d76e';
    ctx.font = 'bold 13px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`♪  ${audioBanner.text}`, W - bw / 2 - 20, 38);
    ctx.restore();
  }

  function drawAchievementToast() {
    if (!state.achievementToast) return;
    const a = Math.min(1, state.achievementToast.t * 2);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(12,14,24,0.9)';
    const bw = 280, bh = 48;
    ctx.fillRect(20, 20, bw, bh);
    ctx.strokeStyle = '#f5d76e';
    ctx.lineWidth = 1;
    ctx.strokeRect(20, 20, bw, bh);
    ctx.fillStyle = '#f5d76e';
    ctx.font = 'bold 11px "JetBrains Mono", Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('ACHIEVEMENT UNLOCKED', 32, 29);
    ctx.fillStyle = '#ececec';
    ctx.font = 'bold 14px "JetBrains Mono", Consolas, monospace';
    ctx.fillText(state.achievementToast.title, 32, 45);
    ctx.restore();
  }

  // ============================================================
  // MAIN LOOP
  // ============================================================
  function tick(time) {
    const dt = Math.min(0.05, (time - lastFrame) / 1000 || 0);
    lastFrame = time;
    pollGamepad();

    if (state.screen === SCREEN.PLAYING) {
      updateGame(dt);
      updateHUD();
    }
    audioBanner.t = Math.max(0, audioBanner.t - dt);
    if (state.achievementToast) {
      state.achievementToast.t -= dt;
      if (state.achievementToast.t <= 0) state.achievementToast = null;
    }

    render();
    requestAnimationFrame(tick);
  }

  // ============================================================
  // BOOT
  // ============================================================
  state._lastBiomeIdx = 0;
  state.bannerT = 0;
  state.scores = loadScores();
  applySettings();
  applyScreen();

  // === 3D RENDERER BRIDGE (feature/road-trip-3d) ===
  // Publishes a read-only view of the live simulation + constants so the
  // optional Three.js renderer (render3d.js) can draw the same game state in
  // 3D. The 2D canvas renderer remains the default and the fallback.
  window.__roadtrip = {
    get state() { return state; },
    currentBiome, nextBiome, biomeBlend,
    BIOMES, SCREEN,
    consts: {
      W, H, VIEW_W, VIEW_H, GROUND_Y, PLAYER_X,
      GRAVITY, JUMP_V, BASE_SPEED, MAX_SPEED, TRIP_TOTAL
    }
  };

  requestAnimationFrame(tick);
})();
