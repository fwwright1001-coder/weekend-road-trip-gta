// Validates the rigged-character art pipeline (gta/onfoot-actors.js) headlessly:
// the vendored CC0 model loads via the real GLTFLoader, is skinned, exposes the
// animation clips the game drives (Idle/Walking/Running/Death), and can be
// per-instance cloned (SkeletonUtils) + animated (AnimationMixer) — i.e. the
// runtime path works on this asset. (Actual rendering still needs a browser.)
import * as THREE from 'three';
import fs from 'fs';
globalThis.self = globalThis;                       // GLTFLoader expects a global scope
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { clone } = await import('three/addons/utils/SkeletonUtils.js');

const NEED = ['Idle', 'Walk', 'Run'];   // clips onfoot-actors.js maps (Soldier.glb)
let ok = true; const fail = (m) => { ok = false; console.log('FAIL ' + m); };

const url = new URL('../../assets/models/Soldier.glb', import.meta.url);
if (!fs.existsSync(url)) { console.log('FAIL model missing at assets/models/Soldier.glb'); process.exit(1); }
const buf = fs.readFileSync(url);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

await new Promise((res) => new GLTFLoader().parse(ab, '', (gltf) => {
  let skinned = 0; gltf.scene.traverse((o) => { if (o.isSkinnedMesh) skinned++; });
  if (skinned < 1) fail('no SkinnedMesh (model not rigged)');

  const have = (gltf.animations || []).map((a) => a.name);
  for (const n of NEED) if (!THREE.AnimationClip.findByName(gltf.animations, n)) fail('missing clip: ' + n);

  const box = new THREE.Box3().setFromObject(gltf.scene);
  const h = box.max.y - box.min.y;
  if (!(h > 0.1)) fail('degenerate bounds');

  try {
    const c = clone(gltf.scene);                    // per-instance skinned clone
    const mixer = new THREE.AnimationMixer(c);
    const walk = THREE.AnimationClip.findByName(gltf.animations, 'Walk');
    const act = mixer.clipAction(walk); act.play(); mixer.update(0.1); mixer.update(0.1);
  } catch (e) { fail('clone+mixer failed: ' + (e.message || e)); }

  console.log(`model: ${(buf.length / 1024) | 0} KB · skinnedMeshes ${skinned} · height ${h.toFixed(2)} -> scale ${(1.8 / h).toFixed(3)}`);
  console.log(`clips: ${have.join(', ')}`);
  res();
}, (e) => { fail('GLTFLoader.parse: ' + (e && (e.message || e))); res(); }));

console.log(ok ? '\nACTOR-CHECK PASS ✅  (rigged + animated + clonable)' : '\nACTOR-CHECK FAIL ❌');
process.exit(ok ? 0 : 1);
