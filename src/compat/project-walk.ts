// Paseo del árbol del proyecto (serve /find/file, /file y autocomplete «@» de la TUI).
// Zero-dep: ignora directorios ruidosos y ocultos (salvo .env.example); tope de profundidad y entradas.

import { readdirSync } from "node:fs";
import { join } from "node:path";

const IGNORED_DIRS = new Set([".git", "node_modules", "target", "dist", "build", ".next", ".venv", "__pycache__", ".cache", "out", "coverage"]);

export function walkProject(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || out.length >= 6000) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 6000) return;
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      const rel = dir === root ? e.name : `${dir.slice(root.length + 1)}/${e.name}`;
      if (e.isDirectory()) { if (!IGNORED_DIRS.has(e.name)) walk(join(dir, e.name), depth + 1); }
      else out.push(rel);
    }
  };
  walk(root, 0);
  return out;
}
