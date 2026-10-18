"""Bake Master Schemer's stock protein sprites from PDB structures, and publish each
surface to the Blender library as an asset.

    python3 tools/bake_molecules.py              all molecules, then writes app/js/mol-tex.js
    python3 tools/bake_molecules.py taq cas9     just these (others reuse their last bake)
    python3 tools/bake_molecules.py --icons      no Blender: redo the cartoon icons and mol-tex.js

Each molecule runs in its own `blender -b` (needs the Molecular Nodes extension): a
fresh scene per molecule, because `mn_surface.publish` purges everything but the asset
and MN must be enabled after the factory reset, never before (see mn_surface).

Same look and pipeline as the DNA brush (tools/bake_dna_brush.py): a Molecular Nodes
surface (mn_surface.SURFACE), white matte, headlight + ambient, orthographic, rendered
to grayscale+alpha and levels-mapped so the app's tint filter shows the chosen colour
at full strength on the bright tops. The app tints, posterizes (toon) and outlines it
with the same SVG filters as DNA.

Only protein chains are kept — bound DNA/RNA is stripped so the sprite is one tintable
body; the app draws the DNA with its brush. A DNA-binding protein is posed with its
crystal DNA's axis (`thread`: chains whose nucleotides fit it, or "pca" for the protein's
own long axis) along +X, the protein's broad face toward the camera, and baked twice:
`src` the whole protein (drawn beneath the app's DNA) and `front` with a DNA-sized
cylinder along that axis as a holdout — only what lies in front of the DNA (drawn over
it). `axis` is the axis's height in the sprite, in Å from the top. Anything else is
posed by plain PCA (long axis across, second up, thinnest toward the camera). `rot`
(degrees, XYZ, applied after the pose) turns it to its textbook view; for a threaded
protein only X (a spin about the DNA) keeps the axis horizontal.
"""
import base64
import json
import os
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "app", "js", "mol-tex.js")
BLENDER_ROOT = os.environ.get("BLENDER_LIB", os.path.expanduser(
    "~/Insync/ian.hoffecker@gmail.com/Google Drive/_3D Modeling/Blender"))
LIB = BLENDER_ROOT + "/assets"
WORK = os.environ.get("MOL_BAKE_WORK", "/tmp/mol_bake")
PX = 4.0        # pixels per Å

HOLE = 10.5     # Å, the holdout cylinder's radius — the app draws a duplex ~12.8 Å half-high

# key: (name, PDB file, protein chains, thread, strand kind, extra rotation, asset name)
# thread: nucleotide chains that fit the DNA axis, "pca" (protein long axis), or None
# file ".pdb1" is RCSB's biological assembly 1 (its MODELs are merged, chains renamed)
MOLS = {
    "taq":    ("Taq polymerase", "1TAU.pdb", "A", "PT", "ds", (0, 0, 0), "Taq_Polymerase"),
    "phi29":  ("phi29 polymerase", "2PYJ.pdb", "A", "XY", "ds", (0, 0, 0), "Phi29_Polymerase"),
    "ecori":  ("EcoRI", "1CKQ.pdb1", "*", "*", "ds", (0, 0, 0), "EcoRI_Dimer"),
    "ligase": ("T4 DNA ligase", "6DT1.pdb", "A", "BCD", "ds", (0, 0, 0), "T4_DNA_Ligase"),
    "igg":    ("IgG antibody", "1IGT.pdb", "ABCD", None, None, (0, 0, 0), "Antibody_IgG_MN"),
    "ssb":    ("SSB tetramer", "1EYG.pdb", "ABCD", "pca", "ss", (0, 0, 0), "SSB_Tetramer"),
    "cas9":   ("Cas9", "5F9R.pdb", "B", "CD", "ds", (0, 0, 0), "Cas9"),
}
# Nucleic acid that belongs to a protein, baked as its own sprite in the protein's
# frame (same pose, crop and axis), so the app stacks it exactly and tints it apart.
# protein key: (part key, name, chains, Blender object name)
PARTS = {"cas9": ("sgrna", "sgRNA", "A", "Cas9_sgRNA")}
AA = set("ALA ARG ASN ASP CYS GLN GLU GLY HIS ILE LEU LYS MET PHE PRO SER THR TRP TYR VAL MSE".split())
NT = {"DA", "DC", "DG", "DT", "DU", "A", "C", "G", "U"}


def fetch(fname):
    path = f"{LIB}/_source_structures/{fname}"
    if not os.path.exists(path):
        urllib.request.urlretrieve(f"https://files.rcsb.org/download/{fname}", path)
    return path


def clean_pdb(src, chains, thread, rot, dst, part=None, part_dst=None):
    """Protein ATOMs of `chains` (all models merged), posed and centred; see the module
    docstring. Writes `dst` (and the nucleotides of `part` chains, posed alike, to
    `part_dst`); returns True if posed on a DNA axis (the posed X axis)."""
    import numpy as np
    from math import radians, cos, sin
    recs, na, prt, model, ids = [], [], [], 0, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    for line in open(src):
        if line.startswith("MODEL"):
            model += 1
        if not line.startswith(("ATOM", "HETATM")) or line[16] not in " A":   # first altloc
            continue
        ch, res = line[21], line[17:20].strip()
        xyz = [float(line[30:38]), float(line[38:46]), float(line[46:54])]
        if res in NT and thread and thread != "pca" and (thread == "*" or ch in thread):
            na.append(xyz)
        if res in NT and part and ch in part:
            prt.append((line, ch, xyz))
        if res not in AA or (chains != "*" and ch not in chains):
            continue
        m = max(model, 1) - 1
        recs.append((line, ids[(ids.index(ch) + 4 * m) % 26] if m else ch, xyz))
    P = np.array([r[2] for r in recs])

    def pc(X):
        return np.linalg.svd(X - X.mean(0), full_matrices=False)[2]
    if thread:
        N = np.array(na) if na else P
        c, d = N.mean(0), pc(N)[0]
        Q = (P - c) - np.outer((P - c) @ d, d)          # protein, flattened onto the axis' normal plane
        up = pc(Q)[0]
        up -= d * (up @ d)
        up /= np.linalg.norm(up)
        R = np.array([d, np.cross(up, d), up])        # X = axis, Y = depth, Z = up
        shift = np.array([((P - c) @ d).mean(), 0, 0])   # centred along the DNA; axis stays at y = z = 0
    else:
        c = P.mean(0)
        vt = pc(P)
        R = np.array([vt[0], vt[2], vt[1]])           # long → X (across), middle → Z (up), thin → Y (depth)
        if np.linalg.det(R) < 0:
            R[1] *= -1
        shift = np.zeros(3)
    for ax, deg in zip("xyz", rot):
        c_, s_ = cos(radians(deg)), sin(radians(deg))
        M = {"x": [[1, 0, 0], [0, c_, -s_], [0, s_, c_]], "y": [[c_, 0, s_], [0, 1, 0], [-s_, 0, c_]],
             "z": [[c_, -s_, 0], [s_, c_, 0], [0, 0, 1]]}[ax]
        R = np.array(M) @ R
        shift = np.array(M) @ shift

    def write(path, rs):
        xyz = np.array([r[2] for r in rs]) - c
        xyz = xyz @ R.T - shift
        with open(path, "w") as fh:
            for i, ((l, ch, _), p) in enumerate(zip(rs, xyz)):
                l = "ATOM  " + l[6:]
                fh.write(f"{l[:6]}{(i + 1) % 100000:5d}{l[11:21]}{ch}{l[22:30]}"
                         f"{p[0]:8.3f}{p[1]:8.3f}{p[2]:8.3f}{l[54:].rstrip()}\n")
            fh.write("END\n")
    write(dst, recs)
    if part:
        write(part_dst, prt)
    return bool(thread)


def png_la(gray, alpha):
    """8-bit grayscale+alpha PNG (Blender's Python has no PIL); as in bake_dna_brush.py."""
    import struct
    import zlib
    import numpy as np
    h, w = gray.shape
    raw = np.dstack([gray, alpha]).astype(np.uint8)
    rows = b"".join(b"\x00" + raw[y].tobytes() for y in range(h))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(
            ">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 4, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def bake_one(key):
    """Runs inside Blender."""
    import math
    import numpy as np
    sys.path.insert(0, f"{LIB}/scripts")
    import mn_surface
    import bpy

    name, fname, chains, thread, strand, rot, asset = MOLS[key]
    pdb = f"{WORK}/{key}.pdb"
    pkey, pname, pchains, passet = PARTS.get(key, (None,) * 4)
    threaded = clean_pdb(fetch(fname), chains, thread, rot, pdb, pchains, f"{WORK}/{pkey}.pdb")

    mn = mn_surface.start_blender()
    obj = mn_surface.realize(mn, pdb, asset)
    part = pkey and mn_surface.realize(mn, f"{WORK}/{pkey}.pdb", passet)
    vs = np.array([v.co[:] for o in (obj, part) if o for v in o.data.vertices])
    lo, hi = vs.min(0) - 3, vs.max(0) + 3

    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "CUDA"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        sc.cycles.device = "GPU"
    except Exception as e:
        print("GPU unavailable:", e)
    sc.cycles.samples = 96
    sc.cycles.use_denoising = True
    sc.render.film_transparent = True
    sc.view_settings.view_transform = "Standard"
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.resolution_percentage = 100
    w, h = hi[0] - lo[0], hi[2] - lo[2]
    sc.render.resolution_x, sc.render.resolution_y = round(w * PX), round(h * PX)
    if sc.world is None:
        sc.world = bpy.data.worlds.new("World")
    sc.world.use_nodes = True
    sc.world.node_tree.nodes["Background"].inputs[0].default_value = (1, 1, 1, 1)
    sc.world.node_tree.nodes["Background"].inputs[1].default_value = 0.15
    cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
    cam_data = bpy.data.cameras.new("Cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = max(w, h)
    cam = bpy.data.objects.new("Cam", cam_data)
    cam.location = (cx, -400, cz)
    cam.rotation_euler = (math.radians(90), 0, 0)
    sc.collection.objects.link(cam)
    sc.camera = cam
    # the DNA bake's headlight + ambient, so proteins and DNA share one light
    lamp_data = bpy.data.lights.new("Head", type="AREA")
    lamp_data.energy, lamp_data.size = 4e5, 400
    lamp = bpy.data.objects.new("Head", lamp_data)
    lamp.location = (cx, -300, cz)
    lamp.rotation_euler = (math.radians(90), 0, 0)
    sc.collection.objects.link(lamp)

    white = bpy.data.materials.new("white")
    white.use_nodes = True
    b = white.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.92, 0.92, 0.92, 1)
    b.inputs["Roughness"].default_value = 0.7
    obj.data.materials.clear()
    obj.data.materials.append(white)
    hold = bpy.data.materials.new("hold")
    hold.use_nodes = True
    nt = hold.node_tree
    nt.nodes.clear()
    nt.links.new(nt.nodes.new("ShaderNodeHoldout").outputs[0],
                 nt.nodes.new("ShaderNodeOutputMaterial").inputs[0])
    if part:
        part.hide_render = True
        part.data.materials.clear()
        part.data.materials.append(white)

    def shoot(path):
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(path)
        iw, ih = img.size
        px = np.array(img.pixels[:]).reshape(ih, iw, 4)[::-1]      # Blender stores bottom-up
        bpy.data.images.remove(img)
        alpha = np.clip(px[..., 3], 0, 1)
        lum = px[..., :3] @ [0.2126, 0.7152, 0.0722]
        return alpha, np.where(alpha > 1e-4, lum / np.maximum(alpha, 1e-4), 0)   # un-premultiply

    alpha, lum = shoot(f"{WORK}/{key}.png")
    if part:
        # the part as seen in the complex: the protein still hides it, but as a holdout
        obj.data.materials[0] = hold
        part.hide_render = False
        p_alpha, p_lum = shoot(f"{WORK}/{pkey}.png")
    if threaded:
        # the DNA as a holdout: hides what is behind it, casts and catches no light
        bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=HOLE, depth=4 * w,
                                            location=(0, 0, 0), rotation=(0, math.pi / 2, 0))
        cyl = bpy.context.active_object
        cyl.data.materials.append(hold)
        for v in ("diffuse", "glossy", "transmission", "volume_scatter", "shadow"):
            setattr(cyl, f"visible_{v}", False)
        if part:
            pf_alpha, pf_lum = shoot(f"{WORK}/{pkey}_front.png")
            obj.data.materials[0] = white
            part.hide_render = True
        f_alpha, f_lum = shoot(f"{WORK}/{key}_front.png")
        bpy.data.objects.remove(cyl, do_unlink=True)

    solid = lum[alpha > 0.99]
    plo, phi = np.percentile(solid, 2), np.percentile(solid, 98)
    LO, HI = 0.30, 0.97                       # as the DNA bake

    cover = np.maximum(alpha, p_alpha) if part else alpha      # one crop for protein and part
    rows, cols = np.where(cover.max(1) > 0.02)[0], np.where(cover.max(0) > 0.02)[0]
    y0, y1, x0, x1 = rows.min(), rows.max() + 1, cols.min(), cols.max() + 1

    def uri(a, l):                            # one levels mapping and one crop for both layers
        g = np.clip(LO + (l - plo) * (HI - LO) / (phi - plo), 0, 1) * 255
        png = png_la(np.round(g[y0:y1, x0:x1]), np.round(a[y0:y1, x0:x1] * 255))
        return "data:image/png;base64," + base64.b64encode(png).decode()

    out = dict(name=name, pdb=fname.split(".")[0], w=(x1 - x0) / PX, h=(y1 - y0) / PX, src=uri(alpha, lum))
    if threaded:
        top = cz + h / 2                      # world z of the image's top row
        out.update(front=uri(f_alpha, f_lum), axis=top - y0 / PX, strand=strand)
    with open(f"{WORK}/{key}.json", "w") as fh:
        json.dump(out, fh)
    if part:
        po = dict(out, name=pname, part=key, src=uri(p_alpha, p_lum))
        if threaded:
            po["front"] = uri(pf_alpha, pf_lum)
        with open(f"{WORK}/{pkey}.json", "w") as fh:
            json.dump(po, fh)

    # the library asset: 1 BU = 1 Å, centred, resting on z = 0
    shift = mn_surface.seat(obj)
    mat = mn_surface.dna_material(f"Mat_{asset}", color=(0.86, 0.88, 0.92))
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    if part:
        for v in part.data.vertices:
            v.co += shift
        part.data.materials.clear()
        part.data.materials.append(mn_surface.dna_material(f"Mat_{passet}", color=(0.95, 0.42, 0.05)))
    n = len(obj.data.vertices)
    pose = (f"posed with the bound DNA's axis along +X at y={shift.y:.1f}, z={shift.z:.1f} Å"
            if threaded else "PCA-posed (long axis +X, thinnest +Y)")
    mn_surface.publish(obj, f"{LIB}/protein/{asset.lower()}.blend", asset,
                       f"{name} (PDB {fname.split('.')[0]}, chains {chains}), Molecular Nodes surface, "
                       f"protein only, {pose}. 1 BU = 1 Å, rests on z=0. "
                       f"{n} verts. Built by Master_Schemer/tools/bake_molecules.py."
                       + (f" The collection also holds `{passet}` ({pname}, chains {pchains}) "
                          "in place." if part else ""),
                       ["protein", "molecular surface", key], extra=[part] if part else ())


def iconize(m):
    """Cartoon variant of a baked sprite, `icon` (+ `iconFront`): the silhouette blurred
    into a smooth blob, flat-shaded in three tones (base, a shadow crescent lower right,
    a highlight rim upper left). Plain Python (PIL), so it re-runs without Blender."""
    import io
    import numpy as np
    from PIL import Image, ImageFilter

    def la(u):
        im = Image.open(io.BytesIO(base64.b64decode(u.split(",", 1)[1]))).convert("LA")
        return im.getchannel("A")

    def blob(a, sigma):                       # blur, then a ~2 px antialiased threshold
        b = np.asarray(a.filter(ImageFilter.GaussianBlur(sigma)), float) / 255
        return np.clip((b - 0.5) * 15 + 0.5, 0, 1)

    def shifted(x, d):                        # x moved by d px down-right (d < 0: up-left), 0-filled
        y = np.zeros_like(x)
        if d > 0:
            y[d:, d:] = x[:-d, :-d]
        else:
            y[:d, :d] = x[-d:, -d:]
        return y

    def crescent(mask, d, sigma):             # parts of the blob whose d-px neighbour is outside
        edge = mask * (1 - shifted(mask, -d))
        return blob(Image.fromarray(np.uint8(edge * 255)), sigma) * mask

    body = blob(la(m["src"]), 3 * PX)          # ponytail: one 3 Å blur for every size
    k = round(1.2 * PX)
    shade = 0.80 - 0.25 * crescent(body, 3 * k, k) + 0.20 * crescent(body, -2 * k, k)
    shade = np.where(body > 0, shade, 0)

    def uri(a):
        png = png_la(np.round(shade * 255), np.round(a * 255))
        return "data:image/png;base64," + base64.b64encode(png).decode()
    out = {"icon": uri(body)}
    if m.get("front"):                        # in the DNA's band, only what's in front of it
        rows = np.arange(body.shape[0])[:, None] / PX
        band = np.abs(rows - m["axis"]) < HOLE
        out["iconFront"] = uri(np.where(band, np.minimum(body, blob(la(m["front"]), 1.5 * PX)), body))
    return out


def main():
    keys = [] if sys.argv[1:] == ["--icons"] else sys.argv[1:] or list(MOLS)
    os.makedirs(WORK, exist_ok=True)
    for k in keys:
        subprocess.run(["blender", "-b", "-P", __file__, "--", k], check=True)
    out = {}
    for k in [*MOLS, *(p[0] for p in PARTS.values())]:
        try:
            out[k] = json.load(open(f"{WORK}/{k}.json"))
            out[k].update(iconize(out[k]))
        except FileNotFoundError:
            print("not baked yet:", k)
    with open(OUT, "w") as fh:
        fh.write("// Generated by tools/bake_molecules.py — do not edit by hand.\n")
        fh.write("// Grayscale protein sprites; w/h in Å.\n")
        fh.write("export default " + json.dumps(out) + ";\n")
    print(f"wrote {OUT}: {os.path.getsize(OUT) / 1024:.0f} KB")


if "--" in sys.argv:                          # inside Blender
    bake_one(sys.argv[sys.argv.index("--") + 1])
else:
    main()
