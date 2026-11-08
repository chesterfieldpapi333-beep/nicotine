// Temas: tokens planos en JSON ("themes/*.theme.json" + built-ins).
// Los componentes leen tokens por nombre vía T(theme, "accent") etc.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseJsonc } from "../util/jsonc.js";

export interface Theme { name: string; tokens: Record<string, string> }

export const defaultThemes: Theme[] = [
  {
    name: "vireo-dark",
    tokens: {
      fg: "#d3d7cf", dim: "#77767b", bg: "#1a1a1a", accent: "#34e2e2",
      success: "#8ae234", error: "#ef2929", warning: "#fce94f",
      user: "#8ae234", assistant: "#d3d7cf", tool: "#729fcf", border: "#555753",
      selection: "#3465a4", diffAdd: "#8ae234", diffDel: "#ef2929", diffHunk: "#34e2e2",
    },
  },
  {
    name: "vireo-light",
    tokens: {
      fg: "#2e3436", dim: "#888a85", bg: "#f3f3ee", accent: "#0b6a83",
      success: "#2e7d32", error: "#c62828", warning: "#9a6a00",
      user: "#2e7d32", assistant: "#2e3436", tool: "#1b4f8a", border: "#b8b8ae",
      selection: "#cfe3f5", diffAdd: "#2e7d32", diffDel: "#c62828", diffHunk: "#0b6a83",
    },
  },
];

/** Directorios de temas de usuario/proyecto (plural `themes/`, como OpenCode). */
export function themeDirs(cwd: string): string[] {
  const dirs = [join(homedir(), ".config", "opencode", "themes"), join(homedir(), ".config", "vireo", "themes")];
  // proyecto: raíz → cwd, carpetas themes/ directas y dentro de .opencode/.vireo
  const trail: string[] = [];
  let cur = cwd;
  for (;;) { trail.push(cur); const parent = join(cur, ".."); if (parent === cur) break; cur = parent; }
  trail.reverse(); // de la raíz hacia cwd: lo más cercano se carga después y gana
  for (const dir of trail) {
    dirs.push(join(dir, "themes"), join(dir, ".opencode", "themes"), join(dir, ".vireo", "themes"));
  }
  return dirs;
}

export function loadThemes(cwd: string): Map<string, Theme> {
  const themes = new Map<string, Theme>(defaultThemes.map((t) => [t.name, t]));
  for (const dir of themeDirs(cwd)) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!/\.(theme\.)?jsonc?$/.test(file)) continue;
      try {
        const raw = parseJsonc<Record<string, unknown>>(readFileSync(join(dir, file), "utf8"), join(dir, file));
        const name = typeof raw["name"] === "string" ? raw["name"] : file.replace(/\.(theme\.)?jsonc?$/, "");
        // Formato tolerante: tokens plano o bajo clave "tokens"/"theme"
        const flat: Record<string, unknown> = (raw["tokens"] ?? raw["theme"] ?? raw) as Record<string, unknown>;
        const tokens: Record<string, string> = {};
        for (const [k, v] of Object.entries(flat)) if (typeof v === "string" && k !== "name") tokens[k] = v;
        // se fusionan tokens sobre vireo-dark para que un tema parcial funcione
        themes.set(name, { name, tokens: { ...defaultThemes[0].tokens, ...tokens } });
      } catch (err) {
        console.error(`[vireo] tema ignorado ${file}: ${(err as Error).message}`);
      }
    }
  }
  return themes;
}

export const token = (theme: Theme, name: string, fallback = "#ffffff"): string => theme.tokens[name] ?? fallback;

// helpers de color ANSI construidos desde hex del tema
export const fgHex = (hex: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};
export const reset = "\x1b[0m";
export const bold = "\x1b[1m";
export const dimmed = "\x1b[2m";
