"use strict";

const WORLD = 2048;
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const mini = document.getElementById("minimap");
const mctx = mini.getContext("2d");

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(1337);

let viewW = 0, viewH = 0, dpr = 1;
const cam = { x: 0, y: 0 };

function resize() {
  dpr = window.devicePixelRatio || 1;
  viewW = window.innerWidth; viewH = window.innerHeight;
  canvas.width = viewW * dpr; canvas.height = viewH * dpr;
  canvas.style.width = viewW + "px"; canvas.style.height = viewH + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  clampCam();
}
window.addEventListener("resize", resize);

function clampCam() {
  cam.x = Math.max(0, Math.min(WORLD - viewW, cam.x));
  cam.y = Math.max(0, Math.min(WORLD - viewH, cam.y));
}

const stock = { wood: 200, gold: 100 };

let nextId = 1;
const units = [], trees = [], golds = [], buildings = [], markers = [];
const groups = { 1: [], 2: [], 3: [], 4: [] };
let placing = null, attackMoveMode = false;

const FIRST = ["Wulf", "Ead", "Hild", "God", "Leof", "Sig", "Ael", "Osw", "Dun", "Beorht"];
const SECOND = ["stan", "ric", "gifu", "wine", "gyth", "mund", "thryth", "burg", "flaed", "gar"];
const ORIGINS = ["Grantebrūc", "Hamstede", "Eoforwic", "Lundenne", "Cantware", "Lindcolne"];
const TRAITS = ["Industrious", "Sturdy", "Quick", "Frail", "Brave", "Cautious", "Keen-eyed", "Stubborn", "Cheerful", "Gruff"];
const SKILL_NAMES = ["Farming", "Mining", "Woodcutting", "Combat", "Building"];

function makeUnit(type, x, y) {
  const r = mulberry32(nextId * 7919);
  const u = {
    id: nextId++, type, x, y, hp: 100,
    sel: false, dead: false, fade: 1, flashT: 0, hitT: 0,
    order: { kind: "idle" }, wx: x, wy: y, wanderT: r() * 4,
    carrying: 0, carryType: null, gatherT: 0, attackCd: 0,
    speed: type === "soldier" ? 82 : type === "enemy" ? 66 : 72,
    dmg: type === "soldier" ? 12 : type === "enemy" ? 8 : 4,
    range: 26,
    name: FIRST[(r() * 10) | 0] + SECOND[(r() * 10) | 0],
    origin: ORIGINS[(r() * ORIGINS.length) | 0],
    age: 16 + ((r() * 34) | 0),
    traits: [TRAITS[(r() * 10) | 0], TRAITS[(r() * 10) | 0]].filter((v, i, a) => a.indexOf(v) === i),
    skills: Object.fromEntries(SKILL_NAMES.map(s => [s, 20 + ((r() * 70) | 0)])),
  };
  if (type === "enemy") { u.name = "Raider"; u.hp = 80; }
  units.push(u);
  return u;
}

const tc = { id: nextId++, type: "tc", label: "Town Center 🏛️", w: 104, h: 88, x: 340, y: 340, hp: 800, maxHp: 800, sel: false, rally: null, flagT: 0 };
buildings.push(tc);
const BUILD_TYPES = [
  { key: "house", label: "House", icon: "🏠", w: 56, h: 56 },
  { key: "mill", label: "Mill", icon: "🌾", w: 64, h: 64 },
  { key: "barracks", label: "Barracks", icon: "🛡️", w: 72, h: 72 },
  { key: "tower", label: "Tower", icon: "🗼", w: 48, h: 48 },
];

for (let i = 0; i < 24; i++) makeUnit("villager", tc.x + 60 + rng() * 160, tc.y + 40 + rng() * 160);
for (let i = 0; i < 8; i++) makeUnit("soldier", tc.x + 240 + rng() * 90, tc.y + 120 + rng() * 120);
for (let i = 0; i < 5; i++) makeUnit("enemy", 1450 + rng() * 220, 900 + rng() * 300);
for (let i = 0; i < 42; i++) {
  const x = 150 + rng() * (WORLD - 300), y = 150 + rng() * (WORLD - 300);
  if (Math.hypot(x - tc.x, y - tc.y) > 180) trees.push({ x, y, amount: 100 });
}
for (let i = 0; i < 6; i++) {
  const cx = 400 + rng() * (WORLD - 800), cy = 400 + rng() * (WORLD - 800);
  if (Math.hypot(cx - tc.x, cy - tc.y) > 260)
    for (let j = 0; j < 3; j++) golds.push({ x: cx + rng() * 50 - 25, y: cy + rng() * 50 - 25, amount: 200 });
}

const terrain = document.createElement("canvas");
terrain.width = WORLD; terrain.height = WORLD;
(function paintTerrain() {
  const t = terrain.getContext("2d");
  t.fillStyle = "#58753c"; t.fillRect(0, 0, WORLD, WORLD);
  for (let i = 0; i < 260; i++) {
    const x = rng() * WORLD, y = rng() * WORLD, r = 20 + rng() * 90;
    t.fillStyle = rng() < 0.55 ? "#4f6a35" : "#618044";
    t.beginPath(); t.ellipse(x, y, r, r * 0.6, rng() * 3, 0, 7); t.fill();
  }
  for (let i = 0; i < 30; i++) {
    const x = rng() * WORLD, y = rng() * WORLD, r = 25 + rng() * 70;
    t.fillStyle = "#7a6a45";
    t.beginPath(); t.ellipse(x, y, r, r * 0.45, rng() * 3, 0, 7); t.fill();
  }
  t.strokeStyle = "rgba(255,255,255,0.035)";
  t.lineWidth = 1;
  for (let g = 0; g <= WORLD; g += 64) {
    t.beginPath(); t.moveTo(g, 0); t.lineTo(g, WORLD); t.stroke();
    t.beginPath(); t.moveTo(0, g); t.lineTo(WORLD, g); t.stroke();
  }
})();

function log(kind, msg) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="kind">${kind}</span>${msg}`;
  const list = document.getElementById("logList");
  list.prepend(li);
  while (list.children.length > 8) list.lastChild.remove();
}

const mouse = { x: 0, y: 0, down: false, dragging: false, sx: 0, sy: 0, shift: false };
const dragRect = () => ({
  x: Math.min(mouse.sx, mouse.wx), y: Math.min(mouse.sy, mouse.wy),
  w: Math.abs(mouse.wx - mouse.sx), h: Math.abs(mouse.wy - mouse.sy),
});
Object.defineProperty(mouse, "wx", { get: () => mouse.x + cam.x });
Object.defineProperty(mouse, "wy", { get: () => mouse.y + cam.y });

function unitAt(wx, wy) {
  let best = null, bd = 14;
  for (const u of units) {
    if (u.dead) continue;
    const d = Math.hypot(u.x - wx, u.y - wy);
    if (d < bd) { bd = d; best = u; }
  }
  return best;
}
function buildingAt(wx, wy) {
  return buildings.find(b => wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) || null;
}
function resourceAt(wx, wy) {
  return trees.find(t => Math.hypot(t.x - wx, t.y - wy) < 18) ||
    golds.find(g => Math.hypot(g.x - wx, g.y - wy) < 16) || null;
}

function selectedUnits() { return units.filter(u => u.sel && !u.dead); }
function selectedBuildings() { return buildings.filter(b => b.sel); }

function clearSelection() {
  for (const u of units) u.sel = false;
  for (const b of buildings) b.sel = false;
}

function selectBox(rect, additive) {
  if (!additive) clearSelection();
  for (const u of units) {
    if (u.dead || u.type === "enemy") continue;
    if (u.x >= rect.x && u.x <= rect.x + rect.w && u.y >= rect.y && u.y <= rect.y + rect.h)
      u.sel = true;
  }
  if (!selectedUnits().length && !additive)
    for (const b of buildings)
      if (b.x + b.w >= rect.x && b.x <= rect.x + rect.w && b.y + b.h >= rect.y && b.y <= rect.y + rect.h)
        b.sel = true;
  afterSelectionChange();
}
function selectOne(ent, additive) {
  if (!additive) clearSelection();
  ent.sel = additive ? !ent.sel : true;
  afterSelectionChange();
}
function selectSameTypeOnScreen(u) {
  clearSelection();
  for (const o of units)
    if (!o.dead && o.type === u.type &&
      o.x >= cam.x && o.x <= cam.x + viewW && o.y >= cam.y && o.y <= cam.y + viewH)
      o.sel = true;
  afterSelectionChange();
  log("SEL", `${selectedUnits().length} × ${u.type}`);
}
function afterSelectionChange() {
  const n = selectedUnits().length + selectedBuildings().length;
  log("SEL", n ? `${n} selected` : "deselected");
}

function formationOffsets(n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const r = 12 * Math.sqrt(i), a = i * 2.399963;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}

function issueMove(list, tx, ty, kind = "move") {
  const offs = formationOffsets(list.length);
  list.forEach((u, i) => {
    u.order = { kind, tx: tx + offs[i][0], ty: ty + offs[i][1], target: null };
    if (kind === "amove") u.order.tx = tx + offs[i][0];
  });
  markers.push({ type: kind === "amove" ? "amove" : "move", x: tx, y: ty, t: 0, dur: 0.7 });
}
function issueAttack(list, target) {
  list.forEach(u => { u.order = { kind: "attack", target }; });
  markers.push({ type: "attack", target, t: 0, dur: 0.9 });
}
function issueGather(villagers, res, resKind) {
  villagers.forEach(u => { u.order = { kind: "gather", target: res, resKind }; u.gatherT = 0; });
  markers.push({ type: "gather", x: res.x, y: res.y, t: 0, dur: 0.8 });
}

canvas.addEventListener("mousedown", e => {
  if (e.button !== 0) return;
  const mx = e.clientX, my = e.clientY;
  if (placing) { tryPlace(); if (!e.shiftKey) exitModes(); return; }
  if (attackMoveMode) {
    const list = selectedUnits();
    if (list.length) { issueMove(list, mouse.wx, mouse.wy, "amove"); log("AMOV", `attack-move → ${list.length} units`); }
    exitModes();
    return;
  }
  mouse.down = true; mouse.dragging = false;
  mouse.sx = mouse.wx; mouse.sy = mouse.wy;
  mouse.shift = e.shiftKey;
});

canvas.addEventListener("mousemove", e => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  if (mouse.down && (Math.abs(mouse.wx - mouse.sx) > 5 || Math.abs(mouse.wy - mouse.sy) > 5))
    mouse.dragging = true;
});

canvas.addEventListener("mouseup", e => {
  if (e.button !== 0 || !mouse.down) return;
  mouse.down = false;
  if (mouse.dragging) {
    selectBox(dragRect(), mouse.shift);
    mouse.dragging = false;
  } else {
    const u = unitAt(mouse.wx, mouse.wy);
    if (u && u.type !== "enemy") selectOne(u, e.shiftKey);
    else {
      const b = buildingAt(mouse.wx, mouse.wy);
      if (b) selectOne(b, e.shiftKey);
      else if (!e.shiftKey) { clearSelection(); afterSelectionChange(); }
    }
  }
});

canvas.addEventListener("dblclick", e => {
  if (e.button !== 0 || placing || attackMoveMode) return;
  const u = unitAt(mouse.wx, mouse.wy);
  if (u && u.type !== "enemy") selectSameTypeOnScreen(u);
});

canvas.addEventListener("contextmenu", e => {
  e.preventDefault();
  if (placing) { exitModes(); return; }
  if (attackMoveMode) { exitModes(); return; }
  const wx = e.clientX + cam.x, wy = e.clientY + cam.y;
  const sU = selectedUnits(), sB = selectedBuildings();

  if (sB.length && !sU.length) {
    sB.forEach(b => { b.rally = { x: wx, y: wy }; b.flagT = 1; });
    markers.push({ type: "rally", x: wx, y: wy, t: 0, dur: 0.8 });
    log("RALLY", `${sB[0].label.split(" ")[0]} rally point set`);
    return;
  }
  if (!sU.length) return;

  const enemy = units.find(u => u.type === "enemy" && !u.dead && Math.hypot(u.x - wx, u.y - wy) < 14);
  if (enemy) {
    issueAttack(sU, enemy);
    log("ATK", `→ ${enemy.name} #${enemy.id}`);
    return;
  }
  const res = resourceAt(wx, wy);
  if (res) {
    const kind = trees.includes(res) ? "wood" : "gold";
    const vill = sU.filter(u => u.type === "villager"), rest = sU.filter(u => u.type !== "villager");
    if (vill.length) issueGather(vill, res, kind);
    if (rest.length) issueMove(rest, res.x, res.y);
    if (vill.length) log("GATH", `${vill.length} villagers → ${kind}`);
    return;
  }
  issueMove(sU, wx, wy);
  log("MOVE", `${sU.length} units → (${wx | 0}, ${wy | 0})`);
});

const panKeys = new Set();
let lastGroupTap = { key: null, t: 0 };

window.addEventListener("keydown", e => {
  const k = e.key.toLowerCase();
  if (["arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) e.preventDefault();
  if (k.startsWith("arrow")) panKeys.add(k.slice(5));

  const mod = e.ctrlKey || e.metaKey;
  if (/^[1-4]$/.test(e.key)) {
    if (mod || e.shiftKey) storeGroup(+e.key);
    else recallGroup(+e.key);
    e.preventDefault();
    return;
  }
  switch (k) {
    case "escape":
      if (placing || attackMoveMode) exitModes();
      else { clearSelection(); afterSelectionChange(); }
      break;
    case "s": {
      const l = selectedUnits();
      l.forEach(u => { u.order = { kind: "idle" }; });
      if (l.length) log("STOP", `${l.length} units halted`);
      break;
    }
    case "a": attackMoveMode = true; canvas.classList.add("attackmove"); break;
    case "f": focusSelection(); break;
    case "b": pulseBuildMenu(); break;
  }
});
window.addEventListener("keyup", e => {
  const k = e.key.toLowerCase();
  if (k.startsWith("arrow")) panKeys.delete(k.slice(5));
});

function storeGroup(n) {
  groups[n] = selectedUnits().map(u => u.id);
  flashChip(n);
  log("GRP", `group ${n} stored (${groups[n].length})`);
}
function recallGroup(n) {
  const now = performance.now();
  const ids = groups[n].filter(id => units.some(u => u.id === id && !u.dead));
  groups[n] = ids;
  if (!ids.length) return;
  clearSelection();
  ids.forEach(id => { const u = units.find(x => x.id === id); if (u) u.sel = true; });
  afterSelectionChange();
  flashChip(n);
  if (lastGroupTap.key === n && now - lastGroupTap.t < 350) {
    const l = selectedUnits();
    const cx = l.reduce((s, u) => s + u.x, 0) / l.length;
    const cy = l.reduce((s, u) => s + u.y, 0) / l.length;
    centerCam(cx, cy);
    log("GRP", `centered on group ${n}`);
  }
  lastGroupTap = { key: n, t: now };
}
function centerCam(x, y) { cam.x = x - viewW / 2; cam.y = y - viewH / 2; clampCam(); }
function focusSelection() {
  const l = [...selectedUnits(), ...selectedBuildings()];
  if (!l.length) return;
  centerCam(l.reduce((s, u) => s + u.x, 0) / l.length, l.reduce((s, u) => s + u.y, 0) / l.length);
}
function exitModes() {
  placing = null; attackMoveMode = false;
  canvas.classList.remove("placing", "attackmove");
  document.querySelectorAll(".buildBtn").forEach(b => b.classList.remove("active"));
}
function pulseBuildMenu() {
  const el = document.getElementById("buildMenu");
  el.classList.add("pulse");
  setTimeout(() => el.classList.remove("pulse"), 600);
}

const buildGrid = document.getElementById("buildGrid");
BUILD_TYPES.forEach(bt => {
  const btn = document.createElement("button");
  btn.className = "buildBtn";
  btn.innerHTML = `${bt.icon}<small>${bt.label}</small>`;
  btn.onclick = () => startPlacing(bt, btn);
  buildGrid.appendChild(btn);
});
function startPlacing(bt, btn) {
  placing = bt;
  canvas.classList.add("placing");
  document.querySelectorAll(".buildBtn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
}
function placementRect(bt) {
  const gx = Math.round((mouse.wx - bt.w / 2) / 16) * 16;
  const gy = Math.round((mouse.wy - bt.h / 2) / 16) * 16;
  return { x: gx, y: gy, w: bt.w, h: bt.h };
}
function placeValid(r) {
  if (r.x < 0 || r.y < 0 || r.x + r.w > WORLD || r.y + r.h > WORLD) return false;
  for (const t of trees) if (Math.hypot(t.x - (r.x + r.w / 2), t.y - (r.y + r.h / 2)) < r.w / 2 + 20) return false;
  for (const g of golds) if (Math.hypot(g.x - (r.x + r.w / 2), g.y - (r.y + r.h / 2)) < r.w / 2 + 20) return false;
  for (const b of buildings) if (!(r.x > b.x + b.w || r.x + r.w < b.x || r.y > b.y + b.h || r.y + r.h < b.y)) return false;
  return true;
}
function tryPlace() {
  const r = placementRect(placing);
  if (!placeValid(r)) return;
  buildings.push({
    id: nextId++, type: placing.key, label: `${placing.label} ${placing.icon}`,
    w: placing.w, h: placing.h, x: r.x, y: r.y, hp: 400, maxHp: 400,
    sel: false, rally: null, flagT: 0,
  });
  log("BUILD", `${placing.label} placed (PROTOTYPE: free)`);
  exitModes();
}

mini.addEventListener("mousedown", e => {
  minimapJump(e);
  const move = ev => minimapJump(ev);
  const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});
function minimapJump(e) {
  const r = mini.getBoundingClientRect();
  centerCam(((e.clientX - r.left) / r.width) * WORLD, ((e.clientY - r.top) / r.height) * WORLD);
}

function injuryFactor(u) {
  const ratio = u.hp / 100;
  if (ratio < 0.35) return 0.5;
  if (ratio < 0.7) return 0.75;
  return 1;
}

function update(dt) {
  const PAN = 620;
  if (panKeys.has("up")) cam.y -= PAN * dt;
  if (panKeys.has("down")) cam.y += PAN * dt;
  if (panKeys.has("left")) cam.x -= PAN * dt;
  if (panKeys.has("right")) cam.x += PAN * dt;
  clampCam();

  for (const m of markers) m.t += dt;
  for (let i = markers.length - 1; i >= 0; i--) if (markers[i].t > markers[i].dur) markers.splice(i, 1);
  for (const b of buildings) if (b.flagT > 0) b.flagT -= dt;

  for (const u of units) {
    if (u.flashT > 0) u.flashT -= dt;
    if (u.hitT > 0) u.hitT -= dt;
    if (u.attackCd > 0) u.attackCd -= dt;
    if (u.dead) { u.fade -= dt * 1.5; continue; }

    const sp = u.speed * injuryFactor(u);
    const o = u.order;
    let dest = null;

    if (o.kind === "move" || o.kind === "amove") {
      dest = [o.tx, o.ty];
      if (Math.hypot(dest[0] - u.x, dest[1] - u.y) < 5) u.order = { kind: "idle" };
      if (o.kind === "amove") {
        const near = units.find(en => en.type === "enemy" && !en.dead && Math.hypot(en.x - u.x, en.y - u.y) < 130);
        if (near) { u.order = { kind: "attack", target: near }; dest = null; }
      }
    } else if (o.kind === "attack") {
      const t = o.target;
      if (!t || t.dead) u.order = { kind: "idle" };
      else {
        const d = Math.hypot(t.x - u.x, t.y - u.y);
        if (d > u.range) dest = [t.x, t.y];
        else if (u.attackCd <= 0) {
          u.attackCd = 0.9; u.hitT = 0.25;
          t.hp -= u.dmg; t.flashT = 0.2; t.__lastAttacker = u;
          markers.push({ type: "hit", x: t.x, y: t.y, t: 0, dur: 0.3 });
          if (t.hp <= 0) {
            t.dead = true; t.sel = false;
            log("KILL", `${u.name} killed ${t.name} #${t.id}`);
          }
        }
      }
    } else if (o.kind === "gather") {
      const r = o.target;
      if (!r || r.amount <= 0 || u.carrying >= 20) {
        if (u.carrying > 0) {
          if (r && r.amount > 0) u.__lastResource = r;
          u.order = { kind: "deposit" };
        } else u.order = { kind: "idle" };
      } else {
        const d = Math.hypot(r.x - u.x, r.y - u.y);
        if (d > 22) dest = [r.x, r.y];
        else {
          u.gatherT += dt;
          if (u.gatherT > 0.9) {
            u.gatherT = 0;
            const take = Math.min(4, r.amount, 20 - u.carrying);
            u.carrying += take; r.amount -= take;
            u.carryType = o.resKind;
            if (r.amount <= 0) log("DEPL", `${o.resKind} source exhausted`);
          }
        }
      }
    } else if (o.kind === "deposit") {
      const b = nearestDropoff(u);
      if (!b) u.order = { kind: "idle" };
      else {
        const d = Math.hypot(b.x + b.w / 2 - u.x, b.y + b.h - u.y);
        if (d > 30) dest = [b.x + b.w / 2, b.y + b.h + 14];
        else {
          stock[u.carryType] += u.carrying;
          u.carrying = 0;
          const src = u.__lastResource;
          if (src && src.amount > 0) u.order = { kind: "gather", target: src, resKind: u.carryType };
          else u.order = { kind: "idle" };
        }
      }
    } else if (u.type === "enemy") {
      const atk = u.__lastAttacker;
      if (atk && !atk.dead && Math.hypot(atk.x - u.x, atk.y - u.y) < 240)
        u.order = { kind: "attack", target: atk };
    } else {
      u.wanderT -= dt;
      if (u.wanderT <= 0) {
        u.wanderT = 3 + Math.random() * 5;
        u.__wanderDest = [u.wx + Math.random() * 140 - 70, u.wy + Math.random() * 140 - 70];
      }
      if (u.__wanderDest) {
        const [ax, ay] = u.__wanderDest;
        if (Math.hypot(ax - u.x, ay - u.y) > 4) dest = [ax, ay];
        else u.__wanderDest = null;
      }
    }

    if (dest) {
      const dx = dest[0] - u.x, dy = dest[1] - u.y, d = Math.hypot(dx, dy);
      const step = Math.min(sp * dt, d);
      u.x += (dx / d) * step; u.y += (dy / d) * step;
      u.__heading = Math.atan2(dy, dx);
    }
    u.x = Math.max(8, Math.min(WORLD - 8, u.x));
    u.y = Math.max(8, Math.min(WORLD - 8, u.y));
  }

  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i];
    if (u.dead && u.fade <= 0) {
      groups[1] = groups[1].filter(id => id !== u.id);
      groups[2] = groups[2].filter(id => id !== u.id);
      groups[3] = groups[3].filter(id => id !== u.id);
      groups[4] = groups[4].filter(id => id !== u.id);
      units.splice(i, 1);
    }
  }
  for (let i = trees.length - 1; i >= 0; i--) if (trees[i].amount <= 0) trees.splice(i, 1);
  for (let i = golds.length - 1; i >= 0; i--) if (golds[i].amount <= 0) golds.splice(i, 1);
}

function nearestDropoff(u) {
  return buildings.reduce((best, b) =>
    Math.hypot(b.x - u.x, b.y - u.y) < Math.hypot(best.x - u.x, best.y - u.y) ? b : best, buildings[0]);
}

function draw() {
  ctx.fillStyle = "#222"; ctx.fillRect(0, 0, viewW, viewH);
  ctx.drawImage(terrain, cam.x, cam.y, viewW, viewH, 0, 0, viewW, viewH);

  ctx.save();
  ctx.translate(-cam.x, -cam.y);

  for (const t of trees) {
    ctx.fillStyle = "#5b4632"; ctx.fillRect(t.x - 2, t.y - 2, 4, 10);
    ctx.fillStyle = t.amount < 30 ? "#3e5c33" : "#39702f";
    ctx.beginPath(); ctx.moveTo(t.x - 11, t.y); ctx.lineTo(t.x + 11, t.y); ctx.lineTo(t.x, t.y - 22); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath(); ctx.moveTo(t.x - 4, t.y - 6); ctx.lineTo(t.x + 2, t.y - 6); ctx.lineTo(t.x, t.y - 18); ctx.closePath(); ctx.fill();
  }
  for (const g of golds) {
    ctx.fillStyle = "#c9a227";
    [[-7, 2], [5, 3], [-1, -6]].forEach(([ox, oy]) => ctx.fillRect(g.x + ox, g.y + oy, 9, 8));
    ctx.fillStyle = "#e8c84a"; ctx.fillRect(g.x - 5, g.y, 5, 4);
  }

  for (const b of buildings) {
    ctx.fillStyle = b.type === "tc" ? "#8a6d4a" : "#96805c";
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = "#6e573c";
    ctx.beginPath(); ctx.moveTo(b.x - 6, b.y); ctx.lineTo(b.x + b.w + 6, b.y); ctx.lineTo(b.x + b.w / 2, b.y - b.h * 0.35); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = b.sel ? "#fff" : "rgba(0,0,0,0.3)";
    ctx.lineWidth = b.sel ? 2 : 1;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    if (b.sel) {
      ctx.font = "13px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(b.label, b.x + b.w / 2, b.y - b.h * 0.35 - 6);
      if (b.rally) {
        ctx.setLineDash([5, 5]); ctx.strokeStyle = "rgba(240,180,41,0.7)"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(b.x + b.w / 2, b.y + b.h / 2); ctx.lineTo(b.rally.x, b.rally.y); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (b.rally) drawFlag(b.rally.x, b.rally.y, b.flagT);
  }

  for (const m of markers) {
    const p = m.t / m.dur;
    ctx.globalAlpha = 1 - p;
    if (m.type === "move" || m.type === "rally") {
      ctx.strokeStyle = "#7ec46f"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(m.x, m.y, 6 + p * 22, 0, 7); ctx.stroke();
    } else if (m.type === "amove") {
      ctx.strokeStyle = "#e8912c"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(m.x, m.y, 6 + p * 22, 0, 7); ctx.stroke();
    } else if (m.type === "gather") {
      ctx.strokeStyle = "#e8c84a"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(m.x, m.y, 8 + p * 10, 0, 7); ctx.stroke();
    } else if (m.type === "attack") {
      const t = m.target;
      ctx.strokeStyle = "#e05d5d"; ctx.lineWidth = 2.5;
      const r = 12 - p * 5;
      ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, 7); ctx.stroke();
      [[0, -1], [0, 1], [-1, 0], [1, 0]].forEach(([dx, dy]) => {
        ctx.beginPath();
        ctx.moveTo(t.x + dx * (r + 2), t.y + dy * (r + 2));
        ctx.lineTo(t.x + dx * (r + 9), t.y + dy * (r + 9));
        ctx.stroke();
      });
    } else if (m.type === "hit") {
      ctx.fillStyle = "#ffd9a0";
      ctx.beginPath(); ctx.arc(m.x, m.y - 8, 4 + p * 8, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  const sorted = [...units].sort((a, b) => a.y - b.y);
  for (const u of sorted) {
    if (u.dead && u.fade <= 0) continue;
    ctx.globalAlpha = u.dead ? Math.max(0, u.fade) : 1;
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath(); ctx.ellipse(u.x, u.y + 6, 7, 3, 0, 0, 7); ctx.fill();

    if (u.sel) {
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(u.x, u.y + 6, 10, 5, 0, 0, 7); ctx.stroke();
    }
    const body =
      u.type === "enemy" ? "#b03a30" :
      u.type === "soldier" ? "#4a6da7" : "#c9a06a";
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.arc(u.x, u.y, u.type === "soldier" || u.type === "enemy" ? 7.5 : 6.5, 0, 7); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.4)"; ctx.lineWidth = 1; ctx.stroke();

    const hx = Math.cos(u.__heading || 0) * 4, hy = Math.sin(u.__heading || 0) * 4;
    ctx.fillStyle = u.type === "enemy" ? "#5e1f18" : "#2b3a55";
    ctx.beginPath(); ctx.arc(u.x + hx, u.y + hy, 2.4, 0, 7); ctx.fill();

    if (u.carrying > 0) {
      ctx.fillStyle = u.carryType === "gold" ? "#e8c84a" : "#8a6440";
      ctx.fillRect(u.x - 3, u.y - 17, 6, 5);
    }
    if (u.flashT > 0) {
      ctx.fillStyle = `rgba(255,80,60,${u.flashT * 2})`;
      ctx.beginPath(); ctx.arc(u.x, u.y, 8, 0, 7); ctx.fill();
    }
    if (u.order.kind === "gather") {
      ctx.strokeStyle = "#e8c84a"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(u.x, u.y, 11, -Math.PI / 2, -Math.PI / 2 + (u.gatherT / 0.9) * 6.28); ctx.stroke();
    }
    if (u.hp < 100 || u.sel) {
      const w = 18, r = u.hp / (u.type === "enemy" ? 80 : 100);
      ctx.fillStyle = "#222"; ctx.fillRect(u.x - w / 2, u.y - 15, w, 3.5);
      ctx.fillStyle = r > 0.5 ? "#7ec46f" : r > 0.25 ? "#e8c84a" : "#e05d5d";
      ctx.fillRect(u.x - w / 2, u.y - 15, w * Math.max(0, r), 3.5);
    }
    ctx.globalAlpha = 1;
  }

  if (placing) {
    const r = placementRect(placing), ok = placeValid(r);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = ok ? "#7ec46f" : "#e05d5d";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.globalAlpha = 0.9;
    ctx.font = "24px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(placing.icon, r.x + r.w / 2, r.y + r.h / 2 + 8);
    if (!ok) { ctx.fillStyle = "#e05d5d"; ctx.fillText("✕", r.x + r.w / 2, r.y + r.h / 2 - 14); }
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  if (mouse.dragging) {
    const r = dragRect();
    const sx = r.x - cam.x, sy = r.y - cam.y;
    ctx.fillStyle = "rgba(255,255,255,0.09)";
    ctx.fillRect(sx, sy, r.w, r.h);
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
    ctx.strokeRect(sx + 0.5, sy + 0.5, r.w, r.h);
  }

  drawMinimap();
}

function drawFlag(x, y, animT) {
  const bounce = animT > 0 ? Math.sin(animT * 12) * 4 * animT : 0;
  ctx.strokeStyle = "#3c3630"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 22 + bounce); ctx.stroke();
  ctx.fillStyle = "#f0b429";
  ctx.beginPath();
  ctx.moveTo(x, y - 22 + bounce); ctx.lineTo(x + 14, y - 17 + bounce); ctx.lineTo(x, y - 12 + bounce);
  ctx.closePath(); ctx.fill();
}

function drawMinimap() {
  const S = mini.width / WORLD;
  mctx.fillStyle = "#3f5730"; mctx.fillRect(0, 0, mini.width, mini.height);
  mctx.fillStyle = "#2c421f";
  for (const t of trees) mctx.fillRect(t.x * S - 1, t.y * S - 1, 2.5, 2.5);
  mctx.fillStyle = "#e8c84a";
  for (const g of golds) mctx.fillRect(g.x * S - 1.5, g.y * S - 1.5, 3, 3);
  mctx.fillStyle = "#c9a06a";
  for (const b of buildings) mctx.fillRect(b.x * S, b.y * S, Math.max(3, b.w * S), Math.max(3, b.h * S));
  for (const u of units) {
    if (u.dead) continue;
    mctx.fillStyle = u.type === "enemy" ? "#ff5d4a" : u.sel ? "#ffffff" : "#6fa8ff";
    mctx.fillRect(u.x * S - 1, u.y * S - 1, 2.5, 2.5);
  }
  mctx.strokeStyle = "#fff"; mctx.lineWidth = 1.5;
  mctx.strokeRect(cam.x * S, cam.y * S, viewW * S, viewH * S);
}

const infoCard = document.getElementById("infoCard");
let cardTick = 0;
function renderInfoCard() {
  const sU = selectedUnits().filter(u => u.type !== "enemy");
  const enemies = selectedUnits().filter(u => u.type === "enemy");
  const sB = selectedBuildings();
  let html = "<h3>Selection</h3>";

  if (sU.length === 1) {
    const u = sU[0];
    const role = u.type === "villager" ? "Villager 👷" : "Soldier ⚔️";
    const status = u.hp >= 70 ? '<span class="status-healthy">Healthy</span>'
      : u.hp >= 35 ? '<span class="status-wounded">Wounded — moving slower</span>'
      : '<span class="status-critical">Critical — half speed</span>';
    html += `
      <div class="name">${u.name}</div>
      <div class="sub">${role} · age ${u.age} · of ${u.origin} · #${u.id}</div>
      <div class="chips">${u.traits.map(t => `<span class="chip">${t}</span>`).join("")}</div>
      <div class="barlabel"><span>Health</span><span>${Math.max(0, u.hp | 0)}/100 · ${status}</span></div>
      <div class="bar hp"><div style="width:${Math.max(0, u.hp)}%"></div></div>
      ${SKILL_NAMES.map(s => `
        <div class="barlabel"><span>${s}</span><span>${u.skills[s]}</span></div>
        <div class="bar skill"><div style="width:${u.skills[s]}%"></div></div>`).join("")}
      <div class="sub" style="margin-top:6px">
        Order: <b>${orderLabel(u)}</b>${u.carrying > 0 ? ` · carrying ${u.carrying} ${u.carryType}` : ""}
      </div>`;
  } else if (sU.length > 1) {
    const counts = {};
    sU.forEach(u => counts[u.type] = (counts[u.type] || 0) + 1);
    const avg = sU.reduce((s, u) => s + u.hp, 0) / sU.length;
    html += `
      <div class="name">${sU.length} units</div>
      <div class="sub">${Object.entries(counts).map(([t, n]) => `${n}× ${t}`).join(", ")}</div>
      <div class="barlabel"><span>Avg health</span><span>${avg | 0}%</span></div>
      <div class="bar hp"><div style="width:${avg}%"></div></div>
      <div class="sub">Double-click one to inspect its Pop card.</div>`;
  } else if (sB.length === 1) {
    const b = sB[0];
    html += `
      <div class="name">${b.label}</div>
      <div class="sub">HP ${b.hp}/${b.maxHp}</div>
      <div class="bar hp"><div style="width:${(b.hp / b.maxHp) * 100}%"></div></div>
      <div class="sub">Right-click map to set <b>rally point</b>${b.rally ? ` — set at (${b.rally.x | 0}, ${b.rally.y | 0})` : " — none"}.</div>`;
  } else if (enemies.length) {
    html += `<div class="name">Raider</div><div class="sub">Enemy scout — no card (mock).</div>`;
  } else {
    html += `<div class="sub">Select a unit or drag a box.<br>Right-click to command.<br>Ctrl/⌘+1..4 stores a group.</div>`;
  }
  infoCard.innerHTML = html;
}
function orderLabel(u) {
  switch (u.order.kind) {
    case "idle": return "idle";
    case "move": return "moving";
    case "amove": return "attack-moving";
    case "attack": return `attacking #${u.order.target?.id ?? "?"}`;
    case "gather": return `gathering ${u.order.resKind}`;
    case "deposit": return "returning resources";
    default: return "?";
  }
}

const groupBar = document.getElementById("groupBar");
const chips = {};
[1, 2, 3, 4].forEach(n => {
  const c = document.createElement("div");
  c.className = "groupChip";
  c.innerHTML = `<b>${n}</b> · –`;
  c.onclick = () => recallGroup(n);
  c.ondblclick = () => recallGroup(n);
  groupBar.appendChild(c);
  chips[n] = c;
});
function flashChip(n) {
  chips[n].classList.add("flash");
  setTimeout(() => chips[n].classList.remove("flash"), 250);
}
function renderGroups() {
  [1, 2, 3, 4].forEach(n => {
    const alive = groups[n].filter(id => units.some(u => u.id === id && !u.dead)).length;
    chips[n].innerHTML = `<b>${n}</b> · ${alive || "–"}`;
  });
}

setInterval(() => {
  document.getElementById("resWood").textContent = stock.wood;
  document.getElementById("resGold").textContent = stock.gold;
  document.getElementById("popCount").textContent = units.filter(u => !u.dead && u.type !== "enemy").length;
}, 200);

log("INIT", "prototype ready — box-select & right-click");

resize();
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  draw();
  if (++cardTick % 6 === 0) { renderInfoCard(); renderGroups(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
