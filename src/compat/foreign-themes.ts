// Temas JSON de otras CLIs → tokens vireo (merge sobre vireo-dark).
//  Shape A (vireo-like): { name?, tokens: { token: color } }
//  Shape B (best-effort): { "theme": {…} } o flat { primary, text, … }
// Mapeo B (documentado como best-effort): primary|info→accent, text|foreground→fg,
// background|backgroundPanel|bg→bg, secondary|muted|comment→dim, error→error,
// warning→warning, success→success, selection→accent, diffAdded→diffAdd,
// diffRemoved→diffDel, hunk→diffHunk. ≥2 tokens mapeados o se descarta con aviso.
// Cualquier excepción de parseo → aviso, nunca crash.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { dirsRootToCwd } from "./util.js";

export interface ForeignTheme {
  name: string;
  tokens: Record<string, string>;
  source: string;
  origin: "global" | "project";
}

export interface PluginThemeSource { name: string; root: string; origin: "global" | "project" }

const KNOWN_VIREO = new Set(["accent", "fg", "bg", "dim", "error", "warning", "success", "diffAdd", "diffDel", "diffHunk"]);
const MAP_B: Record<string, string> = {
  primary: "accent", info: "accent", selection: "accent",
  text: "fg", foreground: "fg",
  background: "bg", backgroundPanel: "bg", bg: "bg",
  secondary: "dim", muted: "dim", comment: "dim", textMuted: "dim",
  error: "error", warning: "warning", success: "success",
  diffAdded: "diffAdd", diffRemoved: "diffDel", hunk: "diffHunk",
};

export function scanForeignThemes(
  cwd: string,
  opts: { home?: string; plugins?: PluginThemeSource[] } = {},
): { themes: ForeignTheme[]; warnings: string[] } {
  const home = opts.home ?? homedir();
  const warnings: string[] = [];
  const themes: ForeignTheme[] = [];
  const seen = new Set<string>();

  const addDir = (dir: string, origin: "global" | "project") => {
    let files: string[] = [];
    try { files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => join(dir, e.name)).sort(); }
    catch { return; }
    for (const f of files) {
      if (themes.length >= 100) return;
      const parsed = parseThemeFile(f);
      if ("warning" in parsed) { warnings.push(parsed.warning); continue; }
      const name = basename(f, ".json");
      if (seen.has(name)) { warnings.push(`tema «${name}»: ${f} ignorado (ya definido)`); continue; }
      seen.add(name);
      themes.push({ name, tokens: parsed.tokens, source: f, origin });
    }
  };

  addDir(join(home, ".config", "opencode", "themes"), "global");
  addDir(join(home, ".pi", "agent", "themes"), "global");
  for (const dir of dirsRootToCwd(cwd)) {
    addDir(join(dir, ".opencode", "themes"), "project");
    addDir(join(dir, ".pi", "themes"), "project");
  }
  for (const p of opts.plugins ?? []) addDir(join(p.root, "themes"), p.origin);
  return { themes, warnings };
}

type ParseResult = { tokens: Record<string, string> } | { warning: string };

export function parseThemeFile(path: string): ParseResult {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return { warning: `${path}: ilegible` }; }
  let json: unknown;
  try { json = JSON.parse(raw); } catch (e) { return { warning: `${path}: JSON inválido (${(e as Error).message})` }; }
  if (!json || typeof json !== "object") return { warning: `${path}: se esperaba un objeto JSON` };
  const obj = json as Record<string, unknown>;

  const tokens: Record<string, string> = {};
  const takeKnown = (src: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(src)) {
      if (KNOWN_VIREO.has(k) && typeof v === "string" && v.trim()) tokens[k] = v.trim();
    }
  };

  // Shape A
  if (obj["tokens"] && typeof obj["tokens"] === "object") {
    takeKnown(obj["tokens"] as Record<string, unknown>);
    if (Object.keys(tokens).length >= 1) return { tokens };
    return { warning: `${path}: «tokens» no contiene ningún token vireo conocido` };
  }

  // Shape B
  const src = (obj["theme"] && typeof obj["theme"] === "object" ? obj["theme"] : obj) as Record<string, unknown>;
  const unmapped: string[] = [];
  for (const [k, v] of Object.entries(src)) {
    if (typeof v !== "string" || !v.trim()) continue;
    const mapped = MAP_B[k] ?? (KNOWN_VIREO.has(k) ? k : undefined);
    if (mapped) tokens[mapped] = v.trim();
    else unmapped.push(k);
  }
  if (Object.keys(tokens).length < 2) {
    return { warning: `${path}: menos de 2 tokens reconocibles (mapeo best-effort); tema descartado` };
  }
  const w = unmapped.length ? `${path}: tokens sin mapear ignorados: ${unmapped.slice(0, 8).join(", ")}${unmapped.length > 8 ? "…" : ""}` : undefined;
  void w; // los warnings detallados se reportan en doctor vía source; no rompas la carga
  return { tokens };
}
