# Tutorial GIFs — plan and status

Each tutorial is one script here, `NN-name.cjs`, recorded with `lib.cjs` (see its
header). GIFs land in the Drive hub: `_PROJECTS_/2026 Master_Schemer/screenshots/tutorials/`.
A contact sheet `.sheet-<name>.png` lands beside each for a quick check.

```bash
python3 tools/serve.py 8123 &               # dev server (once)
node tools/tutorials/01-first-strand.cjs dry   # quick run, PNG snapshots
node tools/tutorials/01-first-strand.cjs       # record the GIF
```

To resume: find the first unchecked row below, write/fix its script, record it,
check it off, commit.

## Basics (re-recorded from the first five GIFs, with newer features)

- [x] 01-first-strand — Strand tool, end caps (barb, harpoon), smooth curve, $\LaTeX$ label, label style
- [x] 02-primer-template — antiparallel strands, Domain tool, labels a / a*, Domains panel colour (a* lighter), Link with base pairs, fill vs rungs, DNA look
- [x] 03-cut-ligate-cards — cut, Shift-cut nick, join lines, rotate/flip/align, duplicate, cards + connect arrows as reaction steps
- [x] 04-text-labels — notes with rich text and math, label size/weight/colour (per label and document-wide), domain strings, Data field
- [x] 05-sequences-grid — Sequence field, Draw as Sequence, Grid menu (ticks, whole bases, bases per square, resize to grid), View → Draw Strands

## Feature themes

- [ ] 06-rendering-styles — Draw as Line / DNA / Sequence, toon vs soft, outline, colour by sequence, View overrides, colour themes, export dialog (PNG with math)
- [ ] 07-objects-menus-library — Objects panel (names, filter, rename), groups and nesting, adaptive right-click menus, memory slots, library (save selection, stock proteins, shapes, surface block)
- [ ] 08-linking-in-depth — area links between shapes/groups, partial pairing, hairpin (segment↔segment), link styles, z-order, notes with live object references

## Scenes (inspired by the scheme library)

- [ ] 09-surface — immobilized strands on the stock surface block, a strand-displacement step on the surface, cards as steps
- [ ] 10-tweezers — three-strand tweezers (hinge, two arms), fuel strand closing them, waste duplex
- [ ] 11-crossover — two-helix double-crossover tile with Holliday-junction routing (strands switching helices)
- [ ] 12-mini-origami — scaffold rastered over 4 helices with staples crossing between them, Draw as DNA

## Notes

- Stock "surface block" asset (Library → Shapes) was added for 09.
- Old GIFs (tutorial_*.gif in screenshots/) are superseded by this set.
