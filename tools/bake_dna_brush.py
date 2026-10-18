"""Bake the DNA brush textures for Master Schemer from the Blender library's B-DNA model.

    blender -b -P tools/bake_dna_brush.py        (needs the Molecular Nodes extension)

Writes app/js/dna-tex.js: grayscale+alpha PNGs as data URIs plus the metrics the brush
needs. The brush is Affinity-style — a head cap, a repeating body, a tail cap — mapped
along a line in "base units" (u = base index, 1 u = one helical rise):

  head[k] u in [-overhang, CAP]      a strand starting at helical phase k (u0 mod 10)
  body    one turn, u in [0, 10)     seamless: the twist is patched to exactly 36°/bp
  tail[k] u in [-CAP, overhang]      relative to the end; k = end u mod 10, so caps
                                     always meet the body in phase

Tail phases come from screw symmetry: rotating the helix by k·36° about its axis makes
base i look like base i+k, so the ends of a k-rotated model are a strand shifted by k
bases. Every layer shares one u frame (strand A's base 0), so a single strand can run on
out of a duplex in phase. Layers split the duplex by strand and backbone/bases (see
LAYERS) so the app can tint each part separately.

Lighting is a headlight plus ambient: symmetric top-to-bottom, so a strand drawn
right-to-left (texture rotated 180°) is lit the same as one drawn left-to-right.

Geometry comes from the library's own modules (bdna_fiber, mn_surface), see
_3D Modeling/Blender/assets/ASSETS.md, "DNA_Duplex".

    DNA_STYLE=ribbon blender -b -P tools/bake_dna_brush.py    (no extension needed)

bakes the oxView-like skin instead, into app/js/dna-tex-ribbon.js: the same fiber atoms,
drawn as a flat ribbon through each strand's backbone and one rounded slab per base. Same
frame, rise and caps, so the app swaps it in texture for texture.
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
STYLE = os.environ.get("DNA_STYLE", "space")
OUT = os.path.join(HERE, "..", "app", "js", "dna-tex.js" if STYLE == "space" else f"dna-tex-{STYLE}.js")
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


# ---- ribbon skin: plain meshes built from the fiber's atoms ----
RIB_W, RIB_T = 4.6, 1.3        # ribbon width and thickness, Å
SLAB_T, SLAB_W = 1.25, 2.1     # base slab half-thickness (along the axis) and half-width
STICK_R = 0.75                 # backbone → base connector radius
BB_ATOMS = ("P", "O5'", "C5'", "C4'", "C3'")


def _sq(w, e):
    return np.sign(w) * np.abs(w) ** e


def superquadric(verts, faces, c, axes, radii, e1, e2, nu=20, nv=12):
    """Append a superellipsoid: e ≈ 1 round, → 0 boxy. axes are its 3 unit vectors."""
    base = len(verts)
    verts.append(c - axes[2] * radii[2])
    for j in range(1, nv):
        v = -math.pi / 2 + math.pi * j / nv
        for i in range(nu):
            u = 2 * math.pi * i / nu
            x = radii[0] * _sq(math.cos(v), e1) * _sq(math.cos(u), e2)
            y = radii[1] * _sq(math.cos(v), e1) * _sq(math.sin(u), e2)
            z = radii[2] * _sq(math.sin(v), e1)
            verts.append(c + axes[0] * x + axes[1] * y + axes[2] * z)
    verts.append(c + axes[2] * radii[2])
    top = len(verts) - 1
    ring = lambda j, i: base + 1 + (j - 1) * nu + i % nu
    for i in range(nu):
        faces.append((base, ring(1, i + 1), ring(1, i)))
        faces.append((top, ring(nv - 1, i), ring(nv - 1, i + 1)))
        for j in range(1, nv - 1):
            faces.append((ring(j, i), ring(j, i + 1), ring(j + 1, i + 1), ring(j + 1, i)))
    return len(faces)


def ribbon(verts, faces, pts, per=10, nc=16):
    """A flat band along pts (Catmull-Rom), its broad face turned out from the axis (x)."""
    P = np.array(pts)
    P = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    samples = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1:i + 3]
        for s in np.linspace(0, 1, per, endpoint=False):
            samples.append(0.5 * (2 * p1 + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s * s
                                  + (-p0 + 3 * p1 - 3 * p2 + p3) * s ** 3))
    samples.append(P[-2])
    # run on half a step past each end, so the band ends in a rounded tip, not on a base
    samples = [P[1] - (P[2] - P[1]) * 0.35] + samples + [P[-2] + (P[-2] - P[-3]) * 0.35]
    S = np.array(samples)
    base = len(verts)
    for k, c in enumerate(S):
        T = S[min(k + 1, len(S) - 1)] - S[max(k - 1, 0)]
        T /= np.linalg.norm(T)
        n = np.array([0, c[1], c[2]])
        n -= np.dot(n, T) * T
        n /= np.linalg.norm(n)
        w = np.cross(T, n)
        taper = min(1.0, 0.45 + 0.55 * min(k, len(S) - 1 - k) / 3)   # rounded ends
        for i in range(nc):
            a = 2 * math.pi * i / nc
            verts.append(c + w * (RIB_W / 2 * taper) * _sq(math.cos(a), 0.4)
                         + n * (RIB_T / 2) * _sq(math.sin(a), 0.6))
    rings = len(S)
    for k in range(rings - 1):
        for i in range(nc):
            a, b = base + k * nc + i, base + k * nc + (i + 1) % nc
            faces.append((a, b, b + nc, a + nc))
    faces.append(tuple(base + nc - 1 - i for i in range(nc)))
    faces.append(tuple(base + (rings - 1) * nc + i for i in range(nc)))


def ribbon_model(fb, name):
    """Mesh with 4 material slots, 2·(chain B) + (base), like the painted surface."""
    verts, faces, slots = [], [], []
    X = np.array([1.0, 0, 0])

    def tag(slot):
        slots.extend([slot] * (len(faces) - len(slots)))
    for ch in "AB":
        on = fb["chain"] == ch
        if not on.any():
            continue
        bbs = []
        for p in sorted(set(fb["pos"][on])):
            r = on & (fb["pos"] == p)
            nm = fb["name"][r]
            xyz = fb["xyz"][r]
            bb = xyz[np.isin(nm, BB_ATOMS)].mean(0)
            bbs.append(bb)
            c1 = xyz[nm == "C1'"][0]
            ring = xyz[~np.isin(nm, list(bdna_fiber.BACKBONE))]
            far = ring[np.argmax(np.linalg.norm(ring - c1, axis=1))]
            d = far - c1
            d -= np.dot(d, X) * X
            L = np.linalg.norm(d)
            e1 = d / L
            # connector: backbone to C1'
            sd = c1 - bb
            sl = np.linalg.norm(sd)
            sa = sd / sl
            sb = np.cross(sa, X if abs(sa[0]) < 0.9 else [0, 0, 1.0])
            sb /= np.linalg.norm(sb)
            superquadric(verts, faces, (bb + c1) / 2, [sb, np.cross(sa, sb), sa],
                         (STICK_R, STICK_R, sl / 2), 0.5, 1.0, nu=12, nv=8)
            tag(2 * (ch == "B"))
            superquadric(verts, faces, c1 + e1 * (L / 2 + 0.2), [e1, np.cross(X, e1), X],
                         (L / 2 + 0.9, SLAB_W, SLAB_T), 0.35, 0.35)
            tag(2 * (ch == "B") + 1)
        ribbon(verts, faces, bbs)
        tag(2 * (ch == "B"))
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    for poly, s in zip(me.polygons, slots):
        poly.material_index = s
        poly.use_smooth = True
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    for _ in range(4):
        obj.data.materials.append(None)
    return obj


# Every layer, as (model, material slots rendered white). Everything else on the model is
# a holdout: transparent, but it still hides what is behind it. Slots are
# 2·(chain B) + (base atom) — backbone and bases of each strand.
LAYERS = {
    "ds": ("ds", {0, 1, 2, 3}),     # the whole duplex
    "ds1": ("ds", {0, 1}),          # strand 1 (A) of the duplex
    "dsbA": ("ds", {1}),            # strand A's bases, as they show in the duplex
    "dsbB": ("ds", {3}),            # strand B's bases
    "ss": ("ss", {0, 1}),           # a lone strand, oriented as A (5'→3' along +u)
    "ssb": ("ss", {1}),
    "ssB": ("ssB", {2, 3}),         # a lone strand oriented as B (antiparallel), to
    "ssBb": ("ssB", {3}),           #   continue strand B out of a duplex in phase
}


def main():
    os.makedirs(WORK, exist_ok=True)
    if STYLE == "space":
        mn = mn_surface.start_blender()
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
    white, hold = material("white"), material("hold", holdout=True)

    # all three models share one frame (pose="raw") and one u: base 0 of strand A
    fibers, objs = {}, {}
    for kind, l1, l2 in (("ds", N, N), ("ss", N, 0), ("ssB", 0, N)):
        pdb = f"{WORK}/fiber_{kind}.pdb"
        fb = fibers[kind] = bdna_fiber.write_fiber(pdb, strand1_len=l1, strand2_len=l2, pose="raw")
        if STYLE == "ribbon":
            obj = ribbon_model(fb, f"DNA_{kind}")
        else:
            obj = mn_surface.realize(mn, pdb, f"DNA_{kind}")
            base = np.array([n not in bdna_fiber.BACKBONE for n in fb["name"]])
            slot = 2 * (fb["chain"] == "B") + base
            mn_surface.paint_by_nearest_atom(obj, fb["xyz"], slot, [white] * 4)
        obj.hide_render = True
        objs[kind] = obj

    f = fibers["ds"]
    rise = f["rise"]
    print(f"twist {f['twist']:.2f}°  rise {rise:.3f} Å")
    # u = 0 at the start of strand A's base-0 slot: its mean axial position, less half a rise
    pos0 = (f["pos"] == 0)
    xref = float(f["xyz"][pos0 & (f["chain"] == "A")][:, 0].mean()) - rise / 2
    is_base = np.array([n not in bdna_fiber.BACKBONE for n in f["name"]])
    # where each strand's bases sit within their slot, for slicing bases one by one
    bshift = {c: float(f["xyz"][pos0 & is_base & (f["chain"] == c)][:, 0].mean() - xref) / rise - 0.5
              for c in "AB"}
    xs = [v.co.x for o in objs.values() for v in o.data.vertices]
    x0, x1 = min(xs) - 3, max(xs) + 3
    sc = setup_scene(x0, x1)

    def to_px(u):
        return round((xref + u * rise - x0) * PX)

    shots = {}      # (layer, k) -> rgba
    for k in range(1 if os.environ.get("DNA_QUICK") else 10):
        for layer, (kind, lit) in LAYERS.items():
            obj = objs[kind]
            obj.hide_render = False
            obj.rotation_euler = (math.radians(TWIST * k), 0, 0)
            for i in range(4):
                obj.data.materials[i] = white if i in lit else hold
            shots[(layer, k)] = render(sc, f"{WORK}/{layer}_{k}.png")
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
    ppb = rise * PX                       # pixels per base
    out = dict(rise=rise, twist=TWIST, px=PX, ppb=ppb, halfH=HALF_H * PX, cap=CAP, layers={})
    for layer, (kind, _) in LAYERS.items():
        # caps by phase: the k-rotated model's ends are a strand starting at phase k
        # (head) and one ending at phase k (tail) — see the module docstring
        heads, tails = [], []
        for k in range(10):
            sk = shots[(layer, k)]
            ck = np.where(sk[..., 3].max(0) > 0.02)[0]
            if not len(ck):         # a bases-only layer can be empty near an end
                ck = np.array([to_px(0), to_px(N) - 1])
            ha, hb = min(int(ck.min()), to_px(0)), to_px(CAP)
            ta, tb = to_px(N - CAP), max(int(ck.max()) + 1, to_px(N))
            heads.append(dict(src=crop(sk, ha, hb), x=(ha - to_px(0)) / ppb, w=(hb - ha) / ppb))
            tails.append(dict(src=crop(sk, ta, tb), w=(tb - ta) / ppb))
        out["layers"][layer] = dict(
            tile=crop(shots[(layer, 0)], to_px(TILE[0]), to_px(TILE[1])),
            head=heads, tail=tails,
            overhang=[-heads[0]["x"], tails[0]["w"] - CAP],
            bshift=bshift["B" if kind == "ssB" or layer == "dsbB" else "A"])
    # the duplex's full height, in Å — what a line's "diameter" maps to
    a = shots[("ds", 0)][..., 3].max(1)
    rows = np.where(a > 0.02)[0]
    out["diameter"] = (rows.max() + 1 - rows.min()) / PX
    with open(OUT, "w") as fh:
        fh.write("// Generated by tools/bake_dna_brush.py — do not edit by hand.\n")
        fh.write("export default " + json.dumps(out) + ";\n")
    print(f"wrote {OUT}: {os.path.getsize(OUT) / 1024:.0f} KB, diameter {out['diameter']:.1f} Å, "
          f"bshift {bshift}")


main()
