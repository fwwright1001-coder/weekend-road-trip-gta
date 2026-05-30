// bone-dump.mjs — print the Soldier.glb skeleton so we can drive a procedural
// aim rig (right-arm chain + spine) and attach the weapon to the hand bone.
import * as THREE from 'three';
import fs from 'fs';
globalThis.self = globalThis;
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');

const url = new URL('../../assets/models/Soldier.glb', import.meta.url);
const buf = fs.readFileSync(url);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

await new Promise((res) => new GLTFLoader().parse(ab, '', (gltf) => {
  const bones = [];
  let firstSkin = null;
  gltf.scene.traverse((o) => {
    if (o.isSkinnedMesh && !firstSkin) firstSkin = o;
    if (o.isBone) bones.push(o);
  });
  console.log('total bones:', bones.length);
  console.log('skinnedMeshes:', gltf.scene.children ? undefined : '');

  // hierarchical print starting from root bones
  const isBone = (o) => o && o.isBone;
  function printTree(node, depth) {
    if (!isBone(node)) { (node.children || []).forEach((c) => printTree(c, depth)); return; }
    const p = node.position;
    console.log('  '.repeat(depth) + node.name +
      `  (x=${p.x.toFixed(3)} y=${p.y.toFixed(3)} z=${p.z.toFixed(3)})`);
    (node.children || []).forEach((c) => printTree(c, depth + 1));
  }
  console.log('\n--- BONE HIERARCHY (local positions) ---');
  gltf.scene.children.forEach((c) => printTree(c, 0));

  console.log('\n--- FLAT NAME LIST ---');
  console.log(bones.map((b) => b.name).join(', '));

  // highlight likely aim-relevant bones
  const want = /right.*(arm|hand|fore|shoulder)|spine|head|neck/i;
  console.log('\n--- AIM-RELEVANT MATCHES ---');
  for (const b of bones) if (want.test(b.name)) console.log(b.name);
  res();
}, (e) => { console.log('parse error', e && (e.message || e)); res(); }));
