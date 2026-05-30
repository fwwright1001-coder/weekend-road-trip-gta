// ============================================================
// gta/onfoot-detail.js — code-generated street dressing for the on-foot town
// ------------------------------------------------------------
// onfoot3d.js builds a small walkable town: a 5x5 grid of building blocks on a
// 24-unit CELL, cross-streets running at k*24+12, an open spawn plaza at the
// centre, all inside a square of half-size BOUND=58. It looks clean but BARE —
// just buildings, asphalt and a few lamps. This module scatters believable
// street furniture over that same town so it reads like a lived-in place:
// sidewalk trees, fire hydrants, benches, planters, trash cans, extra lamp-post
// detail, low bushes, plus painted crosswalks and lane dashes near the
// intersections.
//
// CONTRACT — deliberately self-contained and side-effect-light:
//   * 100% code-generated geometry (Box/Cylinder/Cone/Sphere/Icosahedron/Torus/
//     Plane) with MeshStandard/Physical/Basic materials. NO textures, loaders,
//     asset files or URLs. Original art only.
//   * THREE is passed in (the host already imports it); we never import it, so
//     this file can be dropped in next to onfoot3d.js with no build step.
//   * ALL layout uses a SEEDED rng written below — never Math.random — so the
//     dressing is identical every visit, like a real neighbourhood.
//   * Everything is parented to ONE Group, added to `scene`, and returned. The
//     caller can hide/dispose it wholesale.
//   * Right-handed, Y up; every prop rests its feet at Y=0. Solid meshes set
//     castShadow + receiveShadow; flat road paint only receives.
//
// USAGE (from onfoot3d.ensureInit, after the town + lamps are built):
//     import { buildWorldDetail } from './gta/onfoot-detail.js';
//     buildWorldDetail(THREE, scene, { exclude: [{ x: 24, z: -24, r: 10 }] });
// ============================================================

// ------------------------------------------------------------
// SEEDED RNG — a tiny LCG (same family onfoot3d.js / core.js use). Deterministic
// so the street furniture lands in exactly the same spots every load. We keep a
// few helpers on top of it (range / pick / chance / jitter) for readable layout.
// ------------------------------------------------------------
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ------------------------------------------------------------
// buildWorldDetail — the single public entry point.
//   THREE  : the Three.js namespace (from the host).
//   scene  : the host scene to add the detail group to.
//   opts   : { seed?, exclude?: [{x,z,r}], plazaRadius?, bound?, block?, roadOffset? }
// Returns the Group it added (so the caller can keep a handle).
// ------------------------------------------------------------
export function buildWorldDetail(THREE, scene, opts = {}) {
  const BOUND = opts.bound != null ? opts.bound : 58;        // half-size of the town square
  const BLOCK = opts.block != null ? opts.block : 24;        // CELL grid spacing
  const ROAD_OFFSET = opts.roadOffset != null ? opts.roadOffset : 12; // streets at k*BLOCK+OFFSET
  const PLAZA_R = opts.plazaRadius != null ? opts.plazaRadius : 10;   // keep the spawn plaza clear
  const MAX_PROPS = opts.maxProps != null ? opts.maxProps : 96;       // perf cap on solid props (target band ~60-120)

  const rng = makeRng(opts.seed != null ? opts.seed : 0x57DE7A11);
  const rand = (a, b) => a + rng() * (b - a);
  const irand = (a, b) => (a + Math.floor(rng() * (b - a + 1)));
  const pick = (arr) => arr[(rng() * arr.length) | 0];
  const chance = (p) => rng() < p;

  // exclusion zones (e.g. the bank plaza) + the spawn plaza, all as circles.
  const exclude = Array.isArray(opts.exclude) ? opts.exclude.slice() : [];
  exclude.push({ x: 0, z: 0, r: PLAZA_R });
  const inExcluded = (x, z, pad = 0) => {
    for (const e of exclude) {
      const r = (e.r || 0) + pad;
      const dx = x - (e.x || 0), dz = z - (e.z || 0);
      if (dx * dx + dz * dz < r * r) return true;
    }
    return false;
  };
  const inBounds = (x, z, m = 1.5) => Math.abs(x) <= BOUND - m && Math.abs(z) <= BOUND - m;

  // The host jitters each building up to ±1.5 inside its 24-unit cell, then the
  // footprint is w,d ∈ [7,12] wide (half-extent up to 6 + 1.5 jitter ≈ 7.5 from
  // the cell centre). We don't have the exact aabbs here, so we treat a generous
  // ~8.5-unit half-box around every occupied block centre as "building core" and
  // only place props OUTSIDE that — i.e. on the sidewalk ring. Trees/benches face
  // the nearest street. This keeps furniture off the buildings without the aabbs.
  const CORE_HALF = 8.5;            // keep-clear half-extent around a block centre
  const SIDEWALK = 9.6;            // ring radius from a block centre where props sit
  const blocks = [];               // occupied building cells (cx,cz)
  for (let gx = -2; gx <= 2; gx++) {
    for (let gz = -2; gz <= 2; gz++) {
      if (gx === 0 && gz === 0) continue;        // spawn plaza stays open
      blocks.push({ cx: gx * BLOCK, cz: gz * BLOCK });
    }
  }

  // Reject a candidate if it would overlap a building core, an exclusion zone,
  // leave the map, or sit too close to an already-placed prop (no clutter piles).
  const placed = [];               // {x,z} of every solid prop, for spacing
  const nearCore = (x, z, pad = 0) => {
    for (const b of blocks) {
      if (Math.abs(x - b.cx) < CORE_HALF + pad && Math.abs(z - b.cz) < CORE_HALF + pad) return true;
    }
    return false;
  };
  const tooClose = (x, z, minD) => {
    const m2 = minD * minD;
    for (const p of placed) {
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz < m2) return true;
    }
    return false;
  };
  const accept = (x, z, minD = 2.2, corePad = 0) =>
    inBounds(x, z) && !inExcluded(x, z, 0.5) && !nearCore(x, z, corePad) && !tooClose(x, z, minD);

  // ============================================================
  // SHARED RESOURCES — geometries + materials built ONCE and reused by every
  // instance of a prop type. Keeps draw setup cheap and the GPU buffer count low
  // even with ~100 props. (Meshes are unique; their geometry/material are not.)
  // ============================================================
  const G = {};   // geometries
  const M = {};   // materials

  // --- materials (stylized-realistic; matte where real, a little sheen on metal) ---
  M.bark      = new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.95 });
  M.leaf      = new THREE.MeshStandardMaterial({ color: 0x3f7d3a, roughness: 1.0, flatShading: true });
  M.leafDark  = new THREE.MeshStandardMaterial({ color: 0x356b32, roughness: 1.0, flatShading: true });
  M.leafAutumn= new THREE.MeshStandardMaterial({ color: 0x9c7a2e, roughness: 1.0, flatShading: true });
  M.bush      = new THREE.MeshStandardMaterial({ color: 0x4a8a46, roughness: 1.0, flatShading: true });
  M.hydrant   = new THREE.MeshStandardMaterial({ color: 0xc23b2b, roughness: 0.55, metalness: 0.1 });
  M.hydrantCap= new THREE.MeshStandardMaterial({ color: 0xd9d2c0, roughness: 0.5, metalness: 0.2 });
  M.wood      = new THREE.MeshStandardMaterial({ color: 0x8a5a32, roughness: 0.85 });
  M.metalDark = new THREE.MeshStandardMaterial({ color: 0x34373d, roughness: 0.6, metalness: 0.5 });
  M.metalMid  = new THREE.MeshStandardMaterial({ color: 0x5a5e66, roughness: 0.55, metalness: 0.55 });
  M.concrete  = new THREE.MeshStandardMaterial({ color: 0x9a958c, roughness: 0.95 });
  M.soil      = new THREE.MeshStandardMaterial({ color: 0x3c2c20, roughness: 1.0 });
  M.trash     = new THREE.MeshStandardMaterial({ color: 0x2f6f54, roughness: 0.7, metalness: 0.2 });
  M.trashLid  = new THREE.MeshStandardMaterial({ color: 0x274f3f, roughness: 0.7, metalness: 0.2 });
  M.lampPole  = new THREE.MeshStandardMaterial({ color: 0x2b2e34, roughness: 0.6, metalness: 0.4 });
  M.lampGlass = new THREE.MeshStandardMaterial({ color: 0xfff0b0, emissive: 0xffce72, emissiveIntensity: 1.1, roughness: 0.4 });
  M.flower    = new THREE.MeshStandardMaterial({ color: 0xd8607a, roughness: 0.85, flatShading: true });
  M.paintWhite= new THREE.MeshBasicMaterial({ color: 0xeef0f0 });   // crosswalk / stop bars
  M.paintYellow= new THREE.MeshBasicMaterial({ color: 0xffea88 });  // centre-line dashes

  // --- geometries (unit-ish; positioned/scaled per prop) ---
  G.trunk    = new THREE.CylinderGeometry(0.18, 0.28, 1, 7);          // scaled in Y per tree
  G.canopyLo = new THREE.IcosahedronGeometry(1, 0);                   // faceted leaf blob
  G.canopyHi = new THREE.IcosahedronGeometry(1, 1);                   // rounder leaf blob
  G.cone     = new THREE.ConeGeometry(1, 1, 7);                       // conifer tier
  G.bush     = new THREE.IcosahedronGeometry(1, 0);
  G.hydBody  = new THREE.CylinderGeometry(0.18, 0.22, 0.62, 10);
  G.hydDome  = new THREE.SphereGeometry(0.18, 10, 8);
  G.hydCap   = new THREE.CylinderGeometry(0.1, 0.1, 0.14, 8);
  G.hydBolt  = new THREE.CylinderGeometry(0.09, 0.09, 0.12, 6);
  G.benchSeat= new THREE.BoxGeometry(1.7, 0.08, 0.5);
  G.benchSlat= new THREE.BoxGeometry(1.7, 0.34, 0.08);
  G.benchLeg = new THREE.BoxGeometry(0.1, 0.42, 0.46);
  G.planterBox = new THREE.BoxGeometry(1.5, 0.55, 1.5);
  G.planterRim = new THREE.BoxGeometry(1.62, 0.12, 1.62);
  G.planterSoil= new THREE.BoxGeometry(1.34, 0.1, 1.34);
  G.trashBody= new THREE.CylinderGeometry(0.3, 0.26, 0.78, 12);
  G.trashLid = new THREE.CylinderGeometry(0.33, 0.3, 0.1, 12);
  G.trashBand= new THREE.CylinderGeometry(0.305, 0.305, 0.06, 12);
  G.poleThin = new THREE.CylinderGeometry(0.07, 0.09, 1, 8);          // scaled in Y
  G.poleBase = new THREE.CylinderGeometry(0.18, 0.22, 0.3, 10);
  G.lampArm  = new THREE.BoxGeometry(1.0, 0.1, 0.1);
  G.lampHead = new THREE.BoxGeometry(0.5, 0.22, 0.34);
  G.bannerGeo= new THREE.BoxGeometry(0.04, 0.5, 0.7);
  G.stripe   = new THREE.PlaneGeometry(0.6, 2.6);                     // crosswalk plank
  G.dash     = new THREE.PlaneGeometry(0.3, 2.2);                     // lane dash
  G.flowerHead = new THREE.SphereGeometry(0.09, 6, 5);

  // root group everything hangs off of
  const root = new THREE.Group();
  root.name = 'worldDetail';

  // mark a solid mesh as shadow-casting/receiving (paint decals opt out of cast)
  const solid = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };

  // ============================================================
  // PROP BUILDERS — each returns a Group with feet at Y=0, facing +Z by default.
  // Mesh counts kept lean per the perf budget (person ~14-22 / car ~20-30).
  // ============================================================

  // Street tree: tapered trunk + a couple of overlapping leaf blobs (deciduous)
  // or stacked cones (conifer). ~4-6 meshes. Autumn tint on a few for variety.
  function makeTree() {
    const g = new THREE.Group();
    const conifer = chance(0.28);
    const th = rand(1.8, 2.8);                       // trunk height
    const trunk = solid(new THREE.Mesh(G.trunk, M.bark));
    trunk.scale.y = th; trunk.position.y = th / 2;
    g.add(trunk);

    if (conifer) {
      // 2-3 stacked cone tiers
      const tiers = irand(2, 3);
      const baseR = rand(1.0, 1.4);
      const tierH = rand(1.3, 1.8);
      const mat = chance(0.15) ? M.leafAutumn : M.leafDark;
      for (let i = 0; i < tiers; i++) {
        const f = 1 - i * 0.26;
        const c = solid(new THREE.Mesh(G.cone, mat));
        c.scale.set(baseR * f, tierH, baseR * f);
        c.position.y = th + i * tierH * 0.62 + tierH / 2 - 0.1;
        c.rotation.y = rand(0, Math.PI);
        g.add(c);
      }
    } else {
      // 2-3 leaf blobs clustered into a rounded canopy
      const mat = chance(0.16) ? M.leafAutumn : (chance(0.5) ? M.leaf : M.leafDark);
      const r = rand(1.2, 1.7);
      const blobs = irand(2, 3);
      for (let i = 0; i < blobs; i++) {
        const geo = chance(0.5) ? G.canopyHi : G.canopyLo;
        const c = solid(new THREE.Mesh(geo, mat));
        const s = r * rand(0.7, 1.05);
        c.scale.set(s, s * rand(0.85, 1.05), s);
        c.position.set(rand(-0.5, 0.5), th + r * 0.8 + rand(-0.2, 0.4), rand(-0.5, 0.5));
        c.rotation.set(rand(0, Math.PI), rand(0, Math.PI), 0);
        g.add(c);
      }
    }
    return g;
  }

  // Fire hydrant: short body + dome cap + a side cap each side + top bolt. ~5 meshes.
  function makeHydrant() {
    const g = new THREE.Group();
    const body = solid(new THREE.Mesh(G.hydBody, M.hydrant)); body.position.y = 0.31; g.add(body);
    const dome = solid(new THREE.Mesh(G.hydDome, M.hydrant)); dome.position.y = 0.62; dome.scale.y = 0.8; g.add(dome);
    const bolt = solid(new THREE.Mesh(G.hydBolt, M.hydrantCap)); bolt.position.y = 0.72; g.add(bolt);
    for (const s of [-1, 1]) {
      const cap = solid(new THREE.Mesh(G.hydCap, M.hydrantCap));
      cap.rotation.z = Math.PI / 2;
      cap.position.set(s * 0.22, 0.34, 0);
      g.add(cap);
    }
    const front = solid(new THREE.Mesh(G.hydCap, M.hydrantCap));
    front.rotation.x = Math.PI / 2; front.position.set(0, 0.3, 0.22);
    g.add(front);
    return g;
  }

  // Park bench: slatted seat + back + four legs + arms. ~8 meshes.
  function makeBench() {
    const g = new THREE.Group();
    const seat = solid(new THREE.Mesh(G.benchSeat, M.wood)); seat.position.set(0, 0.46, 0); g.add(seat);
    const back = solid(new THREE.Mesh(G.benchSlat, M.wood)); back.position.set(0, 0.66, -0.21); g.add(back);
    for (const s of [-1, 1]) {
      const leg = solid(new THREE.Mesh(G.benchLeg, M.metalDark));
      leg.position.set(s * 0.72, 0.23, 0); g.add(leg);
      const arm = solid(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.5), M.metalDark));
      arm.position.set(s * 0.8, 0.52, 0); g.add(arm);
    }
    return g;
  }

  // Concrete planter with a low shrub or a few flowers. ~5-7 meshes.
  function makePlanter() {
    const g = new THREE.Group();
    const box = solid(new THREE.Mesh(G.planterBox, M.concrete)); box.position.y = 0.275; g.add(box);
    const rim = solid(new THREE.Mesh(G.planterRim, M.concrete)); rim.position.y = 0.55; g.add(rim);
    const soil = solid(new THREE.Mesh(G.planterSoil, M.soil)); soil.position.y = 0.58; g.add(soil);
    if (chance(0.55)) {
      const shrub = solid(new THREE.Mesh(G.bush, M.bush));
      const s = rand(0.5, 0.72); shrub.scale.set(s, s * 0.8, s); shrub.position.y = 0.78;
      shrub.rotation.set(rand(0, 3), rand(0, 3), 0);
      g.add(shrub);
    } else {
      const tuft = solid(new THREE.Mesh(G.bush, M.leaf));
      tuft.scale.set(0.5, 0.34, 0.5); tuft.position.y = 0.7; g.add(tuft);
      const n = irand(3, 5);
      for (let i = 0; i < n; i++) {
        const f = solid(new THREE.Mesh(G.flowerHead, M.flower));
        f.position.set(rand(-0.45, 0.45), 0.82 + rand(0, 0.06), rand(-0.45, 0.45));
        g.add(f);
      }
    }
    return g;
  }

  // Trash can: tapered drum + lid + a painted band. ~3 meshes.
  function makeTrashCan() {
    const g = new THREE.Group();
    const body = solid(new THREE.Mesh(G.trashBody, M.trash)); body.position.y = 0.39; g.add(body);
    const band = solid(new THREE.Mesh(G.trashBand, M.trashLid)); band.position.y = 0.5; g.add(band);
    const lid = solid(new THREE.Mesh(G.trashLid, M.trashLid)); lid.position.y = 0.82; g.add(lid);
    return g;
  }

  // Low bush clump: 1-3 faceted blobs hugging the ground. ~1-3 meshes.
  function makeBush() {
    const g = new THREE.Group();
    const n = irand(1, 3);
    const mat = chance(0.5) ? M.bush : M.leafDark;
    for (let i = 0; i < n; i++) {
      const b = solid(new THREE.Mesh(G.bush, mat));
      const s = rand(0.5, 0.95);
      b.scale.set(s, s * rand(0.55, 0.78), s);
      b.position.set(rand(-0.6, 0.6), s * 0.4, rand(-0.6, 0.6));
      b.rotation.set(rand(0, 3), rand(0, 3), 0);
      g.add(b);
    }
    return g;
  }

  // Decorative lamp post (richer than the host's pole+bulb): fluted base, tall
  // pole, a cantilever arm, a boxy luminaire head, and an optional little hanging
  // banner. ~5-6 meshes. Glows via an emissive head (no real light, perf-safe).
  function makeLampPost() {
    const g = new THREE.Group();
    const h = rand(3.6, 4.6);
    const base = solid(new THREE.Mesh(G.poleBase, M.lampPole)); base.position.y = 0.15; g.add(base);
    const pole = solid(new THREE.Mesh(G.poleThin, M.lampPole)); pole.scale.y = h; pole.position.y = h / 2 + 0.2; g.add(pole);
    const arm = solid(new THREE.Mesh(G.lampArm, M.lampPole)); arm.position.set(0.45, h + 0.1, 0); g.add(arm);
    const head = solid(new THREE.Mesh(G.lampHead, M.lampGlass)); head.position.set(0.9, h + 0.02, 0); g.add(head);
    const cowl = solid(new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.08, 0.4), M.lampPole)); cowl.position.set(0.9, h + 0.15, 0); g.add(cowl);
    if (chance(0.4)) {
      const banner = solid(new THREE.Mesh(G.bannerGeo, chance(0.5) ? M.hydrant : M.trash));
      banner.position.set(0.12, h - 0.7, 0); g.add(banner);
    }
    return g;
  }

  // ============================================================
  // FLAT ROAD PAINT — crosswalks at intersections + a short centre-line dash run
  // on the approaches. Built as thin Planes laid on the asphalt (y just above 0)
  // with BasicMaterial so they read crisply regardless of lighting. These only
  // RECEIVE no shadow and never cast (they're paint). They don't count against
  // the solid-prop budget.
  // ============================================================
  function addCrosswalk(cx, cz, axis) {
    // axis 'x' => stripes span the street that runs along Z (planks laid across X);
    // we orient a band of ~6 white planks straddling the intersection edge.
    const grp = new THREE.Group();
    grp.position.set(cx, 0.012, cz);
    const planks = 6;
    for (let i = 0; i < planks; i++) {
      const st = new THREE.Mesh(G.stripe, M.paintWhite);
      st.rotation.x = -Math.PI / 2;
      const off = (i - (planks - 1) / 2) * 0.95;
      if (axis === 'x') { st.position.set(off, 0, 0); }
      else { st.position.set(0, 0, off); st.rotation.z = Math.PI / 2; }
      st.receiveShadow = true;
      grp.add(st);
    }
    root.add(grp);
  }

  function addLaneDashes(line, axis, from, to) {
    // dashed centre line down a street: 'axis' is the street's running axis.
    const step = 4.2;
    for (let p = from; p <= to; p += step) {
      if (inExcluded(axis === 'z' ? line : p, axis === 'z' ? p : line, 0)) continue;
      if (Math.hypot(axis === 'z' ? line : p, axis === 'z' ? p : line) < PLAZA_R) continue;
      const d = new THREE.Mesh(G.dash, M.paintYellow);
      d.rotation.x = -Math.PI / 2;
      if (axis === 'z') { d.position.set(line, 0.011, p); }
      else { d.position.set(p, 0.011, line); d.rotation.z = Math.PI / 2; }
      d.receiveShadow = true;
      root.add(d);
    }
  }

  // ============================================================
  // LAYOUT — drive every placement off the seeded rng.
  // ============================================================

  // counters so we report a believable mix and stay under MAX_PROPS
  const counts = { tree: 0, hydrant: 0, bench: 0, planter: 0, trash: 0, bush: 0, lamp: 0 };

  // Add a solid prop instance at (x,z) facing yaw; records it for spacing + budget.
  function place(kind, x, z, yaw, minD, corePad) {
    if (placed.length >= MAX_PROPS) return false;
    if (!accept(x, z, minD, corePad)) return false;
    let m;
    switch (kind) {
      case 'tree': m = makeTree(); break;
      case 'hydrant': m = makeHydrant(); break;
      case 'bench': m = makeBench(); break;
      case 'planter': m = makePlanter(); break;
      case 'trash': m = makeTrashCan(); break;
      case 'bush': m = makeBush(); break;
      case 'lamp': m = makeLampPost(); break;
      default: return false;
    }
    m.position.set(x, 0, z);
    m.rotation.y = yaw != null ? yaw : rand(0, Math.PI * 2);
    root.add(m);
    placed.push({ x, z });
    counts[kind]++;
    return true;
  }

  // ---- 1) CORNER ACCENTS — a hydrant or lamp on the street corners -----------
  // Block corners are classic spots for hydrants and decorative lamp posts. Run
  // this FIRST so the signature street furniture (hydrants especially) is always
  // represented before the heavier tree fill eats into the prop budget.
  for (const b of blocks) {
    if (placed.length >= MAX_PROPS) break;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      if (!chance(0.4)) continue;
      const x = b.cx + sx * (SIDEWALK + 0.6) + rand(-0.3, 0.3);
      const z = b.cz + sz * (SIDEWALK + 0.6) + rand(-0.3, 0.3);
      const kind = chance(0.55) ? 'hydrant' : 'lamp';
      const yaw = Math.atan2(-sx, -sz);   // face toward the block (kerb)
      place(kind, x, z, kind === 'lamp' ? yaw + Math.PI : yaw, 2.6, 0.2);
    }
  }

  // ---- 2) SIDEWALK FURNITURE around each occupied block ----------------------
  // Walk the four sidewalk edges of every block. Each edge offers a row of slots;
  // we sample a subset and drop a type weighted toward trees, with the prop
  // pushed onto the sidewalk ring and oriented to face the street (outward).
  const EDGES = [
    { nx: 0, nz: -1, yaw: 0 },          // -Z edge faces toward -Z street
    { nx: 0, nz: 1, yaw: Math.PI },     // +Z edge
    { nx: -1, nz: 0, yaw: Math.PI / 2 },// -X edge
    { nx: 1, nz: 0, yaw: -Math.PI / 2 },// +X edge
  ];
  // ordered slot positions along an edge (perpendicular offset from centre)
  const SLOTS = [-7, -4.6, -2.2, 0, 2.2, 4.6, 7];

  // a weighted bag for sidewalk picks (trees dominate, then benches/planters/etc.)
  const sidewalkBag = [
    'tree', 'tree', 'tree', 'tree',
    'bush', 'bush',
    'bench', 'planter',
    'trash', 'lamp',
  ];

  // Soft per-block budget so no single block hogs the cap and every block gets
  // dressed — keeps trees from saturating MAX_PROPS before later blocks/types.
  for (const b of blocks) {
    if (placed.length >= MAX_PROPS) break;
    let perBlock = 0;
    for (const e of EDGES) {
      if (perBlock >= 4) break;
      // edge centre point on the sidewalk ring
      const ex = b.cx + e.nx * SIDEWALK;
      const ez = b.cz + e.nz * SIDEWALK;
      // sample 1-2 slots per edge
      const slots = SLOTS.slice();
      // light shuffle via rng so the chosen slots vary deterministically per edge
      for (let i = slots.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const t = slots[i]; slots[i] = slots[j]; slots[j] = t; }
      const take = irand(1, 2);
      for (let s = 0; s < take && s < slots.length; s++) {
        const off = slots[s];
        // offset runs ALONG the edge (perpendicular to its outward normal)
        const along = { x: -e.nz, z: e.nx };
        const x = ex + along.x * off + rand(-0.4, 0.4);
        const z = ez + along.z * off + rand(-0.4, 0.4);
        const kind = pick(sidewalkBag);
        // trees/bushes get a little yaw wobble; furniture faces the street square.
        if (place(kind, x, z, e.yaw + (kind === 'tree' || kind === 'bush' ? rand(-0.3, 0.3) : 0), 2.4, 0.2)) perBlock++;
      }
    }
  }

  // ---- 3) BUSH FILLER — a few low bushes loosely scattered on sidewalks ------
  let bushTries = 0;
  while (counts.bush < 12 && bushTries < 90 && placed.length < MAX_PROPS) {
    bushTries++;
    const b = pick(blocks);
    const ang = rand(0, Math.PI * 2);
    const rr = SIDEWALK + rand(-1.2, 1.6);
    const x = b.cx + Math.cos(ang) * rr;
    const z = b.cz + Math.sin(ang) * rr;
    place('bush', x, z, null, 2.0, 0.1);
  }

  // ---- 4) ROAD PAINT — crosswalks + lane dashes near the intersections -------
  // Intersections sit where two cross-streets meet: x,z ∈ { k*BLOCK+OFFSET }.
  // The host streets run at ±12, ±36 (and the centre seam near 0). We lay
  // crosswalk bands on the four approaches of a handful of intersections and a
  // short dashed centre-line down the nearest street segment.
  const lines = [];
  for (let k = -2; k <= 2; k++) {
    const v = k * BLOCK + ROAD_OFFSET;          // e.g. -36,-12,12,36 (60 clamped out)
    if (Math.abs(v) <= BOUND - 2) lines.push(v);
  }
  // de-dupe + sort
  const uniq = [...new Set(lines)].sort((a, b) => a - b);

  for (const lx of uniq) {
    for (const lz of uniq) {
      if (inExcluded(lx, lz, 1)) continue;
      if (Math.hypot(lx, lz) < PLAZA_R + 2) continue;     // skip the open plaza
      // only dress a deterministic subset of intersections so it's not uniform
      if (!chance(0.7)) continue;
      // four crosswalk bands, set back ~6 units onto each approach
      addCrosswalk(lx, lz - 6, 'x');
      addCrosswalk(lx, lz + 6, 'x');
      addCrosswalk(lx - 6, lz, 'z');
      addCrosswalk(lx + 6, lz, 'z');
    }
  }

  // centre-line dashes down each street line, across the map (skipping plaza/excludes)
  for (const lx of uniq) addLaneDashes(lx, 'z', -(BOUND - 4), BOUND - 4);
  for (const lz of uniq) addLaneDashes(lz, 'x', -(BOUND - 4), BOUND - 4);

  // ============================================================
  // OPTIMIZE — collapse the hundreds of static prop/paint meshes into a handful
  // of InstancedMesh batches (one draw call per geometry+material pair). All the
  // dressing is static and already shares geometries/materials, so this is a big
  // draw-call win (≈ 860 → ~70) with zero visual change. Defensive: any failure
  // just leaves the plain meshes in place.
  // ============================================================
  let drawsBefore = 0, drawsAfter = 0;
  if (opts.instance !== false) {
    try { const r = instancifyStatics(THREE, root); drawsBefore = r.before; drawsAfter = r.after; }
    catch (e) { try { console.warn('[worldDetail] instancing skipped', e); } catch (_) {} }
  }

  // ============================================================
  // FINALISE — one add to the scene; return the handle.
  // ============================================================
  scene.add(root);

  // small machine-readable summary on the group for debugging / HUD overlays
  root.userData.detail = {
    props: placed.length,
    counts: { ...counts },
    seed: opts.seed != null ? opts.seed : 0x57DE7A11,
    bound: BOUND,
    drawsBefore, drawsAfter,
  };
  return root;
}

// ------------------------------------------------------------
// instancifyStatics — turn a tree of static single-material Meshes into a small
// set of InstancedMesh batches keyed by (geometry, material). World matrices are
// baked into the instances, so the look is byte-identical; only the draw-call
// count drops. Buckets with a single member are left as plain meshes (nothing to
// gain). Frustum culling is disabled per batch because an InstancedMesh culls by
// the BASE geometry's bounds, not the spread of its instances — without this,
// props spread across the map would wrongly vanish when the origin prop is
// off-screen. (One always-drawn batch is far cheaper than the meshes it replaces.)
// Returns { before, after } draw-call counts for reporting.
// ------------------------------------------------------------
function instancifyStatics(THREE, root) {
  if (!THREE.InstancedMesh) return { before: 0, after: 0 };
  root.updateMatrixWorld(true);
  const buckets = new Map();          // key -> { geo, mat, items:[Mesh] }
  let before = 0;
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || Array.isArray(o.material) || !o.geometry || !o.material) return;
    before++;
    const key = o.geometry.uuid + '|' + o.material.uuid;
    let b = buckets.get(key);
    if (!b) { b = { geo: o.geometry, mat: o.material, items: [] }; buckets.set(key, b); }
    b.items.push(o);
  });

  let after = 0;
  const m4 = new THREE.Matrix4();
  for (const b of buckets.values()) {
    if (b.items.length < 2) { after++; continue; }   // leave singletons as-is
    const inst = new THREE.InstancedMesh(b.geo, b.mat, b.items.length);
    inst.castShadow = b.items.some((m) => m.castShadow);
    inst.receiveShadow = b.items.some((m) => m.receiveShadow);
    inst.frustumCulled = false;
    for (let i = 0; i < b.items.length; i++) {
      b.items[i].updateWorldMatrix(true, false);
      inst.setMatrixAt(i, b.items[i].matrixWorld);
    }
    inst.instanceMatrix.needsUpdate = true;
    root.add(inst);
    after++;
    for (const m of b.items) m.removeFromParent();
  }
  // sweep up now-empty prop Groups so the tree stays tidy (purely cosmetic)
  const empties = [];
  root.traverse((o) => { if (o !== root && o.isGroup && o.children.length === 0) empties.push(o); });
  for (const g of empties) g.removeFromParent();

  return { before, after };
}

export default buildWorldDetail;
