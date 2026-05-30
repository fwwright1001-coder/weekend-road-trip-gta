# GTA systems layer — wired onto the on-foot mode

This folder turns the hidden "step out of the car and walk around" mode
(`onfoot3d.js`) into a full open-world crime game:

- **The BANK HEIST main mission** (`onfoot-heist.js`): Smeaglodin gets to the
  bank → grabs the **goop** from the vault (the alarm spikes the wanted level) →
  **escapes in a car** to the getaway marker to win (+$5000). Cops can be fought
  or fled.
- **A multi-weapon arsenal** (`combat.js`): pistol + **AK-47** (full auto) +
  SMG + shotgun, `Tab`/`1-5` to switch, per-weapon ammo + reload; **guns, ammo,
  health, and armor pickups** scattered through the world.
- **Wanted stars, police** that spawn/chase/shoot and can be shot back, **health
  + body armor**, **Wasted/Busted** + respawn, a **money economy**, a rotating
  **minimap/radar**, and screen-shake + hit-flash feedback.
- **3D detail**: faces/bodies on people, a columned bank with a vault, nicer
  cars, and street props (trees/hydrants/benches/road paint).

Reach it via `#gta` in the URL, or finish the drive and press **F**.

The driving game (`game.js`) is **untouched**. `onfoot3d.js` stays the host (it
owns the scene, camera, player controller, town, pedestrians, pistol, and
driving); this layer only *reads* its internals and reacts.

## How it's wired
- **Additive hooks in `onfoot3d.js`** (the only host edits, all optional — no
  behavior change when the layer isn't loaded):
  - `OF.internals` — read access to scene/camera/player/keys/yaw/peds/vehicles/
    aabbs/`resolveCollision`/`spawnVehicle`/etc.
  - `OF.onEnter / onTick / onFire / onKill / onJack / onExit` — called from
    `enter()` / the loop / `fire()` / `killPed()` / `enterVehicle()` / `exit()`.
- **`gta/onfoot-bridge.js`** — the integration host. It builds the shared `ctx`
  from `OF.internals`, registers the reviewed systems, and adapts them with three
  thin shims:
  - **world shim** — `world.api` (collision / spawns / road grid) over onfoot3d's
    `aabbs` + `BOUND` + `resolveCollision` (streets at `k*24 + 12`).
  - **combat/health shim** — player health/armor + `currentWeapon`/`damagePlayer`/
    `heal`/`addArmor` (onfoot3d still owns the actual pistol + firing).
  - **vehicles shim** — `count`/`nearestEnterable`/`spawnAt`/`playerVehicle`.
  - Plus: a cop hit-scan on the same aim ray (so police are shootable), crime
    feed (gunfire/assault/vehicle-theft → wanted), ped/vehicle radar mirrors,
    Wasted/Busted respawn, and DOM-only screen-shake + hit-flash feedback.
- **Reused unchanged** (already reviewed in the standalone sandbox):
  `core.js`, `wanted.js`, `economy.js`, `missions.js`, `police.js`, `hud-radar.js`.
- **HUD**: `#gta-hud` (radar, stars, vitals, money, weapon, objective) added to
  `index.html`; `#gta-*` styles appended to `styles.css`. A `body.gta-active`
  class suppresses the legacy on-foot ammo panel while the layer runs.

## Try it
```bash
python -m http.server 8090     # then open http://localhost:8090/#gta
```
`#gta` drops straight into the sandbox. Click to capture the mouse · **WASD** move ·
**Click** shoot (stars climb, cops come) · **R** reload · **E** jack a car · **P** quit.
(Or finish the drive and press **F**.)

## Safety
Every hook body and every system tick is `try/catch`-wrapped and per-system
isolated, so a bug in this layer can never brick the base on-foot mode or the
driving game.

## Physics & performance
- **Ground-level bank**: the bank's interior floor sits at `y=0` like every town
  building (it used to be on a ~1.28-tall podium while the player stays pinned at
  `y=0`, with no step-up collision in the host — so you'd phase through the stone
  base into the bank). The grandeur now comes from the colonnade/pediment/sign,
  not elevation. `gta/tools/collision-probe.mjs` runs the REAL `resolveCollision`
  against the REAL bank footprints and asserts the door is the only XZ opening
  (walls hold for a walker at WALK/RUN worst-case `dt`, and for a car at top speed).
- **Draw-call diet**: `onfoot-detail.js` bakes its hundreds of static prop/paint
  meshes into InstancedMesh batches (one draw per geometry+material) — ~860 → ~70
  draws, no visual change. `gta/tools/scene-stats.mjs` reports the full scene cost.
- **Adaptive post-FX**: the realism pipeline (`onfoot-render.js`) watches frame
  time and sheds SSAO, then bloom, when a machine can't hold framerate, restoring
  them when it recovers (SMAA always stays on). Lets weaker GPUs run the build.

## Tests
- `npm install && npm run smoke` (from `gta/`) runs a headless Node alpha test:
  boots every system + the bridge against a stubbed host and ticks 240+ frames
  while firing, killing peds, taking damage, carjacking, and respawning —
  asserting zero throws/errors and the full crime→wanted→police→damage interlock.
- Adversarially QC-reviewed (3 dimensions + per-finding verification); confirmed
  findings fixed.
