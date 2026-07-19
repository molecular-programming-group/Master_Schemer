# Master Schemer

A lightweight semantic scheme editor — a drawing canvas where lines, segments,
cards, and arrows are tracked objects with labels and colors, not just ink.
Built for illustrating processes and relationships between objects: reaction
schemes, protocols, conceptual flows.

![Master Schemer](docs/screenshot.png)

## Model tools (tracked objects)

| Tool | Key | What it does |
|---|---|---|
| Select | `V` | Click to select, drag to move (multi-selections too), marquee on empty space, double-click to edit text. `Ctrl`+drag clones. Drag a line's end dot to keep laying down line. |
| Line | `L` | Drag on the grid to draw a snaking path — horizontal, vertical, and 45° runs; turns commit corners automatically. Start on an existing line's end to extend it. |
| Segment | `S` | Press on a line and drag along it to mark a colored, labelled sub-segment. Snaps at half-grid resolution; a selected segment's end dots are draggable. |
| Edit line | `E` | Click a line, then drag its square vertex handles to reshape the path. |
| Card | `C` | Drag to frame a section — a white sub-canvas card. Cards move by their border/corners only (so their contents stay clickable) and carry their contents with them. |
| Connect | `A` | Drag from one card to another to draw a labelled arrow between them. |

Select two lines whose ends meet on the same grid point and press **Join
lines** in the panel to fuse them into one object.

## Annotation tools (not tracked)

| Tool | Key | What it does |
|---|---|---|
| Freehand | `D` | Unsnapped ink for quick annotations. |
| Note | `T` | Click to place a text note. Wrap math in `$…$` for LaTeX (KaTeX, offline). |
| Ellipse | `O` | Drag to draw a circle/ellipse. |
| Free line | `N` | A straight line, not locked to the grid. |
| Free arrow | `R` | Same, with an arrowhead. |
| Pan | `H` / Space / middle-drag | Move around the canvas. Mouse wheel zooms at the cursor. |

Any annotation can be **promoted to a tracked object** from the panel — it
then appears in the object sidebar with the rest.

## Sidebar, panel, palette

- The **Objects sidebar** lists every tracked object, grouped under the card
  that contains it; segments nest under their line. Click to select,
  double-click to rename (segments too).
- The **properties panel** edits label, color, width, line style
  (solid/dashed/dotted), end caps (arrow, barb, square, circle), a hidden
  **Data** notes field per object, and z-order (**Arrange**:
  Front/Raise/Lower/Back).
- **Color**: 10 fixed swatches, a full custom color picker, and **memory
  slots**. Objects colored from a slot stay linked to it — edit the slot and
  every user recolors instantly. Removing a slot freezes its current color
  into its users.
- Line width goes up to one full grid unit, so two adjacent lines tile the
  lattice with no gap.

`Ctrl+Z`/`Ctrl+Shift+Z` undo/redo, `Delete` removes, arrow keys nudge by one
grid cell, `1` fits the scheme in view, `0` resets zoom.

Documents autosave locally. **Save** / **Save As** (`Ctrl+S` /
`Ctrl+Shift+S`) write a `.schemer.json` file — through native file dialogs in
the desktop app — **Open** loads one, **Export SVG** produces a standalone
vector file. (Notes using `$math$` render via KaTeX in-app; in exported SVGs
they display correctly in browsers when KaTeX CSS is available.)

## Running

No build step, no dependencies. Serve the folder and open it:

```bash
python3 -m http.server 8123   # then http://localhost:8123
```

(Any static server works; opening `index.html` directly also works in
browsers that allow ES modules from `file://`.)

## Desktop app (Linux / macOS / Windows)

The desktop build is a thin [Tauri](https://tauri.app) wrapper around the same
files. With Rust and the Tauri CLI installed:

```bash
cargo install tauri-cli --locked
cargo tauri build        # from the repo root; bundles for the host platform
```

Tagged releases (`v*`) build all three platforms automatically via GitHub
Actions — see `.github/workflows/release.yml`.

## Development

```bash
node --test test/geom.test.mjs   # geometry unit tests
```

Source layout (vanilla ES modules, no framework):

- `js/geom.js` — grid snapping, 8-direction path logic, arc-length math, path merging
- `js/model.js` — document model, palette slots, selection, undo history, z-order, persistence
- `js/render.js` — SVG rendering (caps, dashes, KaTeX notes) + SVG export
- `js/tools.js` — tool state machines
- `js/app.js` — shell: event routing, sidebar, panel, keyboard, file ops
- `vendor/katex/` — vendored KaTeX for offline math

`PRODUCT.md` and `DESIGN.md` capture the product intent and visual system.
