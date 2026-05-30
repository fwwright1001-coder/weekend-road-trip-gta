# Weekend Road Trip — secret GTA build

Marty's been heads-down shipping for eleven months, and his PTO finally cleared. So he throws a duffel in his red convertible, points it west, and tries to drive coast-to-coast on a single tank of gas. Dodge potholes, jump cones, duck under low signs, and grab roadside snacks and fuel across four hand-paced legs of the trip — a dawn city, a morning pine forest, a blazing desert afternoon, and a sunset coast — before the tank runs dry and you reach the ocean.

…and then the trip doesn't end. **Reach the coast and the game quietly unlocks a hidden third-person mode.** Marty parks at the boardwalk, opens the door, and the whole thing turns into a low-poly GTA: get out of the car and walk a small town, jump, draw a pistol, and shoot the pedestrians wandering the streets (they panic and flee when you fire). Then **jack any car** and tear around in real arcade handling — throttle, handbrake, body roll, and running people over at speed.

Built from scratch in vanilla JavaScript — the road trip is HTML5 Canvas 2D, and the hidden mode is real 3D in [Three.js](https://threejs.org/) loaded straight from a CDN with **no build step, no install, no dependencies to download**. Everything is procedural: frame-rate-independent physics, a third-person character controller with gravity and AABB collision, a seeded town, wandering NPCs with a wander/flee/down state machine, hitscan shooting with tracers and recoil, and a self-contained Web Audio gunshot.

## ▶ Play it live

- **Full game:** https://fwwright1001-coder.github.io/weekend-road-trip-gta/
- **Jump straight to the GTA part** (skip the drive): https://fwwright1001-coder.github.io/weekend-road-trip-gta/#gta

Open it in Chrome or Edge. Needs an internet connection (Three.js streams from a CDN).

## Controls

**The drive:** `Space`/`W`/`↑` jump · `S`/`↓` duck · `D`/`→` accelerate · `A`/`←` brake. Reach the coast.

**On foot (unlocked at the finish, or via the `#gta` link):**
click to capture the mouse · `WASD` walk · mouse look · **click** shoot · `R` reload · `Space` jump · `Shift` run · `E` to steal/exit a car · `P` to quit back to the title.

**Driving:** `W`/`S` throttle/brake/reverse · `A`/`D` steer · `Space` handbrake · `E` to get out.

## Tech

Vanilla HTML5 + Canvas 2D + Three.js (r0.170, via CDN import map). Single folder, zero build. Repo: https://github.com/fwwright1001-coder/weekend-road-trip-gta

---

*An experimental fork of the ENGR 5513 submission game (Lipscomb MSAI). Forrest Wright, 2026.*
