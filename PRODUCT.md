# Product

## Register

product

## Platform

web

(Shipped as a standalone desktop app for Linux/macOS/Windows via a thin Tauri wrapper; the surface itself is a web canvas app. No mobile target.)

## Users

Educators, students, and researchers who need to illustrate processes and relationships between objects — reaction schemes, protocols, conceptual flows. They sit at a desk with a mouse or trackpad, in a focused work session, often preparing material to teach or present. They know vector drawing tools (Inkscape, Illustrator) loosely but are not CAD professionals; the tool must feel learnable in the first five minutes.

## Product Purpose

Master Schemer is a semantic scheme editor: a drawing canvas where lines, segments, cards, and arrows are tracked objects with labels and colors — not just ink. It exists so that a broad range of object relationships can be illustrated neatly, quickly, and legibly. Success: a first-time user draws a labeled multi-step scheme with colored sub-segments in their first session, and the result looks presentation-ready without manual tidying.

## Positioning

A drawing tool where the drawing knows what it is — every stroke is a nameable, colorable, trackable object on a grid that keeps things neat for you.

## Brand Personality

Precise, calm, quietly playful. A well-lit drafting table, not a cockpit. The instrument disappears into the task; the honey-brass accent is the only place the tool itself speaks.

## Anti-references

- Inkscape/Illustrator's full-surface complexity — no dialog forests, no 40-tool palettes.
- Visio / draw.io template-and-autolayout feel — the user draws; the tool doesn't arrange for them.
- Toy whiteboard apps — snap-to-grid precision and semantic labels are the point, not loose scribbling.

## Design Principles

1. The canvas is the hero — chrome recedes, content colors pop against white.
2. Direct manipulation — click, drag, done; properties editable in place or one panel away.
3. Semantic over decorative — color and labels always mean something the user chose.
4. Neat by default — the grid does the tidying; a careless drag still produces a clean path.
5. Lightweight forever — no framework, no build step, instant startup, works offline.

## Accessibility & Inclusion

Keyboard shortcuts for every tool; visible focus states; WCAG AA contrast for all chrome text; `prefers-reduced-motion` respected; content color palette chosen to stay distinguishable under common color-vision deficiencies (labels carry meaning redundantly with color).
