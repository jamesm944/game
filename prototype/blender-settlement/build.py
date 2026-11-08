"""Ageofwind coastal settlement diorama — rebuildable Blender build script.
Run: Blender -b --factory-startup --python-exit-code 1 -P build.py [-- --final]
"""
import sys, math, random
sys.path.insert(0, "/Users/jamesmoss/.local/share/muse/skills/bundled/muse-core--exact-minimal-literal-tests~v1/skills/blender/scripts")
import bpy
import bpy_helpers as H
from mathutils import noise

FINAL = "--final" in sys.argv
OUT = "/tmp/blender-settlement/render.png" if FINAL else "/tmp/blender-settlement/preview.png"
rng = random.Random(1407)

P = dict(world=340.0, sea_level=0.0)

# ---------- terrain height field ----------
def coast_x(y):
    return -26.0 + math.sin(y * 0.011) * 10.0 + math.sin(y * 0.031) * 3.5

def ground_z(x, y):
    d = x - coast_x(y)  # >0 inland
    if d < 0:
        return max(-7.0, d * 0.16 - 0.25)
    base = 0.15 + min(d, 46.0) * 0.095
    hills = max(0.0, math.hypot(x * 0.75, y) - 68.0) * 0.17
    hills *= 1.0 + 0.4 * math.sin(y * 0.02 + x * 0.013)
    n = noise.noise((x * 0.015, y * 0.015, 3.7)) * 1.35 + noise.noise((x * 0.06, y * 0.06, 7.3)) * 0.35
    z = base + hills + n
    town_flat = math.exp(-((x - 14) ** 2 + (y - 0) ** 2) / (2 * 36.0 ** 2))
    z = z * (1.0 - town_flat) + 2.35 * town_flat
    church_pad = math.exp(-((x - (coast_x(-14) + 7.0)) ** 2 + (y + 14) ** 2) / (2 * 9.0 ** 2))
    z = z * (1.0 - church_pad) + 1.7 * church_pad
    return z

def build_terrain():
    size, seg = P["world"], 150
    verts, faces, colors = [], [], []
    step = size / seg
    sand = (0.76, 0.64, 0.42); grass_a = (0.20, 0.36, 0.10); grass_b = (0.32, 0.47, 0.16); rock = (0.42, 0.40, 0.36)
    for j in range(seg + 1):
        for i in range(seg + 1):
            x = -size / 2 + i * step; y = -size / 2 + j * step
            z = ground_z(x, y)
            verts.append((x, y, z))
            patch = noise.noise((x * 0.045, y * 0.045, 9.1)) * 0.5 + 0.5
            if z < 0.55:
                c = sand
            else:
                t = min(1.0, max(0.0, patch))
                c = tuple(grass_a[k] * (1 - t) + grass_b[k] * t for k in range(3))
                if z > 7.5:
                    c = tuple(c[k] * 0.45 + rock[k] * 0.55 for k in range(3))
            path = min(abs(y - math.sin(x * 0.05) * 3.0), abs(x - 8 - math.sin(y * 0.04) * 2.0))
            if z >= 0.55 and path < 2.6:
                f = max(0.0, 1 - path / 2.6) * 0.65
                c = tuple(c[k] * (1 - f) + (0.52, 0.42, 0.26)[k] * f for k in range(3))
            colors.append((c[0]**2.2, c[1]**2.2, c[2]**2.2, 1.0))
    for j in range(seg):
        for i in range(seg):
            a = j * (seg + 1) + i; b = a + seg + 1
            faces.append((a, a + 1, b + 1, b))
    mesh = bpy.data.meshes.new("TerrainMesh")
    mesh.from_pydata(verts, [], faces); mesh.update()
    attr = mesh.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="POINT")
    for i, c in enumerate(colors):
        attr.data[i].color = c
    obj = bpy.data.objects.new("Terrain", mesh)
    H.link(obj)
    mat = bpy.data.materials.new("TerrainMat"); mat.use_nodes = True
    nt = mat.node_tree; bsdf = nt.nodes["Principled BSDF"]
    vc = nt.nodes.new("ShaderNodeVertexColor"); vc.layer_name = "Col"
    nt.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.95
    obj.data.materials.append(mat)
    for p in mesh.polygons: p.use_smooth = True
    return obj

def build_water():
    mat = H.material("Sea", "#14506a", roughness=0.09, metallic=0.0)
    H.add_noise_variation(mat, scale=2.0, amount=0.22, roughness_amount=0.3, bump=0.8)
    return H.add_plane("Sea", size=(P["world"] * 1.4, P["world"] * 1.4), location=(0, 0, P["sea_level"]), mat=mat)

# ---------- shared materials / helpers ----------
M = {}
def make_materials():
    M["timber"] = H.material_preset("Timber", "wood", "#7a5230", scale=2.0)
    M["timber_dark"] = H.material_preset("TimberDark", "wood", "#4f3520", scale=2.0)
    M["plaster"] = H.material_preset("Plaster", "concrete", "#d8c9a8", scale=3.0)
    M["stone"] = H.material_preset("Stone", "stone", "#8d8a80", scale=2.0)
    M["roof_red"] = H.material_preset("RoofRed", "ceramic", "#a8442f", scale=3.0)
    M["roof_brown"] = H.material_preset("RoofBrown", "wood", "#7a4630", scale=3.0)
    M["leaf"] = H.material_preset("Leaf", "foliage", "#3e6b24", scale=2.0)
    M["pine"] = H.material_preset("Pine", "foliage", "#274d26", scale=2.0)
    M["trunk"] = H.material_preset("Trunk", "wood", "#5a4030", scale=1.0)
    M["glow"] = H.emission_material("WindowGlow", "#ffb35c", strength=2.2)
    M["sail"] = H.material_preset("Sail", "fabric", "#e8e0cc", scale=2.0)
    M["wheat"] = H.material_preset("Wheat", "foliage", "#a8842f", scale=4.0)

def move(obj, col):
    try: bpy.context.scene.collection.objects.unlink(obj)
    except Exception: pass
    if obj.name not in col.objects: col.objects.link(obj)
    return obj

def prism_roof(name, w, d, h, loc, mat, col=None):
    pts = [(-w/2, 0.0), (w/2, 0.0), (0.0, h)]
    o = H.add_extrusion(name, pts, depth=d, location=(loc[0], loc[1] + d/2, loc[2]), rotation=(90, 0, 0), mat=mat, bevel=0.03)
    if col: move(o, col)
    return o

def house_variant(idx, wall_mat, roof_mat, w=6.0, d=5.0, wh=3.0):
    col = H.collection(f"House{idx}")
    objs = []
    objs.append(H.add_box(f"H{idx}_walls", size=(w, d, wh), location=(0, 0, wh/2), mat=wall_mat, bevel=0.04))
    objs.append(prism_roof(f"H{idx}_roof", w + 1.0, d + 1.0, 2.0, (0, 0, wh), roof_mat))
    objs.append(H.add_cylinder(f"H{idx}_chim", radius=0.22, depth=1.4, location=(w*0.28, 0, wh + 1.5), mat=M["stone"]))
    objs.append(H.add_box(f"H{idx}_door", size=(0.95, 0.12, 1.9), location=(0, -d/2 - 0.03, 0.95), mat=M["timber_dark"]))
    for sx in (-1, 1):
        objs.append(H.add_box(f"H{idx}_win{sx}", size=(0.8, 0.1, 0.8), location=(sx * w * 0.3, -d/2 - 0.03, 1.7), mat=M["glow"]))
        objs.append(H.add_box(f"H{idx}_beam{sx}", size=(0.18, 0.14, wh), location=(sx * (w/2 - 0.1), -d/2 - 0.02, wh/2), mat=M["timber_dark"]))
    for o in objs: move(o, col)
    col.hide_render = False
    return col

def person_variant(idx, tunic):
    col = H.collection(f"Person{idx}")
    body = H.add_lathe(f"P{idx}_body", [(0.0, 0.0), (0.17, 0.02), (0.14, 0.55), (0.18, 0.95), (0.11, 1.28), (0.05, 1.38)], segments=14, mat=H.material(f"Tunic{idx}", tunic, roughness=0.85))
    head = H.add_sphere(f"P{idx}_head", radius=0.13, location=(0, 0, 1.52), mat=H.material(f"Skin{idx}", "#c9976f", roughness=0.7))
    move(body, col); move(head, col)
    col.hide_render = False
    return col

def tree_variant(idx, pine=False):
    col = H.collection(f"Tree{idx}")
    objs = [H.add_cylinder(f"T{idx}_trunk", radius=0.16, depth=1.6, location=(0, 0, 0.8), mat=M["trunk"])]
    if pine:
        for k, (r, z, h) in enumerate([(1.5, 2.0, 2.2), (1.1, 3.2, 2.0), (0.7, 4.3, 1.8)]):
            objs.append(H.add_cone(f"T{idx}_c{k}", radius=r, depth=h, location=(0, 0, z), mat=M["pine"]))
    else:
        for k, (x, y, z, r) in enumerate([(0, 0, 2.6, 1.35), (0.8, 0.3, 2.1, 0.95), (-0.8, -0.2, 2.2, 0.9)]):
            objs.append(H.add_sphere(f"T{idx}_s{k}", radius=r, location=(x, y, z), mat=M["leaf"]))
    for o in objs: move(o, col)
    col.hide_render = False
    return col

def place(col, name, x, y, yaw=0.0, scale=1.0, sink=0.06):
    return H.collection_instance(col, name, location=(x, y, ground_z(x, y) - sink), rotation=(0, 0, yaw), scale=scale)

def build_hero():
    tcx, tcy = 6.0, -2.0; tz = ground_z(tcx, tcy)
    H.add_box("TC_platform", size=(13, 11, 0.7), location=(tcx, tcy, tz + 0.3), mat=M["stone"], bevel=0.05)
    H.add_box("TC_hall", size=(8.5, 6.5, 3.6), location=(tcx, tcy, tz + 2.4), mat=M["timber"], bevel=0.05)
    prism_roof("TC_roof", 9.7, 7.7, 3.0, (tcx, tcy, tz + 4.2), M["roof_brown"])
    H.add_box("TC_tower", size=(2.4, 2.4, 7.5), location=(tcx + 2.6, tcy + 1.6, tz + 4.3), mat=M["stone"], bevel=0.05)
    H.add_cone("TC_spire", radius=1.9, depth=3.2, location=(tcx + 2.6, tcy + 1.6, tz + 9.6), mat=M["roof_red"])
    for sx in (-1, 1):
        H.add_box(f"TC_win{sx}", size=(1.0, 0.12, 1.1), location=(tcx + sx * 2.4, tcy - 3.3, tz + 2.6), mat=M["glow"])
        H.add_cylinder(f"TC_pole{sx}", radius=0.05, depth=3.4, location=(tcx + sx * 4.4, tcy - 3.4, tz + 2.3), mat=M["timber_dark"])
        H.add_box(f"TC_banner{sx}", size=(0.85, 0.05, 1.5), location=(tcx + sx * 4.4 + 0.42, tcy - 3.4, tz + 3.1), mat=H.material(f"Banner{sx}", "#7e2f35" if sx < 0 else "#274b7c", roughness=0.8))
    H.add_box("TC_door", size=(1.4, 0.14, 2.4), location=(tcx, tcy - 3.3, tz + 1.8), mat=M["timber_dark"])
    chx, chy = coast_x(-14) + 7.0, -14.0; cz = ground_z(chx, chy)
    H.add_box("Church_nave", size=(6, 9, 4.5), location=(chx, chy, cz + 2.2), mat=M["stone"], bevel=0.05)
    prism_roof("Church_roof", 7.0, 10.0, 2.6, (chx, chy, cz + 4.45), M["roof_red"])
    H.add_box("Church_tower", size=(3, 3, 11), location=(chx, chy - 5.2, cz + 5.5), mat=M["stone"], bevel=0.05)
    H.add_cone("Church_spire", radius=2.3, depth=6.5, location=(chx, chy - 5.2, cz + 14.2), mat=M["roof_red"])
    H.add_box("Church_win", size=(0.9, 0.12, 2.2), location=(chx, chy - 6.75, cz + 6.5), mat=M["glow"])
    wx, wy = 34.0, 14.0; wz = ground_z(wx, wy)
    H.add_cylinder("Mill_tower", radius=1.9, depth=7.5, radius_top=1.35, location=(wx, wy, wz + 3.75), mat=M["plaster"])
    H.add_cone("Mill_cap", radius=2.0, depth=2.2, location=(wx, wy, wz + 8.5), mat=M["roof_brown"])
    hub = (wx, wy - 1.75, wz + 7.6)
    H.add_cylinder("Mill_hub", radius=0.32, depth=0.7, location=hub, rotation=(90, 0, 0), mat=M["timber_dark"])
    for k in range(4):
        a = math.radians(28 + k * 90)
        H.add_box(f"Mill_sail{k}", size=(0.95, 0.07, 5.6), location=(hub[0] + math.sin(a) * 2.6, hub[1] - 0.25, hub[2] + math.cos(a) * 2.6), rotation=(28 + k * 90, 0, 0), mat=M["sail"])
    px = coast_x(16) + 2.0
    for i in range(9):
        H.add_box(f"Pier_plank{i}", size=(1.15, 3.4, 0.18), location=(px - i * 1.18, 16, 0.55), mat=M["timber"])
    for i in range(4):
        for sy in (-1.4, 1.4):
            H.add_cylinder(f"Pier_post{i}_{sy}", radius=0.13, depth=1.8, location=(px - 0.6 - i * 2.4, 16 + sy, 0.0), mat=M["timber_dark"])
    H.add_box("Crates", size=(1.2, 1.2, 1.2), location=(px + 1.6, 14.6, ground_z(px + 1.6, 14.6) + 0.6), rotation=(0, 0, 24), mat=M["timber"])
    for i in range(3):
        H.add_cylinder(f"Barrel{i}", radius=0.42, depth=0.95, location=(px + 2.6, 15.5 + i * 0.95, ground_z(px + 2.6, 16) + 0.48), mat=M["timber_dark"])
    bx, by = coast_x(-30) - 12.0, -30.0
    H.add_extrusion("Boat_hull", [(-2.6, 0.0), (2.6, 0.0), (1.9, 0.85), (-1.9, 0.85)], depth=1.5, location=(bx, by + 0.75, -0.15), rotation=(90, 0, -18), mat=M["timber"], bevel=0.08)
    H.add_cylinder("Boat_mast", radius=0.07, depth=4.6, location=(bx, by, 2.4), mat=M["timber_dark"])
    H.add_extrusion("Boat_sail", [(0.0, 0.0), (2.1, 0.25), (0.15, 3.4)], depth=0.05, location=(bx + 0.08, by, 0.9), rotation=(0, 0, -18), mat=M["sail"])
    for i, (mx, my, yaw) in enumerate([(16, -12, 15), (21, -10, -10), (13.5, -16, 40)]):
        mz = ground_z(mx, my)
        for dx, dy in [(-1.3, -0.9), (1.3, -0.9), (-1.3, 0.9), (1.3, 0.9)]:
            H.add_cylinder(f"Stall{i}_leg{dx}{dy}", radius=0.06, depth=2.1, location=(mx + dx, my + dy, mz + 1.05), mat=M["timber_dark"])
        H.add_box(f"Stall{i}_top", size=(3.1, 2.3, 0.12), location=(mx, my, mz + 2.25), rotation=(0, 6, yaw), mat=H.material(f"StallTop{i}", ["#a33b32", "#33548c", "#3f7a44"][i], roughness=0.85))
        H.add_box(f"Stall{i}_goods", size=(2.4, 1.5, 0.55), location=(mx, my, mz + 0.85), rotation=(0, 0, yaw), mat=M["timber"])

def scatter(houses, trees, people):
    spots = [(-6, -8), (2, -14), (14, -6), (20, 4), (-4, 8), (26, -12), (30, 6), (-12, -2), (40, -4), (44, 10), (8, 14), (-2, -22), (18, 16), (48, -10), (36, 18), (0, 22), (52, 4), (-14, 12)]
    for i, (x, y) in enumerate(spots):
        place(houses[i % len(houses)], f"House_i{i}", x, y, yaw=rng.uniform(-35, 35), scale=rng.uniform(0.9, 1.18))
    for i, (x, y, yaw) in enumerate([(28, 22, 12), (37, 26, -8), (24, -24, 20)]):
        H.add_box(f"Field{i}", size=(11, 6.5, 0.18), location=(x, y, ground_z(x, y) + 0.04), rotation=(0, 0, yaw), mat=M["wheat"], bevel=0.1)
    placed, tries = 0, 0
    while placed < 240 and tries < 4000:
        tries += 1
        x = rng.uniform(-120, 150); y = rng.uniform(-140, 140)
        if x < coast_x(y) + 4: continue
        if abs(x - 12) < 52 and abs(y) < 34: continue
        if math.hypot(x - 64, y + 70) < 12: continue
        z = ground_z(x, y)
        if z < 0.4: continue
        if abs(ground_z(x + 1.6, y) - z) + abs(ground_z(x, y + 1.6) - z) > 1.7: continue
        H.collection_instance(rng.choice(trees), f"Tree_i{placed}", location=(x, y, z - 0.08), rotation=(rng.uniform(-2, 2), rng.uniform(-2, 2), rng.uniform(0, 360)), scale=rng.uniform(0.75, 1.5))
        placed += 1
    for i in range(36):
        x = rng.uniform(-90, 130); y = rng.uniform(-120, 120)
        if x < coast_x(y) + 2: continue
        r = rng.uniform(0.4, 1.5)
        H.add_sphere(f"Rock{i}", radius=r, location=(x, y, ground_z(x, y) + r * 0.3), scale=(1, rng.uniform(0.6, 1), rng.uniform(0.5, 0.8)), mat=M["stone"])
    for i in range(74):
        x, y = (rng.gauss(12, 15), rng.gauss(-4, 11)) if i < 46 else (rng.gauss(30, 18), rng.gauss(10, 14))
        if x < coast_x(y) + 3: continue
        H.collection_instance(rng.choice(people), f"Person_i{i}", location=(x, y, ground_z(x, y) - 0.02), rotation=(0, 0, rng.uniform(0, 360)), scale=rng.uniform(1.18, 1.34))

def exclude_from_view(col):
    def walk(lc):
        if lc.collection == col:
            lc.exclude = True
            return True
        return any(walk(ch) for ch in lc.children)
    walk(bpy.context.view_layer.layer_collection)

def main():
    H.reset_scene()
    make_materials()
    build_terrain()
    build_water()
    houses = [house_variant(0, M["plaster"], M["roof_red"]), house_variant(1, M["timber"], M["roof_brown"]), house_variant(2, M["plaster"], M["roof_brown"], w=7.0, d=5.6, wh=3.5)]
    trees = [tree_variant(0), tree_variant(1), tree_variant(2, pine=True), tree_variant(3, pine=True)]
    people = [person_variant(i, c) for i, c in enumerate(["#7e2f35", "#274b7c", "#3f6b35", "#8a6a2f", "#5d435f"])]
    for col in houses + trees + people:
        exclude_from_view(col)
    build_hero()
    scatter(houses, trees, people)
    H.sun_and_sky(elevation=26.0, azimuth=228.0, strength=0.32, sun_strength=3.4)
    H.volume_fog(density=0.00013, size=360.0, center=(10, 0, 0), height=70.0)
    cam = H.add_camera("Camera", location=(62, -68, 30), target=(8, -2, 3.5), lens=40.0)
    cam.data.clip_end = 1200.0
    print(H.report())
    H.set_render(engine="CYCLES", resolution=(1600, 1000) if FINAL else (1120, 700), samples=96 if FINAL else 20, percentage=100, view_transform="AgX", device="GPU")
    H.render_still(OUT)
    if FINAL:
        H.save_blend("/tmp/blender-settlement/settlement.blend")

main()
