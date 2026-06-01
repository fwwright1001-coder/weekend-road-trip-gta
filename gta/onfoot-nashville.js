// ============================================================
// gta/onfoot-nashville.js — re-skins the on-foot town as downtown NASHVILLE
// ------------------------------------------------------------
// onfoot3d.js builds a generic walkable town (5x5 block grid on a 24-unit CELL,
// cross-streets, an open spawn plaza, half-size BOUND=58). This module dresses
// that same footprint as recognizable downtown Nashville: a neon Lower-Broadway
// honky-tonk strip, the AT&T "Batman Building", the Country Music Hall of Fame,
// the Ryman Auditorium, the Tennessee State Capitol on its hill, plus the
// Cumberland River, the John Seigenthaler pedestrian bridge and a Nissan-Stadium
// hint across the water — all as bold LOW-POLY landmarks (silhouette + colour +
// neon do the work; this is not photogrammetry).
//
// CONTRACT — same discipline as onfoot-detail.js so it bolts on with no risk:
//   * 100% code-generated geometry (Box/Cylinder/Cone/Sphere/Plane/Torus/Ring)
//     + procedural CanvasTextures for signage. NO loaders, asset files or URLs.
//   * THREE is passed in (the host already imports it); we never import it.
//   * One SEEDED rng → the city is identical every visit.
//   * Everything parents to ONE Group, added to `scene` and returned, so the
//     caller can hide/dispose it wholesale.
//   * Right-handed, Y up (+X = east toward the river, -Z = north toward the
//     Capitol); landmarks rest their feet at Y=0. Walkable hero buildings push
//     an AABB onto the host's shared `aabbs` (passed via opts) for collision;
//     backdrops live beyond BOUND where the player is already clamped, so they
//     need none.
//   * Every landmark mesh is tagged userData.noTex = true so the later
//     beautifyScene pass leaves its hand-picked look alone (it still gets bloom,
//     which is what makes the neon read).
//
// USAGE (from onfoot3d.ensureInit, after the block grid is built, before peds):
//     import { buildNashville } from './gta/onfoot-nashville.js';
//     buildNashville(THREE, scene, { aabbs, bound: BOUND, cell: CELL });
// ============================================================

// ------------------------------------------------------------
// buildNashville — the single public entry point.
//   THREE : the Three.js namespace (from the host).
//   scene : the host scene to add the city group to.
//   opts  : { seed?, aabbs?: [], bound?, cell? }
// Returns the root Group (so the caller can keep a handle).
// ------------------------------------------------------------
export function buildNashville(THREE, scene, opts = {}) {
  const BOUND = opts.bound != null ? opts.bound : 58;
  const CELL  = opts.cell  != null ? opts.cell  : 24;
  const aabbs = Array.isArray(opts.aabbs) ? opts.aabbs : [];

  // --- seeded RNG (same LCG family as the host) -----------------------------
  let _s = (opts.seed != null ? opts.seed : 0x4E415348) >>> 0; // "NASH"
  const rng   = () => { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; };
  const rand  = (a, b) => a + rng() * (b - a);
  const pick  = (arr) => arr[(rng() * arr.length) | 0];
  const chance = (p) => rng() < p;

  const root = new THREE.Group();
  root.name = 'nashville';

  // --- shared materials (cheap to reuse; landmarks opt out of beautifyScene) -
  const M = {
    limestone: new THREE.MeshStandardMaterial({ color: 0xc9bfa6, roughness: 0.92 }),
    stone:     new THREE.MeshStandardMaterial({ color: 0xb3a98e, roughness: 0.95 }),
    concrete:  new THREE.MeshStandardMaterial({ color: 0x8b8f96, roughness: 0.95 }),
    darkConc:  new THREE.MeshStandardMaterial({ color: 0x4f535b, roughness: 0.9 }),
    brick:     new THREE.MeshStandardMaterial({ color: 0x8a4536, roughness: 0.95 }),
    brickDk:   new THREE.MeshStandardMaterial({ color: 0x6f3528, roughness: 0.95 }),
    glassBlue: new THREE.MeshPhysicalMaterial({ color: 0x3c5a6b, roughness: 0.18, metalness: 0.2, clearcoat: 0.6 }),
    glassTeal: new THREE.MeshPhysicalMaterial({ color: 0x2f5560, roughness: 0.16, metalness: 0.25, clearcoat: 0.6 }),
    steelGrn:  new THREE.MeshStandardMaterial({ color: 0x2f7d54, roughness: 0.6, metalness: 0.35 }), // bridge truss
    metalDk:   new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.6 }),
    white:     new THREE.MeshStandardMaterial({ color: 0xeae6da, roughness: 0.85 }),
    blackKey:  new THREE.MeshStandardMaterial({ color: 0x16171c, roughness: 0.6 }),
    water:     new THREE.MeshPhysicalMaterial({ color: 0x274a5e, roughness: 0.22, metalness: 0.1, clearcoat: 0.5 }),
    grass:     new THREE.MeshStandardMaterial({ color: 0x5f7d49, roughness: 1 }),
    roof:      new THREE.MeshStandardMaterial({ color: 0x3b3f47, roughness: 0.9 }),
    copper:    new THREE.MeshStandardMaterial({ color: 0x6fae93, roughness: 0.55, metalness: 0.4 }), // weathered Capitol dome/tower
  };

  // ------------------------------------------------------------
  // tiny geometry helpers (feet at Y=0 unless stated)
  // ------------------------------------------------------------
  const box = (w, h, d, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    return m;
  };
  const cyl = (rt, rb, h, mat, x = 0, y = 0, z = 0, seg = 18) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    return m;
  };
  const cone = (r, h, mat, x = 0, y = 0, z = 0, seg = 14) => {
    const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    return m;
  };

  // Emissive "neon" — unlit so it glows flat, and bloom (installRealism) blooms it.
  const neonMat = (hex) => new THREE.MeshBasicMaterial({ color: hex });

  // ------------------------------------------------------------
  // procedural CanvasTexture signage (degrades to null when headless)
  // ------------------------------------------------------------
  function signTexture(text, { fg = '#ff39a8', bg = '#140019', font = 700, wpx = 512, hpx = 160 } = {}) {
    if (typeof document === 'undefined') return null;
    let c;
    try { c = document.createElement('canvas'); } catch (e) { return null; }
    c.width = wpx; c.height = hpx;
    const g = c.getContext('2d'); if (!g) return null;
    g.fillStyle = bg; g.fillRect(0, 0, wpx, hpx);
    // neon border
    g.strokeStyle = fg; g.lineWidth = 10; g.shadowColor = fg; g.shadowBlur = 26;
    g.strokeRect(14, 14, wpx - 28, hpx - 28);
    // text
    let size = Math.min(hpx * 0.5, (wpx * 1.7) / Math.max(1, text.length));
    g.font = `${font} ${size}px Georgia, "Times New Roman", serif`;
    g.fillStyle = '#fff7fb'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = fg; g.shadowBlur = 22;
    g.fillText(text, wpx / 2, hpx / 2 + 2);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.needsUpdate = true;
    return t;
  }

  // A flat neon sign panel. Falls back to a plain emissive panel if no canvas.
  function signPanel(text, w, h, opts = {}) {
    const tex = signTexture(text, opts);
    const mat = tex
      ? new THREE.MeshBasicMaterial({ map: tex })
      : neonMat(opts.fg ? new THREE.Color(opts.fg).getHex() : 0xff39a8);
    mat.side = THREE.FrontSide;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    // Signs mount on the buildings' north (−Z) faces. A PlaneGeometry's text only
    // reads correctly from its +Z side, so rotate 180° about Y to point the front
    // at the street/plaza the player views from — otherwise they see the mirrored
    // back of the plane. FrontSide then hides the (mirrored) back entirely.
    m.rotation.y = Math.PI;
    return m;
  }

  // Tileable lit-window facade texture for the tall towers (or null when headless).
  function windowTexture(baseHex, litHex) {
    if (typeof document === 'undefined') return null;
    let c;
    try { c = document.createElement('canvas'); } catch (e) { return null; }
    const COLS = 6, ROWS = 8, S = 24;
    c.width = COLS * S; c.height = ROWS * S;
    const g = c.getContext('2d'); if (!g) return null;
    g.fillStyle = '#' + baseHex.toString(16).padStart(6, '0'); g.fillRect(0, 0, c.width, c.height);
    for (let r = 0; r < ROWS; r++) for (let col = 0; col < COLS; col++) {
      const lit = rng() < 0.5;
      g.fillStyle = lit ? ('#' + litHex.toString(16).padStart(6, '0')) : '#1a1d22';
      g.fillRect(col * S + 4, r * S + 4, S - 8, S - 9);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
    return t;
  }

  // A tall tower body whose four walls show lit windows (texture) or a flat colour.
  function towerShell(w, h, d, baseHex, litHex, repX = 3, repY = 6) {
    const tex = windowTexture(baseHex, litHex);
    let mat;
    if (tex) {
      tex.repeat.set(repX, repY);
      mat = new THREE.MeshStandardMaterial({
        map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.5, roughness: 0.55,
      });
    } else {
      mat = new THREE.MeshStandardMaterial({ color: baseHex, roughness: 0.6 });
    }
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.castShadow = true; m.receiveShadow = true; m.position.y = h / 2;
    return m;
  }

  // ------------------------------------------------------------
  // bookkeeping: tag a finished landmark so beautifyScene skips it, parent it,
  // optionally register a walkable collision footprint.
  // ------------------------------------------------------------
  function place(group, x, z, footprint /* {w,d} | null */, ry = 0) {
    group.position.set(x, group.position.y || 0, z);
    group.rotation.y = ry;
    group.traverse((o) => {
      o.userData = o.userData || {};
      o.userData.noTex = true;
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    root.add(group);
    if (footprint) {
      // footprint is axis-aligned in local space; only rotations of 0/±90/180
      // are used for walkable buildings, so swap w/d on quarter turns.
      let { w, d } = footprint;
      const q = Math.abs(Math.round((ry / (Math.PI / 2)))) % 2;
      if (q === 1) { const t = w; w = d; d = t; }
      aabbs.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
    }
    return group;
  }

  // ============================================================
  // LANDMARK BUILDERS  (each returns a Group with feet at Y=0)
  // ============================================================

  // --- AT&T "Batman Building": stepped tower + the two signature corner spires.
  function batmanBuilding() {
    const g = new THREE.Group();
    const W = 15, D = 13;
    // stacked, slightly setback tiers
    const tiers = [
      { w: W,        d: D,        h: 30, y0: 0 },
      { w: W * 0.84, d: D * 0.84, h: 16, y0: 30 },
      { w: W * 0.66, d: D * 0.66, h: 12, y0: 46 },
    ];
    let top = 0;
    for (const t of tiers) {
      const shell = towerShell(t.w, t.h, t.d, 0x5c6b78, 0xffd98a, 3, Math.max(3, (t.h / 4) | 0));
      shell.position.y = t.y0 + t.h / 2;
      g.add(shell);
      top = t.y0 + t.h;
    }
    // crown slab the spires sit on
    g.add(box(W * 0.66, 3, D * 0.66, M.darkConc, 0, top + 1.5, 0));
    top += 3;
    // the two "ears": tall thin tapered spires at the front corners + a center mast
    const earMat = M.metalDk;
    const earX = W * 0.66 * 0.42;
    g.add(cone(0.7, 22, earMat, -earX, top + 11, D * 0.18, 6));
    g.add(cone(0.7, 22, earMat,  earX, top + 11, D * 0.18, 6));
    g.add(cone(0.55, 14, earMat, 0, top + 7, -D * 0.1, 6));
    // a couple of red aviation lights on the spire tips (neon dots)
    const redDot = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8), neonMat(0xff3b30));
    redDot.position.set(-earX, top + 22, D * 0.18); g.add(redDot);
    const redDot2 = redDot.clone(); redDot2.position.x = earX; g.add(redDot2);
    return g;
  }

  // --- Country Music Hall of Fame: long body + piano-key façade + drum rotunda
  //     with the tall WSM-radio-tower spire, and a sloped "fin" wing.
  function hallOfFame() {
    const g = new THREE.Group();
    const W = 26, H = 9, D = 13;
    g.add(box(W, H, D, M.limestone, 0, H / 2, 0));
    // piano-key window slats across the north (−Z) face
    const keys = 19, kw = W / keys;
    for (let i = 0; i < keys; i++) {
      const white = i % 2 === 0;
      const k = box(kw * 0.82, H * 0.6, 0.5, white ? M.white : M.blackKey,
        -W / 2 + kw * (i + 0.5), H * 0.5, -D / 2 - 0.2);
      g.add(k);
    }
    // sloped "fin" wing on the west end (a wedge of limestone rising to a point)
    const fin = box(7, 13, D, M.stone, -W / 2 - 2.5, 6.5, 0);
    fin.rotation.z = 0.32; g.add(fin);
    // drum rotunda on the east end + tall thin spire
    g.add(cyl(5, 5.6, 13, M.concrete, W / 2 + 1, 6.5, 0, 22));
    g.add(cyl(5.2, 5.2, 1.2, M.darkConc, W / 2 + 1, 13.2, 0, 22)); // cap ring
    g.add(cyl(0.22, 0.4, 20, M.metalDk, W / 2 + 1, 23, 0, 8));     // WSM-style mast
    const spireDot = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 8), neonMat(0xff3b30));
    spireDot.position.set(W / 2 + 1, 33, 0); g.add(spireDot);
    // marquee sign on the façade
    const sign = signPanel('COUNTRY MUSIC HALL OF FAME', 16, 2.4, { fg: '#ffd24a', bg: '#1a1205', wpx: 640, hpx: 128 });
    sign.position.set(0, H + 1.6, -D / 2 - 0.3); g.add(sign);
    return g;
  }

  // --- Ryman Auditorium: red-brick gabled "Mother Church" with arched windows.
  function ryman() {
    const g = new THREE.Group();
    const W = 15, H = 11, D = 21;
    g.add(box(W, H, D, M.brick, 0, H / 2, 0));
    // gable roof (two sloped slabs meeting at a ridge, running along Z)
    const r1 = box(W * 0.74, 0.6, D + 0.6, M.roof, -W * 0.2, H + 1.6, 0); r1.rotation.z = 0.5; g.add(r1);
    const r2 = box(W * 0.74, 0.6, D + 0.6, M.roof,  W * 0.2, H + 1.6, 0); r2.rotation.z = -0.5; g.add(r2);
    // front gable end (triangular, facing −Z / Broadway)
    const gableEnd = new THREE.Mesh(new THREE.ConeGeometry(W * 0.72, 4.5, 3), M.brickDk);
    gableEnd.rotation.y = Math.PI / 2; gableEnd.position.set(0, H + 2.2, -D / 2); g.add(gableEnd);
    // tall arched windows down each flank (box + half-round top)
    const winMat = new THREE.MeshStandardMaterial({ color: 0xf2dd9c, emissive: 0xd9b24a, emissiveIntensity: 0.5, roughness: 0.5 });
    for (let i = -2; i <= 2; i++) {
      for (const sx of [-1, 1]) {
        const z = i * (D / 5.5);
        g.add(box(1.4, 4.2, 0.4, winMat, sx * (W / 2 + 0.02), 4.6, z));
        const arch = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.4, 10, 1, false, 0, Math.PI), winMat);
        arch.rotation.z = Math.PI / 2; arch.rotation.y = Math.PI / 2;
        arch.position.set(sx * (W / 2 + 0.02), 6.8, z); g.add(arch);
      }
    }
    const sign = signPanel('RYMAN AUDITORIUM', 8.5, 1.7, { fg: '#9fd0ff', bg: '#06121f', wpx: 512, hpx: 110 });
    sign.position.set(0, H - 1.5, -D / 2 - 0.25); g.add(sign);
    return g;
  }

  // --- One Lower-Broadway honky-tonk: storefront + glowing marquee + neon blade.
  //     `color` is a CSS hex string (used both as the canvas sign glow + the blade).
  function honkyTonk(name, color) {
    const hexNum = new THREE.Color(color).getHex();
    const g = new THREE.Group();
    const W = rand(7, 9), H = rand(5.5, 7.5), D = 3.4;
    const wallTone = pick([0x6a4f3a, 0x7a3f6a, 0x394a6a, 0x6a3a3a, 0x3a6a55]);
    g.add(box(W, H, D, new THREE.MeshStandardMaterial({ color: wallTone, roughness: 0.85 }), 0, H / 2, 0));
    // lit ground-floor windows / doorway glow (facing −Z, toward the street)
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.8, 2.4), neonMat(0xffe1a8));
    glow.position.set(0, 1.5, -D / 2 - 0.02); glow.rotation.y = Math.PI; g.add(glow);
    // horizontal marquee over the door
    const marquee = signPanel(name, W * 0.92, 1.6, { fg: color, bg: '#0c0010', wpx: 512, hpx: 120 });
    marquee.position.set(0, H - 1.3, -D / 2 - 0.05); g.add(marquee);
    // a tall vertical neon "blade" jutting off the corner (the Broadway look),
    // sat just in front of a dark backing board so it reads as a lit sign.
    const bladeBack = box(0.5, H * 0.95 + 0.4, 1.6, M.metalDk, W / 2 - 0.2, H * 0.75, -D / 2 - 0.72);
    g.add(bladeBack);
    const blade = box(0.4, H * 0.95, 1.4, neonMat(hexNum), W / 2 - 0.2, H * 0.75, -D / 2 - 0.7);
    blade.castShadow = false; g.add(blade);
    return { group: g, w: W, d: D };
  }

  // --- Tennessee State Capitol (backdrop): colonnaded base + tiered cupola tower.
  function capitol() {
    const g = new THREE.Group();
    const W = 30, H = 11, D = 18;
    g.add(box(W, H, D, M.limestone, 0, H / 2, 0));
    // portico columns across the south face
    for (let i = -5; i <= 5; i++) {
      g.add(cyl(0.7, 0.7, H, M.white, i * (W / 12), H / 2, D / 2 + 1, 12));
    }
    g.add(box(W * 0.55, 1.2, 4, M.stone, 0, H + 0.6, D / 2 + 1)); // portico entablature
    const ped = box(W * 0.34, 5, D * 0.5, M.limestone, 0, H + 2.5, 0); g.add(ped); // tower base
    // square tiered cupola (Greek-revival lantern) topped with a small dome
    g.add(box(7, 7, 7, M.stone, 0, H + 8.5, 0));
    for (let i = 0; i < 8; i++) { // lantern columns
      const a = (i / 8) * Math.PI * 2;
      g.add(cyl(0.4, 0.4, 6, M.white, Math.cos(a) * 3.2, H + 15, Math.sin(a) * 3.2, 8));
    }
    g.add(cyl(3.6, 3.6, 1, M.stone, 0, H + 18.2, 0, 10));
    g.add(cyl(0.1, 2.6, 4, M.copper, 0, H + 20.7, 0, 10)); // small spire/dome
    return g;
  }

  // --- Nissan Stadium (backdrop): an open elliptical bowl across the river.
  function stadium() {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(20, 22, 9, 32, 1, true), M.concrete);
    ring.position.y = 4.5; ring.scale.z = 0.78; g.add(ring);
    const field = new THREE.Mesh(new THREE.CircleGeometry(16, 32), M.grass);
    field.rotation.x = -Math.PI / 2; field.position.y = 0.1; field.scale.y = 0.78; g.add(field);
    // light towers
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      g.add(cyl(0.4, 0.4, 14, M.metalDk, Math.cos(a) * 19, 7, Math.sin(a) * 15, 6));
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.2, 0.4), neonMat(0xfff2c4));
      lamp.position.set(Math.cos(a) * 18, 14, Math.sin(a) * 14); g.add(lamp);
    }
    return g;
  }

  // --- a tall generic downtown filler tower (skyline behind the hero buildings).
  function fillerTower(h) {
    const g = new THREE.Group();
    const w = rand(8, 13), d = rand(8, 13);
    const palettes = [[0x46606e, 0xffd98a], [0x55525a, 0xbfe0ff], [0x6b5f4c, 0xffe6a8], [0x33454f, 0x9fd8ff]];
    const [base, lit] = pick(palettes);
    g.add(towerShell(w, h, d, base, lit, 3, Math.max(4, (h / 4) | 0)));
    if (chance(0.5)) g.add(box(w * 0.5, 3, d * 0.5, M.darkConc, 0, h + 1.5, 0)); // rooftop block
    return g;
  }

  // ============================================================
  // ASSEMBLE THE CITY
  // ============================================================

  // --- ground: a wide grass apron beyond the asphalt already reads; add the
  //     Cumberland River down the east side + its grassy far bank. ------------
  {
    const river = new THREE.Mesh(new THREE.PlaneGeometry(40, 220), M.water);
    river.rotation.x = -Math.PI / 2; river.position.set(82, 0.04, -10); river.receiveShadow = true;
    river.userData.noTex = true; root.add(river);
    const farBank = new THREE.Mesh(new THREE.PlaneGeometry(120, 220), M.grass);
    farBank.rotation.x = -Math.PI / 2; farBank.position.set(162, 0.02, -10); farBank.receiveShadow = true;
    farBank.userData.noTex = true; root.add(farBank);
    // riverfront edge (west bank wall, just past the play area)
    const wall = box(2, 2, 200, M.concrete, 60, 0.6, -10); wall.userData.noTex = true; root.add(wall);
  }

  // --- HERO LANDMARKS (walkable; reserved grid cells keep filler off them) ---
  place(batmanBuilding(), -1 * CELL, -1 * CELL, { w: 15, d: 13 });        // (-24,-24) NW skyline anchor
  place(hallOfFame(),       0 * CELL,  1 * CELL, { w: 26, d: 13 });        // (0,24) south of Broadway
  place(ryman(),            1 * CELL,  0 * CELL, { w: 15, d: 21 });        // (24,0) just north of Broadway

  // --- LOWER BROADWAY: a neon honky-tonk strip just south of the spawn plaza,
  //     facing north (−Z) at the player. Sits in the street gap (z≈10) between
  //     the plaza and the gz=1 building row, clear of the cross-street + cars. -
  {
    const names = ['TOOTSIE\'S', 'ROBERT\'S', 'LEGENDS', 'THE STAGE', 'HONKY TONK', 'WHISKEY ROW', 'BOOT SCOOT', 'NUDIE\'S'];
    const neon  = ['#b14ddb', '#ff5d3b', '#ffd24a', '#4ad6ff', '#ff39a8', '#7CFF5D', '#ff8c1a', '#ff4d6d'];
    const z = 10, depth = 3.4;
    let x = -40;
    for (let i = 0; i < names.length; i++) {
      const { group, w } = honkyTonk(names[i], neon[i]);
      place(group, x + w / 2, z, { w: w, d: depth });
      x += w + rand(1.2, 2.4);
    }
    // a "Welcome to Nashville — Music City" sign arched over the strip's west end
    const arch = new THREE.Group();
    arch.add(cyl(0.5, 0.5, 9, M.metalDk, -7, 4.5, 0, 8));
    arch.add(cyl(0.5, 0.5, 9, M.metalDk,  7, 4.5, 0, 8));
    arch.add(box(15.5, 1, 1, M.metalDk, 0, 9, 0));
    const welcome = signPanel('WELCOME TO NASHVILLE', 13, 2.2, { fg: '#ffd24a', bg: '#100018', wpx: 640, hpx: 128 });
    welcome.position.set(0, 9, 0.05); arch.add(welcome);
    const music = signPanel('MUSIC CITY', 7, 1.5, { fg: '#ff39a8', bg: '#100018', wpx: 384, hpx: 96 });
    music.position.set(0, 6.6, 0.05); arch.add(music);
    place(arch, -46, 9, null);
  }

  // --- a giant neon guitar landmark by the plaza (instant "Music City" read) --
  {
    const gtr = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CircleGeometry(2.2, 24), neonMat(0xffb43a));
    body.scale.set(1, 1.15, 1);
    const neck = box(0.7, 7, 0.2, neonMat(0xfff0c0), 0, 6, 0);
    const head = box(1.3, 1.6, 0.25, neonMat(0xff5d3b), 0, 10, 0);
    const hole = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.75, 20), neonMat(0x140019));
    hole.position.z = 0.02;
    gtr.add(body, neck, head, hole);
    gtr.position.y = 2.5; gtr.rotation.z = 0.18;
    const pole = box(0.5, 2.6, 0.5, M.metalDk, 0, 1.3, 0);
    const stand = new THREE.Group(); stand.add(pole, gtr);
    place(stand, 12, 6, null);
  }

  // --- BACKDROPS beyond BOUND (player is clamped, so no collision needed) -----
  place(capitol(), -26, -86, null);                         // up the hill, due north
  // a low green hill under the Capitol so it sits "above" downtown (crests near
  // ground at the play-area edge, only rising into a knoll further north)
  {
    const hill = new THREE.Mesh(new THREE.SphereGeometry(46, 24, 16), M.grass);
    hill.scale.set(1, 0.16, 1); hill.position.set(-26, -6.5, -86);
    hill.userData.noTex = true; hill.receiveShadow = true; root.add(hill);
  }
  place(stadium(), 130, 8, null);                            // across the river, east
  // pedestrian bridge: green truss spanning the river on Broadway's axis (z≈10)
  {
    const br = new THREE.Group();
    const span = 44, y = 6;
    br.add(box(span, 0.8, 4, M.steelGrn, 0, y, 0));          // deck
    for (let i = -1; i <= 1; i += 2) {                       // two shallow truss arches
      const arch = new THREE.Mesh(new THREE.TorusGeometry(span * 0.5, 0.5, 6, 24, Math.PI), M.steelGrn);
      arch.position.set(0, y - 0.2, i * 2.4); br.add(arch);
    }
    for (let x = -span / 2 + 3; x <= span / 2 - 3; x += 6) { // vertical hangers
      br.add(box(0.35, 5, 0.35, M.steelGrn, x, y + 2, 0));
    }
    for (let i = -1; i <= 1; i += 2) { br.add(cyl(0.8, 1, 7, M.concrete, i * span * 0.42, 3.5, 0, 10)); } // piers
    place(br, 82, 10, null);
  }

  // --- distant skyline filler towers ringing the NW/N (behind the hero set) ---
  const skyline = [
    [-66, -54, 46], [-44, -78, 52], [-78, -28, 40], [-70, -72, 60],
    [-30, -70, 38], [-90, -50, 44], [12, -84, 50], [-52, -94, 56],
  ];
  for (const [x, z, h] of skyline) place(fillerTower(h), x, z, null);

  scene.add(root);
  return root;
}
