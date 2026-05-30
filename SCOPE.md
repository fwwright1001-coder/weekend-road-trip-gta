# Weekend Road Trip → Secret GTA Build — Project Scope

## Concept

A vanilla-JavaScript browser game with a hidden genre-switch. The visible game is
**Weekend Road Trip**, a 2D side-scrolling driving game: drive Marty's convertible
coast-to-coast on one tank of gas across four hand-paced legs. Reaching the coast
secretly unlocks a third-person **3D mode** — step out of the car into a low-poly
GTA-style open world: walk a small town, draw weapons, jack cars, and run a
bank-heist mission. It's reachable via the finish line, a title-screen
**ENTER HEIST MODE** button, or the `#gta` URL.

## Tech stack & hard constraints

- Vanilla JS, **no build step, no installed dependencies**.
- The 2D game is HTML5 Canvas; the 3D mode is **Three.js r0.170** loaded from a CDN
  via an import map (`three` + `three/addons/`).
- Hosted free on **GitHub Pages as static files** — so the deployed files are the source.
- Art is overwhelmingly **procedural** (code-generated geometry + procedural
  `CanvasTexture`s), with a recent move to real glTF models for characters.
- ES modules throughout; runs in **Chrome/Edge desktop**.

## Architecture & design principles

The defining idea is **decoupled, additive layering** so one part can't break another:

- **`game.js`** — the 2D driving sim. Untouched by everything else.
- **`onfoot3d.js`** — the 3D host: owns the Three.js scene, camera, third-person
  player controller (gravity, AABB collision), the seeded town, wandering pedestrians,
  the car-driving model, and the input loop. It exposes an optional integration
  surface — `window.ONFOOT.internals` (read-only handles) plus hooks `onEnter` /
  `onTick` / `onKill` / `onJack` / `onExit` / `renderHook`. With no layer attached,
  it's just a simple "walk around and shoot" easter egg.
- **`gta/`** — the crime-sandbox layer. A registry + event-bus core (`core.js`) where
  each subsystem self-registers and is individually `try/catch`-wrapped (`safeCall`),
  so a bug in one system can't crash the others or the base game.

**Key principle for the look:** *cohesion over fidelity* (the "Blizzard polish"
lesson) — a unified post-processing/lighting pass and consistent art language matter
more than polygon count.

## Module map (`gta/`)

- **`core.js`** — system registry, event bus, seeded RNG, math helpers.
- **`wanted.js`** — a continuous "heat" meter mapped to 0–5 stars, with line-of-sight
  gating and bracketed decay.
- **`police.js`** — pooled foot-cops + cruisers that spawn/scale with stars, chase,
  aim, and shoot; shootable back.
- **`economy.js`** — money ledger + world pickup manager (cash/health/armor/ammo).
- **`combat.js`** — multi-weapon system (fists, pistol, AK-47, SMG, shotgun) with
  hitscan, per-weapon ammo/reload, tracers and muzzle flash.
- **`hud-radar.js`** — rotating minimap, wanted stars, money, weapon/ammo,
  health+armor bars, objective text.
- **`onfoot-bridge.js`** — the glue: builds the shared `ctx` from `OF.internals`,
  registers systems, adapts them via thin shims (world/vehicles/combat-health),
  runs the crime feed, Wasted/Busted respawn, and DOM feedback (shake, hit-flash).
- **`onfoot-heist.js`** — the main mission state machine
  (toBank → grabGoop → escape → won), registered as the HUD's objective provider.
- **`onfoot-bank.js` / `onfoot-detail.js`** — procedural bank+vault and instanced
  street props.
- **`onfoot-render.js`** — post-FX pipeline (ACES tone-mapping, image-based lighting,
  SMAA, SSAO, bloom) with an adaptive quality governor that sheds effects under load.
- **`onfoot-textures.js`** — procedural textures + scene "beautify."
- **`onfoot-actors.js`** — the rigged-character pipeline: loads one glTF, normalizes
  it, clones per character (`SkeletonUtils`) with its own `AnimationMixer`, falls back
  to procedural box-people if the asset fails.
- **`tools/`** — headless test harness (below).

## Gameplay loop

Spawn in town → follow the radar marker to the bank → enter and reach the vault →
grab the goop (trips the alarm; wanted ramps ~2★→5★) → steal a car and escape to the
getaway marker → **WIN (+$5000)**. Cops swarm; fight or flee. Health + armor; dying →
respawn in town (heist progress preserved). Downed pedestrians drop cash; pickups
restore ammo/health/armor.

## Controls (desktop only)

`WASD` move · `Q`/`E` turn · mouse + pointer-lock look/aim · click shoot · `R` reload ·
`Tab`/`1–5` switch weapon · `E` enter/exit car · `Space` jump · `Shift` run · `P` quit.
No touch/mobile controls exist.

## Rendering & art

Procedural town, props, bank, and (currently) cops/cars; rigged animated human models
for the player and pedestrians (idle/walk/run via mixer). A unified post-FX grade ties
the frame together. A staged loading screen builds the scene and warms shaders/textures
before play starts. The camera uses frame-rate-independent damped follow (live aim),
wall-collision easing, and speed-based FOV when driving — all live-tunable via
`window.ONFOOT_CAM`.

## Testing & verification philosophy

Because rendering can't be seen headlessly, correctness is proven by a **Node harness**
with a stubbed host + real Three.js:

- `onfoot-sim.mjs` drives the full systems end-to-end (10 seeded mission runs).
- `collision-probe.mjs` tests wall physics (squeeze/tunnel cases).
- `mesh-check.mjs` / `actor-check.mjs` validate character contracts and the glTF pipeline.
- `scene-stats.mjs` audits draw calls.

Visual feel still requires a human in a real browser.

## Current state

**Working:** full heist loop, wanted/police/combat/economy, rigged human player+peds,
robust collision, loading screen, camera smoothing, post-FX, title-screen entry.
All headless checks green.

**Known gaps (improvement targets):**

- **Art cohesion** — cops, cars, and buildings are still procedural boxes next to the
  human characters (the biggest visual inconsistency).
- **Character identity** — player should be a gangster, NPCs civilians; both currently
  use one soldier model (needs new CC0 glTF assets; the pipeline is a model-URL +
  clip-name swap).
- **Mobile** — no touch controls or mobile perf profile.
- **Animation depth** — only idle/walk/run; no aim/death/jump blends; no animation
  blend trees.
- **Game feel** — minimal sound, no hit-pause, light particles.
- **Variety & ambient life** — one character mesh, limited traffic/pedestrian AI.

## Suggested improvement roadmap (highest leverage first)

1. **Lock one art direction + finish cohesion** (convert cops/cars/buildings to
   matching models).
2. **Camera & animation smoothing** — blend trees, eased transitions (most of "smooth").
3. **Game feel** — sound on every action, particles, screen-shake, hit-pause, stable
   framerate.
4. **UI system** — consistent typography, spacing, animated transitions.
5. **Environmental cohesion** — consistent scale, atmospheric fog, ambient
   traffic/crowds.
