# Master Schemer — notes for Claude sessions

## Running and testing

- Local test version: `cd app && python3 -m http.server 8123`, then http://localhost:8123.
  No build step — reload the page after an edit.
- Unit tests: `node --test test/*.test.mjs`
- Desktop shell: `cargo tauri dev` from the repo root (Tauri wraps `app/` unchanged).
  The installed AppImage only changes on a tagged release (`v*` → GitHub Actions),
  pulled with `update-master-schemer`.
- The Linux desktop app runs on WebKitGTK, not Chromium — check canvas/SVG features
  there too (e.g. WebKit taints a canvas drawn from SVG containing `foreignObject`).

## Parallel sessions — one git worktree each

When more than one Claude session works on the app at once, each gets its own
worktree and branch; never point two sessions at the same folder.

1. Commit (or stash) work in progress first — a new worktree starts from the last commit.
2. Create one per task, as a sibling of this repo:
   ```bash
   git worktree add ../ms-<task> -b <task>
   cd ../ms-<task> && claude
   ```
   (`claude --worktree <name>` does the same from the start; it puts the worktree
   under `.claude/worktrees/`, which is gitignored.)
3. Each session serves on its own port (8124, 8125, …). Different ports also keep
   localStorage (recent files, autosave, library) separate.
4. When a task is done, merge from the main checkout and clean up:
   ```bash
   git merge <task>
   git worktree remove ../ms-<task> && git branch -d <task>
   ```

Collision hot spots:
- `app/js/app.js` (~2.5k lines), `app/index.html`, and `app/style.css` are shared by
  nearly every feature. Give sessions clearly separate areas and merge early and
  often rather than at the end.
- Version bumps (`src-tauri/tauri.conf.json`) and release tags happen once, on
  main, after merging — never on a feature branch.
- Concurrent `cargo tauri dev` builds share one app-data dir
  (`~/.local/share/com.intertangler.master-schemer`); use the browser version for
  parallel testing.
- Keep worktrees outside Google Drive — cloud sync corrupts `.git/`.
