"""Bake the DNA brush textures for Master Schemer from the Blender library's B-DNA model.

    blender -b -P tools/bake_dna_brush.py        (needs the Molecular Nodes extension)

Writes app/js/dna-tex.js: grayscale+alpha PNGs as data URIs plus the metrics the brush
needs. The brush is Affinity-style — a head cap, a repeating body, a tail cap — mapped
along a line in "base units" (u = base index, 1 u = one helical rise):

  head    u in [-overhang, CAP]      the 5' end, always helical phase 0
  body    one turn, u in [0, 10)     seamless: the twist is patched to exactly 36°/bp
  tail[k] u in [-CAP, overhang]      relative to the 3' end; k = bases mod 10, so the
                                     tail always meets the body in phase

Tail phases come from screw symmetry: rotating the helix by k·36° about its axis makes
base i look like base i+k, so the end of a k-rotated model is the end of a strand k
bases longer. Two layers for the duplex — the whole duplex, and strand 1 alone (strand 2
held out) — let the app tint each backbone with its own strand's colour.

Lighting is a headlight plus ambient: symmetric top-to-bottom, so a strand drawn
right-to-left (texture rotated 180°) is lit the same as one drawn left-to-right.

Geometry comes from the library's own modules (bdna_fiber, mn_surface), see
_3D Modeling/Blender/assets/ASSETS.md, "DNA_Duplex".
"""
import base64
import json
import math
import os
import struct
import sys
import zlib

import numpy as np

LIB = os.environ.get("BLENDER_LIB", os.path.expanduser(
    "~/Insync/ian.hoffecker@gmail.com/Google Drive/_3D Modeling/Blender")) + "/assets"
sys.path.insert(0, f"{LIB}/scripts")
import bdna_fiber   # noqa: E402
import mn_surface   # noqa: E402
import bpy          # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "app", "js", "dna-tex.js")
WORK = os.environ.get("DNA_BAKE_WORK", "/tmp/dna_bake")

N = 30          # bases in the baked model; a multiple of 10 so rotation k ↔ tail phase k
CAP = 3         # cap length in bases — end effects of the surface reach ~2.2 bases in
TILE = (10, 20)  # body tile crop, well clear of both ends
PX = 7.0        # pixels per Å
HALF_H = 15.0   # Å above/below the axis; the duplex surface reaches ~13
TWIST = 36.0

# ---- exact 10 bp/turn: keep 1BNA's fitted axis and rise, round the twist to 36° ----
_fit = bdna_fiber.fit_step


def fit_step_36(src_pdb=bdna_fiber.DEFAULT_SRC):
    R, t, axis, origin, twist, rise, rmsd = _fit(src_pdb)
    # rotation direction about +axis, from R's antisymmetric part
    w = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]])
    th = math.radians(TWIST) * (1 if np.dot(w, axis) > 0 else -1)
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    R36 = np.eye(3) + math.sin(th) * K + (1 - math.cos(th)) * K @ K
    t36 = origin - R36 @ origin + rise * axis    # same screw axis, same rise
    return R36, t36, axis, origin, TWIST, rise, rmsd


bdna_fiber.fit_step = fit_step_36


def png_la(gray, alpha):
    """Minimal 8-bit grayscale+alpha PNG encoder (Blender's Python has no PIL)."""
    h, w = gray.shape
    raw = np.dstack([gray, alpha]).astype(np.uint8)
    rows = b"".join(b"\x00" + raw[y].tobytes() for y in range(h))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(
            ">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 4, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def setup_scene(x0, x1):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "CUDA"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        sc.cycles.device = "GPU"
    except Exception as e:      # CPU is fine, just slower
        print("GPU unavailable:", e)
    sc.cycles.samples = 96
    sc.cycles.use_denoising = True
    sc.render.film_transparent = True
    sc.view_settings.view_transform = "Standard"
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.resolution_percentage = 100
    sc.render.resolution_x = round((x1 - x0) * PX)
    sc.render.resolution_y = round(2 * HALF_H * PX)

    if sc.world is None:
        sc.world = bpy.data.worlds.new("World")
    sc.world.use_nodes = True
    sc.world.node_tree.nodes["Background"].inputs[0].default_value = (1, 1, 1, 1)
    sc.world.node_tree.nodes["Background"].inputs[1].default_value = float(os.environ.get("DNA_AMB", 0.15))

    cam_data = bpy.data.cameras.new("Cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = x1 - x0          # the wider dimension
    cam = bpy.data.objects.new("Cam", cam_data)
    cam.location = ((x0 + x1) / 2, -300, 0)
    cam.rotation_euler = (math.radians(90), 0, 0)
    sc.collection.objects.link(cam)
    sc.camera = cam

    lamp_data = bpy.data.lights.new("Head", type="AREA")
    lamp_data.energy, lamp_data.size = float(os.environ.get("DNA_KEY", 4e5)), 400
    lamp = bpy.data.objects.new("Head", lamp_data)
    lamp.location = ((x0 + x1) / 2, -300, 0)
    lamp.rotation_euler = (math.radians(90), 0, 0)
    sc.collection.objects.link(lamp)
    return sc


def material(name, holdout=False):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    if holdout:
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        hold = nt.nodes.new("ShaderNodeHoldout")
        nt.links.new(hold.outputs[0], out.inputs[0])
    else:
        b = nt.nodes["Principled BSDF"]
        b.inputs["Base Color"].default_value = (0.92, 0.92, 0.92, 1)
        b.inputs["Roughness"].default_value = 0.7
    return mat


def render(sc, path):
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.array(img.pixels[:]).reshape(h, w, 4)[::-1]    # Blender stores bottom-up
    bpy.data.images.remove(img)
    return px


def main():
    os.makedirs(WORK, exist_ok=True)
    mn = mn_surface.start_blender()
    white, hold = material("white"), material("hold", holdout=True)

    fibers, objs = {}, {}
    for kind, l2 in (("ds", N), ("ss", 0)):
        pdb = f"{WORK}/fiber_{kind}.pdb"
        fibers[kind] = bdna_fiber.write_fiber(pdb, strand1_len=N, strand2_len=l2, pose="raw")
        obj = mn_surface.realize(mn, pdb, f"DNA_{kind}")
        slot = (fibers[kind]["chain"] == "B").astype(int)
        mn_surface.paint_by_nearest_atom(obj, fibers[kind]["xyz"], slot, [white, white])
        obj.hide_render = True
        objs[kind] = obj

    f = fibers["ds"]
    rise = f["rise"]
    print(f"twist {f['twist']:.2f}°  rise {rise:.3f} Å")
    # u = 0 at the start of base 0's slot: the mean axial position of position 0, less half a rise
    xref = {k: float(fb["xyz"][fb["pos"] == 0][:, 0].mean()) - rise / 2 for k, fb in fibers.items()}
    xs = [v.co.x for o in objs.values() for v in o.data.vertices]
    x0, x1 = min(xs) - 3, max(xs) + 3
    zs = [v.co.z for v in objs["ds"].data.vertices] + [v.co.y for v in objs["ds"].data.vertices]
    print(f"duplex surface radius {max(abs(z) for z in zs):.1f} Å")
    sc = setup_scene(x0, x1)

    def to_px(kind, u):
        return round((xref[kind] + u * rise - x0) * PX)

    shots = {}      # (layer, k) -> rgba
    for k in range(1 if os.environ.get("DNA_QUICK") else 10):
        for kind in ("ds", "ss"):
            obj = objs[kind]
            obj.hide_render = False
            obj.rotation_euler = (math.radians(TWIST * k), 0, 0)
            layers = [("ds", white), ("ds1", hold)] if kind == "ds" else [("ss", white)]
            for layer, second in layers:
                obj.data.materials[1] = second      # slot 1 = strand 2 (unused on ss)
                shots[(layer, k)] = render(sc, f"{WORK}/{layer}_{k}.png")
            obj.data.materials[1] = white
            obj.hide_render = True

    def crop(rgba, a, b):
        c = rgba[:, a:b]
        alpha = np.clip(c[..., 3], 0, 1)
        lum = (c[..., 0] * 0.2126 + c[..., 1] * 0.7152 + c[..., 2] * 0.0722)
        lum = np.where(alpha > 1e-4, lum / np.maximum(alpha, 1e-4), 0)   # un-premultiply
        g = np.clip(LO + (lum - lo) * (HI - LO) / (hi - lo), 0, 1) * 255   # levels, see below
        return "data:image/png;base64," + base64.b64encode(
            png_la(np.round(g), np.round(alpha * 255))).decode()

    if os.environ.get("DNA_QUICK"):
        return
    # one levels mapping for every layer, from the duplex: its bright tops land at HI so
    # the tint shows the chosen colour at full strength, its deepest grooves at LO so
    # the form survives the tint
    ref = shots[("ds", 0)]
    lum0 = (ref[..., :3] @ [0.2126, 0.7152, 0.0722])[ref[..., 3] > 0.99]
    lo, hi = np.percentile(lum0, 2), np.percentile(lum0, 98)
    LO, HI = 0.30, 0.97
    out = dict(rise=rise, twist=TWIST, px=PX, halfH=HALF_H * PX, cap=CAP, layers={})
    for layer in ("ds", "ds1", "ss"):
        kind = "ss" if layer == "ss" else "ds"
        s0 = shots[(layer, 0)]
        ppb = rise * PX                       # pixels per base
        # surface extent past the end bases, from the alpha channel
        cols = np.where(s0[..., 3].max(0) > 0.02)[0]
        left = (cols.min() - to_px(kind, 0)) / ppb
        right = (cols.max() + 1 - to_px(kind, N)) / ppb
        head_a, head_b = int(cols.min()), to_px(kind, CAP)
        tails = []
        for k in range(10):
            sk = shots[(layer, k)]
            ck = np.where(sk[..., 3].max(0) > 0.02)[0]
            ta, tb = to_px(kind, N - CAP), int(ck.max()) + 1
            tails.append(dict(src=crop(sk, ta, tb), w=(tb - ta) / ppb))
        out["layers"][layer] = dict(
            tile=crop(s0, to_px(kind, TILE[0]), to_px(kind, TILE[1])),
            head=dict(src=crop(s0, head_a, head_b), x=(head_a - to_px(kind, 0)) / ppb,
                      w=(head_b - head_a) / ppb),
            tail=tails, overhang=[float(-left), float(right)])
    # the duplex's full height, in Å — what a line's "diameter" maps to
    a = shots[("ds", 0)][..., 3].max(1)
    rows = np.where(a > 0.02)[0]
    out["diameter"] = (rows.max() + 1 - rows.min()) / PX
    out["ppb"] = rise * PX
    with open(OUT, "w") as fh:
        fh.write("// Generated by tools/bake_dna_brush.py — do not edit by hand.\n")
        fh.write("export default " + json.dumps(out) + ";\n")
    print(f"wrote {OUT}: {os.path.getsize(OUT) / 1024:.0f} KB, diameter {out['diameter']:.1f} Å")


main()
