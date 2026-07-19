# Design

Visual system for Master Schemer. Register: product (tool UI — design serves the task).
Mood: drafting table under a studio skylight — white vellum, pencil-gray chrome, honey-brass fittings on the instruments.

## Color

Strategy: **Restrained**. Pure white canvas is the content surface; chrome is a warm-tinted neutral one layer below; the honey primary appears only on primary actions, the active tool, and selection state. Document content colors are user-chosen from a fixed swatch palette and stored as hex (for portable SVG export).

```css
:root {
  --bg: oklch(1 0 0);                    /* canvas — pure white */
  --surface: oklch(0.972 0.005 75);      /* toolbar, panels */
  --surface-2: oklch(0.943 0.007 75);    /* pressed / wells */
  --ink: oklch(0.24 0.012 75);           /* chrome text, ≥7:1 on bg */
  --muted: oklch(0.49 0.015 75);         /* secondary text, ≥4.5:1 */
  --line: oklch(0.885 0.008 75);         /* hairlines */
  --primary: oklch(0.63 0.132 74);       /* honey brass — active tool, selection, CTA */
  --primary-strong: oklch(0.55 0.135 74);
  --primary-soft: oklch(0.94 0.04 80);   /* selection tint fills */
  --accent: oklch(0.42 0.09 250);        /* deep ink blue — links, info */
  --danger: oklch(0.53 0.19 25);
}
```

White text on honey fills (Helmholtz-Kohlrausch); dark text only on pale/neutral fills.

Content swatches (hex, in `js/model.js`): ink, red, orange, amber, green, teal, blue, violet, magenta, gray — distinguishable under common CVD; labels always accompany color.

## Typography

One family: `system-ui` stack (offline desktop app — no webfont). Fixed rem scale, ratio ~1.2: 11px status/labels, 13px UI default, 14px panel headers (600), 16px app name (650). Canvas text is in world units and scales with zoom.

## Layout

App shell grid: top bar (48px) / left tool rail (48px, vertical) / canvas (fluid) / right properties panel (264px) / bottom status bar (28px). Panels sit on `--surface` with `--line` hairline borders; the canvas is bare `--bg`.

## Components

- **Tool button**: 36×36, radius 8; hover `--surface-2`; active tool = `--primary` fill with white glyph. Tooltip (CSS, delayed) shows name + shortcut.
- **Swatch**: 22×22 rounded square; selected ring in `--primary`.
- **Inputs**: 28px height, radius 6, `--line` border, focus ring `--primary` 2px.
- **Selection graphics** (on canvas): honey dashed outline, 1.5px/zoom; square handles white fill / honey stroke.
- **Grid**: dot lattice, 20-unit pitch, fades out below 40% zoom.

## Motion

150–200ms, ease-out only. State feedback only (tool switch, panel swap, button press). No entrance choreography. `prefers-reduced-motion: reduce` → transitions off.
