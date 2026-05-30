// ============================================================
// gta/onfoot-bank.js — a single, detailed, 100%-code-generated BANK building
// for the on-foot crime sandbox. No textures, no loaders, no asset files: every
// surface is procedural Box/Cylinder/Cone/Sphere geometry with MeshStandard/
// Physical/Basic materials, in the same low-poly stylized-realistic key as the
// rest of onfoot3d's town.
// ------------------------------------------------------------
// WHAT IT IS: a classical stone/marble bank — wide front STEPS, a colonnade of
// fluted COLUMNS under a triangular PEDIMENT roof, a recessed double-door
// ENTRANCE (the doorway is left OPEN so the player walks straight in), side and
// back walls, and an interior VAULT ROOM at the back holding a big round metal
// VAULT DOOR and a loot PEDESTAL where the heist's "goop" sits. Emissive sign
// bars over the door give the "BANK" read without any text glyphs.
//
// COORDINATE CONTRACT (matches onfoot3d.js):
//   right-handed, Y up, ground at Y=0; the town is a ±BOUND(58) square; +Z is
//   "toward the town centre". The bank is centred near (0,-42) and FACES +Z, so
//   its steps/doors spill toward the middle of the map and the vault sits at the
//   back (-Z) wall, away from the street.
//
// RETURN CONTRACT:
//   {
//     group,                 // THREE.Group already added to `scene`
//     position:{x,z},        // building centre
//     doorPos:{x,z},         // front-door threshold (player "enters" here)
//     vaultPos:{x,z},        // the loot pedestal in the vault room (goop spot)
//     footprints:[{minX,maxX,minZ,maxZ}]  // SOLID-wall AABBs only; the doorway
//                            // and the step approach are deliberately NOT covered
//                            // so onfoot3d's resolveCollision lets the player in.
//   }
//
// The caller is expected to push `footprints` into onfoot3d's `aabbs` array so the
// solid walls collide; the open doorway gap means the player can walk through it.
//
// Self-contained: THREE arrives as a parameter, nothing is imported, and
// scene.add(group) happens inside the function.
// ============================================================

export function buildBank(THREE, scene, opts = {}) {
  // ---- placement & gross dimensions ------------------------------------------
  const cx = opts.x != null ? opts.x : 0;       // building centre X
  const cz = opts.z != null ? opts.z : -42;     // building centre Z (back of town)

  const W = 22;          // overall facade width (X)
  const D = 16;          // overall depth (Z, front +Z .. back -Z)
  const WALL_H = 9;      // height of the main side/back walls
  const WALL_T = 0.7;    // wall thickness
  const HALF_W = W / 2;
  const HALF_D = D / 2;

  const STEP_COUNT = 4;
  const STEP_RISE = 0.32;
  const STEP_DEPTH = 0.9;
  const STEP_BANK = STEP_COUNT * STEP_RISE;     // platform/podium top height
  const STEPS_TOTAL_Z = STEP_COUNT * STEP_DEPTH; // how far the steps reach in +Z

  // The recessed doorway: a gap in the FRONT wall the player passes through.
  const DOOR_W = 4.0;    // clear opening width
  const DOOR_H = 4.2;    // clear opening height

  const group = new THREE.Group();
  group.position.set(cx, 0, cz);
  group.name = 'bank';

  // ---- shared materials (re-used across many meshes to keep draw/material churn down) ----
  const marble = new THREE.MeshStandardMaterial({ color: 0xe9e6dc, roughness: 0.55, metalness: 0.04 });
  const marbleWarm = new THREE.MeshStandardMaterial({ color: 0xdedacb, roughness: 0.6, metalness: 0.03 });
  const stoneDark = new THREE.MeshStandardMaterial({ color: 0xb7b2a4, roughness: 0.75, metalness: 0.03 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xcfc9b6, roughness: 0.45, metalness: 0.06 });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c2, roughness: 0.4, metalness: 0.05 });
  const interiorWall = new THREE.MeshStandardMaterial({ color: 0xcdc7b6, roughness: 0.7 });
  const steelDark = new THREE.MeshStandardMaterial({ color: 0x4b515a, roughness: 0.45, metalness: 0.85 });
  const steelLite = new THREE.MeshStandardMaterial({ color: 0x9aa1ab, roughness: 0.35, metalness: 0.9 });
  const brassMat = new THREE.MeshStandardMaterial({ color: 0xc6a24a, roughness: 0.3, metalness: 0.95 });
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x2a3540, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.55 });
  const signMat = new THREE.MeshStandardMaterial({ color: 0xffe9a8, emissive: 0xffc24a, emissiveIntensity: 1.15, roughness: 0.4 });
  const signMatBlue = new THREE.MeshStandardMaterial({ color: 0xbfe8ff, emissive: 0x4ab6ff, emissiveIntensity: 1.1, roughness: 0.4 });
  const goopGlow = new THREE.MeshBasicMaterial({ color: 0x4dff9e }); // the loot marker base, unlit so it reads at any time

  // small helper: make a shadowing mesh and add it to a parent
  const add = (parent, geo, mat, x, y, z, opts2) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    if (opts2) {
      if (opts2.rx) m.rotation.x = opts2.rx;
      if (opts2.ry) m.rotation.y = opts2.ry;
      if (opts2.rz) m.rotation.z = opts2.rz;
      if (opts2.noShadow) { m.castShadow = false; m.receiveShadow = false; }
      if (opts2.name) m.name = opts2.name;
    }
    parent.add(m);
    return m;
  };

  // ============================================================
  // 1) GROUND-LEVEL BASE + FLAT ENTRANCE  (front face is +Z)
  // ============================================================
  // PHYSICS: the interior floor sits at y=0 (ground level), exactly like every
  // town building, so the player walks straight in through the door without any
  // vertical step to phase through. (An elevated podium used to put the floor at
  // ~1.28 while the player stayed pinned at y=0, which read as "walking through
  // the wall into the bank" — there is no step-up collision in the host.)
  // The grandeur now comes from the colonnade + pediment + sign, not elevation.

  // a flush stone stylobate (thin base slab, footprint + small overhang). Only
  // 0.12 tall, so a player standing on it at y=0 has imperceptible foot overlap.
  const stylobate = add(group, new THREE.BoxGeometry(W + 1.6, 0.12, D + 1.2), stoneDark,
    0, 0.06, 0);
  stylobate.receiveShadow = true;

  // a flat entrance landing fanning out in +Z (two cosmetic colour bands, flush
  // to the ground — purely visual, nothing to climb).
  const frontPodiumZ = HALF_D;   // +Z face of the building body (kept for col/sign math)
  add(group, new THREE.BoxGeometry(W + 1.0, 0.06, 3.2), marbleWarm,
    0, 0.03, frontPodiumZ + 1.7, { noShadow: true });
  add(group, new THREE.BoxGeometry(W - 2.0, 0.08, 1.6), trim,
    0, 0.04, frontPodiumZ + 0.9, { noShadow: true });

  // flanking decorative plinths + ball finials at the front corners (ground
  // anchored, well outside the door path so they never block the walk-in).
  for (const sx of [-1, 1]) {
    add(group, new THREE.BoxGeometry(1.2, 1.5, 1.2), stoneDark,
      sx * (HALF_W + 0.4), 0.75, frontPodiumZ + 0.6);
    add(group, new THREE.SphereGeometry(0.5, 14, 10), trim,
      sx * (HALF_W + 0.4), 1.5 + 0.4, frontPodiumZ + 0.6);
  }

  // ============================================================
  // 2) MAIN WALLS — side (X) + back (-Z), plus a FRONT wall split by the doorway
  // ============================================================
  const floorY = 0;                               // interior floor at ground level (see section 1)
  const wallTopY = floorY + WALL_H;               // top of the side/back walls

  // interior floor slab (receives shadows of columns/pediment)
  add(group, new THREE.BoxGeometry(W - WALL_T * 2 + 0.1, 0.12, D - WALL_T * 2 + 0.1), floorMat,
    0, floorY + 0.06, 0, { noShadow: false });

  // back wall (-Z)
  add(group, new THREE.BoxGeometry(W, WALL_H, WALL_T), marble,
    0, floorY + WALL_H / 2, -HALF_D + WALL_T / 2);
  // side walls (±X) — run the full depth
  for (const sx of [-1, 1]) {
    add(group, new THREE.BoxGeometry(WALL_T, WALL_H, D), marble,
      sx * (HALF_W - WALL_T / 2), floorY + WALL_H / 2, 0);
  }

  // FRONT wall (+Z) split into two jambs + a lintel, leaving a DOOR_W x DOOR_H
  // opening centred on X=0 that the player walks through.
  const frontZ = HALF_D - WALL_T / 2;
  const jambW = (W - DOOR_W) / 2;
  for (const sx of [-1, 1]) {
    add(group, new THREE.BoxGeometry(jambW, WALL_H, WALL_T), marble,
      sx * (DOOR_W / 2 + jambW / 2), floorY + WALL_H / 2, frontZ);
  }
  // lintel above the opening
  const lintelH = WALL_H - DOOR_H;
  add(group, new THREE.BoxGeometry(DOOR_W + 0.6, lintelH, WALL_T + 0.2), marbleWarm,
    0, floorY + DOOR_H + lintelH / 2, frontZ);
  // decorative keystone over the doorway
  add(group, new THREE.BoxGeometry(0.9, 1.1, WALL_T + 0.45), trim,
    0, floorY + DOOR_H + 0.2, frontZ);

  // recessed door surround (frames the opening, pulled slightly inward so the
  // entrance reads as "recessed")
  add(group, new THREE.BoxGeometry(DOOR_W + 1.0, 0.4, 0.5), trim,
    0, floorY + DOOR_H + 0.2, frontZ - 0.7);
  for (const sx of [-1, 1]) {
    add(group, new THREE.BoxGeometry(0.5, DOOR_H, 0.5), trim,
      sx * (DOOR_W / 2 + 0.25), floorY + DOOR_H / 2, frontZ - 0.7);
  }

  // a pair of open double doors, hinged outward against the jambs (do NOT block
  // the opening — they sit at the edges, swung wide). Glassy + brass-handled.
  for (const sx of [-1, 1]) {
    const leaf = new THREE.Group();
    leaf.position.set(sx * (DOOR_W / 2), floorY, frontZ - 0.2);
    leaf.rotation.y = sx * 1.15;   // swung open ~66°
    group.add(leaf);
    add(leaf, new THREE.BoxGeometry(0.12, DOOR_H - 0.2, DOOR_W / 2 - 0.15), steelDark,
      0, (DOOR_H - 0.2) / 2, -sx * (DOOR_W / 4 - 0.05));
    add(leaf, new THREE.BoxGeometry(0.05, DOOR_H - 1.2, DOOR_W / 2 - 0.7), glassMat,
      sx * 0.06, (DOOR_H - 0.2) / 2, -sx * (DOOR_W / 4 - 0.05), { noShadow: true });
    add(leaf, new THREE.CylinderGeometry(0.05, 0.05, 0.8, 8), brassMat,
      sx * 0.1, (DOOR_H - 0.2) / 2, -sx * 0.2);
  }

  // ============================================================
  // 3) COLUMNS — a colonnade across the front, standing on the podium top
  // ============================================================
  const COL_COUNT = 6;
  const COL_R = 0.62;
  const COL_H = WALL_H + 0.4;               // columns are a touch taller than walls
  const colZ = HALF_D + 1.4;                // out in front of the front wall
  const colSpan = W - 2.4;                  // span between outermost columns
  const colY0 = floorY;
  const fluteMat = trim;
  for (let i = 0; i < COL_COUNT; i++) {
    const t = COL_COUNT === 1 ? 0.5 : i / (COL_COUNT - 1);
    const colX = -colSpan / 2 + t * colSpan;
    // base plinth
    add(group, new THREE.BoxGeometry(COL_R * 2.5, 0.5, COL_R * 2.5), trim,
      colX, colY0 + 0.25, colZ);
    add(group, new THREE.CylinderGeometry(COL_R * 1.15, COL_R * 1.25, 0.35, 16), marbleWarm,
      colX, colY0 + 0.5 + 0.17, colZ);
    // fluted shaft (slight entasis: top a bit narrower than bottom)
    add(group, new THREE.CylinderGeometry(COL_R * 0.9, COL_R, COL_H - 1.4, 18), marble,
      colX, colY0 + 0.7 + (COL_H - 1.4) / 2, colZ);
    // capital
    add(group, new THREE.CylinderGeometry(COL_R * 1.25, COL_R * 0.95, 0.45, 18), fluteMat,
      colX, colY0 + 0.7 + (COL_H - 1.4) + 0.22, colZ);
    add(group, new THREE.BoxGeometry(COL_R * 2.7, 0.35, COL_R * 2.7), trim,
      colX, colY0 + COL_H - 0.05, colZ);
  }

  // entablature beam the columns carry (sits across all column tops, +Z of facade)
  const entY = floorY + COL_H + 0.25;
  add(group, new THREE.BoxGeometry(W + 1.2, 0.9, 2.6), marbleWarm,
    0, entY, (colZ + frontZ) / 2 + 0.4);
  // architrave band just under it
  add(group, new THREE.BoxGeometry(W + 1.0, 0.35, 2.7), trim,
    0, entY - 0.6, (colZ + frontZ) / 2 + 0.4);

  // ============================================================
  // 4) PEDIMENT (triangular gable) + main roof slab
  // ============================================================
  // Triangular pediment over the colonnade. A 3-sided prism via CylinderGeometry
  // (radialSegments=3) rotated so the flat face points +Z, scaled to a wide gable.
  const pedZ = (colZ + frontZ) / 2 + 0.4;
  const pedBaseY = entY + 0.45;
  const pediment = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 2.4, 3, 1),
    marble);
  pediment.scale.set(W * 0.62, 1, 2.0);     // wide + shallow triangle
  pediment.rotation.x = Math.PI / 2;        // lay the prism on its side (axis along Z)
  pediment.rotation.y = Math.PI / 2;        // point a vertex up
  pediment.position.set(0, pedBaseY + 1.4, pedZ);
  pediment.castShadow = true; pediment.receiveShadow = true;
  group.add(pediment);
  // tympanum disc ornament centred in the gable
  add(group, new THREE.CylinderGeometry(0.95, 0.95, 0.25, 20), trim,
    0, pedBaseY + 1.5, pedZ + 1.05, { rx: Math.PI / 2 });
  add(group, new THREE.TorusGeometry(0.95, 0.16, 10, 22), brassMat,
    0, pedBaseY + 1.5, pedZ + 1.12, { rx: 0 });
  // acroterion finials at the three corners of the gable
  add(group, new THREE.ConeGeometry(0.4, 1.1, 4), trim, 0, pedBaseY + 3.1, pedZ);
  for (const sx of [-1, 1]) {
    add(group, new THREE.SphereGeometry(0.45, 12, 9), trim,
      sx * W * 0.6, pedBaseY + 0.2, pedZ);
  }

  // flat main roof slab over the body of the building (behind the pediment)
  add(group, new THREE.BoxGeometry(W + 0.6, 0.6, D - 1.5), stoneDark,
    0, wallTopY + 0.3, -1.0);
  // cornice lip around the roofline (front + back + sides)
  add(group, new THREE.BoxGeometry(W + 1.2, 0.4, 0.5), trim, 0, wallTopY + 0.1, -HALF_D + 0.3);
  for (const sx of [-1, 1]) {
    add(group, new THREE.BoxGeometry(0.5, 0.4, D - 1.0), trim,
      sx * (HALF_W + 0.1), wallTopY + 0.1, -0.5);
  }

  // ============================================================
  // 5) BANK SIGN — emissive bars over the door (no glyphs, just lit panels)
  // ============================================================
  const signY = floorY + DOOR_H + 0.7;
  const signZ = frontZ + 0.35;
  // backing plate
  add(group, new THREE.BoxGeometry(DOOR_W + 2.6, 1.3, 0.18), stoneDark,
    0, signY, signZ, { noShadow: true });
  // a row of glowing gold bars (the "lettering" abstracted to lit segments)
  const barCount = 7;
  const barSpan = DOOR_W + 1.8;
  for (let i = 0; i < barCount; i++) {
    const t = barCount === 1 ? 0.5 : i / (barCount - 1);
    const bx = -barSpan / 2 + t * barSpan;
    const bh = 0.55 + ((i % 3) * 0.18);   // varied heights so it reads as text-ish
    add(group, new THREE.BoxGeometry(0.16, bh, 0.08), signMat,
      bx, signY, signZ + 0.12, { noShadow: true });
  }
  // two blue accent under-bars
  for (const sx of [-1, 1]) {
    add(group, new THREE.BoxGeometry(barSpan / 2 - 0.3, 0.12, 0.08), signMatBlue,
      sx * (barSpan / 4 + 0.05), signY - 0.5, signZ + 0.12, { noShadow: true });
  }
  // a couple of point lights under the sign give it a real glow (cheap: 2 lights)
  const signLight = new THREE.PointLight(0xffd27a, 0.9, 14, 2);
  signLight.position.set(0, signY - 0.2, signZ + 1.2);
  group.add(signLight);

  // ============================================================
  // 6) INTERIOR — teller counter, floor medallion, and the VAULT ROOM
  // ============================================================
  // teller counter near the front-left, just inside the door
  const counter = new THREE.Group();
  counter.position.set(-HALF_W + 3.5, floorY, HALF_D - 4.5);
  group.add(counter);
  add(counter, new THREE.BoxGeometry(7, 1.2, 1.1), marbleWarm, 0, 0.6, 0);
  add(counter, new THREE.BoxGeometry(7.2, 0.18, 1.3), trim, 0, 1.25, 0);
  // teller grille (thin bars) on the counter
  for (let i = 0; i < 6; i++) {
    add(counter, new THREE.CylinderGeometry(0.04, 0.04, 1.0, 6), brassMat,
      -3 + i * 1.2, 1.8, 0.2);
  }
  add(counter, new THREE.BoxGeometry(7.2, 0.1, 0.5), brassMat, 0, 2.35, 0.2);

  // floor medallion (inlaid disc) in the centre of the lobby
  add(group, new THREE.CylinderGeometry(2.4, 2.4, 0.06, 28), marbleWarm,
    0, floorY + 0.1, 1.5, { noShadow: true });
  add(group, new THREE.TorusGeometry(2.0, 0.12, 10, 30), brassMat,
    0, floorY + 0.13, 1.5, { rx: Math.PI / 2, noShadow: true });

  // ---- VAULT ROOM: a smaller chamber against the back (-Z) wall ----
  // partition wall that separates the lobby from the vault chamber, with a gap
  // the player walks through to reach the pedestal.
  const vaultRoomDepth = 5.0;                          // how far the chamber extends in +Z
  const partZ = -HALF_D + WALL_T + vaultRoomDepth;     // Z of the partition wall
  const PART_GAP = 3.0;                                 // interior opening width
  const partJambW = (W - WALL_T * 2 - PART_GAP) / 2;
  for (const sx of [-1, 1]) {
    add(group, new THREE.BoxGeometry(partJambW, WALL_H - 1.2, 0.5), interiorWall,
      sx * (PART_GAP / 2 + partJambW / 2), floorY + (WALL_H - 1.2) / 2, partZ);
  }
  // partition lintel
  add(group, new THREE.BoxGeometry(PART_GAP + 0.4, 1.0, 0.5), interiorWall,
    0, floorY + WALL_H - 1.2 - 0.5, partZ);

  // The big round VAULT DOOR set into the back wall, inside the chamber.
  const vaultZ = -HALF_D + WALL_T + 0.05;     // flush to back wall, facing +Z
  const vaultDoorY = floorY + 2.4;
  const vaultR = 1.9;
  const vaultGroup = new THREE.Group();
  vaultGroup.position.set(0, vaultDoorY, vaultZ);
  group.add(vaultGroup);
  // square steel frame the round door sits in
  add(vaultGroup, new THREE.BoxGeometry(vaultR * 2.6, vaultR * 2.6, 0.5), steelDark, 0, 0, 0.0);
  // outer ring
  add(vaultGroup, new THREE.CylinderGeometry(vaultR + 0.25, vaultR + 0.25, 0.5, 36), steelLite,
    0, 0, 0.25, { rx: Math.PI / 2 });
  // the round door slab itself (the "wheel" face), pushed forward so it reads as a plug
  add(vaultGroup, new THREE.CylinderGeometry(vaultR, vaultR, 0.7, 40), steelDark,
    0, 0, 0.55, { rx: Math.PI / 2 });
  // concentric detail rings on the door face
  add(vaultGroup, new THREE.TorusGeometry(vaultR * 0.78, 0.08, 10, 36), steelLite, 0, 0, 0.92);
  add(vaultGroup, new THREE.TorusGeometry(vaultR * 0.5, 0.07, 10, 30), steelLite, 0, 0, 0.92);
  // bolt studs around the rim
  const BOLTS = 12;
  for (let i = 0; i < BOLTS; i++) {
    const a = (i / BOLTS) * Math.PI * 2;
    add(vaultGroup, new THREE.CylinderGeometry(0.1, 0.1, 0.25, 8), steelLite,
      Math.cos(a) * (vaultR * 0.92), Math.sin(a) * (vaultR * 0.92), 0.85, { rx: Math.PI / 2 });
  }
  // big spoked spin-wheel handle in the centre
  add(vaultGroup, new THREE.TorusGeometry(0.7, 0.12, 12, 28), brassMat, 0, 0, 1.0);
  add(vaultGroup, new THREE.CylinderGeometry(0.2, 0.2, 0.4, 16), brassMat, 0, 0, 1.05, { rx: Math.PI / 2 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    add(vaultGroup, new THREE.BoxGeometry(0.12, 1.3, 0.12), brassMat,
      0, 0, 1.0, { rz: a });
  }
  // a stubby latch/hinge bar on the door's left edge
  add(vaultGroup, new THREE.BoxGeometry(0.5, vaultR * 1.6, 0.4), steelLite,
    -(vaultR + 0.1), 0, 0.55);

  // ---- LOOT PEDESTAL at vaultPos (where the "goop" sits) ----
  // Centred in the vault chamber, in front of the vault door.
  const pedLocalZ = (partZ + vaultZ) / 2 + 0.3;   // mid-chamber, biased toward the door
  const pedGroup = new THREE.Group();
  pedGroup.position.set(0, floorY, pedLocalZ);
  group.add(pedGroup);
  // base + column + cap (a classic display plinth)
  add(pedGroup, new THREE.CylinderGeometry(0.85, 1.0, 0.3, 20), marbleWarm, 0, 0.15, 0);
  add(pedGroup, new THREE.CylinderGeometry(0.55, 0.65, 1.0, 18), marble, 0, 0.8, 0);
  add(pedGroup, new THREE.CylinderGeometry(0.8, 0.6, 0.22, 20), trim, 0, 1.4, 0);
  // a faint glowing marker disc on top so the loot spot is obvious; the heist
  // system drops its "goop" mesh on top of this at vaultPos.
  add(pedGroup, new THREE.CylinderGeometry(0.6, 0.6, 0.06, 20), goopGlow, 0, 1.55, 0, { noShadow: true });
  // a soft green up-light from the pedestal to sell the "treasure here" read
  const lootLight = new THREE.PointLight(0x55ff9e, 0.8, 9, 2);
  lootLight.position.set(0, 1.9, 0);
  pedGroup.add(lootLight);

  // a couple of stacked "bullion / cash crate" props flanking the pedestal for flavour
  for (const sx of [-1, 1]) {
    add(group, new THREE.BoxGeometry(1.1, 0.6, 0.8), brassMat,
      sx * 2.2, floorY + 0.3, pedLocalZ + 0.2);
    add(group, new THREE.BoxGeometry(0.9, 0.5, 0.7), brassMat,
      sx * 2.2, floorY + 0.85, pedLocalZ + 0.2);
  }

  // ---- a low interior accent light so the lobby isn't pitch black ----
  const lobbyLight = new THREE.PointLight(0xfff0d0, 0.6, 22, 2);
  lobbyLight.position.set(0, floorY + WALL_H - 1.2, 1.0);
  group.add(lobbyLight);

  // ============================================================
  // 7) WORLD HOOKS — add to scene, compute world-space anchors + footprints
  // ============================================================
  scene.add(group);

  // doorPos: the front-door THRESHOLD in WORLD space. Local front wall is at
  // z = frontZ; the threshold sits a touch in front of it (still on the step
  // landing) so the player triggers "inside" as they cross it.
  const doorPos = { x: cx, z: cz + frontZ + 0.4 };
  // vaultPos: the pedestal top in WORLD space (where the goop is placed).
  const vaultPos = { x: cx, z: cz + pedLocalZ };

  // ---- footprints: SOLID-WALL AABBs only, in WORLD space ----
  // CRITICAL: leave the doorway + the step approach UNCOVERED so onfoot3d's
  // resolveCollision lets the player walk in. We therefore emit the two FRONT
  // JAMBS as separate boxes (not one front wall) with a clear gap between them,
  // plus the two side walls and the back wall. The columns/steps/podium edges are
  // intentionally left non-colliding (the player can brush past columns and climb
  // the steps freely).
  const pad = WALL_T / 2 + 0.15;   // a little buffer so the player doesn't clip wall faces
  const footprints = [];
  // back wall (full width)
  footprints.push({
    minX: cx - HALF_W, maxX: cx + HALF_W,
    minZ: cz - HALF_D, maxZ: cz - HALF_D + WALL_T + pad,
  });
  // side walls (full depth)
  for (const sx of [-1, 1]) {
    const wx = cx + sx * (HALF_W - WALL_T / 2);
    footprints.push({
      minX: wx - WALL_T / 2 - pad, maxX: wx + WALL_T / 2 + pad,
      minZ: cz - HALF_D, maxZ: cz + HALF_D,
    });
  }
  // front-wall JAMBS (two boxes flanking the door gap; the gap itself is open)
  for (const sx of [-1, 1]) {
    const jx = cx + sx * (DOOR_W / 2 + jambW / 2);
    footprints.push({
      minX: jx - jambW / 2, maxX: jx + jambW / 2,
      minZ: cz + frontZ - WALL_T / 2 - pad, maxZ: cz + frontZ + WALL_T / 2 + pad,
    });
  }
  // interior partition JAMBS (two boxes flanking the vault-room interior opening)
  for (const sx of [-1, 1]) {
    const pjx = cx + sx * (PART_GAP / 2 + partJambW / 2);
    footprints.push({
      minX: pjx - partJambW / 2, maxX: pjx + partJambW / 2,
      minZ: cz + partZ - 0.25 - pad, maxZ: cz + partZ + 0.25 + pad,
    });
  }

  // ensure every solid mesh casts/receives (belt-and-suspenders for anything missed)
  group.traverse((o) => {
    if (o.isMesh && o.material !== glassMat && o.material !== goopGlow &&
        o.material !== signMat && o.material !== signMatBlue && o.userData.keepFlags !== true) {
      // leave the explicitly-set noShadow meshes alone; only fix solids that
      // default-missed flags. Solid stone/steel already set above; this is a guard.
      if (o.castShadow === false && o.receiveShadow === false) return; // respect intentional noShadow
      o.castShadow = true; o.receiveShadow = true;
    }
  });

  return {
    group,
    position: { x: cx, z: cz },
    doorPos,
    vaultPos,
    footprints,
  };
}

export default buildBank;
