// ============================================================
// gta/onfoot-render.js — post-processing + lighting "realism" pipeline for the
// on-foot 3D scene (onfoot3d.js, canvas #gamefoot).
// ------------------------------------------------------------
// Goal: make the procedural box-town look far LESS blocky while staying 100%
// code-generated (no downloaded assets). The biggest de-blocking win is proper
// anti-aliasing (SMAA) on top of an EffectComposer chain; we also add ACES tone
// mapping, an image-based-lighting environment (RoomEnvironment via PMREM) for
// real reflections on metal/clearcoat materials, a SUBTLE bloom so emissive
// signs/lights glow, and (best-effort) SSAO for contact-shadow grounding.
//
// DEFENSIVE BY DESIGN: every dynamic import + setup step is wrapped so a single
// failure can never break rendering. If anything below fails, `enabled` goes
// false and render() falls back to plain renderer.render(scene, camera). The
// SSAO add is isolated in its OWN try/catch so its failure never takes down the
// rest of the composer chain.
//
// PUBLIC API:
//   import { installRealism } from './onfoot-render.js';
//   const fx = await installRealism(THREE, renderer, scene, camera, canvas, opts);
//   // per-frame: fx.render(dt);  on resize: fx.setSize(w, h);  flag: fx.enabled
// ============================================================

/**
 * Install the realism pipeline onto an existing renderer/scene/camera.
 *
 * NOTE: this function performs dynamic `import()` of the three/addons modules,
 * so it is async and returns a Promise<{ render, setSize, enabled }>. Calling
 * code can `await` it, or just use the returned object once it resolves — the
 * returned `render`/`setSize` are always safe to call regardless of outcome.
 *
 * @param {object} THREE      the three module namespace (host-provided)
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {HTMLCanvasElement} canvas  the #gamefoot canvas
 * @param {object} [opts]
 * @returns {Promise<{ render:(dt:number)=>void, setSize:(w:number,h:number)=>void, enabled:boolean }>}
 */
export async function installRealism(THREE, renderer, scene, camera, canvas, opts = {}) {
  // ---- tunables (overridable via opts) -------------------------------------
  const EXPOSURE      = opts.exposure        ?? 1.0;
  const MAX_PIXEL_RATIO = opts.maxPixelRatio ?? 2;       // allow up to 2x for crispness (governor pulls it down under load)
  const SUPERSAMPLE   = opts.superSample     ?? 1.5;     // render above native density so the image isn't soft (capped by MAX)
  // Bloom: emissive things (signs, lamps, pickups) should clearly glow without
  // washing the frame — moderate strength + a not-too-low threshold.
  const BLOOM_STRENGTH  = opts.bloomStrength ?? 0.40;
  const BLOOM_RADIUS    = opts.bloomRadius   ?? 0.45;
  const BLOOM_THRESHOLD = opts.bloomThreshold ?? 0.82;
  // LIGHT REBALANCE — the host's lights (sun + hemisphere) were tuned for the
  // plain pipeline (no tone mapping, no IBL). Once we add ACES + a RoomEnvironment
  // image-based light, the scene is double-lit (too bright in lit spots, crushed
  // in shadow). When realism is on we scale the host lights down and let the IBL
  // provide ambient fill, for an even, balanced result. Multipliers off the host's
  // own values, so this self-corrects if the host ever retunes its lights.
  const SUN_MUL       = opts.sunMul  ?? 0.62;       // host sun 1.9 -> ~1.18
  const HEMI_MUL      = opts.hemiMul ?? 0.5;        // host hemi 0.85 -> ~0.43
  const ENV_INTENSITY = opts.envIntensity ?? 0.45;  // IBL contribution (Scene.environmentIntensity)
  const SSAO_KERNEL_RADIUS = opts.ssaoKernelRadius ?? 8;
  const SSAO_MIN_DISTANCE  = opts.ssaoMinDistance ?? 0.005;
  const SSAO_MAX_DISTANCE  = opts.ssaoMaxDistance ?? 0.1;
  const ENABLE_SSAO   = opts.ssao !== false;       // default on (best-effort)
  const ENABLE_BLOOM  = opts.bloom !== false;      // default on
  const ENABLE_SMAA   = opts.smaa !== false;       // default on
  const ENABLE_ENV    = opts.environment !== false; // default on (IBL)
  // adaptive quality: shed the heavy passes (SSAO, then bloom) when the machine
  // can't hold framerate, restore them when it recovers. SMAA always stays on
  // (cheap + the #1 de-blocking win). Lets weaker GPUs run the same build.
  const ADAPTIVE      = opts.adaptive !== false;   // default on
  const FPS_DOWN      = opts.fpsDown ?? 42;         // below this avg fps -> drop a tier
  const FPS_UP        = opts.fpsUp   ?? 58;         // above this avg fps -> restore a tier

  // ---- mutable pipeline handles --------------------------------------------
  let composer    = null;
  let renderPass  = null;
  let ssaoPass    = null;
  let bloomPass   = null;
  let smaaPass    = null;
  let outputPass  = null;
  let pmrem       = null;
  let envTexture  = null;
  let enabled     = false;     // true only once a working composer exists
  const lights    = { hemi: null, sun: null, hemi0: 0, sun0: 0 };  // host lights we rebalance

  // The fallback renderer.render is ALWAYS safe to call. We start the public
  // object pointing at it; if the composer comes up, render() switches over.
  const api = {
    enabled: false,
    render(/* dt */) {
      // overwritten on success; default = direct render
      try { renderer.render(scene, camera); } catch (_) { /* never throw */ }
    },
    setSize(w, h) {
      try {
        renderer.setPixelRatio(clampPR());
        renderer.setSize(w, h, false);
      } catch (_) { /* never throw */ }
    },
  };

  // current backing-store size (CSS px); used to size passes + render targets
  const initSize = currentSize();
  let curW = initSize.w;
  let curH = initSize.h;

  function clampPR() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return Math.min(dpr * SUPERSAMPLE, MAX_PIXEL_RATIO);   // supersample for sharpness, capped
  }

  function currentSize() {
    // Prefer the renderer's own drawing-buffer size; fall back to canvas, then
    // to a sane default. Returned in CSS pixels (pixel ratio applied separately).
    let w = 0, h = 0;
    try {
      const sz = renderer.getSize(new THREE.Vector2());
      w = sz.x; h = sz.y;
    } catch (_) { /* getSize may not exist on a stub */ }
    if (!(w > 0 && h > 0)) {
      w = (canvas && canvas.clientWidth)  || (canvas && canvas.width)  || 960;
      h = (canvas && canvas.clientHeight) || (canvas && canvas.height) || 540;
    }
    return { w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(h)) };
  }

  // ==========================================================================
  // PHASE 1 — renderer-level realism (tone mapping, shadows, IBL). These are
  // valuable on their own even if the composer fails, so they run first and
  // each is independently guarded.
  // ==========================================================================
  try {
    if (THREE.ACESFilmicToneMapping != null) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
    }
    renderer.toneMappingExposure = EXPOSURE;
  } catch (e) { warn('tone mapping setup failed', e); }

  try {
    if (renderer.shadowMap) {
      renderer.shadowMap.enabled = true;
      if (THREE.PCFSoftShadowMap != null) {
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      }
    }
  } catch (e) { warn('shadow map setup failed', e); }

  try {
    renderer.setPixelRatio(clampPR());
  } catch (e) { warn('pixel ratio clamp failed', e); }

  // ---- image-based lighting (real reflections on metal/clearcoat) ----------
  // RoomEnvironment is a procedural lightbox scene; PMREMGenerator (core THREE)
  // pre-filters it into an environment map. Wrapped: a failure just means no
  // env reflections, not a broken renderer.
  if (ENABLE_ENV) {
    try {
      const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');
      pmrem = new THREE.PMREMGenerator(renderer);
      // r0.170: RoomEnvironment() takes no args; fromScene(scene, sigma).
      const roomScene = new RoomEnvironment();
      envTexture = pmrem.fromScene(roomScene, 0.04).texture;
      scene.environment = envTexture;
      // The lightbox geometry/materials are no longer needed once baked.
      try { roomScene.traverse?.((o) => { o.geometry?.dispose?.(); }); } catch (_) {}
    } catch (e) {
      warn('IBL environment setup failed (continuing without reflections)', e);
      try { pmrem?.dispose?.(); } catch (_) {}
      pmrem = null;
      envTexture = null;
    }
  }

  // ---- light rebalance for the tone-mapped + IBL look ----------------------
  // Find the host's hemisphere + sun, remember their originals, and scale them
  // down so they don't stack with the IBL into an over-bright image. Also dial
  // the IBL's own contribution via Scene.environmentIntensity (r0.163+).
  try {
    scene.traverse((o) => {
      if (o.isHemisphereLight && !lights.hemi) { lights.hemi = o; lights.hemi0 = o.intensity; }
      else if (o.isDirectionalLight && !lights.sun) { lights.sun = o; lights.sun0 = o.intensity; }
    });
    if (lights.hemi) lights.hemi.intensity = lights.hemi0 * HEMI_MUL;
    if (lights.sun)  lights.sun.intensity  = lights.sun0  * SUN_MUL;
    if (envTexture && 'environmentIntensity' in scene) scene.environmentIntensity = ENV_INTENSITY;
  } catch (e) { warn('light rebalance failed', e); }

  // ==========================================================================
  // PHASE 2 — the EffectComposer post-processing chain. The whole block is
  // guarded; on any failure we tear down what we built and leave the fallback
  // renderer.render path in place (enabled stays false).
  // ==========================================================================
  try {
    const [
      { EffectComposer },
      { RenderPass },
      { OutputPass },
    ] = await Promise.all([
      import('three/addons/postprocessing/EffectComposer.js'),
      import('three/addons/postprocessing/RenderPass.js'),
      import('three/addons/postprocessing/OutputPass.js'),
    ]);

    composer = new EffectComposer(renderer);
    // Keep the composer's internal render targets at the clamped ratio too.
    try { composer.setPixelRatio(clampPR()); } catch (_) {}
    composer.setSize(curW, curH);

    // 1) base scene render -------------------------------------------------
    renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    // 2) SSAO (ambient-occlusion grounding) — ISOLATED try/catch so a failure
    //    here never takes out SMAA/bloom/output. Added right after the scene
    //    render so AO darkens contact areas before bloom/AA.
    if (ENABLE_SSAO) {
      try {
        const { SSAOPass } = await import('three/addons/postprocessing/SSAOPass.js');
        // r0.170: SSAOPass(scene, camera, width, height, kernelSize?)
        ssaoPass = new SSAOPass(scene, camera, curW, curH);
        ssaoPass.kernelRadius = SSAO_KERNEL_RADIUS;
        ssaoPass.minDistance  = SSAO_MIN_DISTANCE;
        ssaoPass.maxDistance  = SSAO_MAX_DISTANCE;
        // Default output blends AO into the beauty pass (NORMAL). Leave as-is.
        if (SSAOPass.OUTPUT && SSAOPass.OUTPUT.Default != null) {
          ssaoPass.output = SSAOPass.OUTPUT.Default;
        }
        composer.addPass(ssaoPass);
      } catch (e) {
        warn('SSAO pass failed (skipping AO, chain continues)', e);
        try { ssaoPass?.dispose?.(); } catch (_) {}
        ssaoPass = null;
      }
    }

    // 3) SMAA — the #1 de-blocking win (edge anti-aliasing). Procedural search/
    //    area textures are generated internally, no downloaded assets.
    if (ENABLE_SMAA) {
      try {
        const { SMAAPass } = await import('three/addons/postprocessing/SMAAPass.js');
        // r0.170: SMAAPass(width, height) — note these are device pixels.
        const pr = clampPR();
        smaaPass = new SMAAPass(curW * pr, curH * pr);
        composer.addPass(smaaPass);
      } catch (e) {
        warn('SMAA pass failed (no AA)', e);
        try { smaaPass?.dispose?.(); } catch (_) {}
        smaaPass = null;
      }
    }

    // 4) subtle bloom so emissive signs/lights glow (NOT a hazy blur) -------
    if (ENABLE_BLOOM) {
      try {
        const { UnrealBloomPass } = await import('three/addons/postprocessing/UnrealBloomPass.js');
        // r0.170: UnrealBloomPass(resolution: Vector2, strength, radius, threshold)
        bloomPass = new UnrealBloomPass(
          new THREE.Vector2(curW, curH),
          BLOOM_STRENGTH,
          BLOOM_RADIUS,
          BLOOM_THRESHOLD,
        );
        composer.addPass(bloomPass);
      } catch (e) {
        warn('bloom pass failed (no glow)', e);
        try { bloomPass?.dispose?.(); } catch (_) {}
        bloomPass = null;
      }
    }

    // 5) output pass — tone mapping + sRGB conversion / gamma for the final
    //    framebuffer. Must be LAST in the chain.
    outputPass = new OutputPass();
    composer.addPass(outputPass);

    // If we got here, the composer chain is live. Switch render() onto it.
    enabled = true;
    api.enabled = true;

    // ---- adaptive quality governor ----------------------------------------
    // tier 2 = SSAO + bloom + SMAA (full) · 1 = bloom + SMAA · 0 = SMAA only.
    let _emaDt = 1 / 60;     // smoothed frame time (s)
    let _cooldown = 90;      // frames to wait before the first/next change (settle EMA)
    let _tier = 2;
    api.quality = () => _tier;
    const applyTier = () => {
      if (ssaoPass)  ssaoPass.enabled  = _tier >= 2;
      if (bloomPass) bloomPass.enabled = _tier >= 1;
    };
    const governor = (dt) => {
      if (!ADAPTIVE) return;
      if (typeof dt === 'number' && dt > 0 && dt < 0.5) _emaDt = _emaDt * 0.92 + dt * 0.08;
      if (_cooldown > 0) { _cooldown--; return; }
      const fps = 1 / _emaDt;
      const haveDowngrade = (_tier === 2 && ssaoPass) || (_tier === 1 && bloomPass);
      if (fps < FPS_DOWN && haveDowngrade) { _tier--; applyTier(); _cooldown = 120; }
      else if (fps > FPS_UP && _tier < 2)  { _tier++; applyTier(); _cooldown = 150; }
    };

    api.render = function renderComposed(dt) {
      governor(dt);
      try {
        composer.render();
      } catch (e) {
        // First failure: log once, then permanently fall back so we don't spam
        // and don't leave a black frame on screen.
        warn('composer.render() threw — falling back to direct render', e);
        api.render = function renderDirect() {
          try { renderer.render(scene, camera); } catch (_) {}
        };
        api.enabled = false;
        enabled = false;
        try { renderer.render(scene, camera); } catch (_) {}
      }
    };

    // Resize: renderer + composer + every size-sensitive pass.
    api.setSize = function setSizeComposed(w, h) {
      try {
        w = Math.max(1, Math.floor(w));
        h = Math.max(1, Math.floor(h));
        curW = w; curH = h;
        const pr = clampPR();
        renderer.setPixelRatio(pr);
        renderer.setSize(w, h, false);
        if (composer) {
          try { composer.setPixelRatio(pr); } catch (_) {}
          composer.setSize(w, h);
        }
        // SSAO / Bloom take CSS-pixel sizes via setSize(w, h).
        try { ssaoPass?.setSize?.(w, h); } catch (_) {}
        try { bloomPass?.setSize?.(w, h); } catch (_) {}
        // SMAA expects device pixels.
        try { smaaPass?.setSize?.(w * pr, h * pr); } catch (_) {}
      } catch (e) {
        warn('setSize failed', e);
      }
    };
  } catch (e) {
    // Composer chain failed entirely — tear down, keep fallback render path.
    warn('EffectComposer setup failed — using direct renderer.render', e);
    try { composer?.dispose?.(); } catch (_) {}
    composer = null;
    renderPass = ssaoPass = bloomPass = smaaPass = outputPass = null;
    enabled = false;
    api.enabled = false;
    // api.render / api.setSize remain the safe direct-render defaults set above.
  }

  // ---- live tuning (calibrate lighting in the console, no reload) ----------
  // Exposed as window.ONFOOT_FX so it can be dialed in live, e.g.:
  //   ONFOOT_FX.exposure(0.9)  ONFOOT_FX.env(0.5)  ONFOOT_FX.bloom(0.2, 0.92)
  //   ONFOOT_FX.sun(1.1)       ONFOOT_FX.hemi(0.4) ONFOOT_FX.ssao(false)
  //   ONFOOT_FX.dump()  -> the current settings (paste them back so I can bake them in)
  api.exposure = (v) => { try { renderer.toneMappingExposure = v; } catch (_) {} return v; };
  api.env = (v) => { try { if ('environmentIntensity' in scene) scene.environmentIntensity = v; } catch (_) {} return v; };
  api.bloom = (s, t, r) => { try { if (bloomPass) { if (s != null) bloomPass.strength = s; if (t != null) bloomPass.threshold = t; if (r != null) bloomPass.radius = r; } } catch (_) {} };
  api.sun = (v) => { try { if (lights.sun) lights.sun.intensity = v; } catch (_) {} return v; };
  api.hemi = (v) => { try { if (lights.hemi) lights.hemi.intensity = v; } catch (_) {} return v; };
  api.ssao = (on) => { try { if (ssaoPass) ssaoPass.enabled = !!on; } catch (_) {} };
  api.dump = () => ({
    exposure: safeNum(() => renderer.toneMappingExposure),
    env: safeNum(() => ('environmentIntensity' in scene ? scene.environmentIntensity : null)),
    sun: lights.sun ? lights.sun.intensity : null,
    hemi: lights.hemi ? lights.hemi.intensity : null,
    bloom: bloomPass ? { strength: bloomPass.strength, threshold: bloomPass.threshold, radius: bloomPass.radius } : null,
    ssao: ssaoPass ? ssaoPass.enabled : null,
    tier: typeof api.quality === 'function' ? api.quality() : null,
    enabled,
  });
  try { if (typeof window !== 'undefined') window.ONFOOT_FX = api; } catch (_) {}

  return api;

  function safeNum(fn) { try { return fn(); } catch (_) { return null; } }

  // ---- tiny logger (never throws, easy to silence via opts.quiet) ----------
  function warn(msg, err) {
    if (opts.quiet) return;
    try { console.warn('[onfoot-render] ' + msg, err || ''); } catch (_) {}
  }
}
