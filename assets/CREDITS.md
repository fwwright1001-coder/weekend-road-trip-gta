# Asset credits

3D models loaded at runtime (Three.js GLTFLoader). Layout/logic stay procedural;
these are the art assets for the "full art conversion".

## Characters
- **Soldier.glb** — rigged + animated humanoid (clips: Idle / Walk / Run). Used
  for the player and pedestrians (recolored/scaled per spawn for variety).
  - Source: the **three.js** examples (`mrdoob/three.js`), a **Mixamo** (Adobe)
    character + animations.
  - License: **Mixamo / Adobe** — royalty-free for use in projects (incl.
    commercial); not CC0. Embedded here as part of the game project + credited.
  - Want strict CC0 instead? The pipeline (`gta/onfoot-actors.js`) is
    asset-agnostic — swap `MODEL_URL` + the clip-name map and drop in any rigged
    glTF with idle/walk/run.
