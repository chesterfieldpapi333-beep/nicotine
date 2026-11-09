// Descubrimiento multi-CLI (fase 7): reunir lo que otras CLIs dejan en el disco
// como DATOS — skills (extraSources), comandos .md, agentes .md, temas JSON,
// servidores MCP, hooks, archivos de contexto extra — SIN ejecutar código de
// terceros (plugins .ts/.js → reporte «no soportado»).
//
// Orígenes:
//   global (home):  ~/.claude/{plugins,agents,commands,settings.json},
//                   ~/.config/opencode/{agents,commands,themes},
//                   ~/.pi/agent/{prompts,themes,agents,extensions? → no: código},
//                   ~/.gemini/extensions/*/gemini-extension.json,
//                   ~/.gemini/settings.json, ~/.codex/config.toml,
//                   ~/.claude/plugins/*/  (plugins instalados de Claude)
//   project (raíz→cwd): .claude/..., .opencode/..., .pi/..., .gemini/...,
//                   .mcp.json, .codex/config.toml
//
// Precedencia MCP (primera gana, aviso si hay colisión): config nativa de vireo
// (la resuelve manager.ts, siempre gana) > proyecto (de DENTRO hacia FUERA) >
// global. Reglas de datos (skills/commands/themes/agents): primera fuente gana
// con aviso; el orden exacto lo decide cada escáner (global → proyecto → plugins).

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { parseToml } from "./toml-lite.js";
import { dirsRootToCwd } from "./util.js";
import { scanFileCommands, type FileCommand, type PluginCommandSource } from "./file-commands.js";
import { scanForeignThemes, type ForeignTheme, type PluginThemeSource } from "./foreign-themes.js";
import { scanAgentFiles, type AgentFileSource } from "./agent-files.js";
import { collectHooks, type HookCommand, type HookPluginSource } from "./hooks.js";
import type { AgentDef } from "../core/agents.js";
import type { McpLayerKind } from "./mcp/types.js";

export type PluginKind = "claude" | "opencode" | "pi" | "gemini" | "codex";

export interface PluginInfo {
  kind: PluginKind;
  origin: "global" | "project";
  /** nombre público (manifest name, o nombre del directorio) */
  name: string;
  /** directorio raíz del plugin */
  root: string;
  source: string;
}

export interface ExtraMcpDef {
  name: string;
  raw: Record<string, unknown>;
  origin: McpLayerKind;
  excludeTools?: string[];
  source: string;
}

export interface ExtraContextFile { path: string; source: string }

export interface PluginsReport {
  plugins: PluginInfo[];
  warnings: string[];
  unsupported: string[];
  mcp: ExtraMcpDef[];
  commands: FileCommand[];
  themes: ForeignTheme[];
  agents: AgentDef[];
  hooks: HookCommand[];
  hooksSkipped: { source: string; detail: string }[];
  contextFiles: ExtraContextFile[];
  /** dirs extra para el escáner de skills (plugins con skills/) */
  skillSources: { dir: string; origin: "global" | "project" }[];
}

const readJson = (path: string): Record<string, unknown> | null => {
  try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { return null; }
};
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const oneLevelDirs = (dir: string): string[] => {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name)).sort(); }
  catch { return []; }
};

export function discoverPlugins(cwd: string, opts: { home?: string } = {}): PluginsReport {
  const home = opts.home ?? homedir();
  const warnings: string[] = [];
  const unsupported: string[] = [];
  const plugins: PluginInfo[] = [];
  const mcp: ExtraMcpDef[] = [];
  const contextFiles: ExtraContextFile[] = [];
  const skillSources: { dir: string; origin: "global" | "project" }[] = [];

  const seenPlugins = new Set<string>();
  const addPlugin = (kind: PluginKind, origin: "global" | "project", name: string, root: string, source: string): PluginInfo | null => {
    const key = `${kind}:${origin}:${name}`;
    if (seenPlugins.has(key)) return null;
    seenPlugins.add(key);
    const info: PluginInfo = { kind, origin, name, root, source };
    plugins.push(info);
    return info;
  };
  const pushMcp = (name: string, raw: unknown, origin: McpLayerKind, source: string, excludeTools?: string[]) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) { warnings.push(`${source}: servidor MCP «${name}» con nombre inválido; ignorado`); return; }
    if (!raw || typeof raw !== "object") { warnings.push(`${source}: servidor MCP «${name}» sin definición; ignorado`); return; }
    mcp.push({ name, raw: raw as Record<string, unknown>, origin, excludeTools, source });
  };

  // ————— global: plugins y extensiones de usuario —————
  for (const dir of oneLevelDirs(join(home, ".claude", "plugins"))) {
    const manifestPath = join(dir, ".claude-plugin", "plugin.json");
    if (!isFile(manifestPath)) { if (isDir(join(dir))) unsupported.push(`claude: ${dir} (sin .claude-plugin/plugin.json); contenido no cargado`); continue; }
    const manifest = readJson(manifestPath);
    const name = typeof manifest?.["name"] === "string" && String(manifest["name"]).trim() ? String(manifest["name"]).trim() : basename(dir);
    addPlugin("claude", "global", name, dir, manifestPath);
    collectPluginSkills(dir, "global", skillSources);
  }
  for (const dir of oneLevelDirs(join(home, ".gemini", "extensions"))) {
    const manifestPath = join(dir, "gemini-extension.json");
    if (!isFile(manifestPath)) continue;
    geminiExtension(dir, manifestPath, "global", plugins, warnings, mcp, contextFiles, skillSources, addPlugin, pushMcp, unsupported);
  }
  // gemini settings.json (user) — mcpServers
  readGeminiSettings(join(home, ".gemini", "settings.json"), "global", warnings, mcp, pushMcp);
  // codex config.toml (user) — [mcp_servers.*]
  readCodexToml(join(home, ".codex", "config.toml"), "global", warnings, mcp, pushMcp);

  // ————— proyecto: de DENTRO hacia FUERA (innermost gana en colisiones MCP) —————
  const projDirs = [...dirsRootToCwd(cwd)];
  const pjFromCwd = [...projDirs].reverse();
  for (const dir of pjFromCwd) {
    // .mcp.json (Claude, project scope)
    const mcpJson = join(dir, ".mcp.json");
    if (isFile(mcpJson)) {
      const json = readJson(mcpJson);
      if (json?.["mcpServers"] && typeof json["mcpServers"] === "object") {
        for (const [name, def] of Object.entries(json["mcpServers"] as Record<string, unknown>)) pushMcp(name, def, "project", mcpJson);
      } else warnings.push(`${mcpJson}: falta «mcpServers»; se ignora`);
    }
    // gemini settings.json (proyecto)
    readGeminiSettings(join(dir, ".gemini", "settings.json"), "project", warnings, mcp, pushMcp);
    // codex config.toml (proyecto)
    readCodexToml(join(dir, ".codex", "config.toml"), "project", warnings, mcp, pushMcp);
    // plugins
    for (const pdir of oneLevelDirs(join(dir, ".claude", "plugins"))) {
      const manifestPath = join(pdir, ".claude-plugin", "plugin.json");
      if (!isFile(manifestPath)) continue;
      const manifest = readJson(manifestPath);
      const name = typeof manifest?.["name"] === "string" && String(manifest["name"]).trim() ? String(manifest["name"]).trim() : basename(pdir);
      addPlugin("claude", "project", name, pdir, manifestPath);
      collectPluginSkills(pdir, "project", skillSources);
    }
    for (const pdir of oneLevelDirs(join(dir, ".gemini", "extensions"))) {
      const manifestPath = join(pdir, "gemini-extension.json");
      if (!isFile(manifestPath)) continue;
      geminiExtension(pdir, manifestPath, "project", plugins, warnings, mcp, contextFiles, skillSources, addPlugin, pushMcp, unsupported);
    }
    // opencode: plugins/*.ts NO se ejecutan → reporte
    const ocPlugins = join(dir, ".opencode", "plugins");
    if (isDir(ocPlugins)) {
      for (const f of readdirSync(ocPlugins).filter((f) => /\.(ts|mts|js|mjs)$/.test(f))) {
        unsupported.push(`opencode: plugin ejecutable .opencode/plugins/${f} — no se ejecuta (migra a una extensión vireo)`);
      }
    }
  }
  // pi: packages NO se escanean de node_modules (v1); sí las carpetas .pi / ~/.pi/agent
  unsupported.push("pi: packages con clave «pi» en package.json de dependencias no se escanean (v1); solo .pi/ y ~/.pi/agent");
  // claude: ~/.claude.json (user-scope MCP) no se lee
  if (isFile(join(home, ".claude.json"))) unsupported.push("claude: ~/.claude.json (MCP user-scope) no se lee en v1; mueve los servidores a tu config opencode.json");

  const commandPlugins: PluginCommandSource[] = plugins.map((p) => ({ name: p.name, root: p.root, origin: p.origin }));
  const themePlugins: PluginThemeSource[] = commandPlugins;
  const agentPlugins: AgentFileSource[] = commandPlugins;
  const hookPlugins: HookPluginSource[] = commandPlugins;

  const commands = scanFileCommands(cwd, { home, plugins: commandPlugins });
  const themes = scanForeignThemes(cwd, { home, plugins: themePlugins });
  const agents = scanAgentFiles(cwd, { home, plugins: agentPlugins });
  const hooks = collectHooks(cwd, { home, plugins: hookPlugins });

  return {
    plugins,
    warnings: [...warnings, ...commands.warnings, ...themes.warnings, ...agents.warnings, ...hooks.warnings],
    unsupported,
    mcp,
    commands: commands.commands,
    themes: themes.themes,
    agents: agents.agents,
    hooks: hooks.hooks,
    hooksSkipped: hooks.skipped,
    contextFiles,
    skillSources,
  };
}

function collectPluginSkills(pluginRoot: string, origin: "global" | "project", out: { dir: string; origin: "global" | "project" }[]): void {
  const skillsDir = join(pluginRoot, "skills");
  if (isDir(skillsDir)) out.push({ dir: skillsDir, origin });
}

function geminiExtension(
  root: string,
  manifestPath: string,
  origin: "global" | "project",
  plugins: PluginInfo[],
  warnings: string[],
  mcp: ExtraMcpDef[],
  contextFiles: ExtraContextFile[],
  skillSources: { dir: string; origin: "global" | "project" }[],
  addPlugin: (kind: PluginKind, origin: "global" | "project", name: string, root: string, source: string) => PluginInfo | null,
  pushMcp: (name: string, raw: unknown, origin: McpLayerKind, source: string, excludeTools?: string[]) => void,
  unsupported: string[],
): void {
  const manifest = readJson(manifestPath);
  if (!manifest) { warnings.push(`${manifestPath}: JSON inválido; extensión descartada`); return; }
  const name = typeof manifest["name"] === "string" && String(manifest["name"]).trim() ? String(manifest["name"]).trim() : basename(root);
  const info = addPlugin("gemini", origin, name, root, manifestPath);
  if (!info) return;
  // contextFileName: string | string[] (relativo a la extensión)
  const cf = manifest["contextFileName"];
  const ctxFiles = (Array.isArray(cf) ? cf : typeof cf === "string" ? [cf] : []).map(String).slice(0, 4);
  for (const rel of ctxFiles) {
    const p = join(root, rel);
    if (isFile(p)) contextFiles.push({ path: p, source: manifestPath });
    else warnings.push(`${manifestPath}: contextFileName «${rel}» no existe`);
  }
  collectPluginSkills(root, origin, skillSources);
  // excludeTools: se aplica a los tools MCP de ESTA extensión
  const excludeTools = Array.isArray(manifest["excludeTools"]) ? (manifest["excludeTools"] as unknown[]).map(String) : undefined;
  const servers = manifest["mcpServers"];
  if (servers && typeof servers === "object") {
    for (const [serverName, def] of Object.entries(servers as Record<string, unknown>)) {
      pushMcp(serverName, def, origin, manifestPath, excludeTools);
    }
  }
  // comandos TOML/MD de gemini: formato sin verificar → reporte, no ejecución
  const cmdsDir = join(root, "commands");
  if (isDir(cmdsDir)) unsupported.push(`gemini: ${cmdsDir} — comando de extensión en formato sin verificar; no se carga en v1`);
}

function readGeminiSettings(
  path: string,
  origin: "global" | "project",
  warnings: string[],
  mcp: ExtraMcpDef[],
  pushMcp: (name: string, raw: unknown, origin: McpLayerKind, source: string, excludeTools?: string[]) => void,
): void {
  void warnings;
  if (!isFile(path)) return;
  const json = readJson(path);
  const servers = json?.["mcpServers"];
  if (!servers || typeof servers !== "object") return;
  for (const [name, def] of Object.entries(servers as Record<string, unknown>)) pushMcp(name, def, origin, path);
}

function readCodexToml(
  path: string,
  origin: "global" | "project",
  warnings: string[],
  mcp: ExtraMcpDef[],
  pushMcp: (name: string, raw: unknown, origin: McpLayerKind, source: string, excludeTools?: string[]) => void,
): void {
  if (!isFile(path)) return;
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { warnings.push(`${path}: ilegible`); return; }
  const parsed = parseToml(raw);
  if (!parsed.value) { warnings.push(`${path}: TOML no soportado (${parsed.error}); [mcp_servers] no cargados`); return; }
  const servers = (parsed.value as Record<string, unknown>)["mcp_servers"];
  if (!servers || typeof servers !== "object") return;
  for (const [name, def] of Object.entries(servers as Record<string, unknown>)) {
    if (!def || typeof def !== "object") { warnings.push(`${path}: mcp_servers.${name} inválido; ignorado`); continue; }
    pushMcp(name, def, origin, path);
  }
}
