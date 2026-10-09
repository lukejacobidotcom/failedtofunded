/* Trader Royale: the 3D walk-in (door -> sit -> look around -> key floats in -> turn it).
   ES module, three@0.160 from the page's importmap. Exposes window.TR3D; intro.js sequences it.

   World: metres, +Y up, the driver looks toward -Z, left-hand drive (driver seat at x = -0.38).
   Origin: cabin floor (y = 0) on the car centreline, z = 0 at the front of the seat cushions.

   API (every call is wrapped so a WebGL failure rejects mount() cleanly):
     TR3D.mount(container, { model, lite, rm, phone, modelWait, fadeMs, tier, pr, autoTier })  -> Promise, resolves on the first renderable frame (held up to modelWait for the model)
     TR3D.stage('door' | 'sit' | 'observe' | 'keyin' | 'seated') -> Promise, resolves when the move ends
     TR3D.keyAngle(deg) 0..90, TR3D.ignite(), TR3D.catch(), TR3D.blip(), TR3D.dissolve(), TR3D.dispose()
     TR3D.setQuality('ultra' | 'high' | 'base' | 'lite' | 'full'), TR3D.stats(), TR3D.snapshot(name), TR3D.bench(n), TR3D.benchGpu() (test harness)

   Rendering: a procedural night-showroom environment (PMREM), one shadow-casting key spot, gold rect strips, cool fills; the post
   stack is MSAA -> GTAO -> depth of field -> bloom -> output -> lens grade, picked per device by the tier controller
   (ultra / high / base / lite, a one-way ratchet with a burst probe at mount and a steady-state watchdog). */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---------- the real-model drop-in ----------
const MODEL_URL = 'assets/models/cockpit/scene.gltf';   // default when opts.model is not given; null/failed load = procedural cabin
const GROUND = -0.13;                                     // the stage floor (world y); the procedural cabin floor is y = 0
// The Sketchfab 911 (CC BY, authored at 1/100 scale, nose toward +Z, ground at y 0): scale 100 and yaw 180 so the driver looks
// toward -Z, then shift it so its wheel centre lands on the procedural one (x -0.38, z -0.40) and the tyres sit 2 cm above the stage.
// MODEL frame = the file after scale + yaw (ground y 0.02, driver side -x, nose -z); WORLD = MODEL + pos. Every MODEL_FIT and
// POSE_MODEL number below is in the MODEL frame (measured from the vertex data), mw() adds the shift at runtime.
const MODEL_TRANSFORM = { scale: 100, yaw: 180, pos: [-0.045, GROUND, -0.15] };
const MODEL_PAINT = 0xf2f3f1;                            // the file's GTS orange is recoloured to the page car's white (null or opts.paint 'keep' keeps the file colour)
const MODEL_FIT = {
  size: [1.98, 1.32, 4.53], sizeTol: 0.30,               // validation after the transform: a car-sized car with its wheels on the stage
  // the driver door is welded into the body side, but by raw index connectivity it is its own set of islands (skin, handle, mirror,
  // door card, armrest, window): every island whose bounds lie entirely inside this box becomes the door, hinged on a vertical axis
  doorBox: { min: [-1.10, 0.30, -0.78], max: [-0.55, 1.32, 0.62] }, doorTriRange: [1200, 6000], doorMaxSpanZ: 1.45,
  hinge: [-0.84, 0, -0.703], doorOpenDeg: -62,
  // our props on the real dash (positions of the group origins; the dial faces are flat, normal +z toward the driver)
  slot: { pos: [-0.62, 0.7705, -0.380] },               // flat lower-left dash panel, 0.6 cm proud, left of the stalk, clear of the rim from the seated eye
  tach: { pos: [-0.335, 0.9005, -0.445], normal: [0, 0, 1], scale: 0.74 },       // over the baked central tach (face 0.115 m)
  dialL: { pos: [-0.423, 0.8745, -0.446], r: 0.0475, scale: 0.62 },             // inner left dial becomes the left display
  dialR: { pos: [-0.246, 0.8745, -0.446], r: 0.0475, scale: 0.62 },             // inner right dial becomes the right display (as the 991's round TFT)
  dialOL: { pos: [-0.511, 0.8505, -0.447], r: 0.0475, scale: 0.5 },             // the two outer baked dials: a lit gauge face each so the whole cluster wakes at the catch
  dialOR: { pos: [-0.159, 0.8505, -0.447], r: 0.0475, scale: 0.5 },
  // per-pixel regions of the one atlas material (MODEL frame, abs x where noted): the dash top and the A-pillars get a darker, cooler tint
  // and a single specular band; the sun visors read as fabric; the seat cushions get stitch lines and a stronger velvet sheen
  regions: { dashTop: { min: [0, 0.82, -0.80], max: [0.76, 1.02, -0.30] }, pillar: { min: [0.56, 0.85, -0.70], max: [0.80, 1.32, 0.05] }, visor: { min: [0, 1.10, -0.45], max: [0.70, 1.26, -0.08] },
             seatCushion: { min: [0.12, 0.18, -0.34], max: [0.62, 0.72, 0.60] }, seatBack: { min: [0.12, 0.30, 0.45], max: [0.62, 1.10, 1.00] } },
  screen: { pos: [0.006, 0.7665, -0.381], normal: [0, 0.1, 1], scale: 0.64 },   // over the PCM screen in the centre stack (sized to the bezel recess)
  hub: { pos: [-0.3365, 0.8415, -0.211], normal: [0, 0.267, 0.964], standoff: 0.004, scale: 0.8, badgeRadius: 0.05, badgeMaxTris: 200 },
  dome: { pos: [0, 1.264, -0.003] },
  // the sunroof shade, its surround and the roof header are pale in the atlas (a white sticker on the roof from the door pose): every atlas
  // island entirely inside this box gets a matte charcoal material and the sunroof glass island a dark tint (the headliner island is wider and stays)
  roofBox: { min: [-0.55, 1.22, -0.20], max: [0.55, 1.40, 0.91] },
  // the driver door aperture surround (body-in-white: the one atlas island spanning the whole side, plus the hinge-pillar strips) is pale
  // primer in the atlas and threw the door wash back as a glossy slab beside the dash in the sit pose: it gets the body paint
  apertureBoxes: [{ min: [-0.80, 0.20, -1.0], max: [-0.45, 1.05, 1.2], minSpanZ: 1.5 }, { min: [-0.74, 0.57, -0.60], max: [-0.665, 0.93, -0.44] }],
  // the LOD2 cabin is open at the dash ends (above the end cap, between the dash top pad at x 0.681 and the A-pillar base trim): from the
  // sit pose the underside mesh showed through as a blue slab. A thin matte end-cap plate per side closes the strip (anything wider
  // pokes into the door aperture; the aperture's own front edge is at z -0.70).
  liners: [{ min: [-0.705, 0.78, -0.64], max: [-0.69, 0.97, -0.36] }, { min: [0.69, 0.78, -0.64], max: [0.705, 0.97, -0.36] },
           { min: [-0.78, 0.912, -0.98], max: [0.78, 0.924, -0.74] }],   // a 1.2 cm plate under the dash's front edge: the gap between the dash top (y 0.944 at z -0.79) and the cowl (0.927 at -0.90) showed the horizon as a pale dashed line from the seat
  // atlas islands whose centroid lies in these boxes get fully smooth normals (the door card, the pull pocket, the centre console and stack):
  // low-poly soft forms whose facet angles pass the crease threshold; the dash top and the seats keep the 55 degree crease
  smoothBoxes: [{ min: [-1.05, 0.25, -0.80], max: [-0.58, 1.15, 0.65] }, { min: [-0.13, 0.30, -0.80], max: [0.13, 0.95, 0.45] }, { min: [-0.08, 0.88, -0.62], max: [0.17, 1.0, -0.40] }],
  keyPath: [[0, 0.77, -0.093], [-0.3, 0.74, -0.113], [-0.64, 0.72, -0.223]],   // above the gear knob, behind the wheel at the knee, left under the rim and the stalk
  // the cabin points on the real dash (MODEL frame): the courtesy light just under the fitted dome, the puddle lamp under the dash on the
  // carpet (not the cushion), the gauge spill on the rim top, the PCM spill on the console, the catch ember on the slot
  lights: { dome: [0, 1.19, 0.0], dash1: [-0.22, 0.99, -0.33], inst: [-0.335, 1.01, -0.37], pcm: [0.005, 0.79, -0.31], foot: [-0.335, 0.35, -0.37], catchGlow: [-0.60, 0.80, -0.33] },
  domeK: 0.45, warmK: 0.30,                               // the dome point sits close under the real headliner; the warm dash points are scaled for the paler atlas trims
  beamK: 0.25, beamShift: -0.4,                           // the headlight beam cones sit further ahead and softer in the windscreen
  creaseDeg: 55,                                          // crease-angle normal rebuild on the atlas meshes (the file ships split normals on soft forms)
  // the file's steering-wheel rim is a 24-segment polygon (visible as straight edges on its silhouette): every wheel-mesh triangle whose
  // three vertices lie beyond cutRadial from the hub axis is dropped and a smooth stitched-leather torus takes its place (measured
  // from the vertex data: rim cross-section radial 0.151..0.205, axial -0.033..0.006 about the hub point along the hub normal)
  rim: { center: [-0.3365, 0.838, -0.224], normal: [0, 0.267, 0.964], R: 0.177, tube: 0.027, axialScale: 0.74, cutRadial: 0.146, maxTris: 800, minTris: 250 },
  // the headliner is one wide atlas island (x -0.66..0.66, y 0.90..1.29, z -0.66..1.52) that reads as a stippled grey speckle at phone size:
  // it gets a matte fabric material (minSpanZ keeps the sunroof shade islands inside the same box on the roof-shade material)
  headlinerBox: { min: [-0.75, 0.88, -0.70], max: [0.75, 1.32, 1.55], minSpanZ: 1.5 },
  contact: { center: [0, -0.90], size: [5.4, 2.4], tyres: [[-0.78, 1.25], [0.78, 1.25], [-0.78, -1.2], [0.78, -1.2]] },   // the baked contact shadow (MODEL frame x/z)
  doorContact: { size: [0.7, 1.3], pos: [-0.05, 0.62] }   // a soft blob under the open driver door, in the door's hinge frame (0.7 m across the door, 1.3 m along it from the hinge, centred at local x/z)
};
export const MODEL_HINTS = {
  units: 'metres; a file at 1/100 scale (largest raw extent under 0.2 m) gets MODEL_TRANSFORM (scale 100, yaw 180, shift)',
  axes: '+Y up, the driver looks toward -Z, +X toward the passenger (left-hand drive)',
  origin: 'cabin floor at y = 0 on the car centreline; z = 0 at the front edge of the seat cushions; driver seat centred at x = -0.38',
  eye: 'the seated camera is at (-0.42, 0.995, 0.30) looking at (-0.58, 0.76, -0.50); the walk-in starts at (-2.25, 1.42, 0.62) outside the open driver door',
  driverDoor: 'hinged at (-0.80, *, -0.72); if the model carries its own door, name it so the scene can swing it (closed = rotation.y 0, open = -62 deg)',
  unnamed: 'a model with none of the names below is fitted by geometry (MODEL_FIT): door cut from index islands, props placed by measured coordinates, POSE_MODEL camera set',
  // mesh / node names the loader looks for (case-insensitive substring match, first hit wins)
  names: {
    keySlot: ['ignition', 'ign_slot', 'key_slot', 'keyslot'],        // the key and the slot are ours; this only moves them (position + facing)
    wheel: ['steering_wheel', 'steeringwheel', 'wheel_rim'],
    wheelHub: ['wheel_hub', 'hub_cap'],                              // gets the MFFU wordmark texture
    tach: ['tach', 'tachometer', 'dial_centre', 'dial_center'],      // gets our dial face + emissive
    tachNeedle: ['needle_tach', 'tach_needle', 'needle'],            // rotated about its local Z (0 rpm = rotation 0, +130 deg clockwise at 9k)
    dialLeft: ['dial_left', 'display_left'], dialRight: ['dial_right', 'display_right'],
    screen: ['touchscreen', 'pcm', 'center_screen', 'centre_screen'],
    door: ['door_driver', 'door_l', 'driver_door'],
    dome: ['dome_light', 'dome'],
    windscreen: ['windscreen', 'windshield', 'glass_front']
  },
  materials: 'any material whose name contains "lit" or "emissive" is driven by the notch (emissiveIntensity 0..1, cool white #e6eef8)',
  budget: 'under 250k triangles, textures 2k max, no lights baked in (the scene lights it), glass as transparent MeshPhysicalMaterial'
};

// ---------- quality tiers ----------
// Layers: 0 everything, 1 = skipped by the AO / depth-of-field pre-passes and the floor reflector (glass, additive planes, sprites, the
// contact blob), 2 = skipped by the floor reflector only (the stage floor, its rings, the reflector itself).
const LAYER_NOPRE = 1, LAYER_NOREFL = 2;
// budget: the burst probe's throughput budget (ms per frame, GPU-synced, minus the clear+sync calibration); ceilK: the steady-state watchdog
// counts a rAF interval as slow beyond ceilK display periods (1.5 on ultra/high: a dropped vsync; 2.5 on base, the last tier before the floor).
// The last step before lite is probed against 24 ms instead, so a device that holds 40 to 60 fps on base is not pushed to the floor.
// msaa: only ultra multisamples, and only the scene pass (a multisampled HalfFloat target that is resolved once and copied into the
// single-sample ping-pong); the other tiers run SMAA on the LDR image. lite keeps the composer (scene -> output -> SMAA, no bloom, no
// bloom; the grade stays, grain off) so every tier draws the same material programs into the same kind of target: a step into lite is a pass change, never a recompile.
// rect: the two gold RectAreaLights (LTC lookups per pixel) are ultra only; the gold strips still reach every tier through the environment map.
const CLUSTER_K = { ultra: 1, high: 0.85, base: 0.85, lite: 0.85 };   // the cluster emissives per tier: ultra's AO darkens the binnacle hood, the other tiers dim the faces instead so the cluster reads alike on every tier
const TIERS = {
  ultra: { pr: 2, maxPix: 5.0e6, budget: 12, ceilK: 1.5, msaa: 4, gtao: true, dof: true, shadow: 2048, soft: true, sheen: true, refl: true, rect: true, clearcoat: true, post: true, bloom: true, grade: true, clamp: 4.0, bloomK: 1 },
  high: { pr: 1.5, maxPix: 3.5e6, budget: 16, ceilK: 1.5, msaa: 0, gtao: false, dof: true, shadow: 1024, soft: false, sheen: true, refl: false, rect: false, clearcoat: true, post: true, bloom: true, grade: true, clamp: 4.0, bloomK: 1 },
  base: { pr: 1, maxPix: 9e9, budget: 28, ceilK: 2.5, msaa: 0, gtao: false, dof: false, shadow: 1024, soft: false, sheen: false, refl: false, rect: false, clearcoat: true, post: true, bloom: true, grade: true, clamp: 2.0, bloomK: 0.75 },   // no AO or DoF to soften the chrome: a lower clamp and a gentler bloom
  lite: { pr: 1, maxPix: 9e9, budget: 33, ceilK: 0, msaa: 0, gtao: false, dof: false, shadow: 0, soft: false, sheen: false, refl: false, rect: false, clearcoat: false, post: true, bloom: false, grade: true, clamp: 2.0, bloomK: 0.75 }
};
const HDR_CLAMP = 4.0;            // the scene buffer is clamped here before bloom: a 1-pixel specular on a stitched sill cannot seed a firefly
const ABL = k => { try { return !!(S.opts && S.opts.ablate && String(S.opts.ablate).split(',').includes(k)); } catch (e) { return false; } };   // harness only: ?ablate=shadow,clearcoat,latelights,sheen,floor,env,glass,normal,flare,regiondebug
const GPU_RX = {
  software: /SwiftShader|llvmpipe|Microsoft Basic|softpipe/i,
  strong: /NVIDIA.*(RTX|GTX 1[6-9]|GTX [2-9]\d)|Radeon (RX|Pro|[679]\d{3})|Apple (M\d|GPU)|Arc\(TM\) [AB]\d{3}/,
  notStrong: /Intel.*(HD|UHD|Iris)|Arc\(TM\) 1\d{2}/,
  weak: /Intel.*(HD|UHD|Iris)|Radeon\(TM\) (Vega|Graphics)|Mali|Adreno|PowerVR|Apple A\d/,
  phoneStrong: /Apple GPU|Adreno \(TM\) [78]\d{2}|Mali-G(7[1-9]\d|[89]\d{2})|Immortalis|Xclipse/,
  phoneWeak: /Mali-G[35]\d|Adreno \(TM\) (5\d{2}|6[01]\d)|PowerVR/
};

// ---------- small helpers ----------
const DEG = Math.PI / 180;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const easeInOut = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const easeInOutSine = t => -(Math.cos(Math.PI * t) - 1) / 2;
const easeOut = t => 1 - Math.pow(1 - t, 3);
const easeOutQuint = t => 1 - Math.pow(1 - t, 5);
const smooth = t => t * t * (3 - 2 * t);
const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d', { willReadFrequently: true }); return c; }
function ctex(c, srgb, repeat) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = S.aniso || 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
// height field (red channel of a canvas) -> tangent-space normal map
function heightToNormal(c, strength, repeat) {
  const w = c.width, h = c.height, src = c.getContext('2d').getImageData(0, 0, w, h).data;
  const out = canvas(w, h), x = out.getContext('2d'), id = x.createImageData(w, h), d = id.data;
  const H = (i, j) => src[(((j + h) % h) * w + ((i + w) % w)) * 4] / 255;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const dx = (H(i - 1, j) - H(i + 1, j)) * strength, dy = (H(i, j + 1) - H(i, j - 1)) * strength;
    const l = 1 / Math.sqrt(dx * dx + dy * dy + 1), o = (j * w + i) * 4;
    d[o] = (dx * l * .5 + .5) * 255; d[o + 1] = (dy * l * .5 + .5) * 255; d[o + 2] = (l * .5 + .5) * 255; d[o + 3] = 255;
  }
  x.putImageData(id, 0, 0);
  return ctex(out, false, repeat || [1, 1]);
}

// ---------- procedural textures ----------
function leatherNormal() {
  const s = 512, c = canvas(s, s), x = c.getContext('2d'), r = rng(7);
  x.fillStyle = '#808080'; x.fillRect(0, 0, s, s);
  for (let i = 0; i < 3200; i++) {                         // pebble grain
    const rad = 2.5 + r() * 4.5, px = r() * s, py = r() * s, g = x.createRadialGradient(px, py, 0, px, py, rad);
    g.addColorStop(0, 'rgba(255,255,255,.5)'); g.addColorStop(.65, 'rgba(150,150,150,.22)'); g.addColorStop(1, 'rgba(60,60,60,0)');
    x.fillStyle = g; x.beginPath(); x.arc(px, py, rad, 0, Math.PI * 2); x.fill();
  }
  x.strokeStyle = 'rgba(30,30,30,.16)'; x.lineWidth = 1;         // creases
  for (let i = 0; i < 260; i++) { const px = r() * s, py = r() * s; x.beginPath(); x.moveTo(px, py); x.lineTo(px + (r() - .5) * 46, py + (r() - .5) * 46); x.stroke(); }
  const id = x.getImageData(0, 0, s, s), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const n = (r() - .5) * 16; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  x.putImageData(id, 0, 0);
  return heightToNormal(c, 1.9, [1, 1]);
}
function stitchNormal() {                                         // a seam with two rows of angled stitches, runs along u
  const s = 512, c = canvas(s, s), x = c.getContext('2d');
  x.fillStyle = '#808080'; x.fillRect(0, 0, s, s);
  const cy = s / 2, g = x.createLinearGradient(0, cy - 12, 0, cy + 12);
  g.addColorStop(0, '#808080'); g.addColorStop(.5, '#383838'); g.addColorStop(1, '#808080');
  x.fillStyle = g; x.fillRect(0, cy - 12, s, 24);
  x.strokeStyle = '#ececec'; x.lineWidth = 6; x.lineCap = 'round';
  for (let i = 0; i < s; i += 36) for (const sg of [-1, 1]) { const yy = cy + sg * 20; x.beginPath(); x.moveTo(i + 4, yy + sg * 5); x.lineTo(i + 24, yy - sg * 5); x.stroke(); }
  const r = rng(3), id = x.getImageData(0, 0, s, s), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const n = (r() - .5) * 10; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  x.putImageData(id, 0, 0);
  return heightToNormal(c, 2.4, [1, 1]);
}
function seatStitchNormal() {                                     // seat quilting: one soft seam valley (a quarter of the tile) with a row of stitches, tiled over the cushion
  const s = 256, c = canvas(s, s), x = c.getContext('2d');
  x.fillStyle = '#808080'; x.fillRect(0, 0, s, s);
  const cy = s / 2, g = x.createLinearGradient(0, cy - 32, 0, cy + 32);
  g.addColorStop(0, '#808080'); g.addColorStop(.5, '#2c2c2c'); g.addColorStop(1, '#808080');
  x.fillStyle = g; x.fillRect(0, cy - 32, s, 64);
  x.strokeStyle = '#e4e4e4'; x.lineWidth = 5; x.lineCap = 'round';
  for (let i = 0; i < s; i += 24) { x.beginPath(); x.moveTo(i + 3, cy - 2); x.lineTo(i + 15, cy + 2); x.stroke(); }
  const r = rng(5), id = x.getImageData(0, 0, s, s), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const n = (r() - .5) * 8; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  x.putImageData(id, 0, 0);
  return heightToNormal(c, 2.2, [1, 1]);
}
function quiltTextures() {                                       // seat quilting: one diamond per tile (2.1 cm of cushion), a soft dome in the height and a seam band at the tile edges that darkens the albedo to 0.55
  const s = 128, c = canvas(s, s), x = c.getContext('2d'), id = x.createImageData(s, s), d = id.data, a = canvas(s, s), ax = a.getContext('2d'), ia = ax.createImageData(s, s), da = ia.data;
  for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) {
    const u = (i + .5) / s - .5, v = (j + .5) / s - .5, e = 0.5 - Math.max(Math.abs(u), Math.abs(v));   // distance to the tile edge (0 at the seam, 0.5 at the centre)
    const seam = 1 - smooth(clamp(e / 0.085, 0, 1)), h = Math.pow(clamp(e / 0.5, 0, 1), 0.55), o = (j * s + i) * 4;
    d[o] = d[o + 1] = d[o + 2] = Math.round(50 + 205 * h * (1 - 0.6 * seam)); d[o + 3] = 255;
    const alb = (1 - 0.45 * seam) * (0.88 + 0.12 * h); da[o] = da[o + 1] = da[o + 2] = Math.round(alb * 255); da[o + 3] = 255;
  }
  x.putImageData(id, 0, 0); ax.putImageData(ia, 0, 0);
  const normal = heightToNormal(c, 2.0, [1, 1]), albedo = ctex(a, false, [1, 1]); albedo.colorSpace = THREE.NoColorSpace;
  for (const t of [normal, albedo]) t.anisotropy = Math.min(8, S.aniso || 4);
  return { normal, albedo };
}
function brushedNormal() {
  const s = 256, c = canvas(s, s), x = c.getContext('2d'), r = rng(11);
  x.fillStyle = '#808080'; x.fillRect(0, 0, s, s);
  for (let i = 0; i < 900; i++) { x.strokeStyle = `rgba(${r() > .5 ? 255 : 0},${r() > .5 ? 255 : 0},${r() > .5 ? 255 : 0},.12)`; x.lineWidth = 1; const y = r() * s; x.beginPath(); x.moveTo(0, y); x.lineTo(s, y + (r() - .5) * 2); x.stroke(); }
  return heightToNormal(c, 1.2, [1, 1]);
}
function flakeNormal() {                                          // metallic flake under the clearcoat (per-pixel noise, tiled 40x)
  const s = 256, c = canvas(s, s), x = c.getContext('2d'), r = rng(23), id = x.createImageData(s, s), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const v = 128 + (r() - .5) * 180; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  x.putImageData(id, 0, 0);
  return heightToNormal(c, 0.6, [40, 40]);
}
function blobGrey(s, lo, hi, seed, repeat) {                      // soft overlapping blobs (values lo..hi of 255): a polished floor's uneven sheen
  const c = canvas(s, s), x = c.getContext('2d'), r = rng(seed);
  x.fillStyle = 'rgb(' + hi + ',' + hi + ',' + hi + ')'; x.fillRect(0, 0, s, s);
  for (let i = 0; i < 90; i++) { const rad = 18 + r() * 50, px = r() * s, py = r() * s, v = Math.round(lo + r() * (hi - lo) * 0.7), g = x.createRadialGradient(px, py, 0, px, py, rad); g.addColorStop(0, 'rgba(' + v + ',' + v + ',' + v + ',.55)'); g.addColorStop(1, 'rgba(' + v + ',' + v + ',' + v + ',0)'); x.fillStyle = g; for (const [ox, oy] of [[0, 0], [s, 0], [-s, 0], [0, s], [0, -s]]) { x.beginPath(); x.arc(px + ox, py + oy, rad, 0, Math.PI * 2); x.fill(); } }
  return ctex(c, false, repeat || [1, 1]);
}
function noiseGrey(s, lo, hi, seed, repeat) {                     // a grey noise canvas (values lo..hi of 255) for roughness maps
  const c = canvas(s, s), x = c.getContext('2d'), r = rng(seed), id = x.createImageData(s, s), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const v = lo + (r() * 0.6 + r() * 0.4) * (hi - lo); d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  x.putImageData(id, 0, 0);
  return ctex(c, false, repeat || [1, 1]);
}
function dialTextures() {                                         // central tach: black face, 1..9, red from 7
  const s = 512, cx = 256, cy = 256, ang = v => (-130 + v / 9 * 260) * DEG;
  const mk = lit => {
    const c = canvas(s, s), x = c.getContext('2d');
    if (lit) { x.fillStyle = '#000'; x.fillRect(0, 0, s, s); }
    else {
      const g = x.createRadialGradient(cx, cy, 30, cx, cy, 250); g.addColorStop(0, '#111319'); g.addColorStop(1, '#05060a');
      x.fillStyle = g; x.fillRect(0, 0, s, s); x.strokeStyle = '#2a2e38'; x.lineWidth = 3; x.beginPath(); x.arc(cx, cy, 244, 0, Math.PI * 2); x.stroke();
    }
    const white = lit ? '#e6eef8' : '#5d6470', red = lit ? '#ff3b30' : '#5a1a16';
    x.strokeStyle = red; x.lineWidth = 12; x.beginPath(); x.arc(cx, cy, 226, ang(7) - Math.PI / 2, ang(9) - Math.PI / 2); x.stroke();
    for (let v = 0; v <= 9; v += .5) {
      const a = ang(v), major = v % 1 === 0, r0 = major ? 200 : 214, r1 = 238;
      x.strokeStyle = v >= 7 ? red : white; x.lineWidth = major ? 5 : 2.5; x.lineCap = 'round';
      x.beginPath(); x.moveTo(cx + r0 * Math.sin(a), cy - r0 * Math.cos(a)); x.lineTo(cx + r1 * Math.sin(a), cy - r1 * Math.cos(a)); x.stroke();
    }
    x.font = '600 50px system-ui, Segoe UI, Roboto, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    for (let v = 1; v <= 9; v++) { const a = ang(v); x.fillStyle = v >= 7 ? red : white; x.fillText(String(v), cx + 158 * Math.sin(a), cy - 158 * Math.cos(a)); }
    x.fillStyle = white; x.font = '500 20px system-ui, Segoe UI, Roboto, sans-serif'; x.fillText('x1000 rpm', cx, cy + 92);
    return c;
  };
  return { map: ctex(mk(false), true), emissive: ctex(mk(true), true) };
}
function displayTextures(kind) {                                  // flanking dark glass displays (992-style), cool white + page blue
  const w = 512, h = 256;
  const mk = lit => {
    const c = canvas(w, h), x = c.getContext('2d');
    x.fillStyle = lit ? '#000' : '#07080c'; x.fillRect(0, 0, w, h);
    if (!lit) return c;
    const white = '#e6eef8', blue = '#3a82f7', dim = '#7f8aa0';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    if (kind === 'left') {
      x.strokeStyle = '#273043'; x.lineWidth = 10; x.lineCap = 'round'; x.beginPath(); x.arc(256, 150, 108, Math.PI * .8, Math.PI * 2.2); x.stroke();
      x.strokeStyle = blue; x.beginPath(); x.arc(256, 150, 108, Math.PI * .8, Math.PI * .92); x.stroke();
      x.fillStyle = white; x.font = '600 92px system-ui, Segoe UI, Roboto, sans-serif'; x.fillText('0', 256, 148);
      x.fillStyle = dim; x.font = '500 22px system-ui, Segoe UI, Roboto, sans-serif'; x.fillText('km/h', 256, 214);
      x.textAlign = 'left'; x.fillStyle = white; x.font = '600 26px system-ui, Segoe UI, Roboto, sans-serif'; x.fillText('P', 36, 40);
      for (let i = 0; i < 6; i++) { x.fillStyle = i < 5 ? white : '#2a3244'; x.fillRect(380 + i * 16, 30, 10, 20); }
    } else {
      x.strokeStyle = 'rgba(58,130,247,.28)'; x.lineWidth = 1;
      for (let i = 0; i <= w; i += 32) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, h); x.stroke(); }
      for (let j = 0; j <= h; j += 32) { x.beginPath(); x.moveTo(0, j); x.lineTo(w, j); x.stroke(); }
      x.fillStyle = white; x.font = '600 36px system-ui, Segoe UI, Roboto, sans-serif'; x.fillText('READY', 256, 122);
      x.fillStyle = dim; x.font = '500 20px system-ui, Segoe UI, Roboto, sans-serif'; x.fillText('ALL SYSTEMS', 256, 166);
      x.strokeStyle = white; x.lineWidth = 3; x.beginPath(); x.arc(440, 60, 26, 0, Math.PI * 2); x.stroke();
      x.fillStyle = '#ff3b30'; x.beginPath(); x.moveTo(440, 38); x.lineTo(449, 62); x.lineTo(431, 62); x.fill();
      x.fillStyle = white; x.beginPath(); x.moveTo(440, 82); x.lineTo(449, 58); x.lineTo(431, 58); x.fill();
    }
    return c;
  };
  return { map: ctex(mk(false), true), emissive: ctex(mk(true), true) };
}
function screenTextures(wordmark) {                               // the centre touchscreen
  const w = 512, h = 300, c = canvas(w, h), x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
  x.strokeStyle = 'rgba(58,130,247,.22)'; x.lineWidth = 1;
  for (let i = 0; i <= w; i += 40) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, h); x.stroke(); }
  for (let j = 0; j <= h; j += 40) { x.beginPath(); x.moveTo(0, j); x.lineTo(w, j); x.stroke(); }
  x.strokeStyle = 'rgba(58,130,247,.9)'; x.lineWidth = 6; x.lineCap = 'round'; x.beginPath(); x.moveTo(60, 250); x.quadraticCurveTo(250, 240, 300, 120); x.lineTo(470, 60); x.stroke();
  x.fillStyle = '#e6eef8'; x.beginPath(); x.arc(300, 120, 9, 0, Math.PI * 2); x.fill();
  x.fillStyle = 'rgba(230,238,248,.12)'; for (let i = 0; i < 4; i++) x.fillRect(24 + i * 120, h - 46, 100, 26);
  x.fillStyle = '#e6eef8'; x.font = '500 16px system-ui, Segoe UI, Roboto, sans-serif'; x.textAlign = 'left'; x.textBaseline = 'middle';
  ['NAV', 'MEDIA', 'CAR', 'PHONE'].forEach((t, i) => x.fillText(t, 36 + i * 120, h - 33));
  if (wordmark) { try { x.drawImage(wordmark, 24, 20, 179 * .9, 32 * .9); } catch (e) {} }
  const dark = canvas(w, h); const dx = dark.getContext('2d'); dx.fillStyle = '#06070b'; dx.fillRect(0, 0, w, h);
  return { map: ctex(dark, true), emissive: ctex(c, true) };
}
function hubTexture(wordmark) {                                   // satin black hub with the MFFU wordmark
  const s = 512, c = canvas(s, s), x = c.getContext('2d');
  const g = x.createRadialGradient(256, 256, 20, 256, 256, 256); g.addColorStop(0, '#24262c'); g.addColorStop(1, '#101114');
  x.fillStyle = g; x.fillRect(0, 0, s, s);
  x.strokeStyle = '#3a3d45'; x.lineWidth = 4; x.beginPath(); x.arc(256, 256, 236, 0, Math.PI * 2); x.stroke();
  if (wordmark) { try { const W = 330, H = W * 32 / 179; x.drawImage(wordmark, 256 - W / 2, 256 - H / 2, W, H); } catch (e) {} }
  return ctex(c, true);
}
function floorTextures(rep) {                                     // the page's stage: navy floor, faint blue lines every metre
  const s = 512, mk = lit => {
    const c = canvas(s, s), x = c.getContext('2d');
    x.fillStyle = lit ? '#000' : '#05081a'; x.fillRect(0, 0, s, s);
    x.strokeStyle = lit ? 'rgba(58,130,247,.55)' : 'rgba(58,130,247,.22)'; x.lineWidth = 2;
    for (const p of [1, 256]) { x.beginPath(); x.moveTo(p, 0); x.lineTo(p, s); x.stroke(); x.beginPath(); x.moveTo(0, p); x.lineTo(s, p); x.stroke(); }
    return c;
  };
  return { map: ctex(mk(false), true, [rep, rep]), emissive: ctex(mk(true), true, [rep, rep]) };
}
function poolTexture() {                                           // a headlight pool: (1 - r^2)^2.5, a sharper elliptical lobe than the old soft disc
  const s = 256, c = canvas(s, s), x = c.getContext('2d'), id = x.createImageData(s, s), d = id.data;
  for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) { const u = (i + .5) / s * 2 - 1, v = (j + .5) / s * 2 - 1, r2 = u * u + v * v, a = r2 >= 1 ? 0 : Math.pow(1 - r2, 2.5), o = (j * s + i) * 4; d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = Math.round(a * 255); }
  x.putImageData(id, 0, 0); return ctex(c, true);
}
function gaugeTextures() {                                         // the two outer dials of the real cluster: a plain tick ring, white needle, no numerals
  const s = 256, cx = 128, cy = 128, ang = v => (-130 + v * 260) * DEG;
  const mk = lit => {
    const c = canvas(s, s), x = c.getContext('2d');
    if (lit) { x.fillStyle = '#000'; x.fillRect(0, 0, s, s); } else { const g = x.createRadialGradient(cx, cy, 10, cx, cy, 128); g.addColorStop(0, '#111319'); g.addColorStop(1, '#05060a'); x.fillStyle = g; x.fillRect(0, 0, s, s); }
    const white = lit ? '#e6eef8' : '#4a515c';
    for (let v = 0; v <= 1.0001; v += 1 / 16) { const a = ang(v), major = Math.round(v * 16) % 4 === 0, r0 = major ? 92 : 102, r1 = 116; x.strokeStyle = white; x.lineWidth = major ? 4 : 2; x.lineCap = 'round'; x.beginPath(); x.moveTo(cx + r0 * Math.sin(a), cy - r0 * Math.cos(a)); x.lineTo(cx + r1 * Math.sin(a), cy - r1 * Math.cos(a)); x.stroke(); }
    const na = ang(0.28); x.strokeStyle = lit ? '#f4f6fa' : '#5d6470'; x.lineWidth = 4; x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + 88 * Math.sin(na), cy - 88 * Math.cos(na)); x.stroke();
    x.fillStyle = lit ? '#e6eef8' : '#2a2e38'; x.beginPath(); x.arc(cx, cy, 9, 0, Math.PI * 2); x.fill();
    return c;
  };
  return { map: ctex(mk(false), true), emissive: ctex(mk(true), true) };
}
function discTexture(s) {                                          // a soft disc (stage lamps, the ember, the flare core)
  const c = canvas(s, s), x = c.getContext('2d'), g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.25, 'rgba(255,255,255,.75)'); g.addColorStop(.6, 'rgba(255,255,255,.18)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, s, s); return ctex(c, true);
}
function flareTexture() {                                          // the catch flare: a soft core with a faint anamorphic streak and a thin gold ring
  const s = 256, c = canvas(s, s), x = c.getContext('2d');
  let g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.12, 'rgba(230,238,248,.7)'); g.addColorStop(.4, 'rgba(200,215,240,.12)'); g.addColorStop(1, 'rgba(200,215,240,0)');
  x.fillStyle = g; x.fillRect(0, 0, s, s);
  g = x.createLinearGradient(0, 128, 256, 128);
  g.addColorStop(0, 'rgba(216,174,94,0)'); g.addColorStop(.5, 'rgba(240,232,220,.55)'); g.addColorStop(1, 'rgba(216,174,94,0)');
  x.fillStyle = g; x.fillRect(0, 124, 256, 8);
  x.strokeStyle = 'rgba(216,174,94,.28)'; x.lineWidth = 2; x.beginPath(); x.arc(128, 128, 92, 0, Math.PI * 2); x.stroke();
  return ctex(c, true);
}
function contactTexture(fit) {                                     // multiply map: 1 at the edge, dark under the body, darker under each tyre
  const w = 512, h = 256, c = canvas(w, h), x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
  const sx = w / fit.size[0], sz = h / fit.size[1];                // canvas x = along the car (z), canvas y = across (x)
  x.save(); x.translate(w / 2, h / 2); x.scale(1, 0.46);
  let g = x.createRadialGradient(0, 0, 0, 0, 0, w / 2);
  g.addColorStop(0, 'rgba(0,0,0,.92)'); g.addColorStop(.55, 'rgba(0,0,0,.72)'); g.addColorStop(.85, 'rgba(0,0,0,.2)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.beginPath(); x.arc(0, 0, w / 2, 0, Math.PI * 2); x.fill(); x.restore();
  for (const [tx, tz] of fit.tyres) {                              // tyre contact patches
    const px = w / 2 - tz * sx, py = h / 2 + tx * sz;
    x.save(); x.translate(px, py); x.scale(1.6, 1);
    g = x.createRadialGradient(0, 0, 0, 0, 0, 22); g.addColorStop(0, 'rgba(0,0,0,.9)'); g.addColorStop(.5, 'rgba(0,0,0,.5)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.beginPath(); x.arc(0, 0, 22, 0, Math.PI * 2); x.fill(); x.restore();
  }
  const t = ctex(c, false); t.colorSpace = THREE.NoColorSpace; return t;
}

// ---------- geometry helpers ----------
// sweep a side profile ([z, y] points, smoothed) across x; bend(u in -1..1) returns [dz, dy]
function sweep(profile, xFrom, xTo, segsX, bend, samples) {
  let pts = profile.map(p => new THREE.Vector2(p[0], p[1]));
  if (samples) pts = new THREE.SplineCurve(pts).getPoints(samples);
  const rows = pts.length, cols = segsX + 1, pos = [], uv = [], idx = [];
  for (let i = 0; i < cols; i++) {
    const u = i / segsX, x = lerp(xFrom, xTo, u), b = bend ? bend(u * 2 - 1) : [0, 0];
    for (let j = 0; j < rows; j++) { pos.push(x, pts[j].y + b[1], pts[j].x + b[0]); uv.push(u * 6, j / (rows - 1) * 2); }
  }
  for (let i = 0; i < segsX; i++) for (let j = 0; j < rows - 1; j++) { const a = i * rows + j, b = a + rows; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  const g = new THREE.BufferGeometry(); g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals(); return g;
}
function quad(p0, p1, p2, p3) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...p0, ...p1, ...p2, ...p0, ...p2, ...p3], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
  g.computeVertexNormals(); return g;
}
function strut(a, b, r, mat, segs) {
  const A = V3(a), B = V3(b), d = B.clone().sub(A), L = d.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L, segs || 14), mat);
  m.position.copy(A).addScaledVector(d, .5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); return m;
}
function rbox(w, h, d, r, mat) { return new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), mat); }
function at(m, x, y, z, rx, ry, rz) { m.position.set(x, y, z); if (rx !== undefined) m.rotation.set(rx, ry || 0, rz || 0); return m; }
function noPre(o) { o.layers.set(LAYER_NOPRE); return o; }         // skipped by the AO / DoF pre-passes and the reflector
function noRefl(o) { o.layers.set(LAYER_NOREFL); return o; }       // skipped by the reflector only

// ---------- the scene ----------
const S = {                       // runtime state (one scene per page)
  renderer: null, scene: null, camera: null, composer: null, bloom: null, gtao: null, dof: null, grade: null, container: null, canvas: null,
  opts: {}, lite: false, rm: false, phone: false, mounted: false, raf: 0, t: 0, last: 0, disposed: false,
  deg: 0, selfTest: -1, lastOn: false, sagT: -1, catchT: -1, blipT: -1, shakeT: -1, breathT: -1, dome: 1, doorOpen: 1, doorPrev: -1, surge: 0,
  tachV: 0, tachShiver: 0, move: null, breath: true, model: null, modelReady: false, rigModel: false, modelPos: null, fit: null, loadGen: 0, holdTimer: 0, onModelSettled: null, lastStage: null,
  revealed: false, revealPending: false, shown: false, fadeMs: 350, mo: null, mountGen: 0,   // the canvas stays transparent through the model hold (shown: a frame is on the visible canvas); rigModel: the camera/lights/key path follow the fitted model (not a MODEL_HINTS-named one)
  tier: 'base', pr: 1, tierState: null, aniso: 4, exp: 1.2, fov: 58, focus: 0.8, shadowDirty: 0, envTex: null, pmrem: null, lateOn: false,
  stats: { frames: 0, frameMs: 0, renderMs: 0, maxMs: 0, hist: [], rhist: [] }
};
const T = {};                     // textures
const M = {};                     // materials that are driven per frame
const N = {};                     // nodes that are driven per frame
const L = {};                     // lights
const RIG = { pos: new THREE.Vector3(), tgt: new THREE.Vector3(), gPos: new THREE.Vector3(), gTgt: new THREE.Vector3(), nudge: new THREE.Vector3(), off: new THREE.Vector3(), toff: new THREE.Vector3(), placed: false };
const TAU = .085;                 // camera smoothing time constant (joins stay velocity-continuous between stages)

// First person: the camera is the driver. Heights are world y (cabin floor = 0); the stage ground is at GROUND,
// so standing eye 1.47 = 1.60 m above the ground, the duck 1.15 = 1.28 m, seated 0.995 = 1.125 m (a low sports car).
const POSE = {                    // world poses; sit/observe paths end at SEATED (phone variant swapped in at mount)
  doorStart: { pos: [-3.20, 1.55, 1.40], tgt: [-0.20, 0.70, -0.40] },    // far enough back to see the whole car, two paces to the open door
  doorEnd: { pos: [-1.58, 1.46, 0.46], tgt: [-0.30, 0.66, -0.40] },      // one slow step closer
  seated: { pos: [-0.42, 0.995, 0.30], tgt: [-0.60, 0.79, -0.50] },
  seatedPhone: { pos: [-0.42, 1.00, 0.32], tgt: [-0.47, 0.85, -0.48] }
};
// The same poses for the real 911 (MODEL frame, see MODEL_TRANSFORM): the cushion is a deep bucket raked 21 deg with its front lip
// under the wheel centre, so the seated eye sits 0.71 m above the H-point, 0.57 m behind the wheel and sees the cluster THROUGH the
// upper opening of the rim; the roof rail over the door aperture is at y 1.18..1.24, so the sit path ducks to 1.03 before landing.
const POSE_MODEL = {
  // door: a person at eye level (1.40 m over the ground) a step behind the open door's free edge, looking at the wheel through the aperture
  doorStart: { pos: [-3.55, 1.58, 2.45], tgt: [-0.10, 0.70, -0.20] },   // BEAT far enough back to see the whole car; two paces (1.9 m) to the open door as the lights flash, then in
  doorEnd: { pos: [-1.55, 1.36, 0.58], tgt: [-0.38, 0.70, -0.35] },
  seated: { pos: [-0.36, 1.125, 0.317], tgt: [-0.46, 0.885, -0.45] },
  seatedPhone: { pos: [-0.355, 1.12, 0.40], tgt: [-0.42, 0.90, -0.45] },   // a little further back and aimed a touch left of the hub: the whole rim and the slot both fit the 74 deg phone frame
  sitPos: [[-1.55, 1.36, 0.58], [-1.22, 1.30, 0.42], [-0.92, 1.17, 0.33], [-0.68, 1.05, 0.33], [-0.48, 1.055, 0.33]],   // then the seated eye
  sitTgt: [[-0.38, 0.70, -0.35], [-0.36, 0.52, -0.05], [-0.36, 0.47, 0.05], [-0.40, 0.57, -0.15], [-0.40, 0.77, -0.45]],   // then obsTgt[0]
  obsTgt: [[-0.70, 0.72, -0.25], [0, 0.77, -0.39], [-0.335, 0.90, -0.449], [-0.3365, 0.84, -0.211], [-0.62, 0.76, -0.374]]   // door card, PCM, tach, hub, slot, then the seated gaze
};
// field of view per stage (degrees): a longer lens once seated so the cluster fills the frame; phone frames the whole rim at 70
const FOV = {
  desk: { door: 60, sit: [58, 54], observe: 54, keyin: 52, seated: 52, dissolve: [52, 50] },
  phone: { door: 74, sit: [73, 72], observe: 72, keyin: 72, seated: 72, dissolve: [72, 70] }
};
function modelPos() { return S.modelPos || MODEL_TRANSFORM.pos; }
function mw(p) { const o = modelPos(); return [p[0] + o[0], p[1] + o[1], p[2] + o[2]]; }      // MODEL frame -> WORLD
function activePoses() {
  if (!S.rigModel) return POSE;
  const cv = q => ({ pos: mw(q.pos), tgt: mw(q.tgt) }), P = POSE_MODEL;
  return { doorStart: cv(P.doorStart), doorEnd: cv(P.doorEnd), seated: cv(P.seated), seatedPhone: cv(P.seatedPhone) };
}
function seatedPose() { const A = activePoses(); return S.phone ? A.seatedPhone : A.seated; }
function paths() {
  const sp = seatedPose();
  if (S.rigModel) {
    const P = POSE_MODEL, obsTgt = P.obsTgt.map(mw);
    return {
      sitPos: [...P.sitPos.map(mw), sp.pos], sitTgt: [...P.sitTgt.map(mw), obsTgt[0]],
      obsPos: [sp.pos, [sp.pos[0] + .004, sp.pos[1], sp.pos[2] - .006], sp.pos], obsTgt: [...obsTgt, sp.tgt]
    };
  }
  return {
    // sit: duck under the roof rail (pitch down at the cushion), pass the door frame, slide laterally over the bolster, land
    sitPos: [[-1.58, 1.46, 0.46], [-1.22, 1.30, 0.42], [-0.92, 1.15, 0.37], [-0.66, 1.07, 0.32], [-0.50, 1.02, 0.29], sp.pos],
    sitTgt: [[-0.30, 0.66, -0.40], [-0.38, 0.50, -0.20], [-0.40, 0.46, -0.12], [-0.44, 0.56, -0.30], [-0.62, 0.72, -0.46], [-0.80, 0.82, -0.46]],
    // observe: the head turns from the door side across the dash to the centre, the cluster, the wheel, then down-left to the ignition
    obsPos: [sp.pos, [sp.pos[0] + .004, sp.pos[1], sp.pos[2] - .006], sp.pos],
    obsTgt: [[-0.80, 0.82, -0.46], [-0.30, 0.88, -0.72], [-0.05, 0.84, -0.70], [-0.38, 0.90, -0.62], [-0.42, 0.80, -0.45], sp.tgt]
  };
}
const SLOT = { pos: [-0.665, 0.725, -0.485], look: [-0.42, 0.99, 0.32] };   // the ignition faces the seated eye
const KEY_IN = 0.020, KEY_ALIGN = 0.085, KEY_YAW = 30 * DEG;               // key z in slot space: seated depth (8 mm of blade and the chrome ring showing), lined-up hover; the seated bow yaws 30 deg toward the driver

// ---------- the sky dome (seen by the camera, and rendered into the environment so reflections match) ----------
const SKY_SHADER = {
  uniforms: { zenith: { value: new THREE.Color(0x070b16) }, horizon: { value: new THREE.Color(0x0b1530) }, band: { value: new THREE.Color(0x1a1a2c) }, glow: { value: new THREE.Color(0x1b3a8c) } },
  vertexShader: 'varying vec3 vDir; void main() { vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - vec3(0.0, -0.13, 0.0)); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform vec3 zenith, horizon, band, glow; varying vec3 vDir;
    void main() {
      float h = normalize(vDir).y;
      vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.55));
      float b = exp(-max(h, 0.0) * 22.0) * smoothstep(-0.02, 0.012, h);          // the gold-navy band over the horizon, gone 6 degrees up
      col = mix(col, band, b * 0.85);
      col += glow * 0.06 * exp(-max(h, 0.0) * 9.0) * smoothstep(-0.03, 0.0, h);  // a faint blue lift just above the horizon
      col = mix(col, horizon * 0.55, smoothstep(-0.02, -0.12, h));              // below the horizon the stage fog takes over
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`
};
function skyMaterial() { return new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(SKY_SHADER.uniforms), vertexShader: SKY_SHADER.vertexShader, fragmentShader: SKY_SHADER.fragmentShader, side: THREE.BackSide, depthWrite: false, fog: false }); }
function skyDome() { const m = new THREE.Mesh(new THREE.SphereGeometry(60, 48, 24), skyMaterial()); m.name = 'sky'; m.renderOrder = -10; m.frustumCulled = false; m.position.set(0, GROUND, 0); return m; }

// the night showroom around the car: navy floor with the metre lines, one cool key panel high front-right, cool fills, two gold strips
// along the flanks and a gold horizon ring. Baked once through PMREM; every reflection (paint, chrome, glass, floor) comes from this.
function buildEnvironment(renderer) {
  const env = new THREE.Scene(); env.position.set(0, -0.8, 0.3);   // the cube camera sits at the cabin centre
  env.add(skyDome());
  const fl = floorTextures(8);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ map: fl.map, color: 0x04060f })); floor.rotation.x = -Math.PI / 2; floor.position.set(0, GROUND, -0.5); env.add(floor);
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ map: fl.emissive, color: new THREE.Color(0x3a82f7).multiplyScalar(0.22), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })); grid.rotation.x = -Math.PI / 2; grid.position.set(0, GROUND + 0.01, -0.5); env.add(grid);
  const panel = (w, h, hex, k, pos, look) => { const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), side: THREE.DoubleSide })); p.position.fromArray(pos); p.lookAt(V3(look)); env.add(p); return p; };
  panel(3.2, 1.3, 0xdfe8ff, 3, [1.2, 3.4, -4.6], [0, 0.8, -0.5]);           // the key panel (the one bright rectangle in paint, chrome and glass)
  panel(2.5, 1.5, 0x6f8fe0, 2.5, [3.6, 2.4, 1.6], [0, 0.8, 0]);             // cool fill rear-right
  panel(1.8, 1.2, 0x4f6bb0, 1.5, [-3.2, 2.2, 2.2], [0, 0.8, 0]);            // cool fill rear-left (the driver door glass and the mirror)
  panel(4.5, 0.05, 0xd8ae5e, 12, [-3.4, 1.85, 0], [-0.6, 0.75, 0]);          // the gold strips along both flanks: the brand accent in the metal (thin and bright: two crisp lines in the paint, never a bronze wash)
  panel(4.5, 0.05, 0xd8ae5e, 12, [3.4, 1.85, 0], [0.6, 0.75, 0]);
  const ring = (r, h, k) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 72, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xd8ae5e).multiplyScalar(k), side: THREE.BackSide })); m.position.set(0, 0.9, -0.5); env.add(m); };
  ring(6.5, 0.04, 0.55); ring(6.4, 0.02, 0.25);                              // the gold horizon line (the stage ring seen in the glass and the floor): thin and dim, or the whole roof takes a bronze wash from a 360 degree band
  const pm = new THREE.PMREMGenerator(renderer); pm.compileEquirectangularShader();
  const tex = pm.fromScene(env, 0, 0.1, 120).texture;   // no base-level blur: with sigma 0.035 (2 degrees) the 5 cm strips reached the paint, the glass and the chrome as satin bands, never as lines
  env.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); fl.map.dispose(); fl.emissive.dispose(); pm.dispose();
  return tex;
}

function buildMaterials(wordmark) {
  T.leather = leatherNormal(); T.leather.repeat.set(3, 3);
  T.leatherFine = T.leather.clone(); T.leatherFine.repeat.set(100, 100); T.leatherFine.anisotropy = Math.min(8, S.aniso || 4); T.leatherFine.needsUpdate = true;   // fine leather grain on the atlas (about 14 pebbles per 10 cm, mipmapped so it fades with distance instead of speckling)
  T.stitch = stitchNormal(); T.brushed = brushedNormal();
  T.brushedFine = T.brushed.clone(); T.brushedFine.repeat.set(1, 1); T.brushedFine.needsUpdate = true;
  T.stitchFine = seatStitchNormal(); T.stitchFine.anisotropy = Math.min(8, S.aniso || 4);   // the rim's stitch seam
  { const q = quiltTextures(); T.quilt = q.albedo; T.quiltN = q.normal; }                   // seat quilting (sampled by the atlas shader over the cushion and back regions, world-space tiles)
  T.flake = flakeNormal(); T.dust = noiseGrey(256, 70, 255, 31, [3, 3]); T.mottle = blobGrey(256, 118, 165, 37, [10, 10]);
  T.dial = dialTextures(); T.dispL = displayTextures('left'); T.dispR = displayTextures('right'); T.gauge = gaugeTextures();
  T.screen = screenTextures(wordmark); T.hub = hubTexture(wordmark); T.floor = floorTextures(50); T.pool = poolTexture();
  T.disc = discTexture(128); T.flare = flareTexture(); T.contact = contactTexture(MODEL_FIT.contact);
  const leather = (color, rough, sheen) => new THREE.MeshPhysicalMaterial({ color, roughness: rough || .62, metalness: 0, normalMap: T.leather, normalScale: new THREE.Vector2(.7, .7), envMapIntensity: .35, sheen: sheen === undefined ? .35 : sheen, sheenRoughness: .6, sheenColor: new THREE.Color(0x3a4c7c) });
  M.leather = leather(0x1a1c24, .7, .15);        // charcoal dash and door cards
  M.leatherSeat = leather(0x1e2028, .62);
  M.leatherDark = leather(0x13151b, .7, .1);
  M.trimSatin = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: .42, metalness: .6, envMapIntensity: .7 });   // satin black spokes, trims
  M.trimAlu = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: .4, metalness: .95, normalMap: T.brushed, normalScale: new THREE.Vector2(.5, .5), envMapIntensity: .7 });
  M.plastic = new THREE.MeshStandardMaterial({ color: 0x101114, roughness: .8, metalness: 0, envMapIntensity: .3 });
  M.chrome = new THREE.MeshStandardMaterial({ color: 0xd9dde3, roughness: .26, metalness: 1, envMapIntensity: .45 });
  M.chromeTach = new THREE.MeshStandardMaterial({ color: 0x9ea3ac, roughness: .72, metalness: .7, envMapIntensity: .15 });   // the tach bezel: a satin ring (its 6 o'clock arc was a hotspot on every tier: the key panel and the cluster backlight in a polished chrome)
  M.slotChrome = new THREE.MeshStandardMaterial({ color: 0xd9dde3, roughness: .35, metalness: 1, envMapIntensity: .3 });    // the ignition bezel: quiet until the key is in
  M.rimModel = new THREE.MeshStandardMaterial({ name: 'rim-leather', color: 0x15161a, roughness: .58, metalness: 0, normalMap: T.stitch.clone(), normalScale: new THREE.Vector2(.9, .9), envMapIntensity: .28 });   // the smooth torus that replaces the file's polygon rim
  M.rimModel.normalMap.repeat.set(34, 1); M.rimModel.normalMap.needsUpdate = true;
  M.headlinerModel = new THREE.MeshStandardMaterial({ name: 'headliner', color: 0x222a3c, roughness: .96, metalness: 0, normalMap: T.leather.clone(), normalScale: new THREE.Vector2(.3, .3), envMapIntensity: .12 });
  M.headlinerModel.normalMap.repeat.set(18, 18); M.headlinerModel.normalMap.needsUpdate = true;
  M.brushed = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: .4, metalness: .95, normalMap: T.brushed, normalScale: new THREE.Vector2(.5, .5), envMapIntensity: .7 });
  M.headliner = new THREE.MeshStandardMaterial({ color: 0x15171d, roughness: 1, metalness: 0, envMapIntensity: .2 });
  M.carpet = new THREE.MeshStandardMaterial({ color: 0x0c0d12, roughness: 1, metalness: 0, envMapIntensity: .15 });
  M.paint = new THREE.MeshPhysicalMaterial({ color: MODEL_PAINT, roughness: .16, metalness: .3, clearcoat: 1, clearcoatRoughness: .08, clearcoatNormalMap: T.flake, clearcoatNormalScale: new THREE.Vector2(.08, .08), envMapIntensity: .9, specularIntensity: 1 });   // lacquered navy-black: the gold strips draw as two crisp lines across the roof
  M.glass = new THREE.MeshPhysicalMaterial({ name: 'glass', color: 0x0e1626, roughness: .06, roughnessMap: T.dust, metalness: 0, ior: 1.5, transparent: true, opacity: .2, envMapIntensity: 1.0, side: THREE.DoubleSide, depthWrite: false, specularIntensity: 1 });
  M.glassThin = new THREE.MeshPhysicalMaterial({ name: 'glass-cover', color: 0x0b0e14, roughness: .02, metalness: 0, ior: 1.5, transparent: true, opacity: .14, envMapIntensity: 1.2, depthWrite: false, specularIntensity: 1 });
  M.glassPcm = new THREE.MeshPhysicalMaterial({ name: 'glass-pcm', color: 0x0b0e14, roughness: .3, metalness: 0, ior: 1.5, transparent: true, opacity: .14, envMapIntensity: .6, depthWrite: false, specularIntensity: .5 });   // the centre screen's cover: a soft sheen, never a flat glare blob
  M.dial = new THREE.MeshStandardMaterial({ map: T.dial.map, emissiveMap: T.dial.emissive, emissive: new THREE.Color(0xe6eef8), emissiveIntensity: 0, roughness: .55, metalness: 0, envMapIntensity: .2 });
  M.gauge = new THREE.MeshStandardMaterial({ map: T.gauge.map, emissiveMap: T.gauge.emissive, emissive: new THREE.Color(0xe6eef8), emissiveIntensity: 0, roughness: .55, metalness: 0, envMapIntensity: .2 });   // the outer dials on the real cluster
  M.dispL = new THREE.MeshStandardMaterial({ map: T.dispL.map, emissiveMap: T.dispL.emissive, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0, roughness: .45, metalness: 0, envMapIntensity: .35 });
  M.dispR = new THREE.MeshStandardMaterial({ map: T.dispR.map, emissiveMap: T.dispR.emissive, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0, roughness: .45, metalness: 0, envMapIntensity: .35 });
  M.screen = new THREE.MeshStandardMaterial({ map: T.screen.map, emissiveMap: T.screen.emissive, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0, roughness: .5, metalness: 0, envMapIntensity: .3 });
  M.needle = new THREE.MeshStandardMaterial({ color: 0xf4f6fa, emissive: new THREE.Color(0xe6eef8), emissiveIntensity: 0, roughness: .5 });
  M.needleTip = new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: new THREE.Color(0xff3b30), emissiveIntensity: 0, roughness: .5 });
  M.led = new THREE.MeshStandardMaterial({ color: 0x0c0e14, emissive: new THREE.Color(0xd8ae5e), emissiveIntensity: 0, roughness: .4 });   // dark nubs until they light
  M.ledArr = [M.led.clone(), M.led.clone(), M.led.clone()];
  M.ledHalo = new THREE.SpriteMaterial({ map: T.disc, color: 0xf3d698, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false, opacity: 0 });   // the first LED's halo once the key is seated
  M.gold = new THREE.MeshPhysicalMaterial({ color: 0xd8ae5e, roughness: .22, metalness: 1, clearcoat: .6, clearcoatRoughness: .15, envMapIntensity: 1.6, emissive: new THREE.Color(0xd8ae5e), emissiveIntensity: .06 });   // lacquered gold: one sharp highlight on the bow, a strip on the blade
  M.goldHi = new THREE.MeshPhysicalMaterial({ color: 0xf3d698, roughness: .16, metalness: 1, clearcoat: .6, clearcoatRoughness: .12, envMapIntensity: 1.7, emissive: new THREE.Color(0xd8ae5e), emissiveIntensity: .14 });
  M.goldBow = new THREE.MeshPhysicalMaterial({ color: 0xd8ae5e, roughness: .22, metalness: 1, clearcoat: .6, clearcoatRoughness: .15, normalMap: T.brushed, normalScale: new THREE.Vector2(.5, .5), envMapIntensity: 1.6, emissive: new THREE.Color(0xd8ae5e), emissiveIntensity: .06 });   // the bow's brushed face under the lacquer
  M.shield = new THREE.MeshStandardMaterial({ color: 0xd8ae5e, roughness: .3, metalness: 1, envMapIntensity: 1.2, emissive: new THREE.Color(0xd8ae5e), emissiveIntensity: .35 });   // the key's shield badge: gold, never the khaki a cool reflection makes of bare gold
  M.grip = new THREE.MeshStandardMaterial({ color: 0x121317, roughness: .55, metalness: .1, normalMap: T.leather, normalScale: new THREE.Vector2(.25, .25), envMapIntensity: .4 });
  M.dome = new THREE.MeshStandardMaterial({ color: 0xf6f1e8, emissive: new THREE.Color(0xf4ead9), emissiveIntensity: 0, roughness: .6 });
  M.hub = new THREE.MeshPhysicalMaterial({ map: T.hub, roughness: .7, metalness: 0, specularIntensity: .25, envMapIntensity: .3 });   // satin, low specular: the disc faces the seated eye at grazing, and its top edge (under the tach's 6 o'clock arc) was the one hotspot there on the tiers without DoF (dielectric Fresnel, not the bezel)
  // the stage floor: a polished navy surface (roughness about 0.35 under the mottle map) so the key panel, the gold strips and the horizon ring
  // read in it on every tier, the metre lines still showing through; on ultra the Reflector underneath adds the car itself
  M.floor = new THREE.MeshStandardMaterial({ map: T.floor.map, color: new THREE.Color(1.035, 1.035, 1.10), emissiveMap: T.floor.emissive, emissive: new THREE.Color(0x3a82f7), emissiveIntensity: .5, roughness: .62, roughnessMap: T.mottle, metalness: .05, envMapIntensity: .55 });
  // the floor is most polished within 3 m of the car (roughness x0.72, about 0.45 under the mottle) and takes its full 0.62 beyond 6.5 m, so the sill and the door resolve in it
  M.floor.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 trFp;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n trFp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 trFp;').replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor *= mix(0.72, 1.0, smoothstep(3.0, 6.5, length(trFp.xz - vec2(0.0, -0.5))));');
  };
  M.floor.customProgramCacheKey = () => 'tr-floor';
  M.ring = new THREE.MeshStandardMaterial({ color: 0xd8ae5e, emissive: new THREE.Color(0xd8ae5e), emissiveIntensity: .6, roughness: .25, metalness: 1, envMapIntensity: .8 });
  M.pool = new THREE.MeshBasicMaterial({ map: T.pool, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, color: 0xdfe9ff });
  // the metre lines drawn over each headlight pool (the pool is additive, so the floor's own lines wash out under it): world-space lines masked by the pool lobe
  M.poolGrid = new THREE.ShaderMaterial({
    uniforms: { k: { value: 0 }, mask: { value: T.pool }, tint: { value: new THREE.Color(0x3a82f7) } }, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    vertexShader: 'varying vec2 vUv; varying vec3 vWp; void main() { vUv = uv; vWp = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vWp, 1.0); }',
    fragmentShader: `uniform float k; uniform sampler2D mask; uniform vec3 tint; varying vec2 vUv; varying vec3 vWp;
      void main() {
        float lx = 1.0 - smoothstep(0.0, 0.03, abs(fract(vWp.x + 0.5) - 0.5)), lz = 1.0 - smoothstep(0.0, 0.03, abs(fract(vWp.z + 1.0) - 0.5));   // the floor's lines sit at x = n and z = n - 0.5
        float a = max(lx, lz) * texture2D(mask, vUv).a * k;
        gl_FragColor = vec4(tint * a, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  });
  M.flood = new THREE.MeshBasicMaterial({ map: T.pool, color: 0xc9d8f5, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  M.mirror = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: .05, metalness: 1, envMapIntensity: 1.2 });
  M.contact = new THREE.MeshBasicMaterial({ map: T.contact, transparent: true, blending: THREE.MultiplyBlending, depthWrite: false });
  M.doorContact = new THREE.MeshBasicMaterial({ map: T.pool, color: 0x000000, transparent: true, opacity: .85, depthWrite: false });   // the soft blob under the open door (alpha from the pool lobe, black over the floor)
  M.lampCool = new THREE.SpriteMaterial({ map: T.disc, color: 0xcfe0ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: .9 });
  M.lampGold = new THREE.SpriteMaterial({ map: T.disc, color: 0xf3d698, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: .8 });
  M.flare = new THREE.SpriteMaterial({ map: T.flare, color: 0xdfe9ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false, opacity: 0 });   // depth tested: the wheel spoke occludes it where they overlap
  M.ember = new THREE.SpriteMaterial({ map: T.disc, color: 0xd8ae5e, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false, opacity: 0 });
  // the headlight beams: an additive cone with a fresnel rim, fading along its length, breathing with the rumble
  M.beam = new THREE.ShaderMaterial({
    uniforms: { k: { value: 0 }, time: { value: 0 }, tint: { value: new THREE.Color(0xd9e6ff) } }, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: 'varying vec3 vN, vV; varying vec2 vUv; void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }',
    fragmentShader: `uniform float k, time; uniform vec3 tint; varying vec3 vN, vV; varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
      void main() {
        float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
        float along = vUv.y; float a = rim * along * along * k * (0.7 + 0.3 * noise(vUv * vec2(6.0, 3.0) + vec2(0.0, time * 0.4)));
        gl_FragColor = vec4(tint * a, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  });
}

function buildCabin() {
  const cab = new THREE.Group(); cab.name = 'procedural-cabin';
  const add = (m, parent) => { (parent || cab).add(m); return m; };

  // floor + footwells
  add(at(new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.0), M.carpet), 0, 0, -0.05, -Math.PI / 2));
  // dash: side profile [z, y] from the knee panel up over the top to the windscreen base, bowed back toward the ends
  const dashProfile = [[-0.90, 0.02], [-0.78, 0.12], [-0.60, 0.30], [-0.46, 0.46], [-0.42, 0.56], [-0.45, 0.66], [-0.52, 0.76], [-0.60, 0.86], [-0.72, 0.95], [-0.86, 1.00], [-1.02, 1.015], [-1.18, 1.00]];
  N.dash = add(new THREE.Mesh(sweep(dashProfile, -0.84, 0.84, 72, u => [-0.05 * u * u, 0], 40), M.leather));
  for (const sx of [-1, 1]) {                                                                       // end caps close the shell at the doors
    const sh = new THREE.Shape(); dashProfile.forEach((p, i) => i ? sh.lineTo(p[0] - 0.05, p[1]) : sh.moveTo(p[0] - 0.05, p[1])); sh.lineTo(-1.23, 0.02); sh.closePath();
    const cap = new THREE.Mesh(new THREE.ShapeGeometry(sh), M.leatherDark); cap.rotation.y = -Math.PI / 2; cap.position.x = sx * 0.84; add(cap);
  }
  M.leatherDark.side = THREE.DoubleSide;
  M.leather.side = THREE.DoubleSide;
  // dash top leather band (stitched edge) and a brushed trim strip across the dash
  add(at(new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.008, 0.024), M.trimSatin), 0, 0.705, -0.468, -0.55));
  // glovebox line (passenger)
  add(at(new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.004, 0.02), M.trimSatin), 0.45, 0.62, -0.445));
  // binnacle: a flat leather brow over the cluster (992 style), cheeks down to the dash, the pod stands proud of the dash face
  add(at(rbox(0.54, 0.038, 0.30, 0.018, M.leather), -0.38, 0.985, -0.66, 0.10));
  for (const sx of [-0.26, 0.26]) add(at(rbox(0.02, 0.22, 0.20, 0.008, M.leatherDark), -0.38 + sx, 0.90, -0.62, -0.14));
  add(at(rbox(0.52, 0.03, 0.06, 0.01, M.leatherDark), -0.38, 0.79, -0.545, -0.14));                 // lower lip of the pod
  // cluster: back plate, central tach, two flanking displays, glass (leans back a little, stands proud of the dash)
  const cl = new THREE.Group(); at(cl, -0.38, 0.905, -0.575); cl.rotation.x = -0.14; add(cl); N.cluster = cl;
  add(at(rbox(0.50, 0.20, 0.09, 0.02, M.plastic), 0, 0, -0.047), cl);
  const tach = new THREE.Group(); at(tach, 0, 0, 0); cl.add(tach); N.tach = tach;
  N.tachBack = add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.084, 0.084, 0.02, 48), M.plastic), 0, 0, -0.008, Math.PI / 2), tach);
  add(at(new THREE.Mesh(new THREE.TorusGeometry(0.081, 0.006, 12, 64), M.chromeTach), 0, 0, 0.002), tach);
  try {   // BEAT gold around the central dial: a faint ring and a travelling light (goldApply)
    const tg = new THREE.Mesh(new THREE.TorusGeometry(0.093, 0.0022, 8, 128), new THREE.MeshBasicMaterial({ name: 'tach-gold', color: 0xe8c47a, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    tg.position.z = 0.006; add(tg, tach); N.tachGold = tg;
    const tc = new THREE.Mesh(new THREE.TorusGeometry(0.093, 0.0045, 8, 48, 0.9), new THREE.MeshBasicMaterial({ name: 'tach-comet', color: 0xfff1c8, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    tc.position.z = 0.006; add(tc, tach); N.tachComet = tc;
  } catch (e) {}
  add(at(new THREE.Mesh(new THREE.CircleGeometry(0.076, 48), M.dial), 0, 0, 0.001), tach);
  const needle = new THREE.Group(); at(needle, 0, 0, 0.006); tach.add(needle); N.needle = needle;
  add(at(new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.058, 0.0016), M.needle), 0, 0.029, 0), needle);
  add(at(new THREE.Mesh(new THREE.BoxGeometry(0.0035, 0.012, 0.0016), M.needleTip), 0, 0.064, 0), needle);
  add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.006, 24), M.trimSatin), 0, 0, 0.004, Math.PI / 2), tach);
  const flare = new THREE.Sprite(M.flare); flare.scale.set(0.05, 0.05, 1); flare.position.set(0, 0, 0.012); flare.renderOrder = 5; noPre(flare); tach.add(flare); N.flare = flare;   // just in front of the dial, behind the cover glass; depth tested against the rim and spokes
  for (const [x, mat, key, pod] of [[-0.17, M.dispL, 'dispL', 'podL'], [0.17, M.dispR, 'dispR', 'podR']]) {   // each display is its own pod so the model fit can move it onto a dial
    const pg = new THREE.Group(); at(pg, x, 0, 0); cl.add(pg); N[pod] = pg;
    pg.userData.bezel = add(at(rbox(0.15, 0.09, 0.012, 0.01, M.plastic), 0, 0, -0.004), pg);
    N[key] = add(at(new THREE.Mesh(new THREE.PlaneGeometry(0.135, 0.07), mat), 0, 0, 0.003), pg);
  }
  add(noPre(at(new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.18), M.glassThin), 0, 0, 0.014)), cl);
  // steering column, shroud, stalks
  add(strut([-0.38, 0.86, -0.56], [-0.38, 0.775, -0.40], 0.028, M.plastic));
  add(at(rbox(0.12, 0.085, 0.11, 0.025, M.plastic), -0.38, 0.80, -0.475, 0.32));
  add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.009, 0.1, 10), M.plastic), -0.46, 0.79, -0.50, 0, 0, Math.PI / 2 - 0.2));
  add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.009, 0.1, 10), M.plastic), -0.30, 0.79, -0.50, 0, 0, Math.PI / 2 + 0.2));
  // the wheel: stitched leather rim, three satin spokes, hub with the MFFU wordmark
  const wheel = new THREE.Group(); at(wheel, -0.38, 0.79, -0.40); wheel.rotation.x = -0.36; add(wheel); N.wheel = wheel;
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: .58, metalness: 0, normalMap: T.stitch, normalScale: new THREE.Vector2(1.1, 1.1), envMapIntensity: .35 });
  rimMat.normalMap.repeat.set(26, 1); M.rim = rimMat;
  add(new THREE.Mesh(new THREE.TorusGeometry(0.185, 0.019, 20, 96), rimMat), wheel);
  for (const [a, len] of [[0, 0.17], [Math.PI, 0.17], [-Math.PI / 2, 0.17]]) {
    const sp = rbox(len, 0.034, 0.012, 0.005, M.trimSatin); sp.position.set(Math.cos(a) * (0.06 + len / 2), Math.sin(a) * (0.06 + len / 2), 0); sp.rotation.z = a; wheel.add(sp);
  }
  add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.065, 0.03, 40), M.trimSatin), 0, 0, 0.0, Math.PI / 2), wheel);
  N.hub = add(at(new THREE.Mesh(new THREE.CircleGeometry(0.052, 40), M.hub), 0, 0, 0.0155), wheel);
  // ignition slot (left of the column): housing, chrome bezel, recessed barrel, LEDs; the key is its child
  const slot = new THREE.Group(); slot.position.set(...SLOT.pos); slot.lookAt(...SLOT.look); add(slot); N.slot = slot;
  add(at(rbox(0.075, 0.065, 0.03, 0.012, M.leatherDark), 0, 0, -0.012), slot);
  add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.014, 40), M.brushed), 0, 0, 0.003, Math.PI / 2), slot);
  add(at(new THREE.Mesh(new THREE.TorusGeometry(0.0235, 0.0035, 10, 40), M.slotChrome), 0, 0, 0.010), slot);
  add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.0165, 0.0165, 0.03, 32), new THREE.MeshStandardMaterial({ color: 0x050507, roughness: .9 })), 0, 0, -0.004, Math.PI / 2), slot);
  add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.0165, 0.0165, 0.004, 32), M.trimSatin), 0, 0, 0.009, Math.PI / 2), slot);
  add(at(new THREE.Mesh(new THREE.BoxGeometry(0.0045, 0.02, 0.006), new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 })), 0, 0, 0.010), slot);
  // the three LEDs sit on the bezel face (not down in the housing) so the first one is visible from the seated eye; LED 1 carries a small halo
  M.ledArr.forEach((mat, i) => { const a = (-30 - i * 30) * DEG, px = Math.sin(-a) * 0.0295, py = Math.cos(a) * 0.0295; add(at(new THREE.Mesh(new THREE.SphereGeometry(0.0026, 10, 8), mat), px, py, 0.012), slot); if (i === 0) { const halo = new THREE.Sprite(M.ledHalo); halo.scale.set(0.009, 0.009, 1); halo.position.set(px, py, 0.016); halo.renderOrder = 5; noPre(halo); slot.add(halo); N.ledHalo = halo; } });
  const ember = new THREE.Sprite(M.ember); ember.scale.set(0.09, 0.09, 1); ember.position.set(0, 0, 0.012); ember.renderOrder = 5; noPre(ember); slot.add(ember); N.ember = ember;
  // the key (gold, dark grip, shield badge); blade along -Z into the slot
  const key = new THREE.Group(); slot.add(key); N.key = key; key.visible = false; key.scale.setScalar(1.75);   // a big, unmistakable key
  add(at(new THREE.Mesh(new THREE.BoxGeometry(0.0085, 0.0028, 0.042), M.gold), 0, 0, -0.019), key);
  add(at(new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.0055, 0.034), M.gold), 0.0015, 0, -0.016), key);
  for (let i = 0; i < 4; i++) add(at(new THREE.Mesh(new THREE.BoxGeometry(0.0085, 0.0012, 0.003), M.goldHi), 0, 0.0022, -0.008 - i * 0.008), key);
  add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.0115, 0.0115, 0.007, 28), M.goldHi), 0, 0, 0.004, Math.PI / 2), key);
  add(at(rbox(0.036, 0.048, 0.011, 0.004, M.grip), 0, 0.012, 0.031), key);
  add(at(rbox(0.039, 0.051, 0.008, 0.004, M.goldBow), 0, 0.012, 0.0305), key);
  const shield = new THREE.Shape(); shield.moveTo(-0.009, 0.010); shield.lineTo(0.009, 0.010); shield.lineTo(0.009, -0.002); shield.quadraticCurveTo(0.009, -0.012, 0, -0.015); shield.quadraticCurveTo(-0.009, -0.012, -0.009, -0.002); shield.closePath();
  add(at(new THREE.Mesh(new THREE.ExtrudeGeometry(shield, { depth: 0.0015, bevelEnabled: false }), M.shield), 0, 0.014, 0.0365), key);
  add(at(new THREE.Mesh(new THREE.TorusGeometry(0.006, 0.0015, 8, 24), M.gold), 0, 0.040, 0.031), key);
  // centre console, stack, touchscreen, shifter, knobs
  add(at(rbox(0.34, 0.40, 1.0, 0.03, M.leatherDark), 0, 0.21, -0.06));
  add(at(new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.004, 0.46), M.trimSatin), 0, 0.413, 0.0));
  add(at(rbox(0.36, 0.44, 0.16, 0.03, M.leatherDark), 0, 0.62, -0.50));
  const spod = new THREE.Group(); at(spod, 0, 0.80, -0.438, -0.12); add(spod); N.screenPod = spod;   // bezel + screen + glass as one pod (origin on the screen plane)
  N.screenBezel = add(at(rbox(0.34, 0.20, 0.03, 0.01, M.plastic), 0, 0, -0.017), spod);
  N.screen = add(at(new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.15), M.screen), 0, 0, 0), spod);
  add(noPre(at(new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.15), M.glassPcm), 0, 0, 0.001)), spod);
  add(at(rbox(0.07, 0.11, 0.045, 0.012, M.grip), 0, 0.48, -0.16, -0.25));
  add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.012, 0.09, 12), M.chrome), 0, 0.42, -0.14));
  for (const y of [0.50, 0.58]) for (const x of [-0.08, 0.08]) add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.012, 20), M.trimAlu), x, y, -0.416, Math.PI / 2));
  add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.012, 24), M.trimAlu), 0, 0.54, -0.416, Math.PI / 2));
  add(at(rbox(0.30, 0.03, 0.01, 0.004, M.trimSatin), 0, 0.665, -0.418));
  // seats
  for (const x of [-0.38, 0.38]) {
    const seat = new THREE.Group(); cab.add(seat); seat.position.x = x;
    add(at(rbox(0.50, 0.11, 0.50, 0.04, M.leatherSeat), 0, 0.31, 0.25), seat);
    for (const sx of [-0.21, 0.21]) add(at(rbox(0.10, 0.14, 0.46, 0.04, M.leatherSeat), sx, 0.37, 0.24), seat);
    const back = rbox(0.48, 0.62, 0.11, 0.04, M.leatherSeat); at(back, 0, 0.66, 0.50, 0.16); seat.add(back);
    for (const sx of [-0.20, 0.20]) { const b = rbox(0.10, 0.56, 0.13, 0.04, M.leatherSeat); at(b, sx, 0.65, 0.45, 0.16); seat.add(b); }
    add(at(rbox(0.22, 0.14, 0.09, 0.03, M.leatherSeat), 0, 1.02, 0.60, 0.16), seat);
    add(at(new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.08, 0.5), M.plastic), 0, 0.21, 0.25), seat);
  }
  // door cards: driver (on the swinging door) and passenger (fixed)
  const doorCard = (mirror) => {
    const g = new THREE.Group(), s = mirror ? -1 : 1;
    add(at(rbox(0.05, 0.92, 1.26, 0.02, M.leather), 0, 0.56, 0.63), g);
    add(at(rbox(0.06, 0.26, 0.9, 0.02, M.leatherDark), s * 0.03, 0.30, 0.60), g);
    add(at(rbox(0.09, 0.06, 0.46, 0.02, M.leatherDark), s * 0.06, 0.62, 0.62), g);          // armrest
    const pull = strut([s * 0.085, 0.70, 0.52], [s * 0.085, 0.70, 0.72], 0.011, M.trimAlu); g.add(pull);   // brushed pull above the armrest
    add(at(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.028, 0.02), M.trimAlu), s * 0.07, 0.70, 0.51), g);
    add(at(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.028, 0.02), M.trimAlu), s * 0.07, 0.70, 0.73), g);
    add(at(rbox(0.018, 0.04, 0.09, 0.008, M.trimAlu), s * 0.042, 0.82, 0.32), g);                         // release handle
    add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.006, 32), M.trimSatin), s * 0.03, 0.30, 0.42, 0, 0, Math.PI / 2), g);  // speaker
    add(at(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.014, 1.2), M.trimSatin), s * 0.005, 1.02, 0.62), g);  // sill trim at the window base
    // window glass on the door, leaning in a little
    const gl = noPre(new THREE.Mesh(quad([0, 1.03, 0.08], [0, 1.03, 1.12], [s * -0.06, 1.36, 1.0], [s * -0.06, 1.36, 0.25]), M.glass)); gl.renderOrder = 2; g.add(gl);
    g.add(strut([0, 1.03, 0.08], [s * -0.06, 1.36, 0.25], 0.010, M.trimSatin));                             // window frame
    g.add(strut([s * -0.06, 1.36, 0.25], [s * -0.06, 1.36, 1.0], 0.010, M.trimSatin));
    g.add(strut([s * -0.06, 1.36, 1.0], [0, 1.03, 1.12], 0.010, M.trimSatin));
    return g;
  };
  const door = new THREE.Group(); door.position.set(-0.80, 0, -0.72); add(door); N.door = door; N.doorProc = door;
  const dCard = doorCard(false); dCard.position.set(0.0, 0, 0.0); door.add(dCard);
  door.add(doorContactBlob(GROUND));                                                                   // the soft shadow blob under the open door swings with it (the procedural door group sits at cabin floor 0, the stage at GROUND)
  door.userData.welcome = beatsBuild(GROUND, true); door.add(door.userData.welcome);   // BEAT welcome lights (handle glow) on the procedural door; the first call also builds the pool, the lamp and the turn hint
  // outer skin of the driver door (seen from outside while it is open)
  door.add(at(rbox(0.07, 0.95, 1.28, 0.03, M.paint), -0.07, 0.56, 0.64));
  door.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 1.1), M.trimSatin), -0.08, 1.04, 0.64));
  const pCard = doorCard(true); pCard.position.set(0.80, 0, -0.72); add(pCard);
  // door sills, B pillars, A pillars, roof, headliner, visors, mirror, dome
  for (const x of [-0.80, 0.80]) {
    add(at(new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 1.4), M.plastic), x, 0.05, -0.05));
    add(at(rbox(0.08, 1.42, 0.10, 0.02, M.headliner), x * 0.97, 0.71, 0.60));
    add(strut([x * 1.02, 0.98, -1.14], [x * 0.86, 1.42, -0.52], 0.045, M.headliner));
  }
  add(at(new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.03, 1.5), M.headliner), 0, 1.44, 0.15));
  add(at(new THREE.Mesh(new THREE.BoxGeometry(1.52, 0.04, 0.06), M.headliner), 0, 1.41, -0.52));
  for (const x of [-0.40, 0.40]) add(at(rbox(0.32, 0.012, 0.14, 0.005, M.headliner), x, 1.405, -0.42));
  add(strut([0, 1.41, -0.50], [0, 1.30, -0.40], 0.012, M.plastic));
  add(at(rbox(0.24, 0.07, 0.025, 0.01, M.plastic), 0, 1.29, -0.39, 0.1));
  add(at(new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.055), M.mirror), 0, 1.29, -0.376, 0.1));
  N.domeMesh = add(at(rbox(0.10, 0.012, 0.06, 0.004, M.dome), 0, 1.424, 0.0));
  // the body shell around the cabin: rockers, front fenders, rear quarters, rear bulkhead with its window, roof skin
  for (const x of [-0.87, 0.87]) {
    add(at(rbox(0.10, 0.26, 1.7, 0.03, M.paint), x, 0.0, 0.0));                                   // rocker
    add(at(rbox(0.16, 0.62, 1.9, 0.05, M.paint), x * 1.01, 0.55, -1.75));                          // front fender / wing
    add(at(rbox(0.14, 1.05, 1.15, 0.05, M.paint), x * 1.0, 0.42, 1.18));                            // rear quarter
    const qg = noPre(new THREE.Mesh(quad([x, 1.02, 0.66], [x, 1.02, 1.38], [x * 0.93, 1.40, 1.18], [x * 0.93, 1.40, 0.66]), M.glass)); qg.renderOrder = 2; add(qg);   // quarter glass
    add(at(rbox(0.06, 0.40, 0.30, 0.02, M.leatherDark), x * 0.92, 0.80, 0.80));                     // rear side trim
  }
  add(at(rbox(1.66, 0.95, 0.12, 0.03, M.leatherDark), 0, 0.47, 1.00));                              // rear bulkhead
  add(at(rbox(1.60, 0.03, 0.40, 0.01, M.leatherDark), 0, 0.95, 1.20));                              // parcel shelf
  const rw = noPre(new THREE.Mesh(quad([-0.78, 0.96, 1.42], [0.78, 0.96, 1.42], [0.64, 1.42, 0.92], [-0.64, 1.42, 0.92]), M.glass)); rw.renderOrder = 2; add(rw);   // rear window
  add(at(rbox(1.72, 0.05, 1.6, 0.02, M.paint), 0, 1.47, 0.15));                                     // roof skin
  add(at(rbox(1.80, 0.5, 0.9, 0.08, M.paint), 0, 0.72, 1.75));                                      // rear deck
  // windscreen (raked) and wipers
  N.windscreen = add(noPre(new THREE.Mesh(quad([-0.86, 0.985, -1.17], [0.86, 0.985, -1.17], [0.70, 1.425, -0.54], [-0.70, 1.425, -0.54]), M.glass))); N.windscreen.renderOrder = 2;
  for (const x of [-0.42, 0.18]) add(at(new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.01, 0.014), M.plastic), x, 0.995, -1.17, 0, 0.05));
  // the bonnet ahead of the glass (dark paint, a mild rise at the fenders)
  add(new THREE.Mesh(sweep([[-1.16, 0.955], [-1.35, 0.93], [-1.7, 0.86], [-2.1, 0.76], [-2.5, 0.63], [-2.9, 0.50]], -0.95, 0.95, 36, u => [0, 0.05 * Math.pow(Math.abs(u), 3)], 24), M.paint));
  M.paint.side = THREE.DoubleSide;
  add(at(new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.0, 0.02), M.paint), 0, 0.45, -1.19));   // bulkhead under the glass
  cab.traverse(o => { if (o.isMesh && o.layers.mask === 1) { o.castShadow = true; o.receiveShadow = true; } });
  return cab;
}

// a 1.3 x 0.7 m blob on the floor under the open driver door, in the hinge frame (the door swings about its group's Y axis, the blob with it);
// floorY: the floor height in that frame (the procedural door group sits at cabin floor 0, the real one at the hinge's world y)
function doorContactBlob(floorY) {
  const dc = MODEL_FIT.doorContact, m = noPre(new THREE.Mesh(new THREE.PlaneGeometry(dc.size[0], dc.size[1]), M.doorContact));
  m.rotation.set(-Math.PI / 2, 0, 0); m.position.set(dc.pos[0], floorY + 0.006, dc.pos[1]); m.name = 'door-contact'; m.renderOrder = -1; return m;
}
function buildStage() {
  const st = new THREE.Group(); st.name = 'stage';
  const ground = GROUND;
  N.sky = skyDome(); st.add(N.sky);
  const floor = noRefl(new THREE.Mesh(new THREE.PlaneGeometry(100, 100), M.floor)); floor.rotation.x = -Math.PI / 2; floor.position.set(0, ground, -0.5); floor.receiveShadow = true; floor.renderOrder = -1; floor.name = 'floor'; st.add(floor); N.floor = floor;
  const ring = noRefl(new THREE.Mesh(new THREE.TorusGeometry(3.27, 0.015, 8, 160), M.ring)); ring.rotation.x = -Math.PI / 2; ring.position.set(0, ground + 0.012, -0.5); st.add(ring);
  try { const rc = noRefl(new THREE.Mesh(new THREE.TorusGeometry(3.27, 0.04, 8, 96, 0.6), new THREE.MeshBasicMaterial({ name: 'ring-comet', color: 0xfff1c8, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))); rc.rotation.x = -Math.PI / 2; rc.position.copy(ring.position); rc.position.y += 0.004; st.add(rc); N.ringComet = rc; } catch (e) {}   // BEAT the gold light running round the outside of the car     // gold rails on the floor: tubes, so the far one keeps a few pixels of height from the cabin on every tier
  const ring2 = noRefl(new THREE.Mesh(new THREE.TorusGeometry(6.415, 0.022, 8, 200), M.ring)); ring2.rotation.x = -Math.PI / 2; ring2.position.set(0, ground + 0.018, -0.5); st.add(ring2);
  // the baked contact shadow under the car (multiply over the floor; grounds the car in every pose, costs nothing)
  const cs = MODEL_FIT.contact, contact = noPre(new THREE.Mesh(new THREE.PlaneGeometry(cs.size[0], cs.size[1]), M.contact));
  contact.rotation.set(-Math.PI / 2, 0, Math.PI / 2); contact.position.set(0, ground + 0.004, -0.2); contact.name = 'contact'; st.add(contact); N.contact = contact;
  // headlights: two spots forward, their pools on the floor, the beam cones
  for (const x of [-0.62, 0.62]) {
    const sp = new THREE.SpotLight(0xdbe8ff, 0, 30, 0.40, 0.65, 1.2); sp.position.set(x, 0.42, -2.6); sp.target.position.set(x * 2.2, ground, -14); st.add(sp); st.add(sp.target); (L.heads = L.heads || []).push(sp);
    const pool = noPre(new THREE.Mesh(new THREE.PlaneGeometry(1.8, 7), M.pool)); pool.rotation.x = -Math.PI / 2; pool.position.set(Math.sign(x) * 1.6, ground + 0.01, -8.5); st.add(pool);   // two cool lobes on the floor ahead of the nose, 1.8 x 7 m at x +/-1.6: two readable pools, not one glow
    const pg = noPre(new THREE.Mesh(new THREE.PlaneGeometry(1.8, 7), M.poolGrid)); pg.rotation.x = -Math.PI / 2; pg.position.set(Math.sign(x) * 1.6, ground + 0.012, -8.5); st.add(pg);   // the metre lines drawn back over the pool
    const beam = noPre(new THREE.Mesh(new THREE.ConeGeometry(1.1, 12, 24, 1, true), M.beam)); beam.rotation.x = Math.PI / 2; beam.position.set(x * 1.6, 0.30, -8.8); beam.userData.z = -8.8; st.add(beam); (N.beams = N.beams || []).push(beam);
  }
  const flood = noPre(new THREE.Mesh(new THREE.PlaneGeometry(70, 16), M.flood)); flood.position.set(0, ground + 4, -33); st.add(flood);   // the headlights' glow in the stage haze (opacity capped at 0.02: a breath of haze, never a band)
  // far stage lamps: soft discs that go to bokeh in the glass
  for (const [x, y, z, gold] of [[-9, 3.2, -22, 0], [7, 2.6, -26, 1], [14, 3.8, -18, 0], [-15, 2.2, -14, 1], [3, 4.4, -30, 0]]) { const l = noPre(new THREE.Sprite(gold ? M.lampGold : M.lampCool)); l.position.set(x, ground + y, z); l.scale.set(0.5, 0.5, 1); st.add(l); }
  return st;
}

// the night rig: one key panel through the windscreen (the only shadow caster), a navy hemisphere, a cool passenger fill, the gold
// strips as rect lights, the door wash, and the cabin points (dome, dash, footwell, cluster, PCM, the catch ember, the headlight spill)
function buildLights() {
  const sc = S.scene;
  L.hemi = new THREE.HemisphereLight(0x243a6a, 0x060912, 0.62); sc.add(L.hemi);
  L.key = new THREE.SpotLight(0xdfe8ff, 36, 14, 0.62, 0.85, 2); L.key.position.set(2.2, 3.6, -4.6); L.key.target.position.set(-0.3, 0.85, -0.45); sc.add(L.key); sc.add(L.key.target);
  // the shadow frustum is tightened to the car (focus 0.62 of the spot cone: about 6 m across at the car) so the open door's edge resolves on the floor
  L.key.shadow.bias = -0.0005; L.key.shadow.normalBias = 0.02; L.key.shadow.focus = 0.62; L.key.shadow.camera.near = 2; L.key.shadow.camera.far = 11; L.key.shadow.radius = 4; L.key.castShadow = false;
  L.fill = new THREE.DirectionalLight(0x7f9de8, 0.9); L.fill.position.set(3.8, 2.6, 2.2); L.fill.target.position.set(0, 0.7, 0); sc.add(L.fill); sc.add(L.fill.target);   // passenger-rear fill: the second gradient on the door cards and, from the door pose, the rim on the roof and rear quarter
  L.doorFill = new THREE.DirectionalLight(0x6c8cff, 0.22); L.doorFill.position.set(-3.5, 2.0, 0.4); L.doorFill.target.position.set(-0.8, 0.6, 0); sc.add(L.doorFill); sc.add(L.doorFill.target);   // the stage light on the open door; through the sit it also carries the cool fill at the aperture (0.55, 0xbfcbff) onto the seat and footwell
  try { if (!S.rectInit) { RectAreaLightUniformsLib.init(); S.rectInit = true; } } catch (e) {}
  // the gold strips as area lights (ultra): the same thin 4.5 x 0.06 m lines as in the environment map, so the paint shows two crisp lines and never a bronze plate
  const rc = S.opts && S.opts.rect ? S.opts.rect : [4.5, 0.12, 1];        // the same thin lines as the environment strips; opts.rect: harness only ([width, height, k])
  L.goldL = new THREE.RectAreaLight(0xd8ae5e, 7 * rc[2], rc[0], rc[1]); L.goldL.position.set(-3.4, 1.85, -0.2); L.goldL.lookAt(-0.6, 0.75, -0.2); sc.add(L.goldL);
  L.goldR = new THREE.RectAreaLight(0xd8ae5e, 5 * rc[2], rc[0], rc[1]); L.goldR.position.set(3.4, 1.85, 0.3); L.goldR.lookAt(0.6, 0.75, 0.3); sc.add(L.goldR);
  L.dome = new THREE.PointLight(0xf4ead9, 0, 2.8, 2); L.dome.position.set(0, 1.36, 0.02); sc.add(L.dome);
  L.dash1 = new THREE.PointLight(0xf0dcc0, 0, 1.4, 2); L.dash1.position.set(-0.26, 0.99, -0.42); sc.add(L.dash1);     // warm neutral, ramps with the notch
  L.foot = new THREE.PointLight(0xd9e2ff, 0, 0.85, 2); L.foot.position.set(-0.38, 0.22, -0.52); sc.add(L.foot);       // puddle lamp on the carpet and the pedals (cool white: a warm lamp on the charcoal carpet read beige, b under r)
  L.inst = new THREE.PointLight(0xe6eef8, 0, 0.7, 2); L.inst.position.set(-0.38, 0.98, -0.55); sc.add(L.inst);        // the gauges' cool spill on the rim top (6 cm above the dial centre, so its reflection leaves the bezel's 6 o'clock arc)
  L.pcm = new THREE.PointLight(0x9fc2ff, 0, 0.6, 2); L.pcm.position.set(0, 0.70, -0.42); sc.add(L.pcm);               // the centre screen's page-blue spill
  L.catchGlow = new THREE.PointLight(0xd8ae5e, 0, 1.4, 2); L.catchGlow.position.set(-0.62, 0.74, -0.44); sc.add(L.catchGlow);   // the gold ember on the slot at the catch
  L.spill = new THREE.PointLight(0xd8e4ff, 0, 7, 2); L.spill.position.set(0, 1.0, -3.0); sc.add(L.spill);                  // headlight back-spill on the bonnet and the glass
  L.proc = {}; for (const k of Object.keys(MODEL_FIT.lights)) L.proc[k] = L[k].position.toArray();                           // the procedural layout, restored if the model goes away
  // the late lights are dark until the key reaches the first notch (the gauge and PCM spill, the catch ember, the headlights and their
  // back-spill): hidden, they leave the shader entirely, so the walk-in pays for six lights instead of twelve. Both shader variants are
  // compiled at mount (applyTier) so the switch at the notch costs no compile.
  // On phones the late lights are hidden until the notch (fill-bound GPUs pay per light), so every material has two programs; on desktop
  // they stay in the shader at zero intensity (one program per material: half the cold-cache link work at mount and at model arrival)
  S.splitLights = !!S.phone && !ABL('latelights');
  L.late = [L.inst, L.pcm, L.catchGlow, L.spill, ...(L.heads || [])]; setLate(!S.splitLights);
}
function setLate(on) { if (!S.splitLights) on = true; S.lateOn = !!on; if (L.late) for (const l of L.late) l.visible = !!on || ABL('latelights'); }
// the cabin points follow the cabin: the real 911's roof and dash are lower than the procedural ones
function applyModelLayout(on) {
  if (!L.proc) return;
  for (const k of Object.keys(MODEL_FIT.lights)) if (L[k]) L[k].position.fromArray(on ? mw(MODEL_FIT.lights[k]) : L.proc[k]);
  if (N.beams) for (const b of N.beams) b.position.z = b.userData.z + (on ? MODEL_FIT.beamShift : 0);   // the cones' apex further ahead of the real bumper
  if (N.contact) { const c = MODEL_FIT.contact.center; if (on) { const p = mw([c[0], 0, c[1]]); N.contact.position.set(p[0], GROUND + 0.004, p[2]); } else N.contact.position.set(0, GROUND + 0.004, -0.2); }
  if (S.gtao) { try { S.gtao.setSceneClipBox(on && S.model ? new THREE.Box3().setFromObject(S.model, true).expandByScalar(0.3) : null); } catch (e) {} }
  S.shadowDirty = 3;
}

// ---------- camera moves ----------
function makeCurve(pts) { return new THREE.CatmullRomCurve3(pts.map(V3), false, 'centripetal', 0.5); }
function setGoal(p, t) { RIG.gPos.copy(p); RIG.gTgt.copy(t); }
function snapRig() { RIG.pos.copy(RIG.gPos); RIG.tgt.copy(RIG.gTgt); RIG.placed = true; }
function finishMove(m) { if (m && m.resolve) { const r = m.resolve; m.resolve = null; r(); } }

function defineMove(name) {
  const P = paths(), sp = seatedPose(), rmFast = S.rm ? 0.35 : 1;
  switch (name) {
    case 'door': { const A = activePoses(); return { name, dur: 2.1 * rmFast, ease: easeInOutSine, pos: makeCurve([A.doorStart.pos, A.doorEnd.pos]), tgt: makeCurve([A.doorStart.tgt, A.doorEnd.tgt]), door: () => 1, dome: () => 1, sway: () => 1 }; }
    case 'sit': return {
      name, dur: 1.6 * rmFast, ease: easeInOutSine, pos: makeCurve(P.sitPos), tgt: makeCurve(P.sitTgt),
      settle: u => -0.028 * Math.sin(Math.PI * clamp((u - 0.74) / 0.26, 0, 1)),                 // the weight lands: a small bounce
      roll: u => 1.7 * DEG * Math.sin(Math.PI * clamp((u - 0.10) / 0.55, 0, 1)),                 // under 2 deg while ducking under the rail
      sway: u => 1 - smooth(clamp((u - 0.25) / 0.45, 0, 1)),                                     // the walk sway fades as the body lowers
      door: u => 1 - easeInOut(clamp((u - 0.56) / 0.42, 0, 1)), dome: u => 1 - 0.5 * easeInOut(clamp((u - 0.6) / 0.4, 0, 1))
    };
    case 'observe': return { name, dur: 1.5 * rmFast, ease: easeInOutSine, pos: makeCurve(P.obsPos), tgt: makeCurve(P.obsTgt), door: () => 0, dome: u => 0.5 * (1 - easeInOut(clamp(u / 0.6, 0, 1))) };
    case 'keyin': return { name, dur: 0.9 * rmFast, ease: t => t, pos: null, tgt: null, door: () => 0, dome: () => 0, key: true };
    case 'seated': return { name, dur: 0, ease: t => t, pos: makeCurve([sp.pos, sp.pos]), tgt: makeCurve([sp.tgt, sp.tgt]), door: () => 0, dome: () => 0, keySeated: true };
    case 'dissolve': {
      const dir = RIG.gTgt.clone().sub(RIG.gPos).normalize().multiplyScalar(0.10), p0 = RIG.gPos.clone(), t0 = RIG.gTgt.clone();
      return { name, dur: 1.4, ease: easeInOutSine, pos: makeCurve([p0.toArray(), p0.clone().add(dir).toArray()]), tgt: makeCurve([t0.toArray(), t0.clone().add(dir).toArray()]), door: () => 0, dome: () => S.dome };
    }
  }
  return null;
}
// key fly-in path in slot space (world points converted once)
function keyPath() {
  const w = (S.rigModel ? MODEL_FIT.keyPath.map(mw) : [[-0.22, 0.52, -0.04], [-0.52, 0.54, -0.18], [-0.72, 0.62, -0.34]]).map(V3);
  N.slot.updateMatrixWorld(true);
  const pts = w.map(p => N.slot.worldToLocal(p.clone()));
  pts.push(new THREE.Vector3(0.012, -0.006, KEY_ALIGN + 0.01), new THREE.Vector3(0, 0, KEY_ALIGN));
  return new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
}
const TUMBLE = new THREE.Euler(0.75, -1.15, 0.45);
const C_SITFILL = new THREE.Color(0xbfcbff);
function evalMove(m, u) {
  if (m.pos) {
    const uu = clamp(u, 0, 1), p = m.pos.getPointAt(uu), t = m.tgt.getPointAt(uu);
    if (m.alt) {                                   // the model arrived mid-move: ease from the procedural curve onto the model one (no jump)
      const k = smooth(clamp((uu - m.alt.from) / m.alt.win, 0, 1));
      if (k > 0) { p.lerp(m.alt.pos.getPointAt(uu), k); t.lerp(m.alt.tgt.getPointAt(uu), k); }
    }
    if (m.settle) p.y += m.settle(u);
    setGoal(p, t);
  }
  if (m.door) S.doorOpen = m.door(u);
  if (m.dome) S.dome = m.dome(u);
  S.roll = m.roll ? m.roll(u) : 0; S.sway = m.sway ? m.sway(u) : 0;
  if (m.key) placeKey(u);
  if (m.keySeated) placeKey(1);
}
function placeKey(u) {
  const k = N.key; k.visible = true;
  if (!N.keyPath) N.keyPath = keyPath();
  const a = clamp(u / 0.78, 0, 1), s = clamp((u - 0.78) / 0.22, 0, 1);
  const p = N.keyPath.getPointAt(easeInOutSine(a));
  if (s > 0) p.set(0, 0, lerp(KEY_ALIGN, KEY_IN, easeOutQuint(s)) + (s > 0.9 ? 0 : 0));
  k.position.copy(p);
  const r = S.rm ? 0 : 1 - easeOut(clamp(u / 0.72, 0, 1));
  k.rotation.set(TUMBLE.x * r, TUMBLE.y * r + KEY_YAW * (1 - r), TUMBLE.z * r - S.deg * DEG);   // the bow settles 30 deg toward the driver as the tumble dies, so the fob never sits face-on over the ring
  if (u >= 1) { k.rotation.set(0, KEY_YAW, -S.deg * DEG); k.position.set(0, 0, KEY_IN); N.keySeated = true; }
  S.shadowDirty = Math.max(S.shadowDirty, 1);
}

function startMove(name, instant, atU) {
  const prev = S.move; if (prev) { finishMove(prev); S.move = null; }
  const m = defineMove(name); if (!m) return Promise.reject(new Error('unknown stage ' + name));
  S.lastStage = name; S.shadowDirty = 3;
  beatsStage(name, instant);   // BEAT door: welcome lamps on; seated: turn hint until the first input; dissolve: the double flash
  if (name === 'door' && !RIG.placed) { evalMove(m, 0); snapRig(); }
  if (name === 'door' && RIG.placed && !instant) { const A = activePoses(); m.pos = makeCurve([RIG.gPos.toArray(), A.doorEnd.pos]); m.tgt = makeCurve([RIG.gTgt.toArray(), A.doorEnd.tgt]); }
  if (name === 'sit' && !instant) { const P = paths(); P.sitPos[0] = RIG.gPos.toArray(); P.sitTgt[0] = RIG.gTgt.toArray(); m.pos = makeCurve(P.sitPos); m.tgt = makeCurve(P.sitTgt); }
  if (name === 'observe' && !instant) { const P = paths(); P.obsTgt[0] = RIG.gTgt.toArray(); m.tgt = makeCurve(P.obsTgt); }
  if (m.dur === 0 || instant) {
    evalMove(m, atU === undefined ? 1 : atU); snapRig();
    if (name === 'seated' || (instant && atU === undefined)) { N.key.visible = true; placeKey(1); }
    if (instant) { S.fov = wantFov(); S.focus = wantFocus()[0]; }
    return Promise.resolve();
  }
  return new Promise(res => { m.t = 0; m.resolve = res; S.move = m; evalMove(m, 0); });
}
// the model landed: switch the rig to POSE_MODEL. A running move eases onto its model curve over the next 35 percent of the move
// (evalMove blends the two curves); an idle rig drifts to the matching model pose through the TAU smoothing, except before the
// walk-in has started, where nothing has moved yet and the door pose simply snaps.
function onModelReady() {
  S.rigModel = true;
  applyModelLayout(true);
  const m = S.move;
  if (m && m.pos && m.name !== 'dissolve') {
    const nm = defineMove(m.name), u = m.ease(clamp(m.t / m.dur, 0, 1));
    if (nm && nm.pos) m.alt = { pos: nm.pos, tgt: nm.tgt, from: u, win: Math.max(0.05, Math.min(0.35, 1 - u)) };
  } else if (!m || !m.pos) {
    const A = activePoses(), last = S.lastStage;
    if (!last) { setGoal(V3(A.doorStart.pos), V3(A.doorStart.tgt)); snapRig(); S.doorOpen = 1; }
    else if (last === 'door') setGoal(V3(A.doorEnd.pos), V3(A.doorEnd.tgt));
    else if (last !== 'dissolve') { const sp = seatedPose(); setGoal(V3(sp.pos), V3(sp.tgt)); }
  }
  N.keyPath = null; if (N.keySeated) placeKey(1);
}
// the end of the model hold: the next rendered frame fades the canvas in (the page shows its dark overlay until then)
function reveal() { if (S.revealed || S.disposed) return; S.revealed = true; S.revealPending = true; }

// ---------- per-frame state ----------
function tachValue(dt) {
  let v = 0;
  if (S.selfTest >= 0) {                       // ON: needle sweeps to the end and back
    S.selfTest += dt; const t = S.selfTest;
    v = t < .4 ? 9 * easeInOut(t / .4) : t < .5 ? 9 : t < .95 ? 9 * (1 - easeInOut((t - .5) / .45)) : 0;
    if (t >= .95) S.selfTest = -1;
  }
  if (S.catchT >= 0) {
    const t = S.catchT;
    if (t < .25) v = 3.4 * easeOut(t / .25);
    else if (t < 1.05) v = lerp(3.4, 0.95, easeInOut((t - .25) / .8));
    else { S.tachShiver += dt; v = 0.95 + (S.rm ? 0 : 0.045 * Math.sin(S.tachShiver * 71) * Math.sin(S.tachShiver * 23 + 1.3) + 0.02 * Math.sin(S.tachShiver * 9)); }
  }
  if (S.blipT >= 0) { const t = S.blipT; v += 1.3 * (t < .14 ? easeOut(t / .14) : Math.max(0, 1 - easeInOut((t - .14) / .34))); }
  return v;
}
function moveU(name) { const m = S.move; return m && m.name === name ? clamp(m.t / m.dur, 0, 1) : (S.lastStage === name ? 1 : 0); }
function wantFov() {
  const F = S.phone || (S.h > S.w) ? FOV.phone : FOV.desk, st = S.lastStage || 'door', f = F[st] !== undefined ? F[st] : F.seated;
  if (Array.isArray(f)) return lerp(f[0], f[1], smooth(moveU(st)));
  if (st === 'seated' && S.catchT > 0.95) return f - clamp((S.catchT - 0.95) / 1.5, 0, 1);   // the slogan: a 2 cm dolly in
  return f;
}
// depth of field per pose: [focus m, aperture, maxblur] in BokehShader units (blur = (focus - distance) x aperture, clamped)
function wantFocus() {
  const st = S.lastStage || 'door', cam = S.camera;
  if (S.rm) return [0.8, 0.0035, 0.006];
  switch (st) {
    case 'door': return [2.1, 0.004, 0.009];
    case 'sit': return [0.9, 0.006, 0.01];
    case 'observe': return [clamp(RIG.tgt.distanceTo(RIG.pos), 0.3, 1.2), 0.0045, 0.008];
    case 'keyin': { const kp = N.key && N.key.visible ? N.key.getWorldPosition(new THREE.Vector3()).distanceTo(cam.position) : 0.7; return [clamp(kp, 0.25, 1.2), 0.007, 0.012]; }
    case 'dissolve': { const u = moveU('dissolve'); return [0.8, lerp(0.003, 0.012, u), 0.014]; }
    default: {
      if (S.catchT >= 0) { const bump = S.catchT < 0.3 ? Math.sin(Math.PI * S.catchT / 0.3) : 0; return [0.8, 0.0025 + 0.0025 * bump, 0.0035]; }   // the pools ten metres out stay two readable lobes
      return [0.8, 0.003, 0.005];
    }
  }
}
function applyState(dt) {
  if (S.sagT >= 0) S.sagT += dt; if (S.catchT >= 0) S.catchT += dt; if (S.blipT >= 0) { S.blipT += dt; if (S.blipT > .5) S.blipT = -1; }
  if (S.breathT >= 0) { S.breathT += dt; if (S.breathT > 0.6) S.breathT = -1; }
  const deg = S.deg, n = deg / 90, acc = deg >= 30, on = deg >= 60;
  let sag = 1; if (S.sagT >= 0) { const t = S.sagT; sag = t < .12 ? 1 - .62 * (t / .12) : t < .55 ? .38 + .62 * easeOut((t - .12) / .43) : 1; if (t >= .55) S.sagT = -1; }
  const ct = S.catchT, cat = ct >= 0 ? clamp(ct / .5, 0, 1) : 0, catPulse = ct >= 0 ? Math.max(0, 1 - ct / .9) : 0;
  const ramp = ct >= 0 ? clamp(ct / .15, 0, 1) : 0, headRamp = ct >= 0 ? clamp(ct / .12, 0, 1) : 0;
  const ember = ct >= 0 ? 0.06 + 0.84 * Math.pow(Math.max(0, 1 - ct / 0.5), 2) : 0;                  // 0.9 at the catch frame, 0.06 after 0.5 s
  const surge = S.blipT >= 0 ? Math.max(0, 1 - S.blipT / .28) : 0;
  const breath = S.breathT >= 0 && ct < 0 ? 1 - 0.6 * clamp(S.breathT / 0.06, 0, 1) : 1;          // the breath before the boom: every cabin point to 40 percent
  const rumble = ct >= 1.05 && !S.rm ? 1 + 0.05 * Math.sin(S.t * 23) * Math.sin(S.t * 7.3) : 1;
  const fx = S.rigModel ? MODEL_FIT : null, wk = fx ? fx.warmK : 1, dk = fx ? fx.domeK : 1;
  S.sitK = lerp(S.sitK || 0, S.lastStage === 'sit' ? 1 : 0, 1 - Math.exp(-dt / 0.15));   // the sit pose is the one that frames the footwell and the whole dark left third: its own fill, eased in and out at the joins
  const lateWant = acc || ct >= 0 || S.selfTest >= 0; if (S.splitLights && lateWant !== S.lateOn) setLate(lateWant);
  // emissives: gauges cool white, never gold, never past 1.0 (the bloom threshold sits at 0.92 so only the LEDs, the pools and the catch frame bloom)
  const clus = (!acc ? n * 0.12 : !on ? 0.12 + (deg - 30) / 30 * 0.3 : 1) * sag * (S.breathT >= 0 && ct < 0 ? 0.3 : 1) * (CLUSTER_K[S.tier] || 1);
  const lit = Math.max(clus, cat);
  M.dial.emissiveIntensity = lit * 0.85 + catPulse * 0.15; M.needle.emissiveIntensity = lit * .8; M.needleTip.emissiveIntensity = lit * 1.1;
  if (M.gauge) M.gauge.emissiveIntensity = lit * 0.75 + catPulse * 0.12;                         // the outer dials wake with the cluster
  const disp = (on ? 1 : acc ? 0.08 : 0) * sag, ck = CLUSTER_K[S.tier] || 1; M.dispL.emissiveIntensity = Math.max(disp, cat) * 0.8 * ck; M.dispR.emissiveIntensity = Math.max(disp, cat) * 0.8 * ck;
  M.screen.emissiveIntensity = Math.max(on ? 1 : 0, cat) * sag * 0.75;
  // the slot answers the key: LED 1 glows gold with a small halo the moment the key is seated (the key-reaches-slot beat), the others at ON and START
  const seatedK = N.keySeated && N.key && N.key.visible ? 1 : 0;
  M.ledArr[0].emissiveIntensity = acc ? 1.4 : seatedK * 1.0; M.ledArr[1].emissiveIntensity = on ? 1.4 : 0; M.ledArr[2].emissiveIntensity = deg >= 88 ? 1.4 : 0;
  if (M.ledHalo) M.ledHalo.opacity = seatedK * (acc ? 0.5 : 0.4) * (S.breathT >= 0 && ct < 0 ? 0.3 : 1);
  // the cabin points: the dash wakes with the notch, sags on ignite, surges on blips; the dome is the courtesy light; the ember is the catch
  const warm = ((0.05 + 0.5 * n) * sag * (1 + .4 * surge) + cat * 0.05) * wk * breath;
  L.dash1.intensity = warm * 1.3;
  L.inst.intensity = ((on ? .14 : 0) * sag + cat * 0.04 + catPulse * 0.10) * breath;
  L.pcm.intensity = ((on ? .10 : 0) * sag + catPulse * 0.06 + surge * 0.04) * breath;
  L.foot.intensity = (0.48 + 0.16 * n + cat * 0.08) * wk * breath * (1 + 1.5 * S.sitK);               // the puddle lamp lifts the footwell before the key turns (pre-ignition murk), x2.5 through the sit
  const domeK = Math.max(S.dome, 0.3) * (S.breathT >= 0 && ct < 0 ? 0 : 1); L.dome.intensity = (2.2 * domeK * (1 + 0.6 * S.sitK) + cat * 0.2 * (1 - domeK)) * dk; M.dome.emissiveIntensity = Math.max(domeK, cat * .3) * 0.7;   // the courtesy light x1.6 through the sit
  // the navy hemisphere: 0.50 before the catch (0.60 on the phone, whose smaller frame is mostly headliner and footwell), easing to 0.42 once the cabin lights carry the frame
  L.hemi.intensity = lerp(S.phone ? 0.60 : 0.50, 0.42, cat) * (0.6 + 0.4 * breath); L.catchGlow.intensity = ember; M.ember.opacity = clamp(ember * 0.55, 0, 0.5); N.ember.scale.setScalar(0.06 + 0.06 * ember);
  const flareK = ct >= 0 && ct < 0.25 ? 1 - ct / 0.25 : 0;                                            // the catch flare: its own quarter-second decay, never the pulse's 0.9 s
  M.flare.opacity = ABL('flare') ? 0 : 0.15 * flareK; N.flare.scale.set(0.05 + 0.03 * flareK, 0.05 + 0.03 * flareK, 1);
  if (L.key) L.key.intensity = 36 - 14 * cat;                                                          // the key panel eases to 22 cd once the gauges are lit so the spoke specular stays under the bloom
  const heads = 26 * headRamp * (1 + .25 * surge) * rumble; if (L.heads) for (const h of L.heads) h.intensity = heads;
  M.pool.opacity = clamp(0.42 * ramp * (1 + .2 * surge) * rumble, 0, 1); M.flood.opacity = clamp(0.02 * ramp * (1 + .2 * surge) * rumble, 0, 0.02);
  if (M.poolGrid) M.poolGrid.uniforms.k.value = 0.8 * ramp * (1 + .1 * surge);
  M.beam.uniforms.k.value = 0.12 * ramp * (1 + .3 * surge) * (fx ? fx.beamK * 2 : 1); M.beam.uniforms.time.value = S.t;
  L.spill.intensity = 0.45 * ramp * (1 + .2 * surge);
  if (L.doorFill) { L.doorFill.intensity = (0.22 + 0.55 * S.sitK) * clamp(S.doorOpen / 0.3, 0, 1); L.doorFill.color.setHex(0x6c8cff).lerp(C_SITFILL, S.sitK); }   // fades to nothing over the last 30 percent of the sit; through the sit it is the cool aperture fill
  // bloom (threshold 0.97: the LEDs, the flare, the pools and the hottest chrome arc cross it, nothing in the cabin otherwise):
  // 0.18 idle (+0.06 at full notch), 0.24 in the catch frame easing to 0.18, +0.08 on blips, 0.18 -> 0.30 through the dissolve;
  // the radius tightens to 0.25 while the headlights are on so the two pools stay two pools
  if (S.bloom) {
    let b = 0.18 + 0.06 * n;
    if (ct >= 0) b = ct < 0.035 ? 0.24 : 0.18 + 0.06 * Math.exp(-(ct - 0.035) / 0.3);
    if (S.lastStage === 'dissolve') b = lerp(0.18, 0.30, moveU('dissolve'));
    S.bloom.strength = (b + surge * 0.08) * (TIERS[S.tier].bloomK || 1); S.bloom.radius = ct >= 0 ? 0.25 : 0.3;
  }
  // GTAO (ultra): a wider, stronger occlusion in the sit pose so the cushion creases against its bolsters
  if (S.gtao) { const want = S.lastStage === 'sit' ? 'sit' : 'default'; if (S.gtaoMode !== want) { S.gtaoMode = want; try { S.gtao.updateGtaoMaterial(want === 'sit' ? { radius: 0.6, scale: 2.2 } : { radius: 0.4, scale: 1.6 }); } catch (e) {} } }
  // the model crossfade (a model landing after a stage-only reveal): every solid material of the car ramps its opacity over 400 ms
  if (S.modelFade && S.modelFade.active) {
    const f = S.modelFade; f.t += dt; const k = f.k = smooth(clamp(f.t / 0.4, 0, 1));
    for (const e of f.mats) e.m.opacity = e.op * k;
    if (k >= 1) { if (!f.bridged) { f.bridged = true; for (const e of f.mats) if (!e.tr) e.m.blending = THREE.NoBlending; } if (f.opaqueReady) endModelFade(); }   // full opacity with the blend off is an opaque write from the fade program; the true opaque state follows once its programs are linked
  }
  // exposure (ACES): 1.2 idle (the night cabin has to read before the key turns), 1.05 at full notch, the breath 0.9, the catch 0.80 for a
  // quarter second settling to 0.86, the dissolve down to 0.70
  let wantExp = 1.2 - 0.15 * n; if (S.breathT >= 0 && ct < 0) wantExp = 0.9;
  if (ct >= 0) wantExp = ct < 0.25 ? 0.80 : lerp(0.80, 0.86, clamp((ct - 0.25) / 0.75, 0, 1));
  if (S.lastStage === 'dissolve') wantExp = lerp(0.86, 0.70, moveU('dissolve'));
  S.exp = ct >= 0 && ct < 0.1 ? wantExp : S.exp + (wantExp - S.exp) * (1 - Math.exp(-dt / 0.1));
  if (S.renderer) S.renderer.toneMappingExposure = S.exp;
  // the lens grade: vignette 0.35 (0.45 in the catch frame, 0.6 through the dissolve), the gold midtone tint for the first half second of the catch
  if (S.grade) {
    const u = S.grade.uniforms; let v = 0.35; if (ct >= 0) v = 0.35 + 0.10 * Math.max(0, 1 - ct / 0.4); if (S.lastStage === 'dissolve') v = lerp(0.35, 0.6, moveU('dissolve'));
    u.vignette.value = v; u.goldTint.value = ct >= 0 ? 0.03 * Math.max(0, 1 - ct / 0.5) : 0; u.toe.value = 0.03 + 0.02 * (S.sitK || 0); if (!S.rm) u.time.value = S.t;   // the shadow toe lifts a step through the sit
  }
  // the door and the dome
  N.door.rotation.y = (N.door === N.doorModel ? MODEL_FIT.doorOpenDeg : -62) * DEG * S.doorOpen;
  if (S.doorOpen !== S.doorPrev) { S.doorPrev = S.doorOpen; S.shadowDirty = Math.max(S.shadowDirty, 1); }
  // the needle: 0 rpm at the left stop, 9k at the right; the texture puts 0 at -130 deg from the top
  N.needle.rotation.z = (130 - tachValue(dt) / 9 * 260) * DEG;
  if (N.reflector) N.reflector.visible = (S.lastStage === 'door' || S.lastStage === 'sit' || !S.lastStage) && S.doorOpen > 0.05;
  beatsApply(dt);   // BEAT welcome lights, turn hint, double flash (after the headlight values above)
}
function shakeOffset(now) {
  if (S.shakeT < 0 || S.rm) return null;
  const t = now - S.shakeT, amp = t < 0.4 ? 2 : 1, f = t < 0.4 ? 1 : 0.6;
  return [amp * (Math.sin(t * 61 * f) * .6 + Math.sin(t * 97 * f + 1.1) * .4), amp * (Math.sin(t * 73 * f + .4) * .5 + Math.sin(t * 113 * f + 2.3) * .5), t < 0.4 ? 0.3 * DEG * (1 - t / 0.4) * Math.sin(t * 52) : 0];
}

// ---------- loop ----------
// test hook: mount opts.simClock (test.html ?clock=timer) drives the loop from a 60 Hz timer with a simulated clock instead of
// requestAnimationFrame, for harnesses where rAF never fires; a mount option, never a switch readable from the public page's URL
function frame(nowMs) {
  if (S.disposed) return;
  if (S.simClock) { S.simT = (S.simT || nowMs) + 1000 / 60; nowMs = S.simT; S.raf = setTimeout(() => frame(S.simT), 1000 / 60); }
  else S.raf = requestAnimationFrame(frame);
  if (S.compileGate) { S.lastRaf = 0; return; }       // programs for a new tier are linking in the GPU process: hold the last frame rather than block the thread on first use
  const st = S.stats, ts = S.tierState;
  if (ts && ts.probePending && !ts.pinned && st.frames > 0) { ts.probePending = false; try { runProbe(); } catch (e) { console.warn('[TR3D] probe', e); } }
  const rm = tick(nowMs);
  st.frames++;
  st.rhist.push(rm); if (st.rhist.length > 90) st.rhist.shift();
  if (S.lastRaf) { const d = nowMs - S.lastRaf; st.hist.push(d); if (st.hist.length > 90) st.hist.shift(); if (d > st.maxMs) st.maxMs = d; if (ts && !ts.masked) watchdog(d); }
  S.lastRaf = nowMs;
}
// one frame of the walk-in at clock nowMs (seconds advance by the real dt, capped): the moves, the rig, the state, the render
function tick(nowMs, hold) {
  const now = nowMs / 1000, dt = hold ? 0 : clamp(now - (S.last || now), 0, 0.05); if (!hold) { S.last = now; S.t += dt; }
  const t0 = performance.now();
  try {
    S.renderer.info.reset();
    const m = S.move;
    if (m) { m.t += dt; const u = m.ease(clamp(m.t / m.dur, 0, 1)); evalMove(m, u); if (m.t >= m.dur) { S.move = null; finishMove(m); } }
    // smoothed rig: the render pose follows the goal with a short time constant
    const k = 1 - Math.exp(-dt / TAU); RIG.pos.lerp(RIG.gPos, k); RIG.tgt.lerp(RIG.gTgt, k);
    // key nudge (1 to 2 deg toward the slot as it turns) and the seated breath
    const cam = S.camera, tgt = RIG.tgt.clone();
    if (S.deg > 0 && N.slot) { const sw = N.slot.getWorldPosition(new THREE.Vector3()); tgt.addScaledVector(sw.sub(RIG.tgt).normalize(), S.deg / 90 * 0.028); }
    const pos = RIG.pos.clone();
    if (!S.rm && S.breath) { pos.y += 0.0012 * Math.sin(S.t * 1.1); tgt.x += 0.0015 * Math.sin(S.t * 0.7); tgt.y += 0.0008 * Math.sin(S.t * 0.9 + 1); }
    // the walk: a subtle head sway (step bob + lateral), fading out as the body lowers into the seat
    S.swayCur = lerp(S.swayCur || 0, S.move ? (S.sway || 0) : 0, k);   // eases out between moves, never pops
    const sw = S.rm ? 0 : S.swayCur;
    if (sw > 0) { const right = new THREE.Vector3().subVectors(tgt, pos).cross(cam.up).normalize(); pos.y += 0.011 * sw * Math.sin(S.t * 2 * Math.PI * 1.7); pos.addScaledVector(right, 0.006 * sw * Math.sin(S.t * 2 * Math.PI * 0.85)); }
    cam.position.copy(pos); cam.up.set(0, 1, 0); cam.lookAt(tgt);
    if (S.roll && !S.rm) cam.rotateZ(S.roll);                      // the duck under the rail; back to level by the time the weight lands
    const sh = shakeOffset(now); const w = S.w || 1, h = S.h || 1;
    if (sh) { cam.setViewOffset(w, h, sh[0], sh[1], w, h); if (sh[2]) cam.rotateZ(sh[2]); } else if (cam.view && cam.view.enabled) cam.clearViewOffset();
    // the lens: fov per stage and the focus pull, both eased with the rig's time constant
    const fv = wantFov(); S.fov += (fv - S.fov) * k; if (Math.abs(cam.fov - S.fov) > 1e-3) { cam.fov = S.fov; cam.updateProjectionMatrix(); }
    applyState(dt);
    if (S.dof) { const f = wantFocus(); S.focus += (f[0] - S.focus) * k; const u = S.dof.uniforms; u.focus.value = S.focus; u.aperture.value = f[1]; u.maxblur.value = S.phone ? Math.min(f[2], 0.006) : f[2]; }
    if (S.renderer.shadowMap.enabled) { if (S.shadowDirty > 0 || st_frames() < 3) { S.renderer.shadowMap.needsUpdate = true; S.shadowDirty = Math.max(0, S.shadowDirty - 1); } }
    if (S.composer) S.composer.render(); else S.renderer.render(S.scene, cam);                      // every tier draws through the composer (lite: scene, output, SMAA); direct only if the post stack failed to build
    if (S.revealPending) { S.revealPending = false; S.shown = true; if (S.canvas) S.canvas.style.opacity = '1'; schedulePrecompile(); }   // the hold is over and the cabin that stays is on the canvas: fade it in; the next tier's programs follow in the background
  } catch (e) { console.warn('[TR3D] frame', e); }
  return performance.now() - t0;
}
function st_frames() { return S.stats.frames; }

function resize() {
  const c = S.container; if (!c || !S.renderer) return;
  const w = Math.max(1, c.clientWidth || window.innerWidth), h = Math.max(1, c.clientHeight || window.innerHeight);
  S.w = w; S.h = h;
  S.renderer.setSize(w, h, false);
  S.camera.aspect = w / h; S.camera.updateProjectionMatrix();
  if (S.composer) { S.composer.setPixelRatio(S.pr); S.composer.setSize(w, h); if (S.grade) S.grade.uniforms.resolution.value.set(w * S.pr, h * S.pr); }
  if (S.tierState) S.tierState.ignore = Math.max(S.tierState.ignore, 2);
}

// ---------- quality tiers: the post stack, the pick at mount, the burst probe, the steady-state watchdog ----------
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, resolution: { value: new THREE.Vector2(1, 1) }, time: { value: 0 }, vignette: { value: 0.35 }, ca: { value: 0.0006 }, grain: { value: 0.02 }, goldTint: { value: 0 }, lift: { value: new THREE.Vector3(0.027, 0.043, 0.086) }, toe: { value: 0.03 }, gain: { value: new THREE.Vector3(1.0, 1.0, 1.02) } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 resolution; uniform float time, vignette, ca, grain, goldTint, toe; uniform vec3 lift, gain; varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 d = vUv - 0.5; float rr = length(d) * 1.4142;                                 // 0 at the centre, 1 at the corners
      vec2 off = d * (smoothstep(0.6, 1.0, rr) * ca / max(rr, 1e-3));                  // chromatic aberration only outside r 0.6 (the slot ring and the key never fringe), ca uv at the corner
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, c.g, texture2D(tDiffuse, vUv - off).b);
      col = col * gain * (1.0 - lift) + lift;                                           // the night grade: blacks lift to the brand navy
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col += toe * (1.0 - smoothstep(0.0, 0.22, lum)) * vec3(0.9, 0.95, 1.0);            // the shadow toe: the near-black cabin walls and footwell lift a step, the sky (already above the knee) does not
      lum = dot(col, vec3(0.299, 0.587, 0.114));
      float mid = smoothstep(0.08, 0.4, lum) * (1.0 - smoothstep(0.55, 0.9, lum));
      col = mix(col, col * vec3(1.04, 1.0, 0.94), goldTint * mid);                       // a breath of gold in the midtones at the catch, never the highlights
      vec2 gp = vUv * resolution + vec2(fract(time * 13.7) * 97.0, fract(time * 7.3) * 61.0);   // film grain: white noise per pixel with a per-frame offset, strongest in the shadows
      float g = (hash(gp) - 0.5) * grain * mix(1.0, 0.2, smoothstep(0.0, 0.7, lum));
      col += g;
      float v = 1.0 - smoothstep(0.32, 1.0, length(d * vec2(1.25, 1.0)));
      col *= mix(1.0 - vignette, 1.0, v);
      gl_FragColor = vec4(col, c.a);
    }`
};
function prepassWrap(pass) {                       // the AO and DoF pre-passes skip layer 1 (glass, additive planes, sprites) so transparency never writes depth
  const r = pass.render;
  pass.render = function (...a) { const cam = S.camera; cam.layers.disable(LAYER_NOPRE); try { r.apply(this, a); } finally { cam.layers.enable(LAYER_NOPRE); } };
}
// the HDR clamp before bloom: rgb capped at HDR_CLAMP in the HalfFloat buffer, so a one-pixel specular on a stitched sill or a chrome edge
// cannot seed a bloom firefly (the pools, LEDs and the catch flare sit well under the cap and bloom as before)
const ClampShader = {
  uniforms: { tDiffuse: { value: null }, cap: { value: HDR_CLAMP } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform sampler2D tDiffuse; uniform float cap; varying vec2 vUv; void main() { vec4 c = texture2D(tDiffuse, vUv); gl_FragColor = vec4(min(c.rgb, vec3(cap)), c.a); }'
};
// ultra's scene pass: the scene is drawn into a multisampled HalfFloat target that is resolved ONCE (at the end of its render call) and copied
// into the composer's single-sample ping-pong, so GTAO, DoF, bloom and the output pass never pay a 4x RGBA16F resolve each
class MsaaScenePass extends Pass {
  constructor(scene, camera, w, h, samples) {
    super(); this.scene = scene; this.camera = camera; this.needsSwap = false; this.clear = true;
    this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples }); this.rt.texture.name = 'MsaaScenePass.rt';
    const u = THREE.UniformsUtils.clone(CopyShader.uniforms); u.tDiffuse.value = this.rt.texture;
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({ uniforms: u, vertexShader: CopyShader.vertexShader, fragmentShader: CopyShader.fragmentShader, depthTest: false, depthWrite: false, blending: THREE.NoBlending }));
  }
  setSize(w, h) { this.rt.setSize(w, h); }
  render(renderer, writeBuffer, readBuffer) {
    const oldAuto = renderer.autoClear; renderer.autoClear = false;
    renderer.setRenderTarget(this.rt); renderer.clear(true, true, false); renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer); this.quad.render(renderer);
    renderer.autoClear = oldAuto;
  }
  dispose() { try { this.rt.dispose(); this.quad.material.dispose(); this.quad.dispose(); } catch (e) {} }
}
function disposePost() {
  try { if (S.composer) { for (const p of S.composer.passes) { try { if (p.dispose) p.dispose(); } catch (e) {} } S.composer.dispose(); } } catch (e) {}
  S.composer = null; S.bloom = null; S.gtao = null; S.dof = null; S.grade = null; S.clampPass = null; S.gtaoMode = null;
}
function buildPost(tier) {
  const old = S.composer; S.composer = null; S.bloom = null; S.gtao = null; S.dof = null; S.grade = null; S.clampPass = null; S.gtaoMode = null;
  // the old stack is disposed by the CALLER, after the new passes have been issued to compile: three releases a program when its last material
  // goes, so disposing first would destroy the bloom / SMAA / output / grade programs the two stacks share and relink the whole post stack
  const disposeOld = () => { try { if (old) { for (const p of old.passes) { try { if (p.dispose) p.dispose(); } catch (e) {} } old.dispose(); } } catch (e) {} };
  const Tc = TIERS[tier]; if (!Tc.post || !S.renderer) { return disposeOld; }
  const r = S.renderer, w = Math.max(1, Math.round((S.w || 1) * S.pr)), h = Math.max(1, Math.round((S.h || 1) * S.pr)), gl2 = r.capabilities.isWebGL2;
  try {
    const msaa = gl2 ? (S.opts && S.opts.msaa !== undefined ? +S.opts.msaa : Tc.msaa) : 0;   // opts.msaa: harness override; phone base runs SMAA like desktop base (a multisampled RGBA16F resolve is the costliest item on a mobile GPU)
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });            // the ping-pong is always single-sample (see MsaaScenePass)
    const comp = new EffectComposer(r, rt);
    comp.addPass(msaa ? new MsaaScenePass(S.scene, S.camera, w, h, msaa) : new RenderPass(S.scene, S.camera));
    if (Tc.gtao && gl2) {
      const g = new GTAOPass(S.scene, S.camera, w, h); g.output = GTAOPass.OUTPUT.Default; g.blendIntensity = 0.6;   // 0.9 darkened the binnacle hood (and the lit dials in it) 40 levels under the tiers without AO
      g.updateGtaoMaterial({ radius: 0.4, distanceExponent: 1, thickness: 1, distanceFallOff: 1, scale: 1.6, samples: 12, screenSpaceRadius: false });   // the sit pose widens this to 0.6 / 2.2 (applyState) so the cushion creases against its bolsters
      g.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 8 });
      if (S.model) { try { g.setSceneClipBox(new THREE.Box3().setFromObject(S.model, true).expandByScalar(0.3)); } catch (e) {} }
      prepassWrap(g); comp.addPass(g); S.gtao = g; S.gtaoMode = 'default';
    }
    if (Tc.dof) { const d = new BokehPass(S.scene, S.camera, { focus: 0.8, aperture: 0.0035, maxblur: 0.006 }); prepassWrap(d); comp.addPass(d); S.dof = d; }
    if (Tc.bloom) {
      S.clampPass = new ShaderPass(ClampShader); S.clampPass.uniforms.cap.value = Tc.clamp || HDR_CLAMP; comp.addPass(S.clampPass);   // base clamps at 2.0: its frame has no AO or DoF to soften the chrome arc
      S.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.18, 0.3, 0.97); comp.addPass(S.bloom);
    }
    comp.addPass(new OutputPass());
    if (!msaa) comp.addPass(new SMAAPass(w, h));          // no multisampled scene pass (WebGL1, base, high, lite): SMAA on the LDR image instead
    if (Tc.grade) { S.grade = new ShaderPass(GradeShader); S.grade.uniforms.resolution.value.set(w, h); S.grade.uniforms.grain.value = S.rm || tier === 'lite' ? 0 : S.phone ? 0.008 : (tier === 'base' ? 0.014 : 0.02); comp.addPass(S.grade); }
    S.composer = comp;
  } catch (e) { console.warn('[TR3D] post disabled', e); disposePost(); }
  return disposeOld;
}
function passList() { return S.composer ? S.composer.passes.map(p => p.constructor.name) : ['direct']; }
function gpuString(renderer) {
  try { const gl = renderer.getContext(), dbg = gl.getExtension('WEBGL_debug_renderer_info'); return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null; } catch (e) { return null; }
}
// the hint pick: the device class from the GPU string, cores, memory, touch, viewport and the page's own lite flag -> a ladder of steps
function pickLadder(opts, gpu) {
  const nav = navigator, cores = nav.hardwareConcurrency || 0, mem = nav.deviceMemory, save = !!(nav.connection && nav.connection.saveData), dpr = window.devicePixelRatio || 1;
  const cssW = S.w || window.innerWidth, cssH = S.h || window.innerHeight, area = cssW * cssH, g = gpu || '';
  const htmlLite = (() => { try { return document.documentElement.classList.contains('lite'); } catch (e) { return false; } })();
  const step = (tier, pr) => ({ tier, pr: Math.max(1, Math.min(pr, dpr, Math.sqrt(TIERS[tier].maxPix / Math.max(1, area)))) });
  if (opts.lite || htmlLite || GPU_RX.software.test(g) || (cores && cores <= 2) || (mem && mem <= 2)) return { ladder: [step('lite', 1)], cls: 'software', why: opts.lite ? 'opts.lite' : htmlLite ? 'html.lite' : 'weak hints' };
  const dedupe = l => l.filter((s, i) => !i || s.tier !== l[i - 1].tier || s.pr !== l[i - 1].pr);   // at dpr 1 the phone ladder would otherwise step base@1 -> base@1 (a wasted change and cool-down)
  if (S.phone) {
    const weak = GPU_RX.phoneWeak.test(g) || (cores && cores <= 4) || (mem && mem <= 3) || save, strong = GPU_RX.phoneStrong.test(g);
    const ladder = [{ tier: 'base', pr: Math.min(dpr, 2) }, { tier: 'base', pr: Math.min(dpr, 1.5) }, { tier: 'base', pr: 1 }, { tier: 'lite', pr: 1 }];
    return { ladder: dedupe(ladder.slice(weak ? 3 : strong ? 0 : 1)), cls: weak ? 'weak' : strong ? 'strong' : 'mid', why: 'phone' };
  }
  const touch = (nav.maxTouchPoints || 0) > 1;
  const weak = GPU_RX.weak.test(g) || (cores >= 3 && cores <= 4) || (mem && mem >= 3 && mem <= 4) || save;
  let strong = GPU_RX.strong.test(g) && !GPU_RX.notStrong.test(g) && cores >= 8 && (mem === undefined || mem >= 8) && area <= 3.0e6 && !touch;
  if (strong && /^Apple GPU$/.test(g.trim()) && !(screen.width >= 1280 && cores >= 8)) strong = false;
  // strong: ultra@2 -> high@1.5 -> base@1 -> lite; mid: high@1.5 -> high@1 -> base@1 -> lite (an integrated GPU usually holds high at pr 1); weak: base@1 -> lite
  const ladder = strong ? [step('ultra', 2), step('high', 1.5), step('base', 1), step('lite', 1)] : weak ? [step('base', 1), step('lite', 1)] : [step('high', 1.5), step('high', 1), step('base', 1), step('lite', 1)];
  return { ladder: dedupe(ladder), cls: weak ? 'weak' : strong ? 'strong' : 'mid', why: g ? 'gpu string' : 'no gpu string (mid)' };
}
function setupTiers(opts) {
  const gpu = gpuString(S.renderer);
  const pick = pickLadder(opts, gpu), ts = { gpu, cls: pick.cls, why: pick.why, ladder: pick.ladder, idx: 0, pinned: false, auto: opts.autoTier !== false, changes: 0, coolUntil: 0, win: [], consec: 0, slowCount: 0, ignore: 0, stepDowns: [], probePending: false, deferred: null, masked: false, probe: null };
  if (opts.tier && TIERS[opts.tier]) { ts.ladder = [{ tier: opts.tier, pr: opts.pr ? Math.max(1, +opts.pr) : (opts.tier === 'lite' ? 1 : Math.min(TIERS[opts.tier].pr, window.devicePixelRatio || 1)) }]; ts.pinned = true; ts.why = 'pinned'; }
  S.tierState = ts;
  applyTier(ts.ladder[0], 'mount');
  if (!ts.pinned && ts.auto && S.tier !== 'lite') ts.probePending = true;
}
// move the scene to a tier step: pixel ratio, shadows, rect lights, the reflector, the composer; one recompile
function applyTier(step, reason) {
  const Tc = TIERS[step.tier], r = S.renderer; if (!r) return;
  const from = S.tier + '@' + S.pr;
  S.tier = step.tier; S.pr = step.pr; S.lite = step.tier === 'lite';
  r.setPixelRatio(S.pr);
  r.shadowMap.enabled = Tc.shadow > 0; r.shadowMap.type = Tc.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap; r.shadowMap.autoUpdate = false;
  for (const m of [M.leather, M.leatherSeat, M.leatherDark, ...(M.sheenMats || [])]) if (m) { const want = Tc.sheen && !ABL('sheen') ? (m.userData.sheen !== undefined ? m.userData.sheen : m.sheen) : 0; if (m.userData.sheen === undefined) m.userData.sheen = m.sheen; if (m.sheen !== want) { m.sheen = want; m.needsUpdate = true; } }   // the velvet sheen (a per-light Charlie lobe) only where the budget allows
  for (const m of [M.paint, M.modelBiw, ...(M.paintMats || [])]) if (m && 'clearcoat' in m) { const want = Tc.clearcoat && !ABL('clearcoat') ? 1 : 0; if (m.clearcoat !== want) { m.clearcoat = want; m.needsUpdate = true; } }   // the clearcoat lobe (two more per light) is dropped on the floor tier only
  if (ABL('floor') && M.floor) { M.floor.roughnessMap = null; M.floor.envMapIntensity = 0; M.floor.needsUpdate = true; }
  if (ABL('env') && S.scene) S.scene.environment = null;
  if (ABL('glass') && S.scene) S.scene.traverse(o => { if (o.isMesh && o.material && ((o.material.name || '') + '').toLowerCase().includes('glass')) o.visible = false; });
  if (ABL('shadow')) r.shadowMap.enabled = false;
  if (L.key) { L.key.castShadow = Tc.shadow > 0 && !ABL('shadow'); const n = S.phone ? Math.min(Tc.shadow, 1024) : Tc.shadow; if (n && L.key.shadow.mapSize.x !== n) { L.key.shadow.mapSize.set(n, n); if (L.key.shadow.map) { L.key.shadow.map.dispose(); L.key.shadow.map = null; } } }
  if (L.goldL) L.goldL.visible = Tc.rect; if (L.goldR) L.goldR.visible = Tc.rect;
  if (Tc.refl && !S.phone) {
    if (!N.reflector) {
      try {
        const refl = new Reflector(new THREE.PlaneGeometry(26, 26), { textureWidth: 512, textureHeight: 288, clipBias: 0.003, color: 0xa4acbf, multisample: 0 });   // a third-res target: the floor's reflection of the car arrives softened by about 3 px, as a polished floor would show it, the sill and door still resolving
        refl.rotation.x = -Math.PI / 2; refl.position.set(0, GROUND - 0.002, -0.5); refl.name = 'reflector'; noPre(refl); S.scene.add(refl); N.reflector = refl;
      } catch (e) { console.warn('[TR3D] reflector', e); }
    }
    M.floor.transparent = true; M.floor.opacity = S.opts && S.opts.floorOpacity !== undefined ? +S.opts.floorOpacity : 0.5; M.floor.needsUpdate = true;   // the reflector shows through at 0.5; opts.floorOpacity: harness only
  } else {
    if (N.reflector) { try { S.scene.remove(N.reflector); N.reflector.dispose(); N.reflector.geometry.dispose(); } catch (e) {} N.reflector = null; }
    M.floor.transparent = false; M.floor.opacity = 1; M.floor.needsUpdate = true;
  }
  const tA = performance.now(); const disposeOld = buildPost(step.tier); const tB = performance.now();
  resize();
  // the programs this step draws: compiled now with the composer's target bound (the variants the frame uses). At mount the caller awaits
  // the async compile before the first frame; every later step gates the loop on the links (the canvas holds its last frame, or stays
  // transparent before the reveal) so the GPU process links while the thread stays free; a pending probe waits for the gate too
  if (reason !== 'mount') { gateOn(Promise.all([compileBoth(true), compileExtras(true)])); if (S.modelFade && S.modelFade.active) compileOpaque(S.modelFade); }
  if (disposeOld) disposeOld();   // the new passes hold their programs now: the shared ones survive the old stack's disposal
  releaseClones();   // the real materials now hold the programs the clones kept alive
  const tC = performance.now(); S.lastStepMs = { post: Math.round(tB - tA), compileIssue: Math.round(tC - tB) }; if (S.tierState && S.tierState.stepDowns.length) Object.assign(S.tierState.stepDowns[S.tierState.stepDowns.length - 1], S.lastStepMs);
  S.shadowDirty = 3;
  const ts = S.tierState; if (ts) { ts.ignore = 15; ts.win = []; ts.consec = 0; ts.failWins = 0; ts.coolUntil = performance.now() + 900; }
  try { if (S.container) S.container.dispatchEvent(new CustomEvent('tr3d:tier', { detail: { tier: S.tier, pr: S.pr, reason, from } })); } catch (e) {}
}
function gateOn(p) { const t0 = performance.now(), g = S.compileGate = p.then(() => { if (S.compileGate === g) S.compileGate = null; if (S.lastStepMs) S.lastStepMs.gate = Math.round(performance.now() - t0); warmPrograms(); schedulePrecompile(); }, () => { if (S.compileGate === g) S.compileGate = null; }); return g; }
// three fetches a program's uniform and attribute tables on its first draw (a few ms of synchronous location queries each): done here for every
// linked program instead, after the mount compile and after each step's gate, so no frame pays them
function warmPrograms() { const r = S.renderer; if (!r) return 0; let n = 0; const t0 = performance.now(); try { for (const p of r.info.programs) { if (!p.program) continue; let ok = false; try { ok = p.isReady(); } catch (e) {} if (!ok) continue; try { p.getUniforms(); p.getAttributes(); n++; } catch (e) {} } } catch (e) {} S.lastWarmMs = Math.round(performance.now() - t0); return n; }
// After the reveal the NEXT ladder step's programs are linked in the background so a later step-down is a cached swap: every scene
// material is cloned with that tier's flags (sheen, clearcoat; the renderer's shadow and light state is set only inside each compile call), two
// clones per idle callback, so no frame ever renders with the wrong flags and the GPU process never gets a wall of shader
// sources at once (that backpressure was a 1 s main-thread stall). The clones are kept until the step (or dispose) so the shared programs
// stay alive in three's program cache; the real materials pick them up by cache key when the tier changes.
function schedulePrecompile() { if (S.precompileT) clearTimeout(S.precompileT); S.precompileT = setTimeout(precompileNext, 1200); }
function precompileNext() {
  S.precompileT = 0; const ts = S.tierState, r = S.renderer; if (!ts || ts.pinned || !ts.auto || !r || S.disposed || S.compileGate || ts.idx >= ts.ladder.length - 1) return;
  if (S.modelState === 'loading' || S.modelFade) { schedulePrecompile(); return; }   // a model still in flight or fading in has its own compiles and uploads running: the next tier's wait their turn (the slow-network path stepped a tier from the three streams overlapping)
  const nextStep = ts.ladder[ts.idx + 1], next = TIERS[nextStep.tier]; if (ts.precompiled === next || ts.precompiling) return;
  const mats = new Map(); S.scene.traverse(o => { if (!o.material) return; for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m && !mats.has(m) && (m.isMeshStandardMaterial || m.isShaderMaterial || m.isSpriteMaterial || m.isMeshBasicMaterial)) mats.set(m, o); });
  const list = [...mats.keys()], clones = ts.precompiledClones = ts.precompiledClones || [], cam = S.camera, rt = S.composer ? S.composer.readBuffer : null;
  const cloneOf = m => {
    const c = cloneForCompile(m);
    if ('sheen' in c && c.sheen > 0 && !next.sheen) c.sheen = 0;
    if ('clearcoat' in c && c.clearcoat > 0 && !next.clearcoat) c.clearcoat = 0;
    return c;
  };
  ts.precompiling = true; let i = 0; const gen = ts.preGen = (ts.preGen || 0) + 1;
  const chunk = () => {
    if (S.disposed || !S.renderer || ts !== S.tierState || ts.preGen !== gen) { if (ts.preGen === gen) ts.precompiling = false; return; }
    if (i >= list.length) { warm(); return; }
    const tmp = new THREE.Scene();
    for (let k = 0; k < 1 && i < list.length; k++, i++) { const c = cloneOf(list[i]); clones.push(c); tmp.add(compileStandIn(mats.get(list[i]), c)); }   // one program a task (about 8 ms of GLSL assembly, then its link in the GPU process): the walk-in's frames stay under the watchdog's ceiling; each clone on its real mesh's geometry (the attribute set is part of the program key)
    // the program key also carries the shadow-map type, the shadow-caster count and the rect-light count: the next tier's values are set for the compile call only
    const sh = r.shadowMap.enabled, shT = r.shadowMap.type, kc = L.key ? L.key.castShadow : false, gl = L.goldL ? L.goldL.visible : false, gr = L.goldR ? L.goldR.visible : false, was = S.lateOn;
    try {
      r.shadowMap.enabled = next.shadow > 0; r.shadowMap.type = next.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap; if (L.key) L.key.castShadow = next.shadow > 0 && !ABL('shadow'); if (L.goldL) L.goldL.visible = next.rect; if (L.goldR) L.goldR.visible = next.rect;
      setLate(true); r.setRenderTarget(rt); r.compile(tmp, cam, S.scene);
      if (S.splitLights) { setLate(false); r.compile(tmp, cam, S.scene); }   // the phone draws the pre-notch frames with the late lights out of the shader: that variant too
    } catch (e) {} finally { try { r.setRenderTarget(null); } catch (e) {} r.shadowMap.enabled = sh; r.shadowMap.type = shT; if (L.key) L.key.castShadow = kc; if (L.goldL) L.goldL.visible = gl; if (L.goldR) L.goldR.visible = gr; setLate(was); }
    maskChunk(); idle(chunk);
  };
  // phase 2: once a clone's program reports linked, its uniform and attribute tables are fetched here (three does that on first use, about
  // 5 ms of synchronous location queries per program), five programs per task, so the real step pays neither the link nor the queries
  let left = clones.slice();
  const warm = () => {
    if (S.disposed || !S.renderer || ts !== S.tierState || ts.preGen !== gen) { if (ts.preGen === gen) ts.precompiling = false; return; }
    const keep = []; let n = 0;
    for (const c of left) { let prog = null; try { prog = r.properties.get(c).currentProgram; } catch (e) {} if (!prog || !prog.program) continue; let ready = false; try { ready = prog.isReady(); } catch (e) { continue; } if (n < 2 && ready) { try { prog.getUniforms(); prog.getAttributes(); } catch (e) {} n++; } else keep.push(c); }
    left = keep; maskChunk();
    if (left.length) idle(warm); else { ts.precompiling = false; ts.precompiled = next; }
  };
  idle(chunk);
}
function maskChunk() { const ts = S.tierState; if (ts) ts.ignore = Math.max(ts.ignore, 2); }   // the frame that carried a background chunk (GLSL assembly, a texture upload) is not judged by the watchdog
function idle(f) { try { if (window.requestIdleCallback) { window.requestIdleCallback(dl => { if (!dl.didTimeout && dl.timeRemaining() < 6) { idle(f); return; } f(); }, { timeout: 250 }); return; } } catch (e) {} setTimeout(f, 60); }   // the background compile steps run only in real idle time between frames (a step needs about 5 ms)
function releaseClones() { const ts = S.tierState; if (!ts) return; ts.preGen = (ts.preGen || 0) + 1; if (!ts.precompiledClones) return; for (const c of ts.precompiledClones) { try { c.dispose(); } catch (e) {} } ts.precompiledClones = []; ts.precompiled = null; ts.precompiling = false; }   // a new generation stops any chunk or warm loop still running on the old clones
// every material is compiled for both light states (the late lights hidden and shown) so the switch at the first notch is a cached
// program swap, never a compile in the middle of the turn. The composer's read buffer is bound while compiling: three keys a program on
// the bound target (NoToneMapping + linear into a render target, ACES + sRGB to the canvas), so with no target bound every program
// compiled here was the wrong variant and the real ones still linked lazily mid-intro. root: compile only that subtree (the model on
// arrival) against the scene's lights. async: renderer.compileAsync (KHR_parallel_shader_compile), resolved when the programs are linked.
// roots: one object or a list (the model root, the cut door and the moved props on arrival); the whole scene when omitted.
// Never three's compileAsync: its poll reads the current program of every material it was given and throws once one of them has been
// disposed (a probe step replacing the composer under a running poll); issueCompile() + linked() below poll the programs themselves.
function compileBoth(async, roots) {
  const r = S.renderer; if (!r || !S.scene) return Promise.resolve();
  const rt = S.composer ? S.composer.readBuffer : null, list = roots ? (Array.isArray(roots) ? roots : [roots]).filter(Boolean) : [S.scene], tgt = roots ? S.scene : null, progs = new Set();
  const run = on => { const was = S.lateOn; setLate(on); try { issueCompile(list, S.camera, tgt, rt).forEach(p => progs.add(p)); } finally { setLate(was); } };   // one compile pass per light state; the live state is put back at once (the links keep going in the GPU process)
  run(true); if (S.splitLights) run(false);
  return async ? linked(progs) : Promise.resolve();
}
// renderer.compile() of these roots against the target scene's lights with a render target bound, returning the WebGLProgram objects it
// made current (one per material and light state), so the caller waits for exactly those links
function issueCompile(roots, cam, tgt, rt) {
  const r = S.renderer, progs = new Set(); if (!r) return progs;
  try { r.setRenderTarget(rt); for (const o of roots) { const mats = r.compile(o, cam, tgt); mats.forEach(m => { try { const p = r.properties.get(m).currentProgram; if (p && p.program) progs.add(p); } catch (e) {} }); } }
  catch (e) { console.warn('[TR3D] compile', e); }
  finally { try { r.setRenderTarget(null); } catch (e) {} }
  return progs;
}
// resolves once every program in the set reports linked (KHR_parallel_shader_compile, polled every 10 ms, 12 s cap); a program released
// meanwhile counts as done and the poll ends with the renderer that made it, so nothing here can throw or outlive a dispose
function linked(progs, ms) {
  const r = S.renderer; if (!r || !progs.size) return Promise.resolve();
  return new Promise(res => {
    const t0 = performance.now(), check = () => {
      if (S.renderer !== r) { res(); return; }
      for (const p of [...progs]) { let ok = true; try { ok = !p.program || p.isReady(); } catch (e) {} if (ok) progs.delete(p); }
      if (!progs.size || performance.now() - t0 > (ms || 12000)) { res(); return; }
      setTimeout(check, 10);
    };
    check();
  });
}
// a stand-in mesh for compiling a material clone: the real mesh's geometry (shared, nothing uploaded) so the attribute set in the program
// key (uv1..uv3 and tangents on the glTF meshes, plain uv on the procedural ones) matches the program the real mesh will ask for
function compileStandIn(mesh, mat) { if (mat.isSpriteMaterial) return new THREE.Sprite(mat); return new THREE.Mesh(mesh && mesh.geometry ? mesh.geometry : (S.planeGeo = S.planeGeo || new THREE.PlaneGeometry(1, 1)), mat); }
function cloneForCompile(m) {
  let c; if (m.name && String(m.name).toLowerCase().startsWith('car_porsche')) { c = atlasMaterial(m); if (M.sheenMats) M.sheenMats.pop(); } else { c = m.clone(); if (m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) c.onBeforeCompile = m.onBeforeCompile; if (m.hasOwnProperty('customProgramCacheKey')) c.customProgramCacheKey = m.customProgramCacheKey; }
  c.userData.precompileClone = true; return c;
}
// the programs renderer.compile() never sees: the post passes' full-screen materials (bloom, SMAA, output, grade, the override
// depth/normal materials of DoF and GTAO) and the shadow map's depth variants. Each is given a plane in a scratch scene and compiled with
// the composer target bound and again with the canvas bound (the last pass draws to the screen, a different program key), so the first
// real frame links nothing.
function compileExtras(async) {
  const r = S.renderer; if (!r) return Promise.resolve();
  const mats = new Set();
  if (S.composer) for (const p of S.composer.passes) {
    if (p.material && '_toneMapping' in p && '_outputColorSpace' in p) {   // OutputPass sets its tone-mapping / colour-space defines on its first render and relinks: set them now so the compiled program is the one it draws with
      p._outputColorSpace = r.outputColorSpace; p._toneMapping = r.toneMapping; const d = {}; if (THREE.ColorManagement.getTransfer(r.outputColorSpace) === THREE.SRGBTransfer) d.SRGB_TRANSFER = '';
      if (r.toneMapping === THREE.ACESFilmicToneMapping) d.ACES_FILMIC_TONE_MAPPING = ''; else if (r.toneMapping === THREE.LinearToneMapping) d.LINEAR_TONE_MAPPING = ''; else if (r.toneMapping === THREE.ReinhardToneMapping) d.REINHARD_TONE_MAPPING = ''; else if (r.toneMapping === THREE.CineonToneMapping) d.CINEON_TONE_MAPPING = ''; else if (r.toneMapping === THREE.AgXToneMapping) d.AGX_TONE_MAPPING = '';
      p.material.defines = d; p.material.needsUpdate = true;
    }
    for (const k in p) { const v = p[k]; if (v && v.isMaterial) mats.add(v); else if (Array.isArray(v)) { for (const m of v) if (m && m.isMaterial) mats.add(m); } else if (v && v.material && v.material.isMaterial && v._mesh) mats.add(v.material); }
  }
  // the shadow map's depth variants as three builds them: a FrontSide material casts with a BackSide depth material (DoubleSide stays), and the
  // depth material carries the caster's map whenever it has one (USE_MAP is in the program key), so six variants cover every caster
  if (r.shadowMap.enabled) for (const side of [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide]) for (const map of [null, T.leather || null]) { const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side }); if (map) m.map = map; mats.add(m); }
  if (!mats.size) return Promise.resolve();
  const tmp = new THREE.Scene(), g = new THREE.PlaneGeometry(1, 1), cam = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
  for (const m of mats) tmp.add(new THREE.Mesh(g, m));
  const progs = new Set(); for (const rt of [S.composer ? S.composer.readBuffer : null, null]) issueCompile([tmp], cam, null, rt).forEach(p => progs.add(p));   // against the composer target and the canvas (the last pass draws to the screen: a different program key)
  try { g.dispose(); } catch (e) {}
  return async ? linked(progs) : Promise.resolve();
}
function stepDown(reason) {
  const ts = S.tierState; if (!ts || ts.pinned) return false;
  ts.deferred = null; ts.deferredMove = null;
  if (ts.idx >= ts.ladder.length - 1 || ts.changes >= 3) return false;
  const from = ts.ladder[ts.idx]; ts.idx++; const to = ts.ladder[ts.idx];
  ts.changes++;
  ts.stepDowns.push({ t: +(performance.now() / 1000).toFixed(2), from: from.tier + '@' + from.pr, to: to.tier + '@' + to.pr, reason });
  applyTier(to, reason);
  return true;
}
function requestStepDown(reason) {
  const ts = S.tierState, m = S.move;
  if (m && m.dur - m.t > 0 && m.dur - m.t < 0.3) { ts.deferred = reason; ts.deferredMove = m; return; }   // the move ends within 300 ms: change at the join rather than mid-move
  stepDown(reason);
}
// the burst probe: one long rAF callback renders the SEATED pose (the expensive frame: the atlas over the whole frame, the late lights on,
// the gauges lit) back to back with a GPU sync after each frame while the canvas is still transparent, then puts the rig back; over
// budget = one step down and another burst on the next rAF. Phone steps carry their own budgets (12 ms at pr 2 and 1.5, 14 ms at pr 1).
function probeNow() { const ts = S.tierState; let n = 0; while (ts && ts.probePending && !ts.pinned && !S.compileGate && n++ < 3) { ts.probePending = false; try { runProbe(); } catch (e) { console.warn('[TR3D] probe', e); } } }   // a step-down inside the probe gates the loop on the new programs: the next burst waits for the gate (frame() runs it), never renders through a link
function runProbe() {
  const ts = S.tierState, step = ts.ladder[ts.idx], next = ts.ladder[ts.idx + 1], Tc = TIERS[step.tier], last = next && next.tier === 'lite';
  const budget = S.phone ? (last ? 24 : step.pr >= 1.5 ? 12 : 14) : (last ? 24 : Tc.budget);
  const gl = S.renderer.getContext(), px = new Uint8Array(4), sync = () => { try { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); } catch (e) {} };
  const now = S.lastRaf || performance.now(); let n = 0, ms = 0;
  const saved = { move: S.move, lastStage: S.lastStage, pos: RIG.pos.clone(), tgt: RIG.tgt.clone(), gPos: RIG.gPos.clone(), gTgt: RIG.gTgt.clone(), placed: RIG.placed, doorOpen: S.doorOpen, dome: S.dome, keyVis: N.key.visible, keySeated: N.keySeated, fov: S.fov, focus: S.focus, deg: S.deg, late: S.lateOn, roll: S.roll, sway: S.sway, shadowDirty: S.shadowDirty, revealPending: S.revealPending };
  S.revealPending = false;                            // the burst's seated frames never start the canvas fade: the first real frame after it (the door pose) does
  ts.masked = true;
  try {
    S.move = null; startMove('seated', true); keyAngle(60); setLate(true);                           // the seated pose with the cluster lit and every light in the shader
    for (let i = 0; i < 2; i++) { tick(now, true); sync(); }                                       // warm-up: the post-pass and override shaders are first-used here, untimed, while the canvas is hidden
    if (ts.calibMs === undefined) { const c = []; for (let i = 0; i < 6; i++) { const t0 = performance.now(); try { S.renderer.setRenderTarget(null); S.renderer.clear(); } catch (e) {} sync(); c.push(performance.now() - t0); } c.sort((a, b) => a - b); ts.calibMs = c[c.length >> 1]; }
    // throughput: frames submitted back to back, one GPU sync at the end (a sync per frame measures the pipeline drain, not the frame)
    const t0 = performance.now(); for (let i = 0; i < 4; i++) tick(now, true); sync(); n = 4; ms = performance.now() - t0;
    if (ms / n - ts.calibMs <= 2 * budget) { const t1 = performance.now(); for (let i = 0; i < 6; i++) tick(now, true); sync(); n += 6; ms += performance.now() - t1; }   // early exit when the first four are already twice over
  } finally {
    ts.masked = false;
    S.move = saved.move; S.lastStage = saved.lastStage; RIG.pos.copy(saved.pos); RIG.tgt.copy(saved.tgt); RIG.gPos.copy(saved.gPos); RIG.gTgt.copy(saved.gTgt); RIG.placed = saved.placed;
    S.doorOpen = saved.doorOpen; S.dome = saved.dome; S.deg = saved.deg; S.lastOn = false; S.selfTest = -1; N.keySeated = saved.keySeated; N.key.visible = saved.keyVis; if (saved.keySeated) placeKey(1);
    S.fov = saved.fov; S.focus = saved.focus; S.roll = saved.roll; S.sway = saved.sway; setLate(saved.late); S.shadowDirty = Math.max(3, saved.shadowDirty); S.revealPending = saved.revealPending;
  }
  const mean = Math.max(0, ms / n - ts.calibMs);
  ts.probe = { tier: step.tier, pr: step.pr, pose: 'seated', meanMs: +mean.toFixed(2), frames: n, budget, calibMs: +ts.calibMs.toFixed(2) };
  (ts.probes = ts.probes || []).push(ts.probe);
  if (mean > budget && stepDown('probe ' + mean.toFixed(1) + ' ms > ' + budget + ' ms')) { if (S.tier !== 'lite') ts.probePending = true; }
}
// the steady-state watchdog on the rAF intervals, vsync-aware: the display period is the 10th percentile of the last 60 intervals (clamped
// 4..20 ms, so a loop stuck at two vsyncs still reads as slow); a frame is slow beyond ceilK periods (1.5 on ultra/high, 2.5 on base, never
// under 20 / 34 ms, so a 120 Hz display is not punished for 60 fps). Windows of 30 frames: one fails on 8 slow frames or 3 in a row over twice
// the ceiling; a failed window steps down between moves, two consecutive failed windows step down even mid-move.
function framePeriod() { const h = S.stats.hist; if (h.length < 12) return 16.7; const s = h.slice().sort((a, b) => a - b); return clamp(s[Math.floor(s.length * 0.1)], 4, 20); }
function watchCeil() { const Tc = TIERS[S.tier], per = framePeriod(); return Math.max(Tc.ceilK * per, Tc.ceilK >= 2.5 ? 34 : 20); }
function watchdog(d) {
  const ts = S.tierState; if (!ts || ts.pinned || !ts.auto || S.tier === 'lite') return;
  if (ts.deferred && (!S.move || S.move !== ts.deferredMove)) { stepDown(ts.deferred); return; }   // the join: the deferred move ended or the page chained the next stage onto it (stepDown clears the deferral either way)
  if (ts.ignore > 0) { ts.ignore--; return; }
  if (d > 1000 || document.hidden) return;
  if (performance.now() < ts.coolUntil) return;
  const ceil = watchCeil(), slow = d > ceil, vslow = d > 2 * ceil;
  ts.ceil = +ceil.toFixed(1);
  ts.win.push(slow); if (slow) ts.slowCount++;
  ts.consec = vslow ? ts.consec + 1 : 0;
  const n = ts.win.filter(Boolean).length, failed = n >= 8 || ts.consec >= 3;
  if (ts.win.length >= 30 || failed) {
    if (failed) { ts.failWins = (ts.failWins || 0) + 1; const why = n >= 8 ? 'slow ' + n + '/' + ts.win.length + ' frames over ' + ceil.toFixed(0) + ' ms' : '3 frames over ' + (2 * ceil).toFixed(0) + ' ms'; if (!S.move) requestStepDown(why); else if (ts.failWins >= 2) requestStepDown(why + ' (two windows, mid-move)'); }
    else ts.failWins = 0;
    ts.win = []; ts.consec = 0;
  }
}
function setQuality(level) {
  const ts = S.tierState; if (!S.renderer) return;
  if (level === 'lite') { if (S.tier !== 'lite') { if (ts) { ts.idx = ts.ladder.length - 1; if (ts.ladder[ts.idx].tier !== 'lite') ts.ladder.push({ tier: 'lite', pr: 1 }), ts.idx = ts.ladder.length - 1; } applyTier({ tier: 'lite', pr: 1 }, 'setQuality'); } return; }
  if (level === 'full') { const pick = pickLadder(S.opts || {}, ts ? ts.gpu : null); if (ts) { ts.ladder = pick.ladder; ts.idx = 0; ts.pinned = false; } applyTier(pick.ladder[0], 'setQuality full'); return; }
  if (TIERS[level]) { const step = { tier: level, pr: level === 'lite' ? 1 : Math.min(TIERS[level].pr, window.devicePixelRatio || 1) }; if (ts) { ts.ladder = [step]; ts.idx = 0; ts.pinned = true; } applyTier(step, 'setQuality ' + level); }
}

// ---------- the model drop-in ----------
function findNode(root, keys) {                        // whole-word match ('tach' must not hit the Sketchfab 'detach_bumper' nodes)
  let hit = null; const res = keys.map(k => new RegExp('(^|[^a-z0-9])' + k + '([^a-z0-9]|$)'));   // the keys are plain identifiers
  root.traverse(o => { if (hit) return; const n = (o.name || '').toLowerCase(); for (const r of res) if (r.test(n)) { hit = o; return; } }); return hit;
}
function disposeObject(root) {
  try { root.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) { for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); } m.dispose(); } } }); } catch (e) {}
}
// ---- geometry fit helpers (pure functions over BufferGeometry; the door is cut by SHARED INDEX connectivity, never by welding positions) ----
function triIndex(geo) {
  const idx = geo.index ? geo.index.array : null, nt = idx ? idx.length / 3 : geo.attributes.position.count / 3;
  return { nt, tri: idx ? (t, k) => idx[3 * t + k] : (t, k) => 3 * t + k };
}
function worldPositions(mesh) {
  const pa = mesh.geometry.attributes.position, n = pa.count, out = new Float32Array(n * 3), v = new THREE.Vector3();
  for (let i = 0; i < n; i++) { v.set(pa.getX(i), pa.getY(i), pa.getZ(i)).applyMatrix4(mesh.matrixWorld); out[3 * i] = v.x; out[3 * i + 1] = v.y; out[3 * i + 2] = v.z; }
  return out;
}
function islandsByIndex(geo, wp) {                     // union-find over the index buffer; each island gets its triangle list and world bounds
  const nv = geo.attributes.position.count, parent = new Int32Array(nv); for (let i = 0; i < nv; i++) parent[i] = i;
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const { nt, tri } = triIndex(geo);
  for (let t = 0; t < nt; t++) { const a = find(tri(t, 0)), b = find(tri(t, 1)), c = find(tri(t, 2)); if (a !== b) parent[a] = b; const b2 = find(b); if (b2 !== find(c)) parent[b2] = find(c); }
  const byRoot = new Map(), islands = [];
  for (let t = 0; t < nt; t++) {
    const r = find(tri(t, 0)); let isl = byRoot.get(r);
    if (!isl) { isl = { tris: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; byRoot.set(r, isl); islands.push(isl); }
    isl.tris.push(t);
    for (let k = 0; k < 3; k++) { const o = tri(t, k) * 3; for (let a = 0; a < 3; a++) { const v = wp[o + a]; if (v < isl.min[a]) isl.min[a] = v; if (v > isl.max[a]) isl.max[a] = v; } }
  }
  return islands;
}
const inBox = (isl, box) => isl.min[0] >= box.min[0] && isl.min[1] >= box.min[1] && isl.min[2] >= box.min[2] && isl.max[0] <= box.max[0] && isl.max[1] <= box.max[1] && isl.max[2] <= box.max[2];
// a compact copy of the listed triangles, baked to world space and translated so the hinge is the origin
function compactGeometry(geo, tris, mesh, hinge) {
  const { tri } = triIndex(geo), src = geo.attributes, map = new Map(), pos = [], nor = [], uv = [], idx = [];
  const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld), v = new THREE.Vector3();
  for (const t of tris) for (let k = 0; k < 3; k++) {
    const i = tri(t, k); let j = map.get(i);
    if (j === undefined) {
      j = pos.length / 3; map.set(i, j);
      v.set(src.position.getX(i), src.position.getY(i), src.position.getZ(i)).applyMatrix4(mesh.matrixWorld).sub(hinge); pos.push(v.x, v.y, v.z);
      if (src.normal) { v.set(src.normal.getX(i), src.normal.getY(i), src.normal.getZ(i)).applyMatrix3(nm).normalize(); nor.push(v.x, v.y, v.z); }
      if (src.uv) uv.push(src.uv.getX(i), src.uv.getY(i));
    }
    idx.push(j);
  }
  const g = new THREE.BufferGeometry(); g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (nor.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); else g.computeVertexNormals();
  if (uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeBoundingSphere(); return g;
}
function removeTriangles(geo, drop) {                  // rebuild the index without the dropped triangles (same vertex buffers)
  const { nt, tri } = triIndex(geo), keep = [];
  for (let t = 0; t < nt; t++) if (!drop.has(t)) keep.push(tri(t, 0), tri(t, 1), tri(t, 2));
  geo.setIndex(keep); geo.clearGroups(); geo.computeBoundingSphere(); geo.computeBoundingBox();
}
// cut the driver door out of the body meshes and hang it on a Group at the hinge (driven by S.doorOpen like the procedural door)
function splitDoor(root, fit) {
  const box = { min: mw(fit.doorBox.min), max: mw(fit.doorBox.max) }, hinge = V3(mw(fit.hinge)), door = new THREE.Group(); door.name = 'gltf-door';
  door.position.copy(hinge);
  let total = 0, nIsl = 0; const pieces = [];
  root.traverse(o => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const wp = worldPositions(o), islands = islandsByIndex(o.geometry, wp), picked = islands.filter(i => inBox(i, box));
    if (!picked.length) return;
    for (const i of picked) if (i.max[2] - i.min[2] > fit.doorMaxSpanZ) throw new Error('door island spans ' + (i.max[2] - i.min[2]).toFixed(2) + ' m in z');
    const tris = [].concat(...picked.map(i => i.tris)); total += tris.length; nIsl += picked.length;
    pieces.push({ mesh: o, tris, islands: picked.map(i => ({ tris: i.tris.length, min: i.min.map(v => +v.toFixed(3)), max: i.max.map(v => +v.toFixed(3)) })) });
  });
  if (total < fit.doorTriRange[0] || total > fit.doorTriRange[1]) throw new Error('door cut found ' + total + ' triangles (expected ' + fit.doorTriRange.join('..') + ')');
  const report = [];
  for (const p of pieces) {
    const g = compactGeometry(p.mesh.geometry, p.tris, p.mesh, hinge), m = new THREE.Mesh(g, p.mesh.material);
    m.name = 'door:' + p.mesh.name; m.renderOrder = p.mesh.renderOrder; m.layers.mask = p.mesh.layers.mask; m.castShadow = p.mesh.castShadow; m.receiveShadow = p.mesh.receiveShadow; door.add(m);
    removeTriangles(p.mesh.geometry, new Set(p.tris));
    report.push({ node: p.mesh.name, material: p.mesh.material && p.mesh.material.name, tris: p.tris.length, islands: p.islands });
  }
  return { door, tris: total, islands: nIsl, pieces: report };
}
// give one mesh's islands inside a box a second material (index groups, no new geometry): used for the pale sunroof shade
function paintIslands(mesh, box, mat) {
  const geo = mesh.geometry, islands = islandsByIndex(geo, worldPositions(mesh)), picked = islands.filter(i => inBox(i, box) && (!box.minSpanZ || i.max[2] - i.min[2] >= box.minSpanZ));
  if (!picked.length) return 0;
  const drop = new Set(); for (const i of picked) for (const t of i.tris) drop.add(t);
  const { nt, tri } = triIndex(geo), keep = [], moved = [];
  for (let t = 0; t < nt; t++) { const dst = drop.has(t) ? moved : keep; dst.push(tri(t, 0), tri(t, 1), tri(t, 2)); }
  // the mesh may already carry a material array from an earlier paint: the painted triangles of earlier groups stay in place, the new ones go last
  const mats = Array.isArray(mesh.material) ? mesh.material.slice() : [mesh.material], groups = geo.groups.length ? geo.groups.map(g => ({ start: g.start, count: g.count, mi: g.materialIndex })) : [{ start: 0, count: nt * 3, mi: 0 }];
  const out = [], newGroups = []; let cursor = 0;
  for (const g of groups) {                            // rebuild each existing group without the picked triangles, keeping its material index
    const part = []; for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) if (!drop.has(t)) part.push(tri(t, 0), tri(t, 1), tri(t, 2));
    if (part.length) { newGroups.push({ start: cursor, count: part.length, mi: g.mi }); cursor += part.length; out.push(...part); }
  }
  mats.push(mat); newGroups.push({ start: cursor, count: moved.length, mi: mats.length - 1 }); out.push(...moved);
  geo.setIndex(out); geo.clearGroups(); for (const g of newGroups) geo.addGroup(g.start, g.count, g.mi); geo.computeBoundingSphere();
  mesh.material = mats;
  return moved.length / 3;
}
function toStandard(m) {
  const s = new THREE.MeshStandardMaterial({ name: m.name, color: m.color, map: m.map || null, metalness: m.metalness, roughness: m.roughness, metalnessMap: m.metalnessMap || null, roughnessMap: m.roughnessMap || null,
    normalMap: m.normalMap || null, normalScale: m.normalScale, aoMap: m.aoMap || null, aoMapIntensity: m.aoMapIntensity, side: m.side, transparent: m.transparent, opacity: m.opacity, alphaTest: m.alphaTest, envMapIntensity: 0.3 });
  return s;
}
// the one atlas material of the interior: the file marks its pale trims (spokes, bezels, pulls, the shifter surround) as metal in the
// metallicRoughness blue channel and ships roughness 1.0 everywhere, so the shader splits per pixel: satin aluminium with a brushed
// detail normal on the metal mask, navy-leaning charcoal leather with a fine grain and a velvet sheen everywhere else
// Regions (MODEL_FIT.regions, evaluated per pixel from the world position): the dash top and the A-pillars take a darker cooler tint
// (0.50, 0.53, 0.64) with one specular band (roughness 0.5 on the dash, matte 0.9 on the pillars and visors, half the grain); the seat
// cushions take stitch lines, a darker albedo and a stronger velvet sheen. The door pieces share this material (their world position
// moves with the door) and stay outside every box by construction.
function atlasMaterial(m) {
  const a = new THREE.MeshPhysicalMaterial({ name: m.name, map: m.map || null, metalnessMap: m.metalnessMap || null, metalness: 1, roughness: 1, normalMap: ABL('normal') ? null : T.leatherFine, normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 0.6, sheen: 0.35, sheenRoughness: 0.55, sheenColor: new THREE.Color(0x3a4c7c), side: m.side, specularIntensity: 1 });
  const R = MODEL_FIT.regions, v3 = p => new THREE.Vector3(p[0], p[1], p[2]), mp = modelPos();
  a.onBeforeCompile = sh => {
    sh.uniforms.trTintSoft = { value: new THREE.Vector3(0.72, 0.75, 0.86) }; sh.uniforms.trTintMetal = { value: new THREE.Vector3(0.40, 0.42, 0.46) }; sh.uniforms.trTintDash = { value: new THREE.Vector3(0.36, 0.39, 0.48) }; sh.uniforms.trTintVisor = { value: new THREE.Vector3(0.40, 0.42, 0.50) };   // the dash top sits under the key panel's own band: its albedo goes to charcoal so the band is a band, not a plate
    sh.uniforms.trBrushed = { value: T.brushedFine }; sh.uniforms.trQuilt = { value: T.quilt }; sh.uniforms.trQuiltN = { value: T.quiltN }; sh.uniforms.trModelPos = { value: new THREE.Vector3(mp[0], mp[1], mp[2]) };
    sh.uniforms.trDashLo = { value: v3(R.dashTop.min) }; sh.uniforms.trDashHi = { value: v3(R.dashTop.max) }; sh.uniforms.trPilLo = { value: v3(R.pillar.min) }; sh.uniforms.trPilHi = { value: v3(R.pillar.max) };
    sh.uniforms.trVisLo = { value: v3(R.visor.min) }; sh.uniforms.trVisHi = { value: v3(R.visor.max) }; sh.uniforms.trSeatLo = { value: v3(R.seatCushion.min) }; sh.uniforms.trSeatHi = { value: v3(R.seatCushion.max) }; sh.uniforms.trBackLo = { value: v3(R.seatBack.min) }; sh.uniforms.trBackHi = { value: v3(R.seatBack.max) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 trWp;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n trWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 trTintSoft, trTintMetal, trTintDash, trTintVisor, trModelPos, trDashLo, trDashHi, trPilLo, trPilHi, trVisLo, trVisHi, trSeatLo, trSeatHi, trBackLo, trBackHi; uniform sampler2D trBrushed, trQuilt, trQuiltN; varying vec3 trWp;
float trMetal = 0.0, trDash = 0.0, trPil = 0.0, trVis = 0.0, trSeat = 0.0, trBackK = 0.0, trDashK = 0.0; vec2 trQuv = vec2(0.0);
float trIn(vec3 p, vec3 lo, vec3 hi) { vec3 s = smoothstep(lo - 0.004, lo + 0.004, p) * (1.0 - smoothstep(hi - 0.004, hi + 0.004, p)); return s.x * s.y * s.z; }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_METALNESSMAP
 trMetal = step(0.5, texture2D(metalnessMap, vMetalnessMapUv).b);
#endif
 float trCrease = 1.0;
 { vec3 mp = trWp - trModelPos; vec3 ap = vec3(abs(mp.x), mp.y, mp.z);
   float trCush = trIn(ap, trSeatLo, trSeatHi); trBackK = trIn(ap, trBackLo, trBackHi) * (1.0 - trCush); trSeat = max(trCush, trBackK); trDash = trIn(ap, trDashLo, trDashHi); trPil = trIn(ap, trPilLo, trPilHi); trVis = trIn(ap, trVisLo, trVisHi);
   trDash = max(trDash, trPil) * (1.0 - trVis); trSeat *= (1.0 - trDash) * (1.0 - trVis);
   trQuv = mat2(0.7071, 0.7071, -0.7071, 0.7071) * (mix(mp.xz, mp.xy, trBackK) * 48.0);   // diamond quilting, one tile per 2.1 cm, laid out in world space (the atlas layout of the seat islands does not matter)
   float trEdge = mix(min(ap.x - trSeatLo.x, trSeatHi.x - ap.x), min(ap.x - trBackLo.x, trBackHi.x - ap.x), trBackK);
   trCrease = mix(1.0, 0.6 + 0.4 * smoothstep(0.0, 0.04, trEdge), trSeat);                // the cushion darkens into the bolster crease over 4 cm
   trDashK = smoothstep(-0.05, 0.3, mp.x); }                                                // the dash top darkens from the centre pod toward the passenger side (x0.6 past 0.3 m): the band tails off instead of ending in a pale shelf over the glovebox
 vec3 trTint = mix(trTintSoft, trTintDash * mix(1.0, 0.6, trDashK), trDash); trTint = mix(trTint, trTintVisor, trVis); trTint *= mix(1.0, 0.8 * texture2D(trQuilt, trQuv).r * trCrease, trSeat);
#ifdef TR_REGION_DEBUG
 trTint = mix(trTint, vec3(2.0, 0.2, 0.2), trSeat); trTint = mix(trTint, vec3(0.2, 2.0, 0.2), trDash * (1.0 - trPil)); trTint = mix(trTint, vec3(0.2, 0.2, 2.0), trPil); trTint = mix(trTint, vec3(2.0, 2.0, 0.2), trVis);
#endif
 diffuseColor.rgb *= mix(trTint, trTintMetal, trMetal);`)
      .replace('#include <roughnessmap_fragment>', 'float trRough = mix(0.62, 0.50, trDash * (1.0 - trPil)); trRough = mix(trRough, 0.92, max(trPil, trVis)); float roughnessFactor = mix(trRough, 0.72, trMetal);')   // the spokes and bezels: satin aluminium, darker and rougher than the file (the upper spoke's top under the key panel is the brightest neutral surface of the lit cluster: 0.72 / tint 0.40 keeps its p95 under 200 on every tier)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
 { float trSpec = mix(1.0, 0.3, max(trDash, trVis)) * mix(1.0, 0.55, trDash * trDashK); material.specularColor *= trSpec; material.specularF90 *= trSpec;   // the dash top is seen at grazing from the seat: at full Fresnel the key spot made the whole pad one specular plate; at 0.3 it is a band over charcoal
#ifdef USE_SHEEN
   material.sheenColor = mix(material.sheenColor * (1.0 - trMetal) * (1.0 - max(trDash, trVis)), vec3(0.21, 0.24, 0.33) * (1.0 - trMetal), trSeat);   // no velvet lobe on the metal, the dash top or the visors (seen at grazing it was the lavender plate); the seats take a stronger, cooler one (sheen 0.6 of (0.35, 0.40, 0.55))
   material.sheenRoughness = mix(material.sheenRoughness, 0.5, trSeat);
#endif
 }`)   // after the chunk, which three expands when the program is built: an edit inside lights_physical_fragment's own text never lands
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.9 * trMetal;')
      .replace('#include <normal_fragment_maps>', `#ifdef USE_NORMALMAP_TANGENTSPACE
 vec3 mapN = texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0; vec3 mapB = texture2D(trBrushed, vNormalMapUv * 26.0).xyz * 2.0 - 1.0; mapB.xy *= 0.3; mapN = mix(mapN, mapB, trMetal);
 mapN.xy *= normalScale * mix(1.0, 0.5, max(trPil, trVis)) * (1.0 - 0.7 * trSeat); normal = normalize(tbn * mapN);
 if (trSeat > 0.001) {   // the quilt: a world-space bump (the cushion tilts about x and z, the back about x and y), rotated back out of the diamond frame, blended in view space
   vec3 qn = texture2D(trQuiltN, trQuv).xyz * 2.0 - 1.0; qn.xy = mat2(0.7071, -0.7071, 0.7071, 0.7071) * qn.xy * 1.5;
   vec3 qw = mix(vec3(qn.x, 0.0, qn.y), vec3(qn.x, qn.y, 0.0), trBackK); vec3 qv = (viewMatrix * vec4(qw, 0.0)).xyz;
   normal = normalize(mix(normal, normalize(normal + qv), trSeat * (1.0 - trMetal)));
 }
#endif`)
      .replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n radiance *= mix(1.0, 0.4, max(trDash, trVis)) * mix(1.0, 0.6, trDash * trDashK); iblIrradiance *= mix(1.0, 0.7, max(trDash, trVis)) * mix(1.0, 0.8, trDash * trDashK);');   // and the key panel's IBL highlight on it eases to one band
  };
  if (ABL('regiondebug')) a.defines = { TR_REGION_DEBUG: 1 };   // harness: ?ablate=regiondebug paints the regions (seat red, dash green, pillar blue, visor yellow)
  a.customProgramCacheKey = () => ABL('regiondebug') ? 'tr-atlas-dbg' : 'tr-atlas-3';
  a.userData.sheen = 0.35; if (!TIERS[S.tier].sheen) a.sheen = 0; (M.sheenMats = M.sheenMats || []).push(a);
  return a;
}
// the sunroof shade islands double as the car's roof from the door pose (the interior file has no roof skin above them): body lacquer on the
// face that looks up (roughness 0.06, clearcoat, no flake, so the two gold strips draw as two crisp lines) and matte charcoal on the face the
// cabin sees. gl_FrontFacing picks the face; TR_ROOF_OUT says which one is the outside (the island's normals point up, out of the car)
function roofMaterial() {
  const m = M.paint.clone(); m.name = 'roof-shade'; m.side = THREE.DoubleSide; m.roughness = 0.06; m.clearcoat = TIERS[S.tier].clearcoat && !ABL('clearcoat') ? 1 : 0; m.clearcoatRoughness = 0.05; m.clearcoatNormalMap = null; m.envMapIntensity = 0.9;
  m.defines = { TR_ROOF_OUT: (S.opts && S.opts.roofOut === 'back') ? 'false' : 'true' };   // the island's front face is the outside (measured: the gloss face reflects the strips from the door pose); opts.roofOut: harness only
  m.onBeforeCompile = sh => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
 if (gl_FrontFacing != TR_ROOF_OUT) { material.roughness = 1.0; material.specularColor *= 0.3; material.specularF90 *= 0.3; material.diffuseColor *= 2.0;
#ifdef USE_CLEARCOAT
   material.clearcoat = 0.0;
#endif
 }`);
  };
  m.customProgramCacheKey = () => 'tr-roof-' + m.defines.TR_ROOF_OUT;
  (M.paintMats = M.paintMats || []).push(m);   // its clearcoat follows the tier like the body paint
  return m;
}
// crease-angle normals for an atlas mesh, area weighted, with the vertex hash at 0.1 mm of car. The file is authored at 1/100 scale, so
// three's toCreasedNormals (which hashes the raw units at 1 cm) put a metre of car in one hash cell and averaged every similar-facing face in
// it: soft forms went flat and their neighbours read as hard facets. Faces whose centroid lies inside a smooth box (world) blend across any angle.
function creasedNormals(geo, creaseAngle, mesh, smoothBoxes) {
  const g = geo.index ? geo.toNonIndexed() : geo, pa = g.attributes.position, n = pa.count, nt = n / 3, creaseDot = Math.cos(creaseAngle);
  const fn = new Float32Array(nt * 3), fu = new Float32Array(nt * 3), smoothT = new Uint8Array(nt), map = new Map();
  const key = i => Math.round(pa.getX(i) * 1e6) + ',' + Math.round(pa.getY(i) * 1e6) + ',' + Math.round(pa.getZ(i) * 1e6);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cb = new THREE.Vector3(), ab = new THREE.Vector3(), w = new THREE.Vector3();
  const boxes = (smoothBoxes || []).map(bx => new THREE.Box3(V3(bx.min), V3(bx.max)));
  for (let t = 0; t < nt; t++) {
    a.fromBufferAttribute(pa, 3 * t); b.fromBufferAttribute(pa, 3 * t + 1); c.fromBufferAttribute(pa, 3 * t + 2);
    cb.subVectors(c, b); ab.subVectors(a, b); cb.cross(ab);                                  // twice the area, along the face normal
    fn[3 * t] = cb.x; fn[3 * t + 1] = cb.y; fn[3 * t + 2] = cb.z; cb.normalize(); fu[3 * t] = cb.x; fu[3 * t + 1] = cb.y; fu[3 * t + 2] = cb.z;
    if (boxes.length) { w.copy(a).add(b).add(c).multiplyScalar(1 / 3).applyMatrix4(mesh.matrixWorld); for (const bx of boxes) if (bx.containsPoint(w)) { smoothT[t] = 1; break; } }
    for (let k = 0; k < 3; k++) { const h = key(3 * t + k); let l = map.get(h); if (!l) { l = []; map.set(h, l); } l.push(t); }
  }
  const out = new Float32Array(n * 3), acc = new THREE.Vector3();
  for (let t = 0; t < nt; t++) {
    const ux = fu[3 * t], uy = fu[3 * t + 1], uz = fu[3 * t + 2], dot = smoothT[t] ? -1.01 : creaseDot;
    for (let k = 0; k < 3; k++) {
      const i = 3 * t + k; acc.set(0, 0, 0);
      for (const u of map.get(key(i))) { if (u === t || ux * fu[3 * u] + uy * fu[3 * u + 1] + uz * fu[3 * u + 2] > dot) { acc.x += fn[3 * u]; acc.y += fn[3 * u + 1]; acc.z += fn[3 * u + 2]; } }
      if (acc.lengthSq() < 1e-30) acc.set(ux, uy, uz); acc.normalize(); out[3 * i] = acc.x; out[3 * i + 1] = acc.y; out[3 * i + 2] = acc.z;
    }
  }
  g.setAttribute('normal', new THREE.BufferAttribute(out, 3)); return g;
}
function isAtlasMesh(o) { const m0 = Array.isArray(o.material) ? o.material[0] : o.material; return !!(m0 && (m0.name || '').toLowerCase().startsWith('car_porsche')); }
// materials by NAME: fresh physical glass (no per-frame transmission pass), navy-black clearcoat paint with a flake, the atlas split above,
// the carbon as a fine twill under clearcoat, the rest plain standard materials
function fitMaterials(root, keepPaint) {
  const done = new Map(), used = [], aniso = S.aniso || 4;
  root.traverse(o => {
    if (!o.isMesh || !o.material) return;
    const m = o.material, n = (m.name || '').toLowerCase(); let r = done.get(m);
    if (!r) {
      if (n === 'glass' || n.includes('glass')) { r = M.glass.clone(); r.name = m.name; m.dispose(); }
      else if (n === 'carpaint') {
        if (MODEL_PAINT !== null && !keepPaint) m.color.setHex(MODEL_PAINT);
        m.metalness = 0.3; m.roughness = 0.16; if ('clearcoat' in m) { m.clearcoat = 1.0; m.clearcoatRoughness = 0.08; m.clearcoatNormalMap = T.flake; m.clearcoatNormalScale = new THREE.Vector2(0.08, 0.08); }
        if ('specularIntensity' in m) m.specularIntensity = 1; m.envMapIntensity = 0.9; if (!(TIERS[S.tier].clearcoat) && 'clearcoat' in m) m.clearcoat = 0; m.needsUpdate = true; r = m; (M.paintMats = M.paintMats || []).push(m);
      } else if (n === 'carbon') {
        if ('clearcoat' in m) { m.clearcoat = 1; m.clearcoatRoughness = 0.08; } m.roughness = 0.45; m.metalness = 0.2; if ('specularIntensity' in m) m.specularIntensity = 1; m.envMapIntensity = 0.8;
        for (const t of [m.map, m.normalMap]) if (t) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.multiplyScalar(3); t.needsUpdate = true; }
        m.needsUpdate = true; r = m;
      } else if (n.startsWith('car_porsche')) { r = atlasMaterial(m); m.dispose(); }
      else {
        r = toStandard(m);
        if (n === 'under') { r.metalness = 0; r.metalnessMap = null; r.roughness = 0.95; r.roughnessMap = null; r.color.multiplyScalar(0.35); r.envMapIntensity = 0.15; }   // the underside is glossy metal in the file and shows through gaps in the LOD2 cabin
        else if (n === 'phong8' || n === 'calipers') { r.color.setHex(0x0b0c0f); r.metalness = 0.7; r.roughness = 0.4; r.metalnessMap = null; r.roughnessMap = null; r.envMapIntensity = 0.6; }   // black wheels and calipers, like the page car
        else if (n === 'tyre') r.envMapIntensity = 0.15;
        else if (n.startsWith('phong')) { r.roughness = 0.35; r.metalness = 0.5; r.envMapIntensity = 0.5; }
        m.dispose();
      }
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) if (r[k] && r[k].isTexture) r[k].anisotropy = aniso;
      done.set(m, r); used.push(r.name || n);
    }
    o.material = r;
    if (n === 'glass' || n.includes('glass')) { o.renderOrder = 2; noPre(o); o.castShadow = false; o.receiveShadow = false; if (ABL('glass')) o.visible = false; }
    else { o.castShadow = true; o.receiveShadow = true; }
  });
  return used;
}
function texturesReady(root) {                        // true, or the list of material maps that still have no decoded image
  const missing = []; if (!root) return true;
  root.traverse(o => { if (!o.isMesh || !o.material) return; for (const m of (Array.isArray(o.material) ? o.material : [o.material])) for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) { const t = m[k]; if (t && !(t.image && (t.image.width || t.image.naturalWidth || t.image.videoWidth))) missing.push((m.name || '?') + '.' + k + ':' + (t.image ? t.image.constructor.name : 'noimage')); } });
  return missing.length ? [...new Set(missing)] : true;
}
function meshNear(root, point, radius, maxTris) {      // the smallest mesh whose world bounds centre lies within radius of point
  let hit = null, best = Infinity; const p = V3(point), b = new THREE.Box3(), c = new THREE.Vector3();
  root.traverse(o => { if (!o.isMesh || !o.geometry) return; const n = triIndex(o.geometry).nt; if (n > maxTris) return; b.setFromObject(o, true); b.getCenter(c); const d = c.distanceTo(p); if (d < radius && d < best) { best = d; hit = o; } });
  return hit;
}
// move our props (slot + key, tach + needle, the two displays, the screen, the hub disc, the dome) onto the real dash
function propsGroup() { if (!N.propsGroup) { const grp = new THREE.Group(); grp.name = 'model-props'; S.scene.add(grp); N.propsGroup = grp; } return N.propsGroup; }
function placeProps(fit) {
  const grp = propsGroup(); N.propsSaved = [];
  N.cabin.updateMatrixWorld(true);
  const Z = new THREE.Vector3(0, 0, 1);
  const move = (obj, p, normal, scale) => {
    N.propsSaved.push({ obj, parent: obj.parent, pos: obj.position.clone(), quat: obj.quaternion.clone(), scale: obj.scale.clone() });
    obj.parent.remove(obj); grp.add(obj);
    obj.position.fromArray(mw(p)); obj.scale.setScalar(scale || 1);
    if (normal) obj.quaternion.setFromUnitVectors(Z, V3(normal).normalize()); else obj.rotation.set(0, 0, 0);
  };
  const eye = V3(mw(POSE_MODEL.seated.pos));
  move(N.slot, fit.slot.pos); N.slot.lookAt(eye); N.keyPath = null;
  move(N.tach, fit.tach.pos, fit.tach.normal, fit.tach.scale); N.tachBack.visible = false;
  for (const [pod, d] of [[N.podL, fit.dialL], [N.podR, fit.dialR]]) {       // a dark round face covers the baked dial and its needle, our display sits on it
    move(pod, d.pos, [0, 0, 1], d.scale); pod.userData.bezel.visible = false;
    const face = new THREE.Mesh(new THREE.CircleGeometry(d.r / d.scale, 48), M.plastic); face.position.z = 0; pod.add(face); pod.userData.face = face;
  }
  move(N.screenPod, fit.screen.pos, fit.screen.normal, fit.screen.scale); N.screenBezel.visible = false;
  for (const t of [T.screen.map, T.screen.emissive]) { t.offset.x = -0.04; t.repeat.x = 0.96; }   // the real bezel covers the texture's left margin: the menu labels start 4 percent in
  for (const d of [fit.dialOL, fit.dialOR]) {                                // the two outer baked dials get a lit gauge face each (driven with the cluster at the catch)
    if (!d) continue; const g = new THREE.Mesh(new THREE.CircleGeometry(d.r, 48), M.gauge); g.position.fromArray(mw(d.pos)); g.position.z += 0.002; g.name = 'gauge'; g.castShadow = false; g.receiveShadow = true; grp.add(g); (N.gauges = N.gauges || []).push(g);
  }
  const hn = V3(fit.hub.normal).normalize(), hp = V3(fit.hub.pos).addScaledVector(hn, fit.hub.standoff);
  move(N.hub, hp.toArray(), fit.hub.normal, fit.hub.scale);
  move(N.domeMesh, fit.dome.pos);
  if (fit.liners) {                                                          // dark boxes closing the open dash ends of the LOD2 cabin
    M.modelLiner = M.modelLiner || new THREE.MeshStandardMaterial({ name: 'liner', color: 0x08090c, roughness: 1, metalness: 0, envMapIntensity: 0 });
    for (const b of fit.liners) { const lo = mw(b.min), hi = mw(b.max), m = new THREE.Mesh(new THREE.BoxGeometry(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), M.modelLiner); m.position.set((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2); m.name = 'liner'; grp.add(m); }
  }
  grp.traverse(o => { if (o.isMesh && o.layers.mask === 1) { o.castShadow = true; o.receiveShadow = true; } });
  grp.updateMatrixWorld(true);
}
function restoreProps() {
  if (!N.propsSaved) return;
  for (const s of N.propsSaved) { if (s.obj.parent) s.obj.parent.remove(s.obj); s.parent.add(s.obj); s.obj.position.copy(s.pos); s.obj.quaternion.copy(s.quat); s.obj.scale.copy(s.scale); }
  if (N.tachBack) N.tachBack.visible = true; if (N.screenBezel) N.screenBezel.visible = true;
  if (T.screen) for (const t of [T.screen.map, T.screen.emissive]) { t.offset.x = 0; t.repeat.x = 1; }
  for (const pod of [N.podL, N.podR]) if (pod) { pod.userData.bezel.visible = true; if (pod.userData.face) { pod.remove(pod.userData.face); pod.userData.face.geometry.dispose(); pod.userData.face = null; } }
  if (N.propsGroup) { S.scene.remove(N.propsGroup); N.propsGroup.traverse(o => { if (o.isMesh && o.geometry && (o.name === 'liner' || o.name === 'gauge' || o.name === 'rim-torus')) o.geometry.dispose(); }); N.propsGroup = null; }   // the liner plates, gauge faces and rim torus are ours to free
  N.propsSaved = null; N.gauges = null; N.rimTorus = null;
}
// the wheel mesh (the atlas mesh of 250..800 triangles whose bounds centre on the rim centre): triangles entirely beyond cutRadial from
// the hub axis are the polygon rim and are dropped; a stitched-leather torus at the measured radius and cross-section replaces them
function swapRim(root, rim) {
  const C = V3(mw(rim.center)), A = V3(rim.normal).normalize(); let wheel = null, best = Infinity; const b = new THREE.Box3(), c = new THREE.Vector3();
  root.traverse(o => { if (!o.isMesh || !o.geometry || !isAtlasMesh(o)) return; const nt = triIndex(o.geometry).nt; if (nt < rim.minTris || nt > rim.maxTris) return; b.setFromObject(o, true); b.getCenter(c); const d = c.distanceTo(C); if (d < 0.08 && d < best) { best = d; wheel = o; } });
  if (!wheel) throw new Error('no wheel mesh near the rim centre');
  const geo = wheel.geometry, wp = worldPositions(wheel), { nt, tri } = triIndex(geo), drop = new Set(), v = new THREE.Vector3();
  const radial = i => { v.set(wp[3 * i], wp[3 * i + 1], wp[3 * i + 2]).sub(C); return v.addScaledVector(A, -v.dot(A)).length(); };
  for (let t = 0; t < nt; t++) if (radial(tri(t, 0)) > rim.cutRadial && radial(tri(t, 1)) > rim.cutRadial && radial(tri(t, 2)) > rim.cutRadial) drop.add(t);
  if (drop.size < 40) throw new Error('rim cut found only ' + drop.size + ' triangles');
  removeTriangles(geo, drop);
  const torus = new THREE.Mesh(new THREE.TorusGeometry(rim.R, rim.tube, 24, 128), M.rimModel); torus.name = 'rim-torus';
  torus.position.copy(C); torus.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), A); torus.scale.set(1, 1, rim.axialScale);
  torus.castShadow = true; torus.receiveShadow = true; propsGroup().add(torus); N.rimTorus = torus;
  try {   // BEAT gold accent: a thin additive gold ring on the rim's outer edge (casino gold around the wheel), a child so it follows, hides and fades with the rim
    const gold = new THREE.Mesh(new THREE.TorusGeometry(rim.R + rim.tube * 0.62, 0.0032, 8, 160), new THREE.MeshBasicMaterial({ name: 'rim-gold', color: 0xe8c47a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    gold.name = 'rim-gold'; gold.renderOrder = 4; torus.add(gold); N.rimGold = gold;
    const comet = new THREE.Mesh(new THREE.TorusGeometry(rim.R + rim.tube * 0.62, 0.0065, 8, 64, 1.1), new THREE.MeshBasicMaterial({ name: 'rim-comet', color: 0xfff1c8, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    comet.name = 'rim-comet'; comet.renderOrder = 4; torus.add(comet); N.rimComet = comet;   // BEAT the moving gold light around the wheel (goldApply)
  } catch (e) { console.warn('[TR3D] rim gold', e); }   // into the props group: hidden with the root until show(), fades in with the car, freed by restoreProps
  return { wheel: wheel.name, cut: drop.size, kept: nt - drop.size, R: rim.R, tube: rim.tube };
}
// the whole fit for an unnamed model: validate, materials, door, props, lights. Throws to keep the procedural cabin.
function fitModel(root, fit) {
  const opt = S.opts || {}, info = { transform: { scale: root.scale.x, yaw: +(root.rotation.y / DEG).toFixed(1), pos: modelPos().slice() } };
  const bb = new THREE.Box3().setFromObject(root, true), sz = bb.getSize(new THREE.Vector3());
  info.bounds = { min: bb.min.toArray().map(v => +v.toFixed(3)), max: bb.max.toArray().map(v => +v.toFixed(3)) };
  for (let a = 0; a < 3; a++) { const want = fit.size[a], got = sz.getComponent(a); if (Math.abs(got - want) > fit.sizeTol * want) throw new Error('model size ' + sz.toArray().map(v => v.toFixed(2)).join('x') + ' is not a car'); }
  if (Math.abs(bb.min.y - GROUND) > 0.1) throw new Error('model ground at y ' + bb.min.y.toFixed(2) + ' (stage ' + GROUND + ')');
  info.materials = fitMaterials(root, opt.paint === 'keep');
  let tris = 0; root.traverse(o => { if (o.isMesh && o.geometry) tris += triIndex(o.geometry).nt; }); info.modelTris = tris;
  const d = splitDoor(root, fit);
  S.scene.add(d.door); N.doorModel = d.door; N.door = d.door; d.door.add(doorContactBlob(0));   // the hinge group sits at ground level: the shadow blob swings under the door
  d.door.userData.welcome = beatsBuild(0, false); d.door.add(d.door.userData.welcome);   // BEAT welcome lights (handle glow) on the cut door
  info.doorTris = d.tris; info.doorIslands = d.islands; info.doorPieces = d.pieces;
  // the sunroof shade and roof header: matte charcoal, and a dark tint on the sunroof glass, so the roof reads as one dark panel from the door pose
  const rb = { min: mw(fit.roofBox.min), max: mw(fit.roofBox.max) }; let roofTris = 0;
  M.modelRoof = roofMaterial();
  M.modelRoofGlass = new THREE.MeshStandardMaterial({ name: 'roof-glass', color: 0x0a0c10, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.9, depthWrite: false, envMapIntensity: 0.8, side: THREE.DoubleSide });   // the sunroof glass: as glossy as the lacquer under it
  root.traverse(o => { if (!o.isMesh || !o.material || Array.isArray(o.material)) return; const n = (o.material.name || '').toLowerCase(); if (n.startsWith('car_porsche')) roofTris += paintIslands(o, rb, M.modelRoof); else if (n === 'glass') roofTris += paintIslands(o, rb, M.modelRoofGlass); });
  info.roofTris = roofTris;
  // the door aperture surround: body paint instead of pale primer (see MODEL_FIT.apertureBoxes)
  // the sill and jamb: painted like the body but satin (roughness 0.42, a soft clearcoat, no flake) so the gold strips never sparkle into fireflies there
  M.modelBiw = M.paint.clone(); M.modelBiw.name = 'aperture-paint'; M.modelBiw.side = THREE.DoubleSide; M.modelBiw.roughness = 0.42; M.modelBiw.clearcoatRoughness = 0.3; M.modelBiw.clearcoatNormalScale = new THREE.Vector2(0.03, 0.03); M.modelBiw.envMapIntensity = 0.6; if (MODEL_PAINT === null || opt.paint === 'keep') M.modelBiw.color.setHex(0x1a1c22);
  let apTris = 0;
  for (const ab of fit.apertureBoxes) { const bx = { min: mw(ab.min), max: mw(ab.max), minSpanZ: ab.minSpanZ }; root.traverse(o => { if (!o.isMesh || !o.material) return; if (isAtlasMesh(o)) apTris += paintIslands(o, bx, M.modelBiw); }); }
  info.apertureTris = apTris;
  // the headliner island: matte fabric instead of the speckled atlas (see MODEL_FIT.headlinerBox)
  if (fit.headlinerBox) { const hb = { min: mw(fit.headlinerBox.min), max: mw(fit.headlinerBox.max), minSpanZ: fit.headlinerBox.minSpanZ }; let ht = 0; root.traverse(o => { if (o.isMesh && isAtlasMesh(o)) ht += paintIslands(o, hb, M.headlinerModel); }); info.headlinerTris = ht; }
  // the steering-wheel rim: the polygon rim comes off the wheel mesh and a smooth torus goes on (see MODEL_FIT.rim)
  if (fit.rim) { try { info.rim = swapRim(root, fit.rim); } catch (e) { info.rim = { error: String(e && e.message || e) }; console.warn('[TR3D] rim', e); } }
  // crease-angle normals on the atlas meshes (the file ships split normals on the soft forms, which shade as flat facets); after every
  // island paint, since those depend on index connectivity; the door pieces too
  const t0 = performance.now(); let creased = 0; const sb = (fit.smoothBoxes || []).map(b => ({ min: mw(b.min), max: mw(b.max) })); d.door.updateMatrixWorld(true);
  const crease = o => { if (!o.isMesh || !isAtlasMesh(o)) return; try { const g = creasedNormals(o.geometry, fit.creaseDeg * DEG, o, sb); if (g !== o.geometry) o.geometry.dispose(); o.geometry = g; creased++; } catch (e) { console.warn('[TR3D] crease', o.name, e); } };
  root.traverse(crease); d.door.traverse(crease);
  info.creased = { meshes: creased, ms: Math.round(performance.now() - t0) };
  const badge = meshNear(root, mw(fit.hub.pos), fit.hub.badgeRadius, fit.hub.badgeMaxTris); if (badge) badge.visible = false; info.hubBadge = badge ? badge.name : null;
  placeProps(fit);
  info.stuck = { slot: mw(fit.slot.pos), tach: mw(fit.tach.pos), dialL: mw(fit.dialL.pos), dialR: mw(fit.dialR.pos), screen: mw(fit.screen.pos), hub: mw(fit.hub.pos), dome: mw(fit.dome.pos) };
  return info;
}
function loadModel(url) {
  const gen = ++S.loadGen;
  const settle = () => { const f = S.onModelSettled; S.onModelSettled = null; if (f) f(); };
  try {
    S.modelState = 'loading'; S.modelUrl = url;                    // stats().modelState: none | loading | gltf | failed (the harness polls it)
    new GLTFLoader().load(url, gltf => {
      const root = gltf.scene, mp = S.modelPhases = { t0: performance.now() }, mark = k => { mp[k] = +(performance.now() - mp.t0).toFixed(0); };   // stats().modelPhases: ms after the loader callback
      if (gen !== S.loadGen || S.disposed || !S.scene) { disposeObject(root); return; }   // a stale load (disposed or remounted meanwhile)
      let added = false;
      try {
        const opt = S.opts || {}; root.name = 'gltf-cabin';
        // transform: harness overrides first, else the fit transform for a 1/100 file, else as authored
        const raw = new THREE.Box3().setFromObject(root, true), rs = raw.getSize(new THREE.Vector3()), tiny = Math.max(rs.x, rs.y, rs.z) < 0.2;
        const sc = opt.modelScale ? +opt.modelScale : tiny ? MODEL_TRANSFORM.scale : 1;
        const yaw = opt.modelYaw !== undefined && opt.modelYaw !== null ? +opt.modelYaw || 0 : tiny ? MODEL_TRANSFORM.yaw : 0;
        const pos = opt.modelPos ? opt.modelPos.map(Number) : tiny ? MODEL_TRANSFORM.pos.slice() : [0, 0, 0];
        root.scale.setScalar(sc); root.rotation.y = yaw * DEG; root.position.fromArray(pos); S.modelPos = pos.slice();
        root.traverse(o => { if (o.isMesh && o.material) { const mn = (o.material.name || '').toLowerCase(); if (mn.includes('lit') || mn.includes('emissive')) { o.material.emissiveIntensity = 0; (M.modelLit = M.modelLit || []).push(o.material); } } });
        S.scene.add(root); root.visible = false; added = true; root.updateMatrixWorld(true);   // in the scene (the fit needs world matrices) but hidden until its programs are linked
        if (opt.nameTest) { const tn = root.getObjectByName(String(opt.nameTest)); if (tn) tn.name = 'ignition'; }   // harness: ?namehint=<node> exercises the MODEL_HINTS path on this file
        const H = MODEL_HINTS.names, named = findNode(root, H.keySlot) || findNode(root, H.door) || findNode(root, H.wheelHub);
        if (named) {                                                // a model authored to MODEL_HINTS: named nodes carry our props
          const info = { named: true, materials: fitMaterials(root, opt.paint === 'keep') };   // the material pass still applies (fresh glass, navy paint, the atlas split): no file material ships as authored
          const slotNode = findNode(root, H.keySlot);
          if (slotNode) { const p = slotNode.getWorldPosition(new THREE.Vector3()), q = slotNode.getWorldQuaternion(new THREE.Quaternion()); N.cabin.remove(N.slot); S.scene.add(N.slot); N.slot.position.copy(p); N.slot.quaternion.copy(q); N.keyPath = null; }
          const hub = findNode(root, H.wheelHub); if (hub && hub.isMesh) hub.material = M.hub;
          else {                                                    // no named hub: the third-party crest near the fitted hub point is hidden and our wordmark disc goes there (never a manufacturer badge on the brand page)
            const badge = meshNear(root, mw(MODEL_FIT.hub.pos), MODEL_FIT.hub.badgeRadius, MODEL_FIT.hub.badgeMaxTris); info.hubBadge = badge ? badge.name : null;
            if (badge) { badge.visible = false; const f = MODEL_FIT.hub, hn = V3(f.normal).normalize(), hp = V3(f.pos).addScaledVector(hn, f.standoff); if (N.hub.parent) N.hub.parent.remove(N.hub); S.scene.add(N.hub); N.hub.position.fromArray(mw(hp.toArray())); N.hub.scale.setScalar(f.scale); N.hub.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hn); }
          }
          const tach = findNode(root, H.tach); if (tach && tach.isMesh) tach.material = M.dial;
          const needle = findNode(root, H.tachNeedle); if (needle) N.needle = needle;
          const scr = findNode(root, H.screen); if (scr && scr.isMesh) scr.material = M.screen;
          const dl = findNode(root, H.dialLeft); if (dl && dl.isMesh) dl.material = M.dispL;
          const dr = findNode(root, H.dialRight); if (dr && dr.isMesh) dr.material = M.dispR;
          const door = findNode(root, H.door); if (door) N.door = door;
          S.fit = info;
        } else S.fit = fitModel(root, MODEL_FIT);                   // this file: fitted by geometry
        mark('fit');
        if (N.doorModel) N.doorModel.visible = false; if (N.propsGroup) N.propsGroup.visible = false;   // the cut door and the moved props stay hidden with the root until the swap
        // the stage is already on the visible canvas without a cabin (the hold lost to the fetch): the car will crossfade in, so its materials
        // are put in their fade state NOW (transparent, opacity 0, one pass per double-sided material) and the programs compiled below are
        // the ones the fade draws; the fade's end keeps those programs (see endModelFade), so nothing links after this
        const roots = [root, N.doorModel, N.propsGroup];
        if (S.stageOnly) S.modelFade = prepareModelFade(root);
        const show = () => {
          if (gen !== S.loadGen || S.disposed || !S.scene) return;
          mark('linked'); warmPrograms(); root.visible = true; if (N.doorModel) N.doorModel.visible = true; if (N.propsGroup) N.propsGroup.visible = true;
          N.cabin.visible = false; S.stageOnly = false;
          S.model = root; S.modelState = 'gltf'; S.modelReady = true;
          if (!named) onModelReady();                               // the geometry fit also switches the rig (POSE_MODEL, lights, key path); a named model keeps the procedural ones
          if (S.gtao) { try { S.gtao.setSceneClipBox(new THREE.Box3().setFromObject(root, true).expandByScalar(0.3)); } catch (e) {} }
          if (S.modelFade) startModelFade();                        // the stage was revealed without a cabin: the car crossfades in over 400 ms instead of cutting
          S.shadowDirty = 3; if (S.tierState) { S.tierState.ignore = Math.max(S.tierState.ignore, 30); if (!S.tierState.pinned && S.tierState.auto && S.tier !== 'lite' && !S.revealed && S.compiled) { S.tierState.probePending = true; probeNow(); } }   // the model is a different draw cost: one more burst, in this task, but only while the canvas is still hidden (after the reveal the watchdog judges it; a burst would be a visible freeze)
          settle(); if (S.compiled) reveal(); mark('shown');        // before the first frame exists the mount's finish() reveals, after its own probe: the first visible frame is always the door pose, never a probe frame
        };
        // the model's own materials (shared by the cut door) and the moved props are compiled for both light states with the composer target
        // bound, each compile in its own task after the fit's (the GLSL assembly of 20 to 35 programs is 150 to 400 ms of main thread; split,
        // no task passes 300 ms); the textures are uploaded in idle chunks while the programs link; the swap waits for all of it, so the first
        // frame with the car never blocks the thread. show() is always async.
        const live = () => gen === S.loadGen && !S.disposed && !!S.scene;
        const issueFade = () => { if (!live()) return; try {
          const cp = compileChunked(roots, live); mark('compileIssued'); Promise.all([cp, initTextures(root)]).then(show, show);
        } catch (e) { console.warn('[TR3D] model compile', e); show(); } };
        setTimeout(issueFade, 0);
        return;
      } catch (e) {
        S.modelState = 'failed'; S.fit = { error: String(e && e.message || e) }; console.warn('[TR3D] model swap failed, keeping the procedural cabin', e);
        try { if (S.modelFade) endModelFade(); restoreProps(); if (N.doorModel) { S.scene.remove(N.doorModel); disposeObject(N.doorModel); N.doorModel = null; } N.door = N.doorProc; N.cabin.visible = true; S.stageOnly = false; if (added) S.scene.remove(root); disposeObject(root); S.modelPos = null; S.rigModel = false; applyModelLayout(false); } catch (e2) {}
      }
      settle();
    }, xhr => { try { if (xhr && xhr.loaded > 0) S.modelBytes = Math.max(S.modelBytes || 0, xhr.loaded); } catch (e) {} },   // bytes are flowing: the mount hold may extend (see mount)
    err => { S.modelState = 'failed'; if (S.stageOnly && N.cabin) { N.cabin.visible = true; S.stageOnly = false; } console.warn('[TR3D] model load failed, keeping the procedural cabin', err && err.message); settle(); });
  } catch (e) { S.modelState = 'failed'; console.warn('[TR3D] loader', e); settle(); }
}
// the car fades in over the stage: every solid material under the model root, the cut door and the moved props ramps its opacity from 0.
// prepareModelFade puts the materials in their fade state BEFORE their compile (transparent is a program-key bit; forceSinglePass keeps a
// double-sided material to one draw and one variant instead of three's back-then-front pair). Once the car is visible, compileOpaque
// compiles the opaque variants on the same material objects in idle chunks (a material keeps every program it has used, keyed, so the
// restore cannot miss the cache; re-run after a tier step, which changes every key). At full opacity the blend is switched off (an
// opaque write from the fade program) until those are linked, then endModelFade restores the true opaque state (the opaque list, early
// depth). Nothing in the fade links a program inside a frame. Sprites, shader materials and the additive planes keep their own opacity.
function prepareModelFade(root) {
  const mats = [], seen = new Set();
  const grab = o => { if (!o) return; o.traverse(n => { if (!n.isMesh || !n.material) return; for (const m of (Array.isArray(n.material) ? n.material : [n.material])) { if (seen.has(m) || m.isSpriteMaterial || m.isShaderMaterial || m.blending !== THREE.NormalBlending) continue; seen.add(m); mats.push({ m, op: m.opacity, tr: m.transparent, fsp: m.forceSinglePass }); if (!m.transparent) { m.transparent = true; m.forceSinglePass = true; } m.opacity = 0; m.needsUpdate = true; } }); };
  grab(root); grab(N.doorModel); grab(N.propsGroup);
  return { t: 0, k: 0, mats, active: false, bridged: false, opaqueReady: false, opaqueGen: 0, root };
}
function startModelFade() { const f = S.modelFade; if (f) { f.active = true; f.t = 0; try { S.renderer.setTransparentSort(frontToBack); } catch (e) {} if (!ABL('noopaque')) compileOpaque(f); schedulePrecompile(); } }   // ablate=noopaque (harness): the car keeps its fade program with the blend off, no opaque variants   // while the car is in the transparent list it is drawn front to back (depth written, so early depth holds and the body never overdraws the cabin: left back to front, the slow path cost a tier step)
function frontToBack(a, b) { if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder; if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder; if (a.material.id !== b.material.id) return a.material.id - b.material.id; if (a.z !== b.z) return a.z - b.z; return a.id - b.id; }
function fadeState(e, f) { const m = e.m; m.transparent = true; m.forceSinglePass = true; m.opacity = e.op * (f.active ? f.k : 0); m.blending = f.bridged ? THREE.NoBlending : THREE.NormalBlending; m.needsUpdate = true; }
function compileOpaque(f) {
  const r = S.renderer; if (!r || !f) return;
  f.opaqueReady = false; const gen = ++f.opaqueGen, byMat = new Map(f.mats.map(e => [e.m, e])), rt = S.composer ? S.composer.readBuffer : null, progs = new Set(), meshes = [];
  for (const o of [f.root, N.doorModel, N.propsGroup]) if (o) o.traverse(n => { if (n.isMesh && n.material) meshes.push(n); });
  let i = 0; const step = () => {
    if (S.modelFade !== f || f.opaqueGen !== gen || !S.renderer || S.renderer !== r) return;
    const t0 = performance.now(), flipped = [];
    while (i < meshes.length && performance.now() - t0 < 12) {
      const m = meshes[i++];
      for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) { const e = byMat.get(mat); if (e && !e.tr) { mat.transparent = false; mat.opacity = e.op; mat.blending = THREE.NormalBlending; mat.forceSinglePass = e.fsp; mat.needsUpdate = true; flipped.push(e); } }
      const run = on => { const was = S.lateOn; setLate(on); try { issueCompile([m], S.camera, S.scene, rt).forEach(p => progs.add(p)); } finally { setLate(was); } }; run(true); if (S.splitLights) run(false);
      for (const e of flipped) fadeState(e, f); flipped.length = 0;   // back to the fade state inside the same task: no frame sees the flip
    }
    maskChunk(); if (i < meshes.length) { chunkQueue(step); return; }
    linked(progs).then(() => { if (S.modelFade === f && f.opaqueGen === gen) f.opaqueReady = true; });
  };
  chunkQueue(step);
}
// compiles issued mesh by mesh in idle chunks of about 12 ms (a model's worth of GLSL assembly is 150 to 450 ms of main thread; as one task it
// was the longest stall of a slow-network arrival): every mesh under the roots, both light states where they are split, the composer target
// bound; onIssued() runs once every chunk has been issued, the promise resolves once every program it made current reports linked.
// live(): false stops the queue (dispose, a newer load)
function compileChunked(roots, live, onIssued) {
  const r = S.renderer; if (!r || !S.scene) return Promise.resolve();
  const meshes = []; for (const o of roots) if (o) o.traverse(n => { if (n.isMesh && n.material) meshes.push(n); });
  const rt = S.composer ? S.composer.readBuffer : null, progs = new Set();
  return new Promise(res => {
    let i = 0; const step = () => {
      if (!S.renderer || S.renderer !== r || (live && !live())) { res(); return; }
      const t0 = performance.now();
      while (i < meshes.length && performance.now() - t0 < 12) { const m = meshes[i++]; const run = on => { const was = S.lateOn; setLate(on); try { issueCompile([m], S.camera, S.scene, rt).forEach(p => progs.add(p)); } finally { setLate(was); } }; run(true); if (S.splitLights) run(false); }
      maskChunk(); if (i < meshes.length) { chunkQueue(step); return; }
      if (onIssued) { try { onIssued(); } catch (e) { console.warn('[TR3D] compile', e); } }
      linked(progs).then(res, res);
    };
    chunkQueue(step);
  });
}
// the arrival's tasks run one per macrotask when the canvas is hidden (nothing to keep smooth) and in idle time once it is visible
function chunkQueue(f) { if (S.shown) idle(f); else setTimeout(f, 0); }
// the model's textures uploaded (with mipmaps) in idle chunks of about 8 ms before the car is shown, so its first frame does not carry
// 150 to 200 ms of texSubImage2D; resolves when every map is on the GPU (or the scene is gone)
function initTextures(root) {
  const r = S.renderer, list = []; if (!r || !root) return Promise.resolve();
  root.traverse(o => { if (!o.isMesh || !o.material) return; for (const m of (Array.isArray(o.material) ? o.material : [o.material])) for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'clearcoatNormalMap']) { const t = m[k]; if (t && t.isTexture && !list.includes(t)) list.push(t); } });
  return new Promise(res => { let i = 0; const step = () => { if (S.disposed || S.renderer !== r) { res(); return; } const t0 = performance.now(); while (i < list.length && performance.now() - t0 < 8) { try { r.initTexture(list[i]); } catch (e) {} i++; } maskChunk(); if (i < list.length) idle(step); else res(); }; idle(step); });
}
function endModelFade() {
  const f = S.modelFade; if (!f) return; S.modelFade = null; f.opaqueGen++; try { if (S.renderer) S.renderer.setTransparentSort(null); } catch (e) {}
  for (const e of f.mats) { e.m.opacity = e.op; e.m.transparent = e.tr; e.m.forceSinglePass = e.fsp; e.m.blending = THREE.NormalBlending; e.m.needsUpdate = true; }
}

// ---------- API ----------
function mount(container, opts) {
  return new Promise((resolve, reject) => {
    try {
      if (S.mounted) { resolve(); return; }
      opts = opts || {}; S.opts = opts; S.container = container; S.rm = !!opts.rm; S.disposed = false; S.shown = false;
      const mountGen = ++S.mountGen;   // a dispose() during the frame defer followed by another mount(): the first build must not run
      // The page's own weak-device watchdog (intro.js) is one-shot: 20 rAF intervals after its first paint, 4 over 50 ms means html.lite for
      // the whole intro. The scene build is a run of main-thread tasks (environment, textures, geometry, shader issue, the model fit) that
      // would be counted, so the build waits for 24 rAF callbacks first (frames, not milliseconds: the browser's own first paint can stall the
      // compositor for a second on a cold shader cache; 2.5 s safety cap): the watchdog's window has closed before any of this work starts. Skipped for reduced motion and lite (no watchdog there) and for opts.noDefer (harness).
      const t00 = performance.now();
      const build = () => { try {
      if (S.disposed || S.mounted || S.mountGen !== mountGen) { resolve(); return; }
      S.deferMs = Math.round(performance.now() - t00);
      S.w = Math.max(1, container.clientWidth || window.innerWidth); S.h = Math.max(1, container.clientHeight || window.innerHeight);
      S.phone = !!opts.phone || ((navigator.maxTouchPoints || 0) > 1 && S.w < 900);
      const canvasEl = document.createElement('canvas'); canvasEl.style.cssText = 'display:block;width:100%;height:100%'; container.appendChild(canvasEl); S.canvas = canvasEl;
      // no context antialias: every tier draws through the composer (ultra multisamples its scene pass, the others run SMAA), so a multisampled
      // default framebuffer would only add a resolve on the final blit (21 MB a frame on a 2x phone) for nothing
      const nav = navigator, liteHint = !!opts.lite || opts.tier === 'lite' || (nav.hardwareConcurrency && nav.hardwareConcurrency <= 2) || (nav.deviceMemory && nav.deviceMemory <= 2) || (() => { try { return document.documentElement.classList.contains('lite'); } catch (e) { return false; } })();
      let renderer;
      try { renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false }); }
      catch (e) { canvasEl.remove(); reject(new Error('WebGL unavailable: ' + (e && e.message))); return; }
      S.renderer = renderer; S.lite = !!liteHint; S.tier = liteHint ? 'lite' : 'base'; S.pr = 1; S.simClock = !!opts.simClock; S.compileGate = null; S.modelFade = null; S.stageOnly = false; S.modelBytes = 0; S.holdExtended = false;
      renderer.debug.checkShaderErrors = !!opts.debug;   // the link-status and info-log round trips on a program's first draw (25 to 30 ms each through Chrome's GPU process) are harness-only (test.html ?debug=1)
      try { S.aniso = S.phone ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : Math.min(16, renderer.capabilities.getMaxAnisotropy()); } catch (e) { S.aniso = 4; }
      renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = S.exp = 1.2; renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.shadowMap.enabled = false; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = false; renderer.info.autoReset = false; renderer.setClearColor(0x070b16, 1);
      const scene = new THREE.Scene(); S.scene = scene; scene.background = null; scene.fog = new THREE.FogExp2(0x141833, 0.045);
      const camera = new THREE.PerspectiveCamera(58, 1, 0.05, 70); S.camera = camera; camera.layers.enable(LAYER_NOPRE); camera.layers.enable(LAYER_NOREFL); scene.add(camera);
      S.fov = S.phone ? 74 : 60; camera.fov = S.fov;
      const ph = S.mountPhases = { t0: performance.now(), deferMs: S.deferMs || 0 }, mark = k => { ph[k] = +(performance.now() - ph.t0).toFixed(0); };   // stats().mountPhases: cumulative ms per mount step (main-thread cost)
      try { S.envTex = buildEnvironment(renderer); scene.environment = S.envTex; } catch (e) { console.warn('[TR3D] env', e); } mark('env');
      // textures that use the wordmark are redrawn when it arrives
      buildMaterials(null); mark('materials');
      try { const img = new Image(); img.onload = () => { try { T.hub.image = hubTexture(img).image; T.hub.needsUpdate = true; const st = screenTextures(img); T.screen.emissive.image = st.emissive.image; T.screen.emissive.needsUpdate = true; } catch (e) {} }; img.src = new URL('../assets/mffu-wordmark.svg', import.meta.url).href; } catch (e) {}
      N.cabin = buildCabin(); scene.add(N.cabin); mark('cabin');
      scene.add(buildStage());
      buildLights(); mark('lights');
      S.ro = new ResizeObserver(() => { try { resize(); } catch (e) {} }); S.ro.observe(container);
      window.addEventListener('resize', resize);
      // intro.js's weak-device watchdog only adds html.lite after mount: follow it (the floor of the ladder). html.ign-dark is the breath before the catch.
      try { S.mo = new MutationObserver(() => { try { const cl = document.documentElement.classList; if (!S.lite && cl.contains('lite')) setQuality('lite'); if (cl.contains('ign-dark') && S.breathT < 0 && S.catchT < 0) S.breathT = 0; } catch (e) {} }); S.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] }); } catch (e) {}
      // first pose: standing outside the open door
      const m = defineMove('door'); evalMove(m, 0); snapRig(); S.doorOpen = 1; S.dome = 1; S.doorPrev = -1;
      S.mounted = true; S.last = 0; S.lastRaf = 0; S.t = 0; S.focus = 2.1;
      setupTiers(opts); mark('tiers');                                // the hint pick: renderer pixel ratio, shadows, the post stack; a burst probe follows on the first rAF
      // The model load and the hold timer start NOW, before any frame: the programs are compiled asynchronously (both light states, the
      // composer target bound) and the first frame is rendered when they are linked, so nothing blocks the thread. The promise resolves
      // once a frame is on the canvas AND the hold is over: the model landed, or opts.modelWait expired (2.5 s desktop, 1.5 s phone, 0 in
      // rm). While bytes are flowing the hold extends once to 8 s (6 s phone). If it still expires with the model in flight, the stage is
      // revealed with the procedural cabin hidden and the car crossfades in when it lands; the procedural cabin is kept only for a failed
      // load and for mounts without a model URL. intro.js starts its own cap only after mount resolves, so the hold never eats the walk-in.
      const url = opts.model === undefined ? MODEL_URL : opts.model;
      const waitMs = url && !S.rm ? (opts.modelWait !== undefined && opts.modelWait !== null ? Math.max(0, +opts.modelWait || 0) : S.phone ? 1500 : 2500) : 0;
      const extendMs = opts.modelWaitMax !== undefined && opts.modelWaitMax !== null ? Math.max(waitMs, +opts.modelWaitMax || 0) : (S.phone ? 6000 : 8000);
      // through the hold the canvas stays transparent (the page's dark overlay shows) so the visitor never sees the procedural cabin
      // replaced by the real one; reveal() fades it in (opts.fadeMs, 350 ms) on the first frame of whichever cabin the walk-in starts in
      S.fadeMs = opts.fadeMs !== undefined && opts.fadeMs !== null ? Math.max(0, +opts.fadeMs || 0) : 350;
      S.revealed = false; S.revealPending = false; canvasEl.style.transition = S.fadeMs ? 'opacity ' + S.fadeMs + 'ms ease-out' : 'none';
      if (waitMs > 0) canvasEl.style.opacity = '0';
      const t0 = performance.now(); S.holdStart = t0; S.compiled = false; let done = false, holdOver = false;
      const finish = () => {
        if (done || S.disposed) { if (!done) { done = true; resolve(); } return; }
        holdOver = true; if (S.holdTimer) { clearTimeout(S.holdTimer); S.holdTimer = 0; }
        if (!S.compiled) return;                                      // the first frame is not on the canvas yet: finish again when it is
        done = true;
        const go = () => {
          if (S.disposed) { resolve(); return; }
          if (S.modelState === 'loading' && url) { S.stageOnly = true; N.cabin.visible = false; }   // the hold lost to the fetch: the stage alone, never the wrong car
          reveal(); resolve();
        };
        if (S.compileGate) S.compileGate.then(go, go); else go();   // a probe step is still linking its programs (a cold shader cache): the page's stage chain starts only once the first visible frame can be drawn, so no part of the door move plays behind a transparent canvas
      };
      const holdExpired = () => {
        S.holdTimer = 0;
        if (S.modelState === 'loading' && !S.holdExtended && S.modelBytes > 0) {   // bytes are flowing: one extension to the long hold, counted from the mount
          S.holdExtended = true; const left = extendMs - (performance.now() - t0); if (left > 50) { S.holdTimer = setTimeout(holdExpired, left); return; }
        }
        finish();
      };
      if (url) { S.onModelSettled = finish; loadModel(url); }
      if (waitMs > 0 && S.modelState === 'loading') S.holdTimer = setTimeout(holdExpired, waitMs); else holdOver = true;
      const first = () => {
        if (S.disposed) return;
        S.compiled = true; mark('linked');
        ph.warmed = warmPrograms(); mark('warm');                       // every linked program's uniform and attribute tables (three would fetch each on its first draw)
        try {                                                          // one hidden warm-up frame with every light in the shader and the key in the slot (its gold is otherwise first drawn at keyin): any straggling first use is paid here, before the canvas is visible
          const was = S.lateOn, kv = N.key.visible, ks = N.keySeated; setLate(true); placeKey(1); tick(performance.now(), true);
          setLate(was); N.key.visible = kv; N.keySeated = ks; if (ks) placeKey(1); else N.key.rotation.set(0, 0, 0);
        } catch (e) {}
        frame(performance.now()); mark('firstFrame');                 // the first frame, then the loop
        probeNow(); mark('probed');                                   // the burst probe, in this same task (every main-thread task over 50 ms counts against the page's own watchdog); a step-down inside it gates the loop and the reveal waits for the links
        if (holdOver) finish();
      };
      const cp = Promise.all([compileBoth(true), compileExtras(true)]); mark('compileIssued'); cp.then(first, first);
      } catch (e) { S.onModelSettled = null; try { dispose(); } catch (e2) {} reject(e); } };
      const htmlLite = (() => { try { return document.documentElement.classList.contains('lite'); } catch (e) { return false; } })();
      if (opts.noDefer || S.rm || opts.lite || htmlLite) build(); else waitFrames(22, 3000).then(build);
    } catch (e) { reject(e); }
  });
}
// n rAF callbacks counted only once the page's watchdog window can be open (DOMContentLoaded + 430 ms: intro.js initialises at the end of
// the body and opens its 20-frame window 400 ms later), so the count never runs ahead of the watchdog's own; maxMs is a safety cap
function waitFrames(n, maxMs) {
  return new Promise(res => {
    let k = 0, done = false, last = performance.now(); S.deferFrames = [];
    let dcl = 0; try { const nav = performance.getEntriesByType('navigation')[0]; dcl = nav ? nav.domContentLoadedEventStart : 0; } catch (e) {}
    const openAt = (dcl || 0) + 430, fin = () => { if (!done) { done = true; res(); } };
    const f = now => { if (done) return; S.deferFrames.push(Math.round(now - last)); last = now; if (S.disposed || (now >= openAt && ++k >= n)) fin(); else requestAnimationFrame(f); };
    requestAnimationFrame(f); setTimeout(fin, maxMs);
  });
}
function stage(name) { try { if (!S.mounted) return Promise.reject(new Error('not mounted')); return startMove(name); } catch (e) { return Promise.reject(e); } }
function keyAngle(deg) {
  try { S.deg = clamp(+deg || 0, 0, 90); if (N.key && N.keySeated) N.key.rotation.set(0, KEY_YAW, -S.deg * DEG); S.shadowDirty = Math.max(S.shadowDirty, 1);
    const on = S.deg >= 60; if (on && !S.lastOn && S.selfTest < 0) S.selfTest = 0; if (!on && S.deg < 55) S.lastOn = false; else if (on) S.lastOn = true; } catch (e) {}
}
function ignite() { try { keyAngle(90); S.sagT = 0; } catch (e) {} }
function catchFn() { try { S.catchT = 0; S.breathT = -1; S.tachShiver = 0; S.shakeT = S.last; S.selfTest = -1; if (M.modelLit) for (const m of M.modelLit) m.emissiveIntensity = 1; } catch (e) {} }
function blip() { try { S.blipT = 0; } catch (e) {} }
function dissolve() { try { if (!S.mounted) return Promise.resolve(); return startMove('dissolve'); } catch (e) { return Promise.resolve(); } }
function dispose() {
  S.disposed = true; if (S.raf) { cancelAnimationFrame(S.raf); clearTimeout(S.raf); } S.raf = 0;
  S.loadGen++; if (S.holdTimer) clearTimeout(S.holdTimer); S.holdTimer = 0; if (S.precompileT) clearTimeout(S.precompileT); S.precompileT = 0; try { releaseClones(); } catch (e) {}     // a model still in flight is dropped on arrival
  { const f = S.onModelSettled; S.onModelSettled = null; if (f) { try { f(); } catch (e) {} } }   // a mount() still held for the model resolves now rather than never
  try { if (S.mo) S.mo.disconnect(); } catch (e) {} S.mo = null;
  S.model = null; S.modelReady = false; S.rigModel = false; S.modelState = 'none'; S.modelUrl = null; S.modelPos = null; S.fit = null; S.lastStage = null; S.revealed = false; S.revealPending = false;
  try { window.removeEventListener('resize', resize); if (S.ro) S.ro.disconnect(); } catch (e) {}
  try { if (N.reflector) { N.reflector.dispose(); } } catch (e) {}
  try { if (S.scene) S.scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) { for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); } m.dispose(); } } }); } catch (e) {}
  try { if (L.key && L.key.shadow) L.key.shadow.dispose(); } catch (e) {}
  try { for (const k of ['brushedFine', 'leatherFine', 'stitchFine', 'quilt', 'quiltN']) if (T[k]) T[k].dispose(); if (M.rimModel && M.rimModel.normalMap) M.rimModel.normalMap.dispose(); if (M.headlinerModel && M.headlinerModel.normalMap) M.headlinerModel.normalMap.dispose(); } catch (e) {}   // the textures only the atlas shader's uniforms reference (not material properties the traverse above sees)
  try { if (S.envTex) S.envTex.dispose(); S.envTex = null; disposePost(); } catch (e) {}
  try { if (S.renderer) { S.renderer.dispose(); S.renderer.forceContextLoss(); } } catch (e) {}
  try { if (S.canvas) S.canvas.remove(); } catch (e) {}
  S.canvas = null; S.container = null; S.compileGate = null; S.compiled = false; S.modelFade = null; S.stageOnly = false; S.modelBytes = 0; S.holdExtended = false; S.shown = false; try { if (S.planeGeo) S.planeGeo.dispose(); } catch (e) {} S.planeGeo = null;
  S.mounted = false; S.renderer = null; S.scene = null; S.composer = null; S.bloom = null; S.gtao = null; S.dof = null; S.grade = null; S.clampPass = null; S.gtaoMode = null; S.move = null; RIG.placed = false; S.tierState = null; S.tier = 'base'; S.pr = 1;
  for (const k in N) delete N[k]; for (const k in M) delete M[k]; for (const k in L) delete L[k]; for (const k in T) delete T[k];
  S.deg = 0; S.catchT = -1; S.sagT = -1; S.blipT = -1; S.shakeT = -1; S.breathT = -1; S.selfTest = -1; S.lastOn = false; S.swayCur = 0; S.sway = 0; S.roll = 0; S.doorOpen = 1; S.doorPrev = -1; S.dome = 1; S.exp = 1.2; S.shadowDirty = 0; S.lateOn = false; S.benchQ = null;
  beatsReset();   // BEAT
  S.stats.hist = []; S.stats.rhist = []; S.stats.maxMs = 0; S.stats.frames = 0;
}
function stats() {
  const st = S.stats, avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0, info = S.renderer ? S.renderer.info.render : {}, ts = S.tierState;
  return { frames: st.frames, frameMs: +avg(st.hist).toFixed(2), renderMs: +avg(st.rhist).toFixed(2), maxFrameMs: +st.maxMs.toFixed(1), triangles: info.triangles || 0, calls: info.calls || 0, pixelRatio: S.renderer ? S.renderer.getPixelRatio() : 0, size: [S.w, S.h], lite: S.lite, model: S.modelReady ? 'gltf' : 'procedural', modelState: S.modelState || 'none', modelUrl: S.modelUrl || null,
    tier: S.tier, pr: S.pr, passes: passList(), gpu: ts ? ts.gpu : null, deviceClass: ts ? ts.cls : null, tierWhy: ts ? ts.why : null, ladder: ts ? ts.ladder.map(s => s.tier + '@' + s.pr) : null, pinned: ts ? ts.pinned : null, probe: ts ? ts.probe : null, probes: ts ? ts.probes || [] : null, stepDowns: ts ? ts.stepDowns : [], slowCount: ts ? ts.slowCount : 0,
    shadows: S.renderer ? S.renderer.shadowMap.enabled : false, shadowMap: L.key && L.key.castShadow ? L.key.shadow.mapSize.x : 0, reflector: !!(N.reflector && N.reflector.visible), fov: +S.fov.toFixed(1), focus: +S.focus.toFixed(3), aniso: S.aniso, lateLights: S.lateOn, lights: countLights(), calibMs: ts && ts.calibMs !== undefined ? +ts.calibMs.toFixed(2) : null,
    rigModel: S.rigModel, revealed: S.revealed, canvasOpacity: S.canvas ? (S.canvas.style.opacity === '' ? '1' : S.canvas.style.opacity) : null, exposure: S.renderer ? +S.renderer.toneMappingExposure.toFixed(3) : null,
    shown: !!S.shown, lastStepMs: S.lastStepMs || null, lastWarmMs: S.lastWarmMs || 0, mountPhases: S.mountPhases || null, deferFrames: S.deferFrames || null, modelPhases: S.modelPhases || null, cabinVisible: !!(N.cabin && N.cabin.visible), stageOnly: !!S.stageOnly, modelFading: !!S.modelFade, compiling: !!S.compileGate, modelBytes: S.modelBytes || 0, holdExtended: !!S.holdExtended, ceilMs: ts && ts.ceil !== undefined ? ts.ceil : null, periodMs: +framePeriod().toFixed(1),
    texturesReady: S.model ? texturesReady(S.model) : null, fit: S.fit || null, door: N.doorModel && N.door === N.doorModel ? 'gltf' : 'procedural', doorOpen: S.doorOpen, lastStage: S.lastStage,
    cam: S.camera ? { pos: S.camera.position.toArray().map(v => +v.toFixed(3)), tgt: RIG.tgt.toArray().map(v => +v.toFixed(3)) } : null };
}
function countLights() { let n = 0; try { S.scene.traverseVisible(o => { if (o.isLight && !o.isAmbientLight) n++; }); } catch (e) {} return n; }
// test harness: render n frames back to back with a real GPU sync after each (a 1x1 readPixels; gl.finish does not block through ANGLE),
// plus GPU time from EXT_disjoint_timer_query_webgl2 when the driver exposes it, a calib row (clear + sync alone) and throughput (n frames, one sync)
function bench(n) {
  n = n || 60; const gl = S.renderer.getContext(), px = new Uint8Array(4), ts = S.tierState;
  const raf = S.raf; if (raf) cancelAnimationFrame(raf); S.raf = 0; if (ts) ts.masked = true;
  const sync = () => { try { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); } catch (e) {} };
  const clock = { last: S.last, lastRaf: S.lastRaf, t: S.t };          // the simulated clock below must not leak into the live loop's rAF history or its dt
  let now = (S.lastRaf || performance.now());
  const calib = []; for (let i = 0; i < 8; i++) { const t0 = performance.now(); try { S.renderer.setRenderTarget(null); S.renderer.clear(); } catch (e) {} sync(); calib.push(performance.now() - t0); }
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'), queries = [], synced = [];
  for (let i = 0; i < n; i++) {
    now += 16.7; const t0 = performance.now(); let q = null;
    if (ext) { try { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); } catch (e) { q = null; } }
    S.disposed = false; S.raf = 0; tick(now); if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0;
    if (q) { try { gl.endQuery(ext.TIME_ELAPSED_EXT); } catch (e) {} queries.push(q); }
    sync(); synced.push(performance.now() - t0);
  }
  const t1 = performance.now(); for (let i = 0; i < 20; i++) { now += 16.7; S.raf = 0; tick(now); if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; } sync(); const tput = (performance.now() - t1) / 20;
  const gpu = null; S.benchQ = ext && queries.length ? { ext, queries } : null;   // the query results arrive from the GPU process asynchronously: benchGpu() polls them across rAF frames
  S.last = clock.last; S.lastRaf = 0; S.t = clock.t;                   // the next live frame starts a fresh interval (no simulated gap in stats().frameMs) and continues the real clock
  if (ts) { ts.masked = false; ts.ignore = Math.max(ts.ignore, 3); } S.raf = requestAnimationFrame(frame);
  const sorted = synced.slice(2).sort((a, b) => a - b), avg = sorted.reduce((a, b) => a + b, 0) / sorted.length, cal = calib.slice(2).sort((a, b) => a - b);
  return { frames: n, tier: S.tier, syncedMs: { avg: +avg.toFixed(2), median: +sorted[sorted.length >> 1].toFixed(2), p90: +sorted[Math.floor(sorted.length * .9)].toFixed(2) }, calibMs: +cal[cal.length >> 1].toFixed(2), tputMs: +tput.toFixed(2), gpuMs: gpu,
    avgMs: +avg.toFixed(2), medianMs: +sorted[sorted.length >> 1].toFixed(2), p90Ms: +sorted[Math.floor(sorted.length * .9)].toFixed(2), size: [S.w, S.h], pixelRatio: S.renderer.getPixelRatio(), lite: S.lite, passes: passList(), triangles: S.renderer.info.render.triangles, calls: S.renderer.info.render.calls };
}
// test harness: after bench(), resolve the GPU time of its frames from EXT_disjoint_timer_query_webgl2 (polled across up to 90 rAF frames;
// a synchronous poll never sees the results through Chrome's GPU process), {medianMs, p90Ms, avgMs, n} or null when the extension is absent
function benchGpu() {
  return new Promise(res => {
    const bq = S.benchQ; S.benchQ = null; if (!bq || !S.renderer) { res(null); return; }
    const gl = S.renderer.getContext(), ext = bq.ext, vals = []; let left = bq.queries.slice(), frames = 0;
    const poll = () => {
      try {
        const keep = [];
        for (const q of left) { if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) { if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) vals.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); try { gl.deleteQuery(q); } catch (e) {} } else keep.push(q); }
        left = keep;
      } catch (e) { left = []; }
      if (left.length && frames++ < 90) { requestAnimationFrame(poll); return; }
      for (const q of left) { try { gl.deleteQuery(q); } catch (e) {} }
      if (vals.length > 2) { const s = vals.slice(2).sort((a, b) => a - b); res({ medianMs: +s[s.length >> 1].toFixed(2), p90Ms: +s[Math.floor(s.length * .9)].toFixed(2), avgMs: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2), n: s.length, pending: left.length }); }
      else res(null);
    };
    requestAnimationFrame(poll);
  });
}
// test harness: what is under a canvas pixel (CSS px): the nearest hits with node, material and world point
function pick(px, py, n) {
  try {
    const rc = new THREE.Raycaster(), ndc = new THREE.Vector2((px / (S.w || 1)) * 2 - 1, 1 - (py / (S.h || 1)) * 2);
    rc.setFromCamera(ndc, S.camera); rc.layers.enableAll();
    const hits = rc.intersectObjects(S.scene.children, true).filter(h => h.object.visible && (!h.object.parent || h.object.parent.visible));
    return hits.slice(0, n || 4).map(h => { const mats = Array.isArray(h.object.material) ? h.object.material : [h.object.material]; const mi = h.face && h.face.materialIndex || 0;
      return { node: h.object.name, parent: h.object.parent && h.object.parent.name, material: mats[mi] && (mats[mi].name || mats[mi].type), dist: +h.distance.toFixed(3), point: h.point.toArray().map(v => +v.toFixed(3)), normal: h.face ? h.face.normal.toArray().map(v => +v.toFixed(2)) : null }; });
  } catch (e) { return [{ error: String(e && e.message || e) }]; }
}
// test harness: jump straight to a pose (no smoothing)
function snapshot(name) {
  try {
    S.move = null;
    switch (name) {
      case 'door': RIG.placed = false; startMove('door', true, 0.15); N.key.visible = false; S.sway = 0; break;
      case 'sit': startMove('door', true, 1); startMove('sit', true, 0.50); N.key.visible = false; S.sway = 0; break;
      case 'observe': startMove('seated', true); startMove('observe', true, 0.42); N.key.visible = false; S.dome = 0.3; break;
      case 'seated': startMove('seated', true); break;
      case 'keyin': startMove('seated', true); N.keySeated = false; startMove('keyin', true, 0.55); break;
      case 'catch': startMove('seated', true); keyAngle(90); S.lastOn = true; S.selfTest = -1; S.sagT = -1; catchFn(); S.catchT = 1.6; S.shakeT = S.last - 1.6; S.exp = 0.84; if (S.renderer) S.renderer.toneMappingExposure = 0.84; break;
      case 'catch0': startMove('seated', true); keyAngle(90); S.lastOn = true; S.selfTest = -1; S.sagT = -1; catchFn(); S.catchT = 0.02; S.shakeT = S.last - 0.02; break;   // the catch frame itself
      default: if (!beatsSnapshot(name)) return false; break;   // BEAT ?shot=welcome|welcomesit|hint|flash
    }
    S.fov = wantFov(); S.focus = wantFocus()[0]; S.shadowDirty = 3;
    return true;
  } catch (e) { return false; }
}

// ---------- beats: welcome lights, turn hint, double flash (BEAT) ----------
// Three small beats, each a self-contained function; the call sites are the lines marked // BEAT (buildCabin, fitModel, applyState,
// startMove, snapshot, dispose, the TR3D object). Beat state lives in B so dispose() resets it with one call. Cost: three draw calls
// (pool plane, arc, arrowhead), one sprite and one thin strip per door, and no new light: the catch ember point light (L.catchGlow, dark
// until the catch) is borrowed as the warm handle lamp while the door is open, so the shader's light count and programs are unchanged.
const B = { welcomeT: -1, hintOn: false, hintK: 0, hintInput: false, hintT: 0, flashT: -1, flashFreeze: false, flashK: 0 };
const BEAT = {
  // welcome: the inner door-handle recess (door hinge frame: x inboard, y up from the hinge, z along the door) and the puddle pool on the
  // stage floor beside the sill (x outboard of the hinge, z along the car), 0.6 x 1.2 m, warm white (never beige: b stays near r)
  welcome: { handle: [0.075, 0.86, 0.42], handleProc: [0.042, 0.82, 0.32], pool: [-0.28, 0.25], poolSize: [0.6, 1.2], light: 0.5, fadeIn: 0.4, color: 0xffd8a6 },
  // hint: a thin gold ring segment in the slot's frame (the slot faces the seated eye), 120 deg clockwise from the key's rest (12 o'clock)
  hint: { radius: 0.068, half: 0.0013, span: 120, head: 12, headHalf: 0.0085, z: 0.014, breathe: 2.2, lo: 0.35, hi: 0.9, fade: 0.14 },
  // flash: two 120 ms pulses 180 ms apart at the start of the dissolve, 2.5x the catch level (k 1.5 over the base), a touch of bloom
  flash: { pulse: 0.12, gap: 0.18, k: 1.5, bloom: 0.12, spill: 0.5 }
};
function beatsReset() { B.lampBorrowed = false; B.welcomeT = -1; B.hintOn = false; B.hintK = 0; B.hintInput = false; B.hintT = 0; B.flashT = -1; B.flashFreeze = false; B.flashK = 0; }
// the scene parts: called once per door (procedural door in buildCabin, the cut glTF door in fitModel); returns the door-side group.
// The first (procedural) call also builds the shared materials, the stage-floor pool, the point light and the turn hint at the slot.
function beatsBuild(floorY, proc) {
  const W = BEAT.welcome, g = new THREE.Group(); g.name = 'welcome';
  if (!M.welcomeGlow) {
    M.welcomeGlow = new THREE.SpriteMaterial({ map: T.disc, color: W.color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false, opacity: 0 });   // same program as the LED halo
    M.welcomeStrip = new THREE.MeshStandardMaterial({ name: 'welcome-strip', color: 0x15120e, emissive: new THREE.Color(W.color), emissiveIntensity: 0, roughness: .5 });   // same program as the dome lens
    M.welcomePool = new THREE.MeshBasicMaterial({ map: T.pool, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, color: W.color });   // same program as the headlight pools
    const pool = noPre(new THREE.Mesh(new THREE.PlaneGeometry(W.poolSize[0], W.poolSize[1]), M.welcomePool)); pool.rotation.x = -Math.PI / 2; pool.position.set(-0.80 + W.pool[0], GROUND + 0.008, -0.72 + W.pool[1]); pool.name = 'welcome-pool'; pool.renderOrder = -1; pool.visible = false; S.scene.add(pool); N.welcomePool = pool;
    try { turnHintBuild(); } catch (e) { console.warn('[TR3D] turn hint', e); }
  }
  const h = proc ? W.handleProc : W.handle;
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.008, 0.085), M.welcomeStrip); strip.position.set(h[0] - 0.004, h[1] - 0.028, h[2]); strip.name = 'welcome-strip'; g.add(strip);   // the lit lip of the handle recess
  const glow = noPre(new THREE.Sprite(M.welcomeGlow)); glow.scale.set(0.17, 0.11, 1); glow.position.set(h[0] + 0.015, h[1] - 0.015, h[2]); glow.renderOrder = 5; glow.name = 'welcome-glow'; g.add(glow);
  g.userData.handle = new THREE.Vector3(h[0] + 0.06, h[1] - 0.02, h[2]);   // where the point light sits (a little inboard of the recess, so the sill plate and the card catch it)
  return g;
}
function turnHintBuild() {
  const H = BEAT.hint, r = H.radius, a0 = (90 - H.span) * DEG, g = new THREE.Group(); g.name = 'turn-hint'; g.position.z = H.z; g.visible = false;
  M.hintArc = new THREE.MeshBasicMaterial({ name: 'hint-arc', color: 0xe6c47c, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false });
  M.hintHead = new THREE.MeshBasicMaterial({ name: 'hint-head', color: 0xfbe8bc, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false });   // no depth test: the arc is a guide drawn over the dash curve and the rim, never clipped by them
  const gapA = H.head * DEG * 0.35;   // the arc stops just short of the arrowhead's base
  const arc = noPre(new THREE.Mesh(new THREE.RingGeometry(r - H.half, r + H.half, 72, 1, a0 + gapA, H.span * DEG - gapA), M.hintArc)); arc.renderOrder = 6; arc.name = 'hint-arc'; g.add(arc);
  const sh = new THREE.Shape(), ca = Math.cos(a0), sa = Math.sin(a0), tip = a0 - H.head * DEG;   // clockwise end: the arrowhead points on toward ACC/ON
  sh.moveTo((r + H.headHalf) * ca, (r + H.headHalf) * sa); sh.lineTo(r * Math.cos(tip), r * Math.sin(tip)); sh.lineTo((r - H.headHalf) * ca, (r - H.headHalf) * sa); sh.closePath();
  const head = noPre(new THREE.Mesh(new THREE.ShapeGeometry(sh), M.hintHead)); head.renderOrder = 6; head.name = 'hint-head'; g.add(head);
  N.slot.add(g); N.turnHint = g;   // a child of the slot: the model fit carries it to the real dash and it faces the seated eye with the slot
}
function turnHint(on) { try { B.hintOn = !!on; if (on) { B.hintInput = false; B.hintT = 0; } } catch (e) {} }
// per frame (end of applyState): the welcome lights follow the door, the hint breathes, the flash rides the headlight values set above
function beatsApply(dt) {
  try { beatWelcome(dt); beatHint(dt); beatFlash(dt); goldApply(dt); } catch (e) { if (!B.warned) { B.warned = true; console.warn('[TR3D] beats', e); } }
}
function goldApply(dt) {   // BEAT the moving gold: a bright arc runs round the wheel rim (0.35 rev/s) and the other way round the ignition ring; the rings breathe
  if (N.rimComet) N.rimComet.rotation.z += dt * 2.2;
  if (N.tachComet) N.tachComet.rotation.z -= dt * 2.6;
  if (N.ringComet) N.ringComet.rotation.z += dt * 0.9;
  const br = 0.5 + 0.5 * Math.sin(S.t * 1.6);
  if (N.rimGold) N.rimGold.material.opacity = 0.5 + 0.3 * br;
  if (N.tachGold) N.tachGold.material.opacity = 0.35 + 0.3 * br;
}
function beatWelcome(dt) {
  const W = BEAT.welcome, door = N.door, rig = door && door.userData.welcome, lamp = L.catchGlow; if (!rig || !lamp) return;
  if (B.welcomeT >= 0) B.welcomeT += dt;
  // fades in over 0.4 s as the door step starts, holds through the sit, and goes with the dome over the last third of the door close
  const k = (B.welcomeT >= 0 ? smooth(clamp(B.welcomeT / W.fadeIn, 0, 1)) : 0) * smooth(clamp(S.doorOpen / 0.35, 0, 1)) * (S.catchT >= 0 ? 0 : 1);
  B.welcomeK = k;
  M.welcomeGlow.opacity = 0.5 * k; M.welcomeStrip.emissiveIntensity = 1.3 * k; M.welcomePool.opacity = 0.75 * k;
  const on = k > 0.002; if (N.welcomePool) N.welcomePool.visible = on;
  if (on) {   // the ember light is dark until the catch (seconds after the door has closed): borrow it as the handle lamp, warm white, at the recess
    lamp.intensity = W.light * k; lamp.color.setHex(W.color); lamp.distance = 1.2; B.lampBorrowed = true;
    const p = lamp.position.copy(rig.userData.handle); door.localToWorld(p);
    const hp = door.getWorldPosition(B.v = B.v || new THREE.Vector3()); if (N.welcomePool) N.welcomePool.position.set(hp.x + W.pool[0], GROUND + 0.008, hp.z + W.pool[1]);
  } else if (B.lampBorrowed) {   // hand the ember back: its colour, range and place at the slot (the procedural layout or the fitted one)
    B.lampBorrowed = false; lamp.color.setHex(0xd8ae5e); lamp.distance = 1.4; lamp.position.fromArray(S.rigModel ? mw(MODEL_FIT.lights.catchGlow) : (L.proc ? L.proc.catchGlow : [-0.62, 0.74, -0.44]));
  }
}
function beatHint(dt) {
  const g = N.turnHint; if (!g) return;
  const masked = !!(S.tierState && S.tierState.masked);   // BEAT the tier probe's hidden burst (runProbe) poses the key at 60 deg behind the mask: not the user's turn
  if (!masked && (S.deg >= 16 || S.sagT >= 0 || S.catchT >= 0)) { B.hintInput = true; B.hintOn = false; }   // BEAT real input (the idle nudge stops at 14 deg): hide, and never auto-show again
  const want = B.hintOn && N.keySeated && N.key && N.key.visible ? 1 : 0;
  B.hintK = S.rm ? want : B.hintK + (want - B.hintK) * (1 - Math.exp(-dt / BEAT.hint.fade));
  if (want) B.hintT += dt;
  const k = B.hintK; g.visible = k > 0.01; if (!g.visible) return;
  const H = BEAT.hint, br = S.rm ? 0.7 : lerp(H.lo, H.hi, 0.5 - 0.5 * Math.cos(2 * Math.PI * B.hintT / H.breathe));   // 0.35 -> 0.9 -> 0.35 over 2.2 s; static in reduced motion
  const nudge = clamp(S.deg / 14, 0, 1);                                                                             // the idle nudge rocks the key to 14 deg: the arrowhead glows with it
  M.hintArc.opacity = br * k; M.hintHead.opacity = clamp(br + 0.1 + 0.55 * nudge, 0, 1) * k;
}
function flashLevel(t) {   // 0..1: two 120 ms pulses 180 ms apart, 25 ms attack and 35 ms release
  const F = BEAT.flash; let f = 0;
  for (const s of [0, F.pulse + F.gap]) { const u = (t - s) / F.pulse; if (u > 0 && u < 1) f = Math.max(f, smooth(clamp(u / 0.2, 0, 1)) * smooth(clamp((1 - u) / 0.3, 0, 1))); }
  return f;
}
function beatFlash(dt) {
  if (B.flashT < 0) { B.flashK = 0; return; }
  if (!B.flashFreeze) B.flashT += dt;
  const F = BEAT.flash, f = B.flashK = flashLevel(B.flashT);
  if (!B.flashFreeze && B.flashT > F.pulse * 2 + F.gap + 0.1) B.flashT = -1;   // settled: the idle values from applyState stand while the canvas fades
  if (f <= 0) return;
  if (S.catchT < 0) {   // BEAT before the catch (the unlock flash at the door): the lamps are off, so the pools, cones, the welcome lamps and bloom carry it
    M.pool.opacity = Math.max(M.pool.opacity, 0.5 * f); M.beam.uniforms.k.value = Math.max(M.beam.uniforms.k.value, 0.1 * f);
    if (M.poolGrid) M.poolGrid.uniforms.k.value = Math.max(M.poolGrid.uniforms.k.value, 0.6 * f);
    if (M.welcomePool) M.welcomePool.opacity = Math.max(M.welcomePool.opacity, 0.9 * f); if (M.welcomeGlow) M.welcomeGlow.opacity = Math.max(M.welcomeGlow.opacity, 0.8 * f);
    if (S.bloom) S.bloom.strength += F.bloom * f * (TIERS[S.tier].bloomK || 1);
    return;
  }
  const m = 1 + F.k * f;   // 2.5x at the peak: the lamps, the floor pools, the beam cones; the cabin lights are not touched (no white-out)
  if (L.heads) for (const h of L.heads) h.intensity *= m;
  M.pool.opacity = clamp(M.pool.opacity * m, 0, 1); M.beam.uniforms.k.value *= m; M.flood.opacity = clamp(M.flood.opacity * m, 0, 0.02);
  if (M.poolGrid) M.poolGrid.uniforms.k.value = clamp(M.poolGrid.uniforms.k.value * (1 + 0.3 * f), 0, 1);
  if (L.spill) L.spill.intensity *= 1 + F.spill * f;
  if (S.bloom) S.bloom.strength += F.bloom * f * (TIERS[S.tier].bloomK || 1);
}
// stage starts (startMove): the door step lights the welcome lamps, 'seated' shows the hint until the first input, the dissolve flashes
function beatsStage(name, instant) {
  if (instant) return;   // harness snapshots set their own beat state (beatsSnapshot)
  if (name === 'door') { B.welcomeT = 0; B.flashT = 0; B.flashFreeze = false; }   // BEAT the unlock: the lights flash twice as you arrive, the lamps come on
  if (name === 'seated' && !B.hintInput) { B.hintOn = true; B.hintT = 0; }
  if (name === 'dissolve') { B.flashT = 0; B.flashFreeze = false; B.hintOn = false; }
}
// harness poses: ?shot=welcome (door step mid-way, lamps on), welcomesit (sit mid-way, lamps on), hint (seated, arc at the nudge peak), flash (dissolve at the second pulse)
function beatsSnapshot(name) {
  switch (name) {
    case 'welcome': RIG.placed = false; startMove('door', true, 0.5); N.key.visible = false; S.sway = 0; B.welcomeT = 1; return true;
    case 'welcomesit': startMove('door', true, 1); startMove('sit', true, 0.5); N.key.visible = false; S.sway = 0; B.welcomeT = 1; return true;
    case 'hint': startMove('seated', true); turnHint(true); keyAngle(14); B.hintT = BEAT.hint.breathe * 0.5; B.hintK = 1; return true;
    case 'flash': snapshot('catch'); startMove('dissolve'); if (S.move) S.move.t = 0.36; B.flashT = 0.36; B.flashFreeze = true; return true;
  }
  return false;
}
function beatsInfo() {
  return { welcomeT: +B.welcomeT.toFixed(3), welcomeK: +(B.welcomeK || 0).toFixed(3), welcomeLight: L.catchGlow ? +L.catchGlow.intensity.toFixed(3) : null, welcomePool: M.welcomePool ? +M.welcomePool.opacity.toFixed(3) : null,
    hintOn: B.hintOn, hintK: +B.hintK.toFixed(3), hintInput: B.hintInput, hintVisible: !!(N.turnHint && N.turnHint.visible), hintArc: M.hintArc ? +M.hintArc.opacity.toFixed(3) : null, hintHead: M.hintHead ? +M.hintHead.opacity.toFixed(3) : null,
    flashT: +B.flashT.toFixed(3), flashK: +B.flashK.toFixed(3), heads: L.heads ? +L.heads[0].intensity.toFixed(2) : null, pool: M.pool ? +M.pool.opacity.toFixed(3) : null, beam: M.beam ? +M.beam.uniforms.k.value.toFixed(3) : null, bloom: S.bloom ? +S.bloom.strength.toFixed(3) : null };
}

const TR3D = { mount, stage, keyAngle, ignite, catch: catchFn, blip, dissolve, dispose, setQuality, stats, snapshot, bench, benchGpu, pick, stepDown: reason => stepDown(reason || 'harness'), MODEL_HINTS, TIERS, version: '2.2' };   // stepDown: harness only (one ladder step, as the watchdog would)
TR3D.turnHint = turnHint; TR3D.beats = beatsInfo;   // BEAT turnHint(on): the key-turn arc; beats(): beat state for the harness
try { window.TR3D = TR3D; } catch (e) {}
export default TR3D;
