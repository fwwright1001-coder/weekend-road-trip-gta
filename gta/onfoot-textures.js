// ============================================================
// onfoot-textures.js — procedural CanvasTexture generators + a scene beautifier
// ------------------------------------------------------------
// 100% code-generated, no downloaded assets. Every texture here is drawn with
// the 2D canvas API (noise / gradients / lines / speckle) and wrapped into a
// THREE.CanvasTexture. A second export walks an existing Scene and upgrades the
// MeshStandard/Physical look of the town (ground, roads, buildings) WITHOUT
// touching the player, peds, cars, sky, goop, markers or any tiny prop.
//
// DESIGN CONTRACT — this module must NEVER break rendering:
//   * THREE is passed in (no imports), so a missing/odd build can't crash load.
//   * Texture generation is cached at module scope and built once; if a canvas
//     can't be made (headless / locked-down DOM) every getter degrades to null
//     and beautifyScene simply skips mapping rather than throwing.
//   * beautifyScene is try/caught per-mesh: one bad material can't abort the walk.
//   * It is idempotent: handled meshes are tagged userData._tex = true and the
//     texture set is cached, so calling it every frame would still be cheap and
//     stable (though once is enough).
//
// Coordinate convention matches the host (right-handed, Y up, ground at Y=0).
// ============================================================

// ---- module-scope cache ----------------------------------------------------
let _texCache = null;          // the built { asphalt, grass, concrete, facade, brick }
let _texTried = false;         // we only attempt the (possibly failing) build once

// A tiny deterministic PRNG so the noise looks the same every load (mulberry32).
function _rng(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Make a 2D canvas + context, or return null if the environment can't (headless).
function _makeCanvas(size) {
  try {
    let cv;
    if (typeof OffscreenCanvas !== 'undefined') {
      // OffscreenCanvas keeps the work off the DOM; THREE accepts it as a source.
      cv = new OffscreenCanvas(size, size);
    } else if (typeof document !== 'undefined') {
      cv = document.createElement('canvas');
      cv.width = size; cv.height = size;
    } else {
      return null;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    return { cv, ctx };
  } catch (e) {
    return null;
  }
}

// Wrap a drawn canvas into a configured, tiling CanvasTexture (or null on fail).
function _toTexture(THREE, cv) {
  try {
    if (!cv) return null;
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    // colorSpace: prefer the modern name, fall back to legacy r0.15x naming.
    if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    else if ('encoding' in tex && THREE.sRGBEncoding != null) tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = 8;        // crisp at grazing angles (clamped by GPU caps later)
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  } catch (e) {
    return null;
  }
}

// ---- low-level drawing helpers --------------------------------------------
// Fill the whole canvas with a flat base colour.
function _fill(ctx, size, color) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);
}

// Sprinkle soft speckle / grain over the canvas. `mono` keeps it grayscale-ish.
function _speckle(ctx, size, count, rand, opts) {
  const o = opts || {};
  const minA = o.minA == null ? 0.02 : o.minA;
  const maxA = o.maxA == null ? 0.10 : o.maxA;
  const rMin = o.rMin == null ? 0.6 : o.rMin;
  const rMax = o.rMax == null ? 2.2 : o.rMax;
  const tint = o.tint || null;     // [r,g,b] or null for light/dark gray flecks
  for (let i = 0; i < count; i++) {
    const x = rand() * size, y = rand() * size;
    const r = rMin + rand() * (rMax - rMin);
    const a = minA + rand() * (maxA - minA);
    let col;
    if (tint) col = `rgba(${tint[0]},${tint[1]},${tint[2]},${a})`;
    else {
      const v = rand() < 0.5 ? 0 : 255;   // dark and light flecks
      col = `rgba(${v},${v},${v},${a})`;
    }
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Large soft blotches for tonal variation (clouds of slightly darker/lighter).
function _blotches(ctx, size, count, rand, baseAlpha) {
  for (let i = 0; i < count; i++) {
    const x = rand() * size, y = rand() * size;
    const r = size * (0.08 + rand() * 0.22);
    const dark = rand() < 0.5;
    const a = (baseAlpha || 0.06) * (0.5 + rand());
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    const v = dark ? 0 : 255;
    grad.addColorStop(0, `rgba(${v},${v},${v},${a})`);
    grad.addColorStop(1, `rgba(${v},${v},${v},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

// ============================================================
// TEXTURE PAINTERS — each draws one tile and returns the canvas (or null).
// ============================================================

// ASPHALT — dark gritty road with a faint vignette + a centred dashed lane line.
function _drawAsphalt(size) {
  const made = _makeCanvas(size);
  if (!made) return null;
  const { cv, ctx } = made;
  const rand = _rng(0xA59A17);
  _fill(ctx, size, '#34343a');
  _blotches(ctx, size, 14, rand, 0.07);
  // dense fine grit
  _speckle(ctx, size, Math.floor(size * size * 0.012), rand, { minA: 0.03, maxA: 0.14, rMin: 0.5, rMax: 1.8 });
  // a few small cracks / patches
  ctx.strokeStyle = 'rgba(20,20,24,0.5)';
  for (let i = 0; i < 10; i++) {
    ctx.lineWidth = 0.6 + rand() * 1.2;
    ctx.beginPath();
    let x = rand() * size, y = rand() * size;
    ctx.moveTo(x, y);
    const segs = 2 + (rand() * 3 | 0);
    for (let s = 0; s < segs; s++) {
      x += (rand() - 0.5) * size * 0.18;
      y += (rand() - 0.5) * size * 0.18;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // dashed yellow lane line down the vertical centre (tile repeats into a road)
  const cx = size / 2;
  const dashW = Math.max(3, size * 0.018);
  const dashH = size * 0.20, gap = size * 0.18;
  ctx.fillStyle = 'rgba(232,196,90,0.82)';
  for (let y = size * 0.06; y < size; y += dashH + gap) {
    ctx.fillRect(cx - dashW / 2, y, dashW, dashH);
  }
  // tyre-buffed darker tracks either side of centre
  ctx.fillStyle = 'rgba(0,0,0,0.10)';
  ctx.fillRect(size * 0.20, 0, size * 0.10, size);
  ctx.fillRect(size * 0.70, 0, size * 0.10, size);
  return cv;
}

// GRASS — green base with blade-noise streaks + tonal patches (a lawn, not pixels).
function _drawGrass(size) {
  const made = _makeCanvas(size);
  if (!made) return null;
  const { cv, ctx } = made;
  const rand = _rng(0x6F8F5A);
  // base vertical gradient (slightly darker toward one edge for depth)
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, '#6f9655');
  g.addColorStop(1, '#5d8047');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // broad patches of lighter / darker turf
  _blotches(ctx, size, 18, rand, 0.10);
  // dirt/earth flecks
  _speckle(ctx, size, Math.floor(size * size * 0.004), rand, { minA: 0.05, maxA: 0.16, rMin: 0.6, rMax: 1.6, tint: [90, 70, 45] });
  // blade noise: short directional strokes in varying greens
  const blades = Math.floor(size * size * 0.02);
  for (let i = 0; i < blades; i++) {
    const x = rand() * size, y = rand() * size;
    const len = 2 + rand() * 5;
    const ang = -Math.PI / 2 + (rand() - 0.5) * 0.9;   // mostly upright, jittered
    const shade = rand();
    let col;
    if (shade < 0.33) col = `rgba(70,110,50,${0.18 + rand() * 0.22})`;
    else if (shade < 0.66) col = `rgba(120,160,80,${0.16 + rand() * 0.20})`;
    else col = `rgba(95,135,65,${0.16 + rand() * 0.22})`;
    ctx.strokeStyle = col;
    ctx.lineWidth = 0.7 + rand() * 0.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
  return cv;
}

// CONCRETE — pale gray slab with speckle, hairline cracks + faint expansion joints.
function _drawConcrete(size) {
  const made = _makeCanvas(size);
  if (!made) return null;
  const { cv, ctx } = made;
  const rand = _rng(0xC0C0C8);
  _fill(ctx, size, '#9a9a9f');
  _blotches(ctx, size, 12, rand, 0.06);
  _speckle(ctx, size, Math.floor(size * size * 0.010), rand, { minA: 0.04, maxA: 0.14, rMin: 0.5, rMax: 1.6 });
  // a touch of warm/cool aggregate flecks
  _speckle(ctx, size, Math.floor(size * size * 0.002), rand, { minA: 0.06, maxA: 0.16, rMin: 0.7, rMax: 1.8, tint: [120, 110, 100] });
  // faint expansion joints dividing the slab into quarters
  ctx.strokeStyle = 'rgba(60,60,66,0.35)';
  ctx.lineWidth = Math.max(1, size * 0.006);
  ctx.beginPath();
  ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2);
  ctx.stroke();
  // hairline cracks
  ctx.strokeStyle = 'rgba(50,50,55,0.4)';
  for (let i = 0; i < 6; i++) {
    ctx.lineWidth = 0.5 + rand() * 0.8;
    ctx.beginPath();
    let x = rand() * size, y = rand() * size;
    ctx.moveTo(x, y);
    for (let s = 0; s < 3; s++) { x += (rand() - 0.5) * size * 0.2; y += (rand() - 0.5) * size * 0.2; ctx.lineTo(x, y); }
    ctx.stroke();
  }
  return cv;
}

// FACADE — a building wall: tinted concrete/stucco base with a grid of windows
// (glass gradient + frame + a little reflection), plinth + cornice bands.
function _drawFacade(size) {
  const made = _makeCanvas(size);
  if (!made) return null;
  const { cv, ctx } = made;
  const rand = _rng(0x7A6F63);
  // wall base — warm gray stucco
  const wall = ctx.createLinearGradient(0, 0, 0, size);
  wall.addColorStop(0, '#8b8a84');
  wall.addColorStop(1, '#797872');
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, size, size);
  _blotches(ctx, size, 10, rand, 0.05);
  _speckle(ctx, size, Math.floor(size * size * 0.004), rand, { minA: 0.02, maxA: 0.08, rMin: 0.5, rMax: 1.4 });

  // window grid: cols x rows, with margins so the tile repeats cleanly.
  const cols = 4, rows = 4;
  const margin = size * 0.06;
  const cellW = (size - margin * 2) / cols;
  const cellH = (size - margin * 2) / rows;
  const winW = cellW * 0.62, winH = cellH * 0.66;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = margin + c * cellW + (cellW - winW) / 2;
      const y = margin + r * cellH + (cellH - winH) / 2;
      // frame (slightly darker recess)
      ctx.fillStyle = '#56554f';
      ctx.fillRect(x - 2, y - 2, winW + 4, winH + 4);
      // glass — vertical gradient, occasionally a warm-lit interior
      const lit = rand() < 0.22;
      const gl = ctx.createLinearGradient(x, y, x, y + winH);
      if (lit) {
        gl.addColorStop(0, '#ffe8a8');
        gl.addColorStop(1, '#d8b878');
      } else {
        gl.addColorStop(0, '#9fc2d6');
        gl.addColorStop(0.5, '#6f93ab');
        gl.addColorStop(1, '#4f6f86');
      }
      ctx.fillStyle = gl;
      ctx.fillRect(x, y, winW, winH);
      // diagonal reflection streak on the glass
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, winW, winH);
      ctx.clip();
      ctx.strokeStyle = lit ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.30)';
      ctx.lineWidth = winW * 0.10;
      ctx.beginPath();
      ctx.moveTo(x - winW * 0.2, y + winH * 0.7);
      ctx.lineTo(x + winW * 0.7, y - winH * 0.2);
      ctx.stroke();
      ctx.restore();
      // mullion (cross divider)
      ctx.strokeStyle = 'rgba(60,60,64,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + winW / 2, y); ctx.lineTo(x + winW / 2, y + winH);
      ctx.moveTo(x, y + winH / 2); ctx.lineTo(x + winW, y + winH / 2);
      ctx.stroke();
    }
  }
  // top cornice + bottom plinth bands for floor structure
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.fillRect(0, 0, size, margin * 0.5);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(0, size - margin * 0.7, size, margin * 0.7);
  return cv;
}

// BRICK — running-bond red/brown courses with mortar lines + per-brick tone jitter.
function _drawBrick(size) {
  const made = _makeCanvas(size);
  if (!made) return null;
  const { cv, ctx } = made;
  const rand = _rng(0xB0683A);
  // mortar background
  _fill(ctx, size, '#9c9489');
  _speckle(ctx, size, Math.floor(size * size * 0.003), rand, { minA: 0.03, maxA: 0.10, rMin: 0.5, rMax: 1.4 });

  const courses = 8;                 // rows of bricks
  const brickH = size / courses;
  const bricksPerRow = 4;
  const brickW = size / bricksPerRow;
  const mortar = Math.max(2, size * 0.012);
  const brickTones = ['#9c4a32', '#a85539', '#8f4330', '#b15c3d', '#974730', '#a35136'];
  for (let r = 0; r < courses; r++) {
    const y = r * brickH;
    const offset = (r % 2) ? brickW / 2 : 0;   // running bond
    // draw a row plus one extra to cover the half-offset wrap
    for (let c = -1; c <= bricksPerRow; c++) {
      const x = c * brickW + offset;
      const bx = x + mortar / 2;
      const by = y + mortar / 2;
      const bw = brickW - mortar;
      const bh = brickH - mortar;
      const tone = brickTones[(rand() * brickTones.length) | 0];
      ctx.fillStyle = tone;
      ctx.fillRect(bx, by, bw, bh);
      // subtle per-brick shading (top-left light, bottom-right shadow)
      const sh = ctx.createLinearGradient(bx, by, bx + bw, by + bh);
      sh.addColorStop(0, 'rgba(255,255,255,0.08)');
      sh.addColorStop(1, 'rgba(0,0,0,0.16)');
      ctx.fillStyle = sh;
      ctx.fillRect(bx, by, bw, bh);
      // a few darker pits per brick
      const pits = 3 + (rand() * 4 | 0);
      for (let p = 0; p < pits; p++) {
        ctx.fillStyle = `rgba(0,0,0,${0.05 + rand() * 0.08})`;
        ctx.beginPath();
        ctx.arc(bx + rand() * bw, by + rand() * bh, 0.6 + rand() * 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  return cv;
}

// ============================================================
// PUBLIC: makeTextures(THREE) — build once, cache, return the set.
// ============================================================
export function makeTextures(THREE) {
  if (_texCache) return _texCache;
  // Even if a build fails we cache the (partly-null) result so we never retry
  // a hopeless environment every frame.
  if (_texTried && _texCache) return _texCache;
  _texTried = true;

  const out = { asphalt: null, grass: null, concrete: null, facade: null, brick: null };
  if (!THREE || typeof THREE.CanvasTexture !== 'function') {
    _texCache = out;
    return out;
  }
  try {
    out.asphalt = _toTexture(THREE, _drawAsphalt(512));
    out.grass = _toTexture(THREE, _drawGrass(512));
    out.concrete = _toTexture(THREE, _drawConcrete(256));
    out.facade = _toTexture(THREE, _drawFacade(512));
    out.brick = _toTexture(THREE, _drawBrick(512));
  } catch (e) {
    // partial set is fine; beautifyScene tolerates nulls
    if (typeof console !== 'undefined') console.warn('[onfoot-textures] makeTextures partial:', e);
  }
  _texCache = out;
  return out;
}

// ============================================================
// BEAUTIFY HELPERS
// ============================================================

// Pull the box dimensions out of a mesh's geometry parameters, or null if it's
// not an axis-aligned box we understand. (We never read world transforms here —
// building bodies sit in a Group at y = h/2, so geometry params are the truth.)
function _boxDims(mesh) {
  const geo = mesh && mesh.geometry;
  if (!geo) return null;
  // BoxGeometry exposes .parameters {width,height,depth}; guard the type too.
  const isBox = geo.type === 'BoxGeometry' || geo.type === 'BoxBufferGeometry';
  const p = geo.parameters;
  if (!isBox || !p) return null;
  if (p.width == null || p.height == null || p.depth == null) return null;
  // account for the mesh's own scale (host scales people, not buildings, but be safe)
  const sx = mesh.scale ? mesh.scale.x : 1;
  const sy = mesh.scale ? mesh.scale.y : 1;
  const sz = mesh.scale ? mesh.scale.z : 1;
  return { w: p.width * sx, h: p.height * sy, d: p.depth * sz };
}

// Is this a flat ground-style plane (PlaneGeometry laid roughly horizontal)?
function _planeDims(mesh) {
  const geo = mesh && mesh.geometry;
  if (!geo) return null;
  const isPlane = geo.type === 'PlaneGeometry' || geo.type === 'PlaneBufferGeometry';
  const p = geo.parameters;
  if (!isPlane || !p || p.width == null || p.height == null) return null;
  return { w: p.width, h: p.height };
}

// Clone a CanvasTexture so per-mesh .repeat values don't fight each other while
// still sharing the underlying image. Falls back to the shared texture on fail.
function _repeated(tex, rx, ry) {
  if (!tex) return null;
  try {
    const t = tex.clone();
    t.needsUpdate = true;       // clones must be flagged to upload independently
    t.repeat.set(rx, ry);
    t.wrapS = tex.wrapS; t.wrapT = tex.wrapT;
    t.anisotropy = tex.anisotropy;
    if ('colorSpace' in t && tex.colorSpace != null) t.colorSpace = tex.colorSpace;
    return t;
  } catch (e) {
    return tex;
  }
}

// Decide whether a material is one we should leave completely alone.
function _skipMaterial(THREE, mat) {
  if (!mat) return true;
  if (mat.transparent) return true;                // glass / faded peds
  if (mat.isMeshBasicMaterial) return true;        // unlit road stripes / flat markers
  // strong emissive = lit windows / lamps / tail-lights / goop glow → leave alone
  if (mat.emissive) {
    const ei = mat.emissiveIntensity == null ? 1 : mat.emissiveIntensity;
    const e = mat.emissive;
    const lum = (e.r + e.g + e.b);
    if (ei > 0.05 && lum > 0.12) return true;
  }
  return false;
}

// Apply the standard look polish to a standard/physical material (cheap, safe).
function _polish(mat, envBump) {
  if (mat.envMapIntensity == null || mat.envMapIntensity < envBump) {
    mat.envMapIntensity = envBump;
  }
}

// ============================================================
// PUBLIC: beautifyScene(THREE, scene, opts) — upgrade the town look in place.
// Returns the number of meshes it upgraded.
// ============================================================
export function beautifyScene(THREE, scene, opts = {}) {
  if (!THREE || !scene || typeof scene.traverse !== 'function') return 0;

  const o = opts || {};
  const envBump = o.envMapIntensity == null ? 0.8 : o.envMapIntensity;
  const buildingMinH = o.buildingMinHeight == null ? 5 : o.buildingMinHeight;
  const buildingMinFoot = o.buildingMinFootprint == null ? 5 : o.buildingMinFootprint;
  const groundMinSize = o.groundMinSize == null ? 30 : o.groundMinSize;   // a plane this big is "ground"
  const smallSkip = o.smallSkip == null ? 0.9 : o.smallSkip;              // ignore tiny detail boxes

  const tex = makeTextures(THREE);
  let count = 0;

  scene.traverse((obj) => {
    try {
      if (!obj || !obj.isMesh) return;
      if (obj.userData && obj.userData._tex) return;       // already handled (idempotent)
      if (obj.userData && obj.userData.noTex) return;      // host opted this mesh out

      const mat = obj.material;
      // multi-material meshes: only polish, don't risk mapping mismatched groups
      if (Array.isArray(mat)) {
        let touched = false;
        for (const m of mat) {
          if (m && (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) && !_skipMaterial(THREE, m)) {
            _polish(m, envBump); m.needsUpdate = true; touched = true;
          }
        }
        if (touched) { obj.userData._tex = true; count++; }
        return;
      }

      if (!mat) return;
      const isStd = mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial;
      if (!isStd) return;                 // basic/shader/sky/etc. left untouched
      if (_skipMaterial(THREE, mat)) return;

      let mapped = false;

      // --- GROUND / ROAD PLANES ---------------------------------------------
      const plane = _planeDims(obj);
      if (plane && plane.w >= groundMinSize && plane.h >= groundMinSize) {
        // distinguish grass (greenish) from asphalt/road (dark/desaturated) by colour
        const col = mat.color;
        let isGreen = false, isDark = false;
        if (col) {
          isGreen = col.g > col.r * 1.05 && col.g > col.b * 1.05 && col.g > 0.18;
          const lum = (col.r + col.g + col.b) / 3;
          isDark = lum < 0.35;
        }
        // repeat scaled to plane size so tiles stay a sensible real-world size
        if (isGreen && tex.grass) {
          const rep = Math.max(1, Math.round(plane.w / 12));
          mat.map = _repeated(tex.grass, rep, rep);
          if (mat.roughness != null) mat.roughness = Math.max(mat.roughness, 0.95);
          mapped = true;
        } else if ((isDark || !isGreen) && tex.asphalt) {
          const rep = Math.max(1, Math.round(plane.w / 16));
          mat.map = _repeated(tex.asphalt, rep, rep);
          if (mat.roughness != null) mat.roughness = Math.max(mat.roughness, 0.92);
          mapped = true;
        }
      }

      // --- BUILDING BOXES ----------------------------------------------------
      if (!mapped) {
        const box = _boxDims(obj);
        if (box) {
          const tall = box.h > buildingMinH;
          const footOk = box.w > buildingMinFoot && box.d > buildingMinFoot;
          if (tall && footOk) {
            // pick brick for some, facade for the rest, keyed off footprint so it's
            // stable per building (no flicker if called twice).
            const useBrick = (Math.round(box.w + box.d)) % 2 === 0;
            const baseTex = useBrick ? (tex.brick || tex.facade) : (tex.facade || tex.brick);
            if (baseTex) {
              // ~3m per facade tile vertically, ~4m horizontally — repeat by box size
              const repX = Math.max(1, Math.round(box.w / 4));
              const repY = Math.max(1, Math.round(box.h / 4));
              mat.map = _repeated(baseTex, repX, repY);
              // reuse the same image as a subtle roughnessMap for micro-relief
              mat.roughnessMap = _repeated(baseTex, repX, repY);
              if (mat.roughness != null) mat.roughness = Math.min(1, Math.max(0.8, mat.roughness));
              mapped = true;
            }
          } else if (box.w <= smallSkip && box.h <= smallSkip && box.d <= smallSkip) {
            // tiny detail box (eyes, hubs, window panes, props) — polish only below
          }
        }
      }

      // --- POLISH (always, for any kept standard material) ------------------
      _polish(mat, envBump);
      mat.needsUpdate = true;
      obj.userData._tex = true;
      count++;
    } catch (e) {
      // one bad mesh must never abort the whole walk
      if (typeof console !== 'undefined') console.warn('[onfoot-textures] skip mesh:', e && e.message);
    }
  });

  return count;
}

export default { makeTextures, beautifyScene };
