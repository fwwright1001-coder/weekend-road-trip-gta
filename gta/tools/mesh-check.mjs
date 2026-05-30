// Validates onfoot3d's buildPerson/buildCarMesh actually run with real three.js
// and honor their contracts (the gameplay sims use stub meshes, so this covers them).
import * as THREE from 'three';
import fs from 'fs';
const src = fs.readFileSync(new URL('../../onfoot3d.js', import.meta.url),'utf8');
function extract(sig){ const i=src.indexOf(sig); if(i<0) throw new Error('not found '+sig);
  let j=src.indexOf('{',i),depth=0,k=j; for(;k<src.length;k++){const c=src[k]; if(c==='{')depth++; else if(c==='}'){depth--; if(depth===0){k++;break;}}}
  return src.slice(i,k); }
const bp = new Function('THREE', extract('function buildPerson(colors, armed) {')+'\n return buildPerson;')(THREE);
const bc = new Function('THREE', extract('function buildCarMesh(bodyColor) {')+'\n return buildCarMesh;')(THREE);
let ok=true; const fail=(m)=>{ok=false;console.log('FAIL '+m);};
try {
  const p = bp({skin:0xd9a679,shirt:0x2f6f8f,pants:0x2b2b33,hair:0x3a2a1a}, true);
  if(!p || !p.isGroup) fail('person not a Group');
  for(const k of ['armL','armR','legL','legR','muzzle']) if(!p.userData[k]) fail('person missing userData.'+k);
  let meshes=0; p.traverse(o=>{if(o.isMesh)meshes++;}); if(meshes<8) fail('person too few meshes ('+meshes+')');
  console.log('person OK: '+meshes+' meshes, userData '+Object.keys(p.userData).join(','));
} catch(e){ fail('person threw: '+(e.stack||e)); }
try {
  const c = bc(0xd8392e);
  if(!c || !c.group || !c.group.isGroup) fail('car.group not a Group');
  if(!Array.isArray(c.wheels) || c.wheels.length!==4) fail('car.wheels != 4');
  if(!Array.isArray(c.steerPivots) || c.steerPivots.length!==2) fail('car.steerPivots != 2');
  let meshes=0; c.group.traverse(o=>{if(o.isMesh)meshes++;}); if(meshes<10) fail('car too few meshes ('+meshes+')');
  console.log('car OK: '+meshes+' meshes, wheels '+c.wheels.length+', steerPivots '+c.steerPivots.length);
} catch(e){ fail('car threw: '+(e.stack||e)); }
console.log(ok?'\nMESH-CHECK PASS ✅':'\nMESH-CHECK FAIL ❌'); process.exit(ok?0:1);
