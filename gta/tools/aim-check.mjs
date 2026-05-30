// Verifies the gun/aim rig wires up against the real Soldier skeleton: the bones
// the rig poses exist, a gun mesh can be parented to the right-hand bone, and
// posing the arm/forearm + a recoil kick run without throwing. (Visual aim angles
// are tuned in-browser via window.ONFOOT_AIM — this only proves the plumbing.)
import * as THREE from 'three';
import fs from 'fs';
globalThis.self = globalThis;
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { clone } = await import('three/addons/utils/SkeletonUtils.js');
const NEED = ['mixamorigRightHand', 'mixamorigRightForeArm', 'mixamorigRightArm'];
let ok = true; const fail = (m) => { ok = false; console.log('FAIL ' + m); };
const buf = fs.readFileSync(new URL('../../assets/models/Soldier.glb', import.meta.url));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
await new Promise((res) => new GLTFLoader().parse(ab, '', (gltf) => {
  const inner = clone(gltf.scene);
  const bones = {};
  inner.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  for (const n of NEED) if (!bones[n]) fail('missing bone: ' + n);
  if (bones['mixamorigRightHand']) {
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.42), new THREE.MeshStandardMaterial());
    const muzzle = new THREE.Object3D(); gun.add(muzzle); muzzle.position.set(0, 0, 0.4);
    bones['mixamorigRightHand'].add(gun); gun.position.set(0.02, 0, 0.06); gun.rotation.set(Math.PI / 2, 0, 0);
    // pose + recoil kick (must not throw)
    bones['mixamorigRightArm'].rotation.set(-1.15, 0.15, 0.1);
    bones['mixamorigRightForeArm'].rotation.set(-0.55, 0, 0);
    gun.position.z = 0.06 - 0.06;   // recoil
    inner.updateMatrixWorld(true);
    const mw = new THREE.Vector3(); muzzle.getWorldPosition(mw);
    if (!isFinite(mw.x + mw.y + mw.z)) fail('muzzle world position NaN');
    console.log('rig OK — gun parented to right hand; muzzle world (' + mw.x.toFixed(2) + ',' + mw.y.toFixed(2) + ',' + mw.z.toFixed(2) + ')');
  }
  res();
}, (e) => { fail('parse: ' + (e && (e.message || e))); res(); }));
console.log(ok ? '\nAIM-CHECK PASS ✅  (rig plumbing valid; tune angles in-browser via ONFOOT_AIM)' : '\nAIM-CHECK FAIL ❌');
process.exit(ok ? 0 : 1);
