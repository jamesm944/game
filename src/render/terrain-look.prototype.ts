/** THROWAWAY: three terrain/camera compositions at /?prototype=terrain&variant=A.
 * A: tactical orthographic; B: settlement perspective; C: coastal panorama.
 * Visual-only synthetic heightfield; no simulation or pathfinding changes.
 */
import {
  ACESFilmicToneMapping,
  Box3,
  BoxGeometry,
  CapsuleGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  FogExp2,
  Group,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  Scene,
  TextureLoader,
  Vector3,
} from "three";
import { WebGPURenderer, MeshStandardNodeMaterial } from "three/webgpu";
import {
  attribute,
  color,
  mix,
  positionWorld,
  sin,
  smoothstep,
  texture as sampleTexture,
  time,
} from "three/tsl";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import grassUrl from "../assets/models/terrain/ambientcg-grass001/Grass001_1K-JPG_Color.jpg";
import tcUrl from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/TownCenter_FirstAge_Level3.gltf";
import houseUrl from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Houses_FirstAge_1_Level3.gltf";
import treeUrl from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Resource_Tree1.gltf";
import millUrl from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Windmill_FirstAge.gltf";
import farmUrl from "../assets/models/quaternius-ultimate-fantasy-rts/glTF/Farm_FirstAge_Level1_Wheat.gltf";

const variants = [
  {
    key: "A",
    name: "The commander's view",
    description: "Orthographic · 55° pitch · town-first framing",
    target: [4, 0, 0],
    eye: [4, 66, 46],
    span: 55,
  },
  {
    key: "B",
    name: "Life in the settlement",
    description: "Perspective · close civic focus · lower, human-scale angle",
    target: [5, 1, 1],
    eye: [35, 25, 39],
    span: 38,
  },
  {
    key: "C",
    name: "The coastal frontier",
    description: "Perspective · coastline-led composition · long horizon",
    target: [-4, 0, -8],
    eye: [-54, 43, 61],
    span: 74,
  },
];
const params = new URLSearchParams(location.search);
const useRust = params.get("backend") === "rust";
let active = Math.max(
  0,
  variants.findIndex((v) => v.key === params.get("variant")),
);
const scene = new Scene();
scene.background = new Color("#a9bec5");
scene.fog = new FogExp2("#a9bec5", 0.0035);
const benchmark = params.get("benchmark") === "1";
const renderWidth = benchmark ? 1600 : innerWidth;
const renderHeight = benchmark ? 1000 : innerHeight;
const renderer = new WebGPURenderer({ antialias: true });
renderer.setPixelRatio(benchmark ? 1 : Math.min(devicePixelRatio, 1.5));
renderer.setSize(renderWidth, renderHeight);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
renderer.shadowMap.enabled = true;
document.body.style.margin = "0";
document.body.append(renderer.domElement);
if (benchmark)
  renderer.domElement.style.cssText =
    "width:100vw;height:100vh;object-fit:contain";

const style = document.createElement("style");
style.textContent = `
body{overflow:hidden;background:#152427;color:#f2eddd;font:14px Inter,system-ui,sans-serif}canvas{display:block}
.panel{position:fixed;z-index:3;background:#142225e8;border:1px solid #d5c19745;box-shadow:0 14px 45px #0003;backdrop-filter:blur(14px)}
header{top:26px;left:28px;padding:18px 23px;width:330px;pointer-events:none}small{color:#d0bc8c;letter-spacing:.18em;font-size:10px}h1{font:28px Georgia,serif;margin:9px 0}p{color:#c6d1cc;line-height:1.6;margin:8px 0 0;font-size:12px}
#stats{right:26px;top:26px;padding:13px 18px;min-width:190px;font-size:11px;line-height:1.9;color:#c6d1cc}
nav{bottom:24px;left:50%;transform:translateX(-50%);border-radius:14px;display:flex;align-items:center;padding:9px;gap:12px;white-space:nowrap}
button{cursor:pointer;border:1px solid #d5c19755;background:#26383a;color:#fff4da;border-radius:8px;padding:10px 15px;font:12px inherit}button:hover{background:#3c5454}#label{min-width:270px;text-align:center}#label b{display:block;font:17px Georgia,serif}#label span{font-size:10px;color:#b8c6bf}#help{position:fixed;bottom:98px;left:28px;color:#253b39;font-size:11px;text-shadow:0 1px 4px #fff9;pointer-events:none}#status{position:fixed;inset:45% 20%;text-align:center;color:white;font-size:20px}
@media(max-width:800px){#stats{top:auto;bottom:155px}header{width:250px}nav{gap:5px}#label{min-width:190px}nav button{padding:10px}}
`;
document.head.append(style);
const ui = document.createElement("div");
ui.innerHTML = `<header class="panel"><small>AGEOFWIND / LOOK DEVELOPMENT</small><h1>A living coastline</h1><p>Continuous land. Soft shores. A town worth getting closer to.</p><p>${useRust ? "Live Rust movement / needs / deliveries slice" : "Throwaway visual study · no live simulation"}</p></header><aside id="stats" class="panel"></aside><div id="help">Drag to orbit · right-drag to pan · wheel to zoom<br>← → compare views · R restore framing</div><nav class="panel"><button id="prev" aria-label="Previous variant">←</button><div id="label"></div><button id="next" aria-label="Next variant">→</button><button id="reset">Reset view</button></nav><div id="status">Preparing terrain…</div>`;
document.body.append(ui);

const sun = new DirectionalLight("#fff1d1", 3.2);
sun.position.set(-25, 65, 35);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, {
  left: -65,
  right: 65,
  top: 65,
  bottom: -65,
  far: 180,
});
sun.shadow.bias = -0.0008;
scene.add(sun, new HemisphereLight("#c6dfe8", "#747451", 2.1));

// An analytic continuous coast is used to compare appearance, not as a
// replacement for the authoritative tile masks defined in ADR-0002.
function coast(z: number) {
  return -18 + Math.sin(z * 0.1) * 4 + Math.sin(z * 0.27) * 1.4;
}
function height(x: number, z: number) {
  const d = x - coast(z);
  if (d < 0) return Math.max(-5, d * 0.19 - 0.14);
  const hills = Math.max(0, Math.hypot(x * 0.8, z) - 25);
  return (
    -0.14 +
    Math.min(d, 7) * 0.11 +
    hills * 0.08 * (1 + 0.45 * Math.sin(z * 0.13 + x * 0.07))
  );
}
const ground = new PlaneGeometry(320, 320, 400, 400);
ground.rotateX(-Math.PI / 2);
const points = ground.attributes.position!;
const colors: number[] = [];
for (let i = 0; i < points.count; i++) {
  const x = points.getX(i),
    z = points.getZ(i),
    d = x - coast(z);
  points.setY(i, height(x, z));
  const grass = new Color("#849658"),
    sand = new Color("#d3be8f");
  const variation =
    Math.sin(x * 0.41 + Math.sin(z * 0.17)) * Math.cos(z * 0.37) * 0.04;
  grass.offsetHSL(variation * 0.3, 0, variation);
  const path = Math.min(
    Math.abs(z - Math.sin(x * 0.2) * 1.5),
    Math.abs(x - 6 - Math.sin(z * 0.17)),
  );
  grass.lerp(new Color("#b3a07b"), Math.max(0, 1 - path / 1.15) * 0.8);
  grass.lerp(sand, 1 - Math.min(1, Math.max(0, (d - 0.5) / 4)));
  if (d < 0) grass.lerp(new Color("#4e8d89"), Math.min(1, -d / 9));
  colors.push(grass.r, grass.g, grass.b);
}
ground.setAttribute("color", new Float32BufferAttribute(colors, 3));
ground.computeVertexNormals();
const texture = new TextureLoader().load(grassUrl);
texture.wrapS = texture.wrapT = RepeatWrapping;
texture.repeat.set(90, 90);
const shoreDistance = positionWorld.x
  .add(18)
  .sub(sin(positionWorld.z.mul(0.1)).mul(4))
  .sub(sin(positionWorld.z.mul(0.27)).mul(1.4));
const terrainMaterial = new MeshStandardNodeMaterial({
  roughness: 0.96,
  bumpMap: texture,
  bumpScale: 0.12,
});
terrainMaterial.colorNode = mix(
  color("#cbb687"),
  sampleTexture(texture, positionWorld.xz.mul(0.28)).rgb.mul(
    attribute("color", "vec3"),
  ),
  smoothstep(1, 5, shoreDistance),
);
const land = new Mesh(ground, terrainMaterial);
land.receiveShadow = true;
scene.add(land);

const waterMaterial = new MeshStandardNodeMaterial({
  transparent: true,
  opacity: 0.82,
  roughness: 0.25,
  metalness: 0.22,
});
const ripple = sin(
  positionWorld.x.mul(1.7).add(positionWorld.z.mul(2.3)).add(time.mul(1.3)),
)
  .mul(0.5)
  .add(0.5);
const waterColor = mix(
  color("#205160"),
  color("#6bada0"),
  smoothstep(-14, 1, shoreDistance),
);
const foam = smoothstep(0.25, 1.25, shoreDistance).mul(
  ripple.mul(0.35).add(0.5),
);
waterMaterial.colorNode = mix(
  waterColor.mul(ripple.mul(0.07).add(0.93)),
  color("#d9e5cf"),
  foam,
);
const water = new Mesh(new PlaneGeometry(320, 320), waterMaterial);
water.rotation.x = -Math.PI / 2;
water.position.y = -0.02;
scene.add(water);

const loader = new GLTFLoader();
const actors = new Group();
scene.add(actors);
async function model(url: string, width: number) {
  const root = (await loader.loadAsync(url)).scene;
  const box = new Box3().setFromObject(root),
    size = box.getSize(new Vector3());
  root.scale.multiplyScalar(width / Math.max(size.x, size.z));
  const scaled = new Box3().setFromObject(root),
    center = scaled.getCenter(new Vector3());
  root.position.set(-center.x, -scaled.min.y, -center.z);
  root.traverse((o) => {
    if (o instanceof Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  const wrapper = new Group();
  wrapper.add(root);
  return wrapper;
}
function plant(source: Group, x: number, z: number, rotation = 0) {
  const obj = source.clone(true);
  obj.position.set(x, height(x, z), z);
  obj.rotation.y = rotation;
  scene.add(obj);
  return obj;
}
type RustFrame = {
  tick: number;
  pops: { x: number; z: number }[];
  workers: number;
  threads_observed: number;
  digest: string;
  sim_ms: number;
  stock: number;
  ack: number;
};
let rustFrame: RustFrame | null = null;
let previousRust: RustFrame | null = null;
let rustReceived = 0;
let pollBusy = false;
let commandSequence = Date.now();
if (useRust) {
  setInterval(async () => {
    if (pollBusy) return;
    pollBusy = true;
    try {
      const frame = (await (
        await fetch("http://127.0.0.1:4189/snapshot")
      ).json()) as RustFrame;
      if (frame.tick !== rustFrame?.tick) {
        previousRust = rustFrame;
        rustFrame = frame;
        rustReceived = performance.now();
      }
    } finally {
      pollBusy = false;
    }
  }, 33);
  const actions = document.createElement("div");
  actions.className = "panel";
  actions.style.cssText =
    "position:fixed;left:28px;bottom:140px;padding:8px;z-index:9";
  for (const [name, kind] of [
    ["Move group", "move"],
    ["Resume work", "work"],
    ["Pause", "pause"],
  ]) {
    const button = document.createElement("button");
    button.textContent = name!;
    button.onclick = () => {
      void fetch("http://127.0.0.1:4189/command", {
        method: "POST",
        body: JSON.stringify({
          kind,
          seq: ++commandSequence,
          x: -10000,
          z: 12000,
        }),
      });
    };
    actions.append(button);
  }
  document.body.append(actions);
}
const walkers: Mesh[] = [];
for (let i = 0; i < (useRust ? 500 : 32); i++) {
  const pop = new Mesh(
    new CapsuleGeometry(0.19, 0.42, 3, 6),
    new MeshStandardMaterial({
      color: i < 20 ? "#3f6f9d" : "#a85d41",
      roughness: 0.85,
    }),
  );
  pop.castShadow = true;
  if (!useRust) actors.add(pop);
  walkers.push(pop);
}
let popBatch: InstancedMesh | null = null;
if (useRust) {
  popBatch = new InstancedMesh(
    walkers[0]!.geometry,
    new MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }),
    walkers.length,
  );
  popBatch.castShadow = true;
  walkers.forEach((_, i) =>
    popBatch!.setColorAt(i, new Color(i % 3 ? "#3f6f9d" : "#a85d41")),
  );
  actors.add(popBatch);
}
// Wharf gives a hard man-made silhouette against the soft organic shore.
for (let i = 0; i < 22; i++) {
  const board = new Mesh(
    new BoxGeometry(0.38, 0.16, 2.5),
    new MeshStandardMaterial({ color: "#8b7351", roughness: 0.9 }),
  );
  board.position.set(-24 + i * 0.4, 0.35, 12);
  board.castShadow = true;
  scene.add(board);
}

let camera: OrthographicCamera | PerspectiveCamera;
let controls: OrbitControls;
let backend = "initializing";
function showState() {
  const v = variants[active]!;
  document.querySelector("#label")!.innerHTML =
    `<b>${v.key} · ${v.name}</b><span>${v.description}</span>`;
  document.querySelector("#stats")!.innerHTML =
    `RENDERER &nbsp; ${backend}<br>SCENE &nbsp; fixed coastal settlement<br>CAMERA &nbsp; ${camera instanceof OrthographicCamera ? "orthographic" : "perspective"}<br>ZOOM &nbsp; ${camera instanceof OrthographicCamera ? camera.zoom.toFixed(2) + "×" : Math.round(camera.position.distanceTo(controls.target)) + " units"}<br>POPS &nbsp; ${useRust ? 500 : 32} scale stand-ins<br>LAND &nbsp; continuous heightfield${rustFrame ? `<br>RUST &nbsp; tick ${rustFrame.tick} · ${rustFrame.workers} workers<br>Threads observed &nbsp; ${rustFrame.threads_observed}<br>sim &nbsp; ${rustFrame.sim_ms.toFixed(3)} ms · ack ${rustFrame.ack}<br>stock &nbsp; ${rustFrame.stock}<br>digest &nbsp; ${rustFrame.digest}` : ""}`;
}
function choose(index: number) {
  active = (index + variants.length) % variants.length;
  const v = variants[active]!;
  const aspect = renderWidth / renderHeight;
  controls?.dispose();
  camera =
    active === 0
      ? new OrthographicCamera(
          (-v.span * aspect) / 2,
          (v.span * aspect) / 2,
          v.span / 2,
          -v.span / 2,
          0.1,
          700,
        )
      : new PerspectiveCamera(44, aspect, 0.1, 700);
  camera.position.set(v.eye[0]!, v.eye[1]!, v.eye[2]!);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(v.target[0]!, v.target[1]!, v.target[2]!);
  controls.minDistance = 12;
  controls.maxDistance = 115;
  controls.minZoom = 0.6;
  controls.maxZoom = 3;
  controls.maxPolarAngle = Math.PI * 0.46;
  controls.enableDamping = true;
  controls.update();
  params.set("variant", v.key);
  history.replaceState(null, "", `?${params}`);
  showState();
  console.info("Terrain prototype variant", v);
}
document
  .querySelector("#prev")!
  .addEventListener("click", () => choose(active - 1));
document
  .querySelector("#next")!
  .addEventListener("click", () => choose(active + 1));
document
  .querySelector("#reset")!
  .addEventListener("click", () => choose(active));
window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).closest("input,textarea,[contenteditable]"))
    return;
  if (e.key === "ArrowLeft") choose(active - 1);
  if (e.key === "ArrowRight") choose(active + 1);
  if (e.key.toLowerCase() === "r") choose(active);
});
window.addEventListener("resize", () => {
  if (benchmark) return;
  renderer.setSize(renderWidth, renderHeight);
  if (camera instanceof PerspectiveCamera)
    camera.aspect = innerWidth / innerHeight;
  else {
    camera.left = (-variants[active]!.span * innerWidth) / innerHeight / 2;
    camera.right = -camera.left;
  }
  camera.updateProjectionMatrix();
});
async function boot() {
  await renderer.init();
  backend = renderer.backend.constructor.name;
  const [tc, house, tree, mill, farm] = await Promise.all([
    model(tcUrl, 7),
    model(houseUrl, 3.8),
    model(treeUrl, 3),
    model(millUrl, 4),
    model(farmUrl, 5),
  ]);
  plant(tc, 5, -4);
  for (const [x, z] of [
    [-4, 4],
    [3, 8],
    [12, 6],
    [14, -5],
    [3, -13],
    [-6, -8],
    [14, -15],
    [22, 4],
  ])
    plant(house, x!, z!, 0.25 * x!);
  plant(mill, 22, -11);
  for (const [x, z] of [
    [24, -2],
    [25, 5],
    [32, 0],
    [32, 7],
  ])
    plant(farm, x!, z!);
  for (let i = 0; i < 190; i++) {
    const x = Math.sin(i * 127.1) * 65 + 19,
      z = Math.sin(i * 311.7) * 70;
    if (x < coast(z) + 5 || (x > -12 && x < 37 && Math.abs(z) < 23)) continue;
    const t = plant(tree, x, z, i);
    t.scale.setScalar(0.75 + 0.35 * (1 + Math.sin(i)));
  }
  choose(active);
  document.querySelector("#status")!.remove();
  const start = performance.now();
  let frames = 0;
  let lastFrame = performance.now();
  const intervals: number[] = [];
  const metrics = document.createElement("output");
  metrics.id = "hybrid-metrics";
  metrics.style.cssText =
    "position:fixed;bottom:0;left:0;background:#142225;color:white;font:10px monospace;z-index:10";
  if (benchmark) document.body.append(metrics);

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const elapsed = (now - start) / 1000;
    if (benchmark && elapsed > 3 && intervals.length < 600)
      intervals.push(now - lastFrame);
    lastFrame = now;
    if (benchmark && intervals.length === 600 && metrics.textContent === "") {
      intervals.sort((a, b) => a - b);
      metrics.textContent = JSON.stringify({
        engine: "three.js WebGPU",
        view: variants[active]!.key,
        p50_frame_ms: intervals[300],
        p95_frame_ms: intervals[570],
        frames: 600,
        pops: walkers.length,
        tick: rustFrame?.tick,
        digest: rustFrame?.digest,
        width: renderWidth,
        height: renderHeight,
        dpr: 1,
      });
      const capture = document.createElement("a");
      capture.textContent = "Download canvas screenshot";
      capture.id = "download-frame";
      capture.download = "three-" + variants[active]!.key + ".png";
      capture.href = renderer.domElement.toDataURL("image/png");
      capture.style.cssText =
        "position:fixed;right:20px;bottom:120px;background:#142225;color:white;z-index:20;padding:12px";
      document.body.append(capture);
    }

    walkers.forEach((pop, i) => {
      let x = -8 + ((i * 2.4 + elapsed * 0.35) % 27),
        z = Math.sin(i * 2.1) * 1.3;
      const p = rustFrame?.pops[i];
      const old = previousRust?.pops[i];
      if (p) {
        const alpha = Math.min(1, (performance.now() - rustReceived) / 33);
        x = (old ? old.x + (p.x - old.x) * alpha : p.x) / 1000;
        z = (old ? old.z + (p.z - old.z) * alpha : p.z) / 1000;
      }
      pop.position.set(x, height(x, z) + 0.5, z);
      if (popBatch) {
        pop.updateMatrix();
        popBatch.setMatrixAt(i, pop.matrix);
      }
    });
    if (popBatch) popBatch.instanceMatrix.needsUpdate = true;
    controls.update();
    renderer.render(scene, camera);
    window.dispatchEvent(
      new CustomEvent("hybrid-frame", {
        detail: {
          tick: rustFrame?.tick,
          pops: walkers.length,
          backend,
          variant: variants[active]!.key,
        },
      }),
    );
    if (++frames % 30 === 0) showState();
  });
}
boot().catch((error) => {
  document.querySelector("#status")!.textContent =
    `Preview unavailable: ${error.message}`;
  console.error(error);
});
