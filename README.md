# see-claude-skills

> Browse the [Claude Code](https://claude.com/claude-code) skills installed in your `~/.claude/skills` directory. Interactive terminal UI, pipe-friendly plain output, and a polished Linear-styled web preview with markdown rendering.

```bash
npx see-claude-skills
```

That's it — no install needed.

## Why

If you've installed a handful of skills (via `find-skills`, manually, or symlinked from `~/.agents/skills`), it's easy to forget what's in there. This tool reads each skill's `SKILL.md` frontmatter (`name`, `description`) and lists everything in one place. The web mode also renders the full `SKILL.md` plus any other files inside the skill directory.

## Three modes

### 1. Interactive TUI (default)

```bash
npx see-claude-skills
```

Compact list of skills, one per line, with file count and symlink badge. Navigate with arrow keys, expand a description with space, expand all with tab, quit with esc.

```
~/.claude/skills · 7
────────────────────────────────────────────────────────
 ▸ find-skills              1 ↪
   frontend-design           2 ↪
   step-by-step              1
   to-issues                 1
   to-prd                    1
   transitions-dev          11 ↪
   ui-ux-pro-max            35 ↪
────────────────────────────────────────────────────────
↑↓ nav  space expand  tab all  esc quit
```

| Key | Action |
| --- | --- |
| `↑` `↓` or `j` `k` | Navigate |
| `home` `g` / `end` `G` | Jump to top / bottom |
| `space` or `enter` | Toggle expand for current item |
| `tab` | Toggle expand all |
| `esc` `q` `ctrl+c` | Quit |

The TUI uses an alt screen buffer, so your terminal scrollback stays clean on exit.

### 2. Plain text

```bash
npx see-claude-skills --plain
```

Static colored print — useful for piping (`see-claude-skills --plain | grep ui`). This mode is also chosen automatically when stdout is not a TTY.

### 3. Web preview

```bash
npx see-claude-skills --web
```

Generates an HTML file with a Linear-styled UI and opens it in your default browser:

- Sidebar of skills with live search
- Per-skill detail pane with metadata + file list
- Click any file to preview — markdown rendered with [marked](https://marked.js.org/), syntax highlighting via [highlight.js](https://highlightjs.org/)
- Light + dark + system theme toggle, persisted in `localStorage`
- Keyboard shortcut `/` focuses the search box

Files larger than 256 KB and binary files show metadata only (no inline preview). Everything is bundled into a single self-contained HTML file in your temp directory — no server, no network beyond CDN-hosted fonts and libraries.

## Installation

You don't need to install — `npx see-claude-skills` always pulls the latest. But if you'd rather have it on PATH:

```bash
npm install -g see-claude-skills
```

## Requirements

- Node.js **>= 18**

No runtime dependencies — the published package ships a single bundled `dist/index.js` (the web preview pulls Tailwind, marked, highlight.js, and Alpine.js from CDNs at view time).

## Development

```bash
git clone https://github.com/fadlihdytullah/see-claude-skills.git
cd see-claude-skills
npm install

# Iterate on the .ts source directly (needs Node >= 22.6 for TS strip)
npm run dev          # = node index.ts

# Or build + run the compiled version
npm run build        # tsc → dist/index.js
npm start            # = node dist/index.js

# Install the global bin, symlinked to your clone
npm link
see-claude-skills
```

Source is a single `index.ts`. `npm publish` triggers `prepublishOnly` which runs `tsc` so the tarball always ships an up-to-date `dist/`.

## License

MIT © Fadli Hidayatullah
