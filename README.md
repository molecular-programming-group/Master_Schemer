# Master Schemer

A lightweight semantic scheme editor — a drawing canvas where lines, segments,
cards, and arrows are tracked objects with labels and colors, not just ink.
Built for illustrating processes and relationships between objects: reaction
schemes, protocols, conceptual flows.

![Master Schemer](docs/screenshot.png)

## Tools

| Tool | Key | What it does |
|---|---|---|
| Select | `V` | Click to select, drag to move, marquee on empty space, double-click to edit text. Corner handles resize cards. |
| Line | `L` | Drag on the grid to draw a snaking path — horizontal, vertical, and 45° runs; turns commit corners automatically. |
| Segment | `S` | Press on a line and drag along it to mark a colored, labelled sub-segment. |
| Card | `C` | Drag to frame a section — a white sub-canvas card. |
| Connect | `A` | Drag from one card to another to draw a labelled arrow between them. |
| Freehand | `D` | Unsnapped ink for quick annotations. |
| Note | `T` | Click to place a text note (multi-line, Ctrl+Enter to finish). |
| Pan | `H` / Space / middle-drag | Move around the canvas. Mouse wheel zooms at the cursor. |

Everything selected gets a properties panel on the right: label, color
(10-swatch palette), stroke width. `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo,
`Delete` removes, arrow keys nudge by one grid cell, `1` fits the scheme in
view, `0` resets zoom.

Documents autosave to the browser's local storage. **Save** downloads a
`.schemer.json` file, **Open** loads one, **Export SVG** produces a
standalone vector file of the scheme.

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
node --test test/        # geometry unit tests
```

Source layout (vanilla ES modules, no framework):

- `js/geom.js` — grid snapping, 8-direction path logic, arc-length math
- `js/model.js` — document model, selection, undo history, persistence
- `js/render.js` — SVG rendering + SVG export
- `js/tools.js` — tool state machines
- `js/app.js` — shell: event routing, panel, keyboard, file ops

`PRODUCT.md` and `DESIGN.md` capture the product intent and visual system.
