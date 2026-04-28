#!/usr/bin/env node
import {
  readdir,
  readFile,
  lstat,
  stat,
  realpath,
  writeFile,
  mkdtemp,
} from "node:fs/promises";
import { join, extname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import readline from "node:readline";

const SKILLS_DIR = join(homedir(), ".claude", "skills");
const MAX_FILE_BYTES = 256 * 1024;

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  magenta: "\x1b[35m",
};

interface SkillFile {
  path: string;
  size: number;
  isText: boolean;
  truncated: boolean;
  content: string;
}

interface Skill {
  name: string;
  description: string;
  isSymlink: boolean;
  realPath: string;
  files: SkillFile[];
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const fm: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  let currentKey = "";
  let currentValue = "";

  const flush = () => {
    if (currentKey) {
      fm[currentKey] = currentValue.trim().replace(/^["']|["']$/g, "");
    }
  };

  for (const line of lines) {
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (kvMatch) {
      flush();
      currentKey = kvMatch[1];
      currentValue = kvMatch[2];
    } else if (currentKey) {
      currentValue += " " + line.trim();
    }
  }
  flush();

  return fm;
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = line ? line + " " + word : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

function looksTextual(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  return true;
}

async function walkDir(
  root: string,
  prefix: string,
  out: SkillFile[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const full = join(root, rel);

    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      await walkDir(root, rel, out);
      continue;
    }
    if (!st.isFile()) continue;

    const size = st.size;

    if (size > MAX_FILE_BYTES) {
      out.push({ path: rel, size, isText: true, truncated: true, content: "" });
      continue;
    }

    try {
      const buf = await readFile(full);
      const isText = looksTextual(buf);
      out.push({
        path: rel,
        size,
        isText,
        truncated: false,
        content: isText ? buf.toString("utf8") : "",
      });
    } catch {}
  }
}

async function readSkill(entryName: string): Promise<Skill | null> {
  const skillPath = join(SKILLS_DIR, entryName);
  let resolved: string;
  try {
    resolved = await realpath(skillPath);
  } catch {
    return null;
  }

  const ls = await lstat(skillPath);
  const files: SkillFile[] = [];
  await walkDir(resolved, "", files);

  if (files.length === 0) return null;

  const skillMd = files.find((f) => f.path === "SKILL.md");
  const fm = skillMd ? parseFrontmatter(skillMd.content) : {};

  files.sort((a, b) => {
    if (a.path === "SKILL.md") return -1;
    if (b.path === "SKILL.md") return 1;
    return a.path.localeCompare(b.path);
  });

  return {
    name: fm.name || entryName,
    description: fm.description || "(no description)",
    isSymlink: ls.isSymbolicLink(),
    realPath: resolved,
    files,
  };
}

async function loadSkills(): Promise<Skill[]> {
  const entries = await readdir(SKILLS_DIR);
  const skills = (await Promise.all(entries.map(readSkill))).filter(
    (s): s is Skill => s !== null,
  );
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

function renderTerminal(skills: Skill[]) {
  const termWidth = process.stdout.columns || 80;
  const wrapWidth = Math.max(40, termWidth - 6);

  console.log();
  console.log(
    `${c.bold}${c.cyan}Skills in ~/.claude/skills${c.reset} ${c.dim}(${skills.length} total)${c.reset}`,
  );
  console.log();

  if (skills.length === 0) {
    console.log(`  ${c.dim}No skills found.${c.reset}\n`);
    return;
  }

  for (const skill of skills) {
    const linkBadge = skill.isSymlink ? ` ${c.magenta}↪ symlink${c.reset}` : "";
    const fileBadge = ` ${c.dim}· ${skill.files.length} file${skill.files.length === 1 ? "" : "s"}${c.reset}`;
    console.log(`  ${c.bold}${c.green}${skill.name}${c.reset}${linkBadge}${fileBadge}`);
    console.log(
      `${c.gray}${wrap(skill.description, wrapWidth, "    ")}${c.reset}`,
    );
    console.log();
  }
}

function runInteractive(skills: Skill[]): Promise<void> {
  return new Promise((resolve) => {
    const stdout = process.stdout;
    const stdin = process.stdin;

    if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) {
      renderTerminal(skills);
      resolve();
      return;
    }

    if (skills.length === 0) {
      renderTerminal(skills);
      resolve();
      return;
    }

    const ENTER_ALT = "\x1b[?1049h";
    const EXIT_ALT = "\x1b[?1049l";
    const HIDE_CUR = "\x1b[?25l";
    const SHOW_CUR = "\x1b[?25h";
    const CLEAR = "\x1b[2J\x1b[H";

    let cursor = 0;
    const expanded = new Set<number>();
    let allExpanded = false;

    const nameWidth = Math.min(
      28,
      Math.max(...skills.map((s) => s.name.length)),
    );
    const countWidth = Math.max(
      ...skills.map((s) => String(s.files.length).length),
    );

    const render = () => {
      const w = stdout.columns || 80;
      const ruleW = Math.min(w - 1, 56);
      const out: string[] = [];

      out.push(
        `${c.bold}${c.cyan}~/.claude/skills${c.reset} ${c.dim}· ${skills.length}${c.reset}`,
      );
      out.push(`${c.gray}${"─".repeat(ruleW)}${c.reset}`);

      for (let i = 0; i < skills.length; i++) {
        const s = skills[i];
        const isCursor = i === cursor;
        const isExp = allExpanded || expanded.has(i);
        const arrow = isCursor ? (isExp ? "▾" : "▸") : " ";
        const arrowColor = isCursor ? c.cyan : c.dim;
        const nameStyle = isCursor ? `${c.bold}${c.green}` : c.green;
        const name =
          s.name.length > nameWidth
            ? s.name.slice(0, nameWidth - 1) + "…"
            : s.name.padEnd(nameWidth);
        const count = String(s.files.length).padStart(countWidth);
        const sym = s.isSymlink ? `${c.magenta}↪${c.reset}` : " ";

        out.push(
          ` ${arrowColor}${arrow}${c.reset} ${nameStyle}${name}${c.reset}  ${c.dim}${count}${c.reset} ${sym}`,
        );

        if (isExp) {
          const wrapWidth = Math.max(30, w - 6);
          out.push(`${c.gray}${wrap(s.description, wrapWidth, "      ")}${c.reset}`);
        }
      }

      out.push(`${c.gray}${"─".repeat(ruleW)}${c.reset}`);
      out.push(
        `${c.dim}↑↓${c.reset} nav  ${c.dim}space${c.reset} expand  ${c.dim}tab${c.reset} all  ${c.dim}esc${c.reset} quit`,
      );

      stdout.write(CLEAR + out.join("\n"));
    };

    const cleanup = () => {
      stdout.write(SHOW_CUR + EXIT_ALT);
      stdin.removeListener("keypress", onKey);
      try { stdin.setRawMode(false); } catch {}
      stdin.pause();
      resolve();
    };

    const onKey = (
      _str: string,
      key: { name?: string; ctrl?: boolean; shift?: boolean },
    ) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") return cleanup();
      if (key.name === "escape" || key.name === "q") return cleanup();

      if (key.name === "up" || key.name === "k") {
        cursor = (cursor - 1 + skills.length) % skills.length;
        render();
      } else if (key.name === "down" || key.name === "j") {
        cursor = (cursor + 1) % skills.length;
        render();
      } else if (key.name === "home" || key.name === "g") {
        cursor = 0;
        render();
      } else if (key.name === "end" || (key.shift && key.name === "g")) {
        cursor = skills.length - 1;
        render();
      } else if (key.name === "space" || key.name === "return") {
        if (expanded.has(cursor)) expanded.delete(cursor);
        else expanded.add(cursor);
        render();
      } else if (key.name === "tab") {
        allExpanded = !allExpanded;
        if (!allExpanded) expanded.clear();
        render();
      }
    };

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(ENTER_ALT + HIDE_CUR);

    stdout.on("resize", render);
    stdin.on("keypress", onKey);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
    process.once("exit", () => {
      stdout.write(SHOW_CUR + EXIT_ALT);
    });

    render();
  });
}

function safeJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
}

function langFor(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  const map: Record<string, string> = {
    md: "markdown",
    markdown: "markdown",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    jsx: "javascript",
    py: "python",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    json: "json",
    yml: "yaml",
    yaml: "yaml",
    toml: "ini",
    css: "css",
    scss: "scss",
    html: "html",
    xml: "xml",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    sql: "sql",
    csv: "plaintext",
    txt: "plaintext",
  };
  return map[ext] || "plaintext";
}

function renderHtml(skills: Skill[]): string {
  const totalFiles = skills.reduce((acc, s) => acc + s.files.length, 0);
  const payload = skills.map((s) => ({
    name: s.name,
    description: s.description,
    isSymlink: s.isSymlink,
    realPath: s.realPath,
    files: s.files.map((f) => ({
      path: f.path,
      size: f.size,
      isText: f.isText,
      truncated: f.truncated,
      content: f.content,
      lang: langFor(f.path),
    })),
  }));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>claude-skills-viewer · ${skills.length} skills</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/atom-one-dark.min.css" id="hljs-dark" disabled>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/atom-one-light.min.css" id="hljs-light" disabled>
    <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/highlight.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js"></script>
    <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.13.5/dist/cdn.min.js"></script>
    <style>
      :root {
        --bg: #fafaf9;
        --surface: #ffffff;
        --surface-2: #f4f4f5;
        --surface-hover: #efeff1;
        --border: #e7e7ea;
        --border-strong: #d4d4d8;
        --text: #18181b;
        --text-2: #52525b;
        --text-3: #a1a1aa;
        --accent: #059669;
        --accent-2: #10b981;
        --accent-bg: rgba(16, 185, 129, 0.08);
        --accent-glow: rgba(16, 185, 129, 0.18);
        --shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
        --shadow-md: 0 4px 14px -4px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04);
      }
      html.dark {
        --bg: #08080a;
        --surface: #0f0f12;
        --surface-2: #15151a;
        --surface-hover: #1c1c22;
        --border: #1f1f25;
        --border-strong: #2a2a32;
        --text: #ededf0;
        --text-2: #a1a1aa;
        --text-3: #6a6a75;
        --accent: #34d399;
        --accent-2: #10b981;
        --accent-bg: rgba(52, 211, 153, 0.08);
        --accent-glow: rgba(52, 211, 153, 0.22);
        --shadow-sm: 0 1px 2px rgba(0,0,0,0.4);
        --shadow-md: 0 4px 16px -4px rgba(0,0,0,0.5), 0 2px 4px rgba(0,0,0,0.3);
      }

      * { box-sizing: border-box; }
      html, body {
        margin: 0; padding: 0;
        background: var(--bg);
        color: var(--text);
        font-family: 'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif;
        font-feature-settings: "ss01", "ss02", "cv11";
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }
      .mono {
        font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
        font-feature-settings: "zero", "ss01";
      }

      body {
        min-height: 100vh;
        background-image:
          radial-gradient(circle at 1px 1px, var(--border) 1px, transparent 0);
        background-size: 24px 24px;
        background-attachment: fixed;
      }

      .app {
        display: grid;
        grid-template-columns: 320px 1fr;
        grid-template-rows: 56px 1fr;
        height: 100vh;
        max-width: 1600px;
        margin: 0 auto;
      }

      header.topbar {
        grid-column: 1 / -1;
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 0 20px;
        border-bottom: 1px solid var(--border);
        background: color-mix(in srgb, var(--bg) 80%, transparent);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        position: sticky; top: 0; z-index: 10;
      }
      .brand {
        display: flex; align-items: center; gap: 10px;
        font-weight: 600; font-size: 14px;
        letter-spacing: -0.01em;
      }
      .brand .dot {
        width: 8px; height: 8px; border-radius: 999px;
        background: var(--accent);
        box-shadow: 0 0 12px var(--accent-glow);
      }
      .brand-meta { color: var(--text-3); font-size: 12px; }

      .top-search {
        flex: 1;
        max-width: 420px;
        margin-left: auto;
        position: relative;
      }
      .top-search input {
        width: 100%; height: 32px;
        padding: 0 12px 0 32px;
        font: inherit; font-size: 13px;
        color: var(--text);
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: 8px;
        outline: none;
        transition: border-color .15s ease, background .15s ease;
      }
      .top-search input::placeholder { color: var(--text-3); }
      .top-search input:focus {
        border-color: var(--accent);
        background: var(--surface);
        box-shadow: 0 0 0 3px var(--accent-bg);
      }
      .top-search svg {
        position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
        width: 14px; height: 14px; color: var(--text-3);
      }
      .top-search kbd {
        position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
        font: inherit; font-size: 11px;
        padding: 2px 6px;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 4px;
        color: var(--text-3);
      }

      .icon-btn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 32px; height: 32px;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 8px;
        color: var(--text-2);
        cursor: pointer;
        transition: background .15s, border-color .15s, color .15s;
      }
      .icon-btn:hover {
        background: var(--surface-2);
        border-color: var(--border);
        color: var(--text);
      }
      .icon-btn svg { width: 16px; height: 16px; }

      aside.sidebar {
        border-right: 1px solid var(--border);
        background: color-mix(in srgb, var(--bg) 60%, transparent);
        overflow-y: auto;
        padding: 8px;
      }
      .sidebar-label {
        font-size: 11px; font-weight: 500;
        text-transform: uppercase; letter-spacing: 0.06em;
        color: var(--text-3);
        padding: 12px 12px 8px;
      }
      .skill-item {
        display: block;
        width: 100%;
        text-align: left;
        padding: 10px 12px;
        margin: 1px 0;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 8px;
        color: var(--text);
        cursor: pointer;
        transition: background .12s ease, border-color .12s ease;
      }
      .skill-item:hover { background: var(--surface-2); }
      .skill-item.active {
        background: var(--accent-bg);
        border-color: color-mix(in srgb, var(--accent) 30%, transparent);
      }
      .skill-item .row1 {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px;
      }
      .skill-item .name {
        font-size: 13px; font-weight: 500;
        letter-spacing: -0.005em;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .skill-item.active .name { color: var(--accent); }
      .skill-item .count {
        font-size: 11px; color: var(--text-3);
        flex-shrink: 0;
      }
      .skill-item .preview {
        font-size: 12px; color: var(--text-2);
        margin-top: 4px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        line-height: 1.45;
      }

      .symlink-pill {
        display: inline-block;
        font-size: 10px;
        padding: 1px 5px;
        border-radius: 3px;
        background: color-mix(in srgb, var(--accent) 12%, transparent);
        color: var(--accent);
        margin-left: 6px;
      }

      main.workspace {
        overflow-y: auto;
        position: relative;
      }
      .workspace-inner {
        max-width: 880px;
        margin: 0 auto;
        padding: 40px 48px 80px;
      }

      .empty {
        height: 100%;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        color: var(--text-3); padding: 40px;
      }
      .empty .glyph {
        width: 48px; height: 48px; margin-bottom: 16px;
        border-radius: 12px;
        background: var(--accent-bg);
        color: var(--accent);
        display: flex; align-items: center; justify-content: center;
      }
      .empty h2 { font-size: 18px; font-weight: 600; color: var(--text); margin: 0 0 6px; }
      .empty p { font-size: 13px; margin: 0; max-width: 320px; text-align: center; line-height: 1.55; }

      .skill-header {
        margin-bottom: 28px;
        padding-bottom: 24px;
        border-bottom: 1px solid var(--border);
      }
      .skill-header .crumb {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--accent);
        margin-bottom: 10px;
        display: flex; align-items: center; gap: 6px;
      }
      .skill-header h1 {
        font-size: 32px; font-weight: 600;
        letter-spacing: -0.025em;
        margin: 0 0 12px;
        line-height: 1.1;
      }
      .skill-header .desc {
        font-size: 15px; line-height: 1.6;
        color: var(--text-2);
        margin: 0 0 16px;
      }
      .skill-header .meta {
        display: flex; flex-wrap: wrap; gap: 16px;
        font-size: 12px; color: var(--text-3);
      }
      .skill-header .meta .item {
        display: inline-flex; align-items: center; gap: 6px;
      }
      .skill-header .meta svg { width: 12px; height: 12px; }
      .skill-header .meta code {
        font-family: 'Geist Mono', monospace;
        font-size: 11px;
        color: var(--text-2);
      }

      .files-section {
        margin-bottom: 24px;
      }
      .files-bar {
        display: flex; align-items: center; gap: 4px;
        padding: 4px;
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: 10px;
        overflow-x: auto;
        scrollbar-width: thin;
      }
      .file-tab {
        flex-shrink: 0;
        display: inline-flex; align-items: center; gap: 6px;
        padding: 6px 10px;
        font-size: 12px;
        color: var(--text-2);
        background: transparent;
        border: 1px solid transparent;
        border-radius: 6px;
        cursor: pointer;
        font-family: 'Geist Mono', monospace;
        transition: background .12s, color .12s, border-color .12s;
      }
      .file-tab:hover { color: var(--text); background: var(--surface-hover); }
      .file-tab.active {
        background: var(--surface);
        color: var(--text);
        border-color: var(--border);
        box-shadow: var(--shadow-sm);
      }
      .file-tab .size {
        color: var(--text-3); font-size: 10px;
      }

      .preview-card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        overflow: hidden;
        box-shadow: var(--shadow-sm);
      }
      .preview-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 14px;
        border-bottom: 1px solid var(--border);
        background: var(--surface-2);
      }
      .preview-head .path {
        font-family: 'Geist Mono', monospace;
        font-size: 12px;
        color: var(--text-2);
      }
      .preview-head .actions { display: flex; gap: 4px; }
      .copy-btn {
        font-size: 11px;
        padding: 4px 10px;
        background: transparent;
        border: 1px solid var(--border);
        border-radius: 6px;
        color: var(--text-2);
        cursor: pointer;
        transition: background .12s, color .12s;
      }
      .copy-btn:hover { background: var(--surface-hover); color: var(--text); }

      .preview-body { padding: 28px 32px; }
      .preview-body .truncated {
        text-align: center; padding: 40px;
        color: var(--text-3); font-size: 13px;
      }
      .preview-body pre {
        margin: 0;
        font-family: 'Geist Mono', monospace;
        font-size: 12.5px;
        line-height: 1.6;
        background: var(--surface-2);
        padding: 16px;
        border-radius: 8px;
        overflow-x: auto;
      }

      /* Markdown prose */
      .prose { font-size: 14.5px; line-height: 1.7; color: var(--text); }
      .prose > *:first-child { margin-top: 0; }
      .prose > *:last-child { margin-bottom: 0; }
      .prose h1, .prose h2, .prose h3, .prose h4 {
        font-weight: 600; letter-spacing: -0.015em;
        margin-top: 1.8em; margin-bottom: 0.5em;
        line-height: 1.25;
      }
      .prose h1 { font-size: 24px; }
      .prose h2 {
        font-size: 19px;
        padding-bottom: 6px;
        border-bottom: 1px solid var(--border);
      }
      .prose h3 { font-size: 16px; }
      .prose h4 { font-size: 14px; color: var(--text-2); text-transform: uppercase; letter-spacing: 0.05em; }
      .prose p { margin: 0.8em 0; }
      .prose a {
        color: var(--accent);
        text-decoration: none;
        border-bottom: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
        transition: border-color .12s;
      }
      .prose a:hover { border-bottom-color: var(--accent); }
      .prose ul, .prose ol { padding-left: 1.4em; margin: 0.8em 0; }
      .prose li { margin: 0.3em 0; }
      .prose li::marker { color: var(--text-3); }
      .prose code {
        font-family: 'Geist Mono', monospace;
        font-size: 0.88em;
        padding: 2px 6px;
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: 4px;
        color: var(--accent);
      }
      .prose pre {
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 14px 16px;
        overflow-x: auto;
        font-size: 12.5px;
        line-height: 1.6;
        margin: 1em 0;
      }
      .prose pre code {
        background: transparent;
        border: none;
        padding: 0;
        color: var(--text);
        font-size: inherit;
      }
      .prose blockquote {
        margin: 1em 0;
        padding: 6px 16px;
        border-left: 3px solid var(--accent);
        background: var(--accent-bg);
        color: var(--text-2);
        border-radius: 0 6px 6px 0;
      }
      .prose blockquote p { margin: 0.4em 0; }
      .prose hr {
        border: 0; border-top: 1px solid var(--border); margin: 2em 0;
      }
      .prose table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
        margin: 1em 0;
      }
      .prose th, .prose td {
        border: 1px solid var(--border);
        padding: 8px 12px;
        text-align: left;
      }
      .prose th {
        background: var(--surface-2);
        font-weight: 600;
      }
      .prose img {
        max-width: 100%;
        border-radius: 6px;
      }

      /* Scrollbar */
      ::-webkit-scrollbar { width: 10px; height: 10px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb {
        background: var(--border-strong);
        border-radius: 999px;
        border: 2px solid var(--bg);
      }
      ::-webkit-scrollbar-thumb:hover { background: var(--text-3); }

      /* Transitions */
      .fade-enter { animation: fadeIn .25s ease forwards; }
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: translateY(0); }
      }

      [x-cloak] { display: none !important; }

      @media (max-width: 820px) {
        .app { grid-template-columns: 1fr; grid-template-rows: 56px auto 1fr; }
        aside.sidebar { max-height: 280px; border-right: 0; border-bottom: 1px solid var(--border); }
        .workspace-inner { padding: 28px 20px 60px; }
      }
    </style>
  </head>
  <body x-data="app()" x-init="init()" x-cloak :class="theme === 'dark' ? 'dark-mode' : ''">
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <span class="dot"></span>
          <span>claude-skills-viewer</span>
          <span class="brand-meta mono">v0.1</span>
        </div>

        <div class="top-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input
            type="search"
            placeholder="Search skills…"
            x-model="query"
            x-ref="search"
            @keydown.escape="query = ''"
          />
          <kbd class="mono">/</kbd>
        </div>

        <button class="icon-btn" @click="cycleTheme()" :title="'Theme: ' + theme">
          <template x-if="theme === 'light'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
          </template>
          <template x-if="theme === 'dark'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          </template>
          <template x-if="theme === 'system'">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>
          </template>
        </button>
      </header>

      <aside class="sidebar">
        <div class="sidebar-label">
          <span x-text="filteredSkills.length === skills.length ? skills.length + ' skills' : filteredSkills.length + ' / ' + skills.length"></span>
        </div>
        <template x-for="skill in filteredSkills" :key="skill.name">
          <button
            class="skill-item"
            :class="{ active: selected && selected.name === skill.name }"
            @click="select(skill)"
          >
            <div class="row1">
              <span class="name" x-text="skill.name"></span>
              <span class="count" x-text="skill.files.length"></span>
            </div>
            <div class="preview" x-text="skill.description"></div>
          </button>
        </template>
        <template x-if="filteredSkills.length === 0">
          <div style="padding: 16px; color: var(--text-3); font-size: 12px; text-align: center;">
            No matches for <span class="mono" x-text="'&quot;' + query + '&quot;'"></span>
          </div>
        </template>
      </aside>

      <main class="workspace">
        <template x-if="!selected">
          <div class="empty">
            <div class="glyph">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>
            </div>
            <h2>Select a skill</h2>
            <p><span x-text="skills.length"></span> skills · <span x-text="totalFiles"></span> files indexed from <span class="mono">~/.claude/skills</span></p>
          </div>
        </template>

        <template x-if="selected">
          <div class="workspace-inner fade-enter" :key="selected.name">
            <section class="skill-header">
              <div class="crumb">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>
                <span>Skill</span>
              </div>
              <h1>
                <span x-text="selected.name"></span>
                <template x-if="selected.isSymlink"><span class="symlink-pill">symlink</span></template>
              </h1>
              <p class="desc" x-text="selected.description"></p>
              <div class="meta">
                <div class="item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
                  <span><span x-text="selected.files.length"></span> file<span x-show="selected.files.length !== 1">s</span></span>
                </div>
                <div class="item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
                  <span x-text="formatBytes(totalSize(selected))"></span>
                </div>
                <div class="item">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                  <code x-text="selected.realPath"></code>
                </div>
              </div>
            </section>

            <section class="files-section">
              <div class="files-bar">
                <template x-for="file in selected.files" :key="file.path">
                  <button
                    class="file-tab"
                    :class="{ active: selectedFile && selectedFile.path === file.path }"
                    @click="selectFile(file)"
                  >
                    <span x-text="file.path"></span>
                    <span class="size" x-text="formatBytes(file.size)"></span>
                  </button>
                </template>
              </div>
            </section>

            <template x-if="selectedFile">
              <section class="preview-card" :key="selected.name + '/' + selectedFile.path">
                <div class="preview-head">
                  <span class="path" x-text="selectedFile.path"></span>
                  <div class="actions">
                    <button class="copy-btn" @click="copyContent()" x-text="copied ? 'Copied' : 'Copy'"></button>
                  </div>
                </div>
                <div class="preview-body">
                  <template x-if="selectedFile.truncated">
                    <div class="truncated">
                      File too large to preview inline (<span x-text="formatBytes(selectedFile.size)"></span>).
                    </div>
                  </template>
                  <template x-if="!selectedFile.truncated && !selectedFile.isText">
                    <div class="truncated">
                      Binary file (<span x-text="formatBytes(selectedFile.size)"></span>).
                    </div>
                  </template>
                  <template x-if="!selectedFile.truncated && selectedFile.isText && selectedFile.lang === 'markdown'">
                    <div class="prose" x-html="renderMarkdown(selectedFile.content)"></div>
                  </template>
                  <template x-if="!selectedFile.truncated && selectedFile.isText && selectedFile.lang !== 'markdown'">
                    <pre><code :class="'language-' + selectedFile.lang" x-html="renderCode(selectedFile)"></code></pre>
                  </template>
                </div>
              </section>
            </template>
          </div>
        </template>
      </main>
    </div>

    <script>
      const SKILLS = ${safeJson(payload)};
      const TOTAL_FILES = ${totalFiles};

      function applyTheme(mode) {
        const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.classList.toggle('dark', dark);
        document.getElementById('hljs-dark').disabled = !dark;
        document.getElementById('hljs-light').disabled = dark;
      }

      function app() {
        return {
          skills: SKILLS,
          totalFiles: TOTAL_FILES,
          query: '',
          selected: null,
          selectedFile: null,
          theme: localStorage.getItem('claude-skills-viewer-theme') || 'system',
          copied: false,

          init() {
            applyTheme(this.theme);
            matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
              if (this.theme === 'system') applyTheme('system');
            });

            marked.setOptions({
              gfm: true,
              breaks: false,
              highlight: (code, lang) => {
                if (lang && hljs.getLanguage(lang)) {
                  try { return hljs.highlight(code, { language: lang }).value; } catch {}
                }
                try { return hljs.highlightAuto(code).value; } catch { return code; }
              },
            });

            document.addEventListener('keydown', (e) => {
              if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
                e.preventDefault();
                this.$refs.search.focus();
              }
            });

            if (this.skills.length > 0) this.select(this.skills[0]);
          },

          get filteredSkills() {
            const q = this.query.trim().toLowerCase();
            if (!q) return this.skills;
            return this.skills.filter(s =>
              s.name.toLowerCase().includes(q) ||
              s.description.toLowerCase().includes(q)
            );
          },

          select(skill) {
            this.selected = skill;
            this.selectedFile = skill.files[0] || null;
            this.copied = false;
          },

          selectFile(file) {
            this.selectedFile = file;
            this.copied = false;
            this.$nextTick(() => {
              document.querySelectorAll('.preview-body pre code').forEach(el => {
                if (!el.dataset.highlighted) {
                  hljs.highlightElement(el);
                  el.dataset.highlighted = 'yes';
                }
              });
            });
          },

          renderMarkdown(content) {
            const html = marked.parse(content);
            this.$nextTick(() => {
              document.querySelectorAll('.prose pre code').forEach(el => {
                if (!el.dataset.highlighted) {
                  hljs.highlightElement(el);
                  el.dataset.highlighted = 'yes';
                }
              });
            });
            return html;
          },

          renderCode(file) {
            try {
              return hljs.highlight(file.content, { language: file.lang }).value;
            } catch {
              return file.content
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            }
          },

          totalSize(skill) {
            return skill.files.reduce((acc, f) => acc + f.size, 0);
          },

          formatBytes(n) {
            if (n < 1024) return n + ' B';
            if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
            return (n / (1024 * 1024)).toFixed(2) + ' MB';
          },

          cycleTheme() {
            const order = ['system', 'light', 'dark'];
            const next = order[(order.indexOf(this.theme) + 1) % order.length];
            this.theme = next;
            localStorage.setItem('claude-skills-viewer-theme', next);
            applyTheme(next);
          },

          async copyContent() {
            if (!this.selectedFile) return;
            try {
              await navigator.clipboard.writeText(this.selectedFile.content);
              this.copied = true;
              setTimeout(() => { this.copied = false; }, 1400);
            } catch {}
          },
        };
      }
    </script>
  </body>
</html>`;
}

function openInBrowser(filePath: string) {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open"
    : platform === "win32" ? "start"
    : "xdg-open";
  const args = platform === "win32" ? ["", filePath] : [filePath];
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
    shell: platform === "win32",
  });
  child.unref();
}

async function runWeb(skills: Skill[]) {
  const dir = await mkdtemp(join(tmpdir(), "claude-skills-viewer-"));
  const file = join(dir, "skills.html");
  const html = renderHtml(skills);
  await writeFile(file, html, "utf8");

  const totalFiles = skills.reduce((acc, s) => acc + s.files.length, 0);

  console.log();
  console.log(`${c.bold}${c.cyan}claude-skills-viewer${c.reset} ${c.dim}— web preview${c.reset}`);
  console.log(`  ${c.green}✓${c.reset} ${skills.length} skill${skills.length === 1 ? "" : "s"}, ${totalFiles} files indexed`);
  console.log(`  ${c.gray}file://${file}${c.reset}`);
  console.log();

  openInBrowser(file);
}

async function main() {
  const args = process.argv.slice(2);
  const wantsWeb = args.includes("--web") || args.includes("-w");
  const wantsHelp = args.includes("--help") || args.includes("-h");
  const wantsPlain = args.includes("--plain") || args.includes("-p");

  if (wantsHelp) {
    console.log(`
${c.bold}claude-skills-viewer${c.reset} — list skills installed in ~/.claude/skills

${c.bold}Usage:${c.reset}
  claude-skills-viewer            Interactive compact list (default)
  claude-skills-viewer --plain    Print plain list (good for piping)
  claude-skills-viewer --web      Open an HTML preview in your browser
  claude-skills-viewer --help     Show this help

${c.bold}Interactive keys:${c.reset}
  ${c.dim}↑↓${c.reset} or ${c.dim}j/k${c.reset}    navigate
  ${c.dim}space${c.reset}        toggle expand for current item
  ${c.dim}tab${c.reset}          toggle expand all
  ${c.dim}esc${c.reset} or ${c.dim}q${c.reset}     quit
`);
    return;
  }

  let skills: Skill[];
  try {
    skills = await loadSkills();
  } catch (err) {
    console.error(`${c.yellow}Could not read ${SKILLS_DIR}${c.reset}`);
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (wantsWeb) {
    await runWeb(skills);
  } else if (wantsPlain || !process.stdout.isTTY) {
    renderTerminal(skills);
  } else {
    await runInteractive(skills);
  }
}

main();
