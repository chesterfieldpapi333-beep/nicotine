// Carga opencode.json(c) con las capas de precedencia de OpenCode:
//   system (/etc/opencode) < global (~/.config/opencode) < proyecto (raíz→cwd)
//   < .opencode/ del árbol proyecto < --config-dir (capa custom de Nicotine)
// Cada capa deep-mergea con la anterior; `permissions` (array v2) SE CONCATENA
// entre capas (las reglas se aplican en orden; la última que casa gana).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseJsonc } from "../util/jsonc.js";
import { baseRules, configToRules, policiesFromConfig, type Rule, type Policy } from "./permissions.js";

export interface LoadedConfig {
  /** Config final ya mergeada y con variables {env:}/{file:} sustituidas. */
  config: Record<string, unknown>;
  /** Reglas ordenadas: defaults < system < global < proyecto < .opencode < custom. */
  rules: Rule[];
  policies: Policy[];
  /** Archivos cargados, en orden de aplicación (para `doctor`). */
  layers: string[];
  /** Origen de cada regla/policy en el mismo orden que `rules`/`policies` (defaults|system|global|project|policy|custom). */
  ruleSources: string[];
  policySources: string[];
  /** Avisos no fatales (claves desconocidas, etc.); nunca errores. */
  warnings: string[];
  /** Nombre de servidor mcp → capa de origen (para la compuerta de confianza). */
  mcpOrigins: Record<string, "system" | "global" | "project" | "custom">;
  /** Path tal como aparece en config.extensions → capa de origen (compuerta de confianza). */
  extensionOrigins: Record<string, "system" | "global" | "project" | "custom">;
}

// Claves de primer nivel conocidas (las que usa o irá usando Nicotine). Una clave
// fuera de esta lista se reporta como aviso y se ignora — nunca es un error.
const KNOWN_TOP_KEYS = new Set([
  "$schema", "model", "small_model", "default_agent", "permission", "permissions",
  "compaction", "instructions", "skills", "mcp", "snapshots", "tui", "theme",
  "agents", "commands", "themes", "plugins", "policies", "provider", "providers",
  "mode", "tools", "experimental", "share", "autoupdate", "enabled_providers", "extensions",
  "disabled_providers", "keybinds", "username", "shell", "compat", "approval_policy",
]);

function readRulePolicy(dir: string): { path: string; data: Record<string, unknown> } | null {
  // .nicotine/policy.json(c): política versionada del proyecto (la escribe `nic policy import`).
  for (const name of ["policy.json", "policy.jsonc"]) {
    const path = join(dir, ".nicotine", name);
    if (!existsSync(path)) continue;
    try {
      return { path, data: parseJsonc<Record<string, unknown>>(readFileSync(path, "utf8"), path) };
    } catch { return null; } // política inválida: se ignora aquí; `nic policy import` valida al escribir
  }
  return null;
}

const SYSTEM_DIR = process.platform === "darwin" ? "/Library/Application Support/opencode" : "/etc/opencode";
const GLOBAL_DIR = join(homedir(), ".config", "opencode");

function* projectDirs(cwd: string): Generator<string> {
  // De la raíz del FS hacia cwd (los más cercanos ganan al final del merge).
  const trail: string[] = [];
  let cur = resolve(cwd);
  for (;;) {
    trail.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  yield* trail.reverse();
}

function readLayer(dir: string): { path: string; data: Record<string, unknown> } | null {
  // .json primero para que .jsonc (JSONC) gane dentro del mismo directorio.
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const data = parseJsonc<Record<string, unknown>>(readFileSync(path, "utf8"), path);
    applySubstitutions(data, dirname(path));
    return { path, data };
  }
  return null;
}

function applySubstitutions(node: unknown, configDir: string): void {
  if (Array.isArray(node)) return node.forEach((v) => applySubstitutions(v, configDir));
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === "string") {
      (node as Record<string, unknown>)[k] = v
        .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? "")
        .replace(/\{file:([^}]+)\}/g, (_, raw) => {
          const p = String(raw).trim();
          const abs = p.startsWith("~/") ? join(homedir(), p.slice(2)) : p.startsWith("/") ? p : resolve(configDir, p);
          try { return readFileSync(abs, "utf8").trimEnd(); } catch { return ""; } // archivo ausente → ""
        });
    } else applySubstitutions(v, configDir);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key];
    if (key === "permissions" && Array.isArray(prev) && Array.isArray(value)) {
      out[key] = [...prev, ...value]; // v2: las reglas se concatenan entre capas
      continue;
    }
    if (isPlainObject(prev) && isPlainObject(value)) out[key] = deepMerge(prev, value);
    else out[key] = value;
  }
  return out;
}

type LayerKind = "system" | "global" | "project" | "policy" | "custom";

export function loadConfig(cwd: string, opts: { configDir?: string } = {}): LoadedConfig {
  const layers: { path: string; data: Record<string, unknown>; kind: LayerKind }[] = [];
  const sys = readLayer(SYSTEM_DIR);
  if (sys) layers.push({ ...sys, kind: "system" });
  const glob = readLayer(GLOBAL_DIR);
  if (glob) layers.push({ ...glob, kind: "global" });
  for (const dir of projectDirs(cwd)) {
    const direct = readLayer(dir);      // opencode.json(c) directo
    if (direct) layers.push({ ...direct, kind: "project" });
    const dot = readLayer(join(dir, ".opencode")); // .opencode/opencode.json(c) gana al directo
    if (dot) layers.push({ ...dot, kind: "project" });
    const rp = readRulePolicy(dir);
    if (rp) layers.push({ ...rp, kind: "policy" }); // después de la config del proyecto, antes de custom
  }
  if (opts.configDir) {
    const custom = readLayer(resolve(cwd, opts.configDir));
    if (custom) layers.push({ ...custom, kind: "custom" }); // capa explícita del usuario = confiada
  }

  let config: Record<string, unknown> = {};
  for (const layer of layers) config = deepMerge(config, layer.data);

  // Reglas: defaults primero; luego, capa por capa EN ORDEN (no del merge,
  // que reordenaría). Así los allows del proyecto pisan al ask global.
  const base = baseRules();
  const rules: Rule[] = [...base];
  const policies: Policy[] = [];
  const ruleSources: string[] = base.map(() => "defaults");
  const policySources: string[] = [];
  for (const layer of layers) {
    const rs = configToRules(layer.data["permission"], layer.data["permissions"]);
    rules.push(...rs);
    for (const _ of rs) ruleSources.push(layer.kind);
    const ps = policiesFromConfig(layer.data["policies"]);
    policies.push(...ps);
    for (const _ of ps) policySources.push(layer.kind);
  }

  const warnings: string[] = [];
  for (const key of Object.keys(config)) {
    if (!KNOWN_TOP_KEYS.has(key)) warnings.push(`clave desconocida (se ignora): "${key}"`);
  }

  // Orígenes de servidores mcp: la última capa que declara el nombre gana.
  const mcpOrigins: Record<string, "system" | "global" | "project" | "custom"> = {};
  for (const layer of layers) {
    const mcp = layer.data["mcp"];
    if (!mcp || typeof mcp !== "object") continue;
    const obj = mcp as Record<string, unknown>;
    const names: string[] = [];
    for (const k of Object.keys(obj)) if (k !== "servers" && obj[k] && typeof obj[k] === "object") names.push(k);
    const servers = obj["servers"];
    if (servers && typeof servers === "object") {
      for (const k of Object.keys(servers as Record<string, unknown>)) {
        const v = (servers as Record<string, unknown>)[k];
        if (v && typeof v === "object") names.push(k);
      }
    }
    for (const n of names) mcpOrigins[n] = layer.kind as typeof mcpOrigins[string];
  }

  // Orígenes de rutas de extensiones: la última capa que declara el path gana.
  const extensionOrigins: Record<string, "system" | "global" | "project" | "custom"> = {};
  for (const layer of layers) {
    const raw = layer.data["extensions"];
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      if (typeof item === "string" && item.trim()) extensionOrigins[item] = layer.kind as typeof extensionOrigins[string];
    }
  }

  return { config, rules, policies, layers: layers.map((l) => l.path), warnings, mcpOrigins, extensionOrigins, ruleSources, policySources };
}
