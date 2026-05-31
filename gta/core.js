// ============================================================
// gta/core.js — the spine of the open-world "crime sandbox" layer
// ------------------------------------------------------------
// This is an ADD-ON layer designed to bolt onto the on-foot mode the road-trip
// game already has (onfoot3d.js, window.ONFOOT). It is deliberately decoupled:
//
//   * It NEVER imports or edits onfoot3d.js / render3d.js / game.js. It reads
//     the public bridges (window.ONFOOT, window.__roadtrip) and otherwise owns
//     its own state, drawn into the host's existing Three.js scene.
//   * Every subsystem (wanted level, police AI, vehicles, combat, economy,
//     missions, traffic, radar) is a self-registered module with the same
//     {name, init, update, reset, api} shape. They talk to each other ONLY
//     through GTA.bus events + ctx.systems.<name>.api — never by reaching into
//     each other's internals. Swap any one out and the rest keep running.
//   * Everything is wrapped so a throw in one system can never brick the host
//     game: GTA.boot()/GTA.tick() try/catch each system independently.
//
// LEGAL NOTE (see LEGAL.md): we clone GAME MECHANICS — wanted stars, police
// escalation, carjacking, mission objectives — which are not copyrightable.
// We originate ALL expressive content: no trademarked names, no real-world
// brands, no copied characters/cities/vehicles/music. Generic crime-sandbox
// systems, original low-poly art generated in code.
//
// Coordinate convention (inherited from onfoot3d.js): right-handed, Y up.
// Entities walk/drive the XZ plane; Y is height; feet/wheels rest at Y=0.
// ============================================================

// ------------------------------------------------------------
// THE GTA NAMESPACE
// ------------------------------------------------------------
const GTA = {
  version: '0.1.0',
  systems: {},        // name -> system object (also mirrored on ctx.systems)
  _order: [],         // registration order = init/update order
  ctx: null,          // the shared context (set by GTA.boot)
  bus: null,          // event bus (set below)
  booted: false,
  // host integration mode: 'standalone' (our own harness drives the loop) or
  // 'onfoot' (onfoot3d.js drives; we hook its loop). Set by whoever calls boot.
  mode: 'standalone',
};
if (typeof window !== 'undefined') window.GTA = GTA;

// ============================================================
// EVENT BUS — the decoupling backbone
// ------------------------------------------------------------
// Systems publish facts ("a crime happened", "an entity was killed") and react
// to facts; they don't call each other directly. This is what lets eight people
// (or eight agents) write eight systems that interlock without a merge war.
//
// CANONICAL EVENT CATALOG (payloads are plain objects):
//   crime            {kind, pos, severity, source?}   a wanted-relevant act
//                      kind: 'assault'|'gunfire'|'vehicleTheft'|'propertyDamage'
//                            |'copAssault'|'copKilled'|'evading'
//   wanted:changed   {level, prev, heat}              stars went up/down
//   damage           {target, amount, kind, pos, source?}  request to hurt an entity
//   entityKilled     {entity, kind, pos, byPlayer}    kind: 'ped'|'cop'|'player'
//   playerHurt       {amount, health, armor, source}
//   playerWasted     {pos, cause}                     health hit 0
//   playerBusted     {pos}                            police arrest succeeded
//   playerRespawn    {pos}                            after wasted/busted
//   vehicle:entered  {vehicle, byPlayer}
//   vehicle:exited   {vehicle, byPlayer}
//   vehicle:jacked   {vehicle, victim}                stole an occupied car
//   pickup           {kind, value, pos}               kind: 'cash'|'health'|'armor'|'ammo'|'weapon'
//   money:changed    {delta, total, reason}
//   weapon:changed   {slot, weapon}
//   mission:offered  {id, title, pos}
//   mission:start    {id, title}
//   mission:objective{id, text, kind, progress?}
//   mission:complete {id, reward}
//   mission:failed   {id, reason}
//   toast            {html, ms}                        request the HUD show a message
//   shake            {amount}                          request a camera shake
//   --- fx:* — optional one-shot visual-FX requests (gta/fx.js, Lane B, subscribes;
//       combat.js / the bridge emit them where they know the exact point). Dormant
//       and harmless until a subscriber exists (emit() no-ops with no listeners). ---
//   fx:muzzle        {pos, dir, weapon?}               muzzle flash + smoke at the barrel
//   fx:impact        {pos, kind?, normal?, scale?}     bullet/crash hit: spark/debris puff
//   fx:casing        {pos, dir, weaponId}              spent shell ejects from the breech (spin + ping)
//   fx:explosion     {pos, radius?}                    vehicle/explosive blast
//   fx:spawn         {pos, kind?, color?}              generic one-shot particle burst
//   fx:crash         {pos, severity, speed, normal?, damage}  car-vs-building impact (dust/crumple)
// --- mode / state events ---
//   fp:toggle        {firstPerson}                     first/third-person view toggled (V)
// ============================================================
function makeBus() {
  const map = new Map();          // type -> Set<fn>
  return {
    on(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      return () => this.off(type, fn);   // returns an unsubscribe
    },
    off(type, fn) { const s = map.get(type); if (s) s.delete(fn); },
    once(type, fn) {
      const off = this.on(type, (p) => { off(); fn(p); });
      return off;
    },
    emit(type, payload) {
      const s = map.get(type);
      if (!s) return;
      // copy so handlers can subscribe/unsubscribe during dispatch
      for (const fn of [...s]) {
        try { fn(payload); }
        catch (e) { console.error(`[GTA.bus] handler for "${type}" threw`, e); }
      }
    },
    clear() { map.clear(); },
  };
}
GTA.bus = makeBus();

// ============================================================
// SYSTEM REGISTRY
// ------------------------------------------------------------
// A system is a plain object:
//   {
//     name: 'wanted',
//     deps?: ['world'],          // optional: names that must init first
//     init(ctx)   {},            // build meshes, subscribe to bus, seed state
//     update(dt, ctx) {},        // per-frame; dt is clamped seconds
//     reset(ctx)  {},            // on (re)enter / respawn
//     drawRadar?(r, ctx) {},     // optional: draw onto the 2D radar (see hud-radar)
//     api: { ... },              // public methods other systems may call
//   }
// Register with GTA.register(system). Order is registration order unless `deps`
// forces an earlier slot.
// ============================================================
GTA.register = function register(system) {
  if (!system || !system.name) throw new Error('GTA.register: system needs a name');
  if (GTA.systems[system.name]) {
    console.warn(`[GTA] system "${system.name}" already registered — replacing`);
    GTA._order = GTA._order.filter((n) => n !== system.name);
  }
  GTA.systems[system.name] = system;
  GTA._order.push(system.name);
  // if we're already running, init it live so late-loaded modules still work
  if (GTA.booted && GTA.ctx) safeCall(system, 'init', GTA.ctx);
  return system;
};

// Topologically order by `deps` (stable; missing deps are ignored gracefully).
function orderedSystems() {
  const out = [], seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const sys = GTA.systems[name];
    if (!sys) return;
    for (const d of sys.deps || []) if (GTA.systems[d]) visit(d);
    out.push(sys);
  };
  for (const name of GTA._order) visit(name);
  return out;
}

function safeCall(system, method, ...args) {
  const fn = system && system[method];
  if (typeof fn !== 'function') return;
  try { fn.call(system, ...args); }
  catch (e) { console.error(`[GTA] ${system.name}.${method}() threw`, e); }
}

// ============================================================
// THE SHARED CONTEXT (ctx)
// ------------------------------------------------------------
// Built by the host (standalone harness boot.js, or the onfoot3d adapter) and
// passed to every init()/update(). Systems read/write the live player object
// and query the world through it. Shape (host fills these in):
//   ctx.THREE              the three.module reference
//   ctx.scene/camera/renderer
//   ctx.player            { pos:Vector3, vel:Vector3, vy, grounded, yaw, pitch,
//                           health, maxHealth, armor, money, inVehicle, vehicle,
//                           weapon, mesh, alive }
//   ctx.world             world system api (collision/spawns/roads) — may be null
//                         until the world system inits; access via ctx.systems.world.api
//   ctx.input             { keys:Set, pointerLocked, mouseDown,
//                           pressed(code), consume(code), mouseJust(button) }
//   ctx.time              { t (seconds since boot), dt }
//   ctx.rng               seeded ()=>[0,1) for deterministic spawns
//   ctx.systems           === GTA.systems (cross-system api access)
//   ctx.bus               === GTA.bus
//   ctx.config            tunables (difficulty, density, etc.)
// GTA.boot wires ctx.systems/ctx.bus/ctx.time for you; the host supplies the rest.
// ============================================================
GTA.boot = function boot(ctx, opts = {}) {
  GTA.ctx = ctx;
  GTA.mode = opts.mode || GTA.mode;
  ctx.systems = GTA.systems;
  ctx.bus = GTA.bus;
  ctx.time = ctx.time || { t: 0, dt: 0 };
  ctx.config = Object.assign({
    difficulty: 1,        // scales police aggression / damage
    pedDensity: 1,        // scales ambient ped/traffic counts
    persist: true,        // localStorage for money/stats
  }, ctx.config || {});
  for (const sys of orderedSystems()) safeCall(sys, 'init', ctx);
  GTA.booted = true;
  GTA.bus.emit('gta:booted', { ctx });
  return ctx;
};

// One frame. `dt` is delta seconds (the host clamps it). Call this from the
// host loop AFTER the host has updated ctx.player.pos for this frame, so systems
// react to the player's current position. Each system is isolated: a throw in
// one does not stop the others.
GTA.tick = function tick(dt, ctx = GTA.ctx) {
  if (!GTA.booted || !ctx) return;
  ctx.time.dt = dt;
  ctx.time.t += dt;
  for (const sys of orderedSystems()) safeCall(sys, 'update', dt, ctx);
};

// Re-enter / respawn hook — resets every system without rebuilding meshes.
GTA.reset = function reset(ctx = GTA.ctx) {
  if (!ctx) return;
  for (const sys of orderedSystems()) safeCall(sys, 'reset', ctx);
  GTA.bus.emit('gta:reset', { ctx });
};

// ============================================================
// MATH / UTILITY HELPERS (no per-frame allocation where it matters)
// ============================================================
const GU = {
  clamp: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v),
  lerp: (a, b, t) => a + (b - a) * t,
  // shortest-arc angle lerp (radians)
  lerpAngle(a, b, t) {
    let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  },
  // smooth exponential approach independent of frame rate
  damp: (a, b, lambda, dt) => GU.lerp(a, b, 1 - Math.exp(-lambda * dt)),
  dist2D: (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz),
  rand: (rng, a, b) => a + (rng ? rng() : Math.random()) * (b - a),
  pick: (rng, arr) => arr[((rng ? rng() : Math.random()) * arr.length) | 0],
  chance: (rng, p) => (rng ? rng() : Math.random()) < p,
  // mulberry32 seeded RNG factory — deterministic worlds/spawns
  makeRng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  },
};
GTA.util = GU;

// A reusable disposable mesh helper: build a Group, tag it for shadows.
GTA.shadowize = function shadowize(obj, cast = true, receive = true) {
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive; } });
  return obj;
};

// Pool helper any system can use: keep N reusable meshes, hide the unused tail.
// usage: const pool = GTA.makePool(factory); pool.begin(); const m = pool.get(); ... pool.end();
GTA.makePool = function makePool(factory, parent) {
  const items = [];
  let idx = 0;
  return {
    items,
    begin() { idx = 0; },
    get() {
      if (idx >= items.length) {
        const m = factory(items.length);
        if (parent) parent.add(m);
        items.push(m);
      }
      const m = items[idx++];
      m.visible = true;
      return m;
    },
    end() { for (let i = idx; i < items.length; i++) items[i].visible = false; },
  };
};

export { GTA, GU };
export default GTA;
