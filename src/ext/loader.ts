// Cargador de extensiones: descubrimiento, compuerta de confianza, activación.
// Nunca lanza: cualquier fallo → reporte `failed` y se sigue con las demás.
// NO importa código durante `doctor` (doctor lista archivos, no ejecuta).

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import type { AgentEvent } from "../core/events.js";
import type { AgentTool } from "../core/types.js";
import type { Runtime } from "../modes/common.js";
import { dirsRootToCwd } from "../compat/util.js";
import type { ExtensionAPI, ExtensionReport, UiBridge, SlotName, ExtCommand } from "./api.js";
import type { Component } from "../ui/component.js";
import type { Theme } from "../ui/theme.js";

const EXT_FILE = /\.(ts|mts|cts|js|mjs|cjs)$/;

interface Candidate { id: string; path: string; dir: string; origin: "global" | "project" | "custom" }

export function discoverExtensions(cwd: string, config: Record<string, unknown>, extensionOrigins: Record<string, "system" | "global" | "project" | "custom">): { candidates: Candidate[]; warnings: string[] } {
  const candidates: Candidate[] = [];
  const warnings: string[] = [];

  // legado primero: nicotine pisa vireo en caso de mismo id (el dedupe deja ganar al último)
  // global: ~/.config/vireo/extensions/* (legado, compat) y ~/.config/nicotine/extensions/* (confiables)
  const legacyGlobal = join(homedir(), ".config", "vireo", "extensions");
  for (const f of listExtFiles(legacyGlobal)) candidates.push({ id: idOf(f), path: f, dir: legacyGlobal, origin: "global" });
  const globalDir = join(homedir(), ".config", "nicotine", "extensions");
  for (const f of listExtFiles(globalDir)) candidates.push({ id: idOf(f), path: f, dir: globalDir, origin: "global" });
  // proyecto: raíz→cwd, .vireo/extensions/ (legado, compat) y .nicotine/extensions/ (NO confiables)
  for (const dir of dirsRootToCwd(cwd)) {
    const legacyPdir = join(dir, ".vireo", "extensions");
    for (const f of listExtFiles(legacyPdir)) candidates.push({ id: idOf(f), path: f, dir: legacyPdir, origin: "project" });
    const pdir = join(dir, ".nicotine", "extensions");
    for (const f of listExtFiles(pdir)) candidates.push({ id: idOf(f), path: f, dir: pdir, origin: "project" });
  }
  // config `extensions`: rutas (archivo .ts/.js o carpeta); origen desde la capa
  const raw = config["extensions"];
  if (raw !== undefined && !Array.isArray(raw)) {
    warnings.push('config "extensions" debe ser un array de rutas; se ignora');
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string" || !item.trim()) { warnings.push("extensions: entrada vacía o no-string; se ignora"); continue; }
      const origin = extensionOrigins[item] ?? "project";
      const abs = resolve(cwd, item.startsWith("~/") ? join(homedir(), item.slice(2)) : item);
      if (!existsSync(abs)) { warnings.push(`extensions: no existe: ${item}`); continue; }
      const files = isDir(abs) ? listExtFiles(abs) : EXT_FILE.test(abs) ? [abs] : [];
      if (!files.length) { warnings.push(`extensions: sin módulos .ts/.js en ${item}`); continue; }
      for (const f of files) candidates.push({ id: idOf(f), path: f, dir: dirname(f), origin: origin === "system" ? "global" : origin });
    }
  }
  // id duplicado: último gana (config pisa convención) con aviso
  const byId = new Map<string, Candidate>();
  for (const c of candidates) {
    if (byId.has(c.id)) warnings.push(`extensión «${c.id}»: ${c.path} pisa a ${byId.get(c.id)!.path}`);
    byId.set(c.id, c);
  }
  return { candidates: [...byId.values()], warnings };
}

function idOf(file: string): string { return basename(file, extname(file)); }

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function listExtFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && EXT_FILE.test(e.name))
      .map((e) => join(dir, e.name))
      .sort();
  } catch { return []; }
}

export interface PrepareExtensionsOptions {
  /** Puente a la TUI; ausente → modos sin UI (los registros de UI se ignoran con aviso). */
  bridge?: UiBridge;
  /** Confirmación interactiva (misma UI que MCP). En modos no TTY rechaza. */
  ui: { confirm(req: { action: string; resource: string; diff?: string }): Promise<"once" | "always" | "reject">; info(text: string): void };
}

export async function prepareExtensions(rt: Runtime, opts: PrepareExtensionsOptions): Promise<ExtensionReport[]> {
  const { candidates, warnings } = discoverExtensions(rt.ctx.cwd, rt.config, rt.extensionOrigins);
  for (const w of warnings) opts.ui.info(`extensiones: ${w}`);
  const reports: ExtensionReport[] = [];

  for (const cand of candidates) {
    // compuerta: proyecto pide confirmación antes de IMPORTAR (importa = ejecuta código)
    if (cand.origin === "project") {
      const decision = await opts.ui.confirm({
        action: "extension",
        resource: cand.id,
        diff: `extensión de PROYECTO: ${cand.path}\nejecutará TypeScript/JavaScript con tus permisos de usuario.\nSolo acepta si confías en el origen de este código.`,
      });
      if (decision === "reject") {
        reports.push({ id: cand.id, source: cand.path, origin: cand.origin, status: "untrusted", tools: 0, commands: 0, error: "rechazada por el usuario" });
        opts.ui.info(`extensión «${cand.id}»: omitida (no confiada)`);
        continue;
      }
    }
    reports.push(await activate(cand, rt, opts));
  }
  return reports;
}

async function activate(cand: Candidate, rt: Runtime, opts: PrepareExtensionsOptions): Promise<ExtensionReport> {
  const report: ExtensionReport = { id: cand.id, source: cand.path, origin: cand.origin, status: "loaded", tools: 0, commands: 0 };
  const tools: AgentTool[] = [];
  const commands: { name: string; hint: string; run: (app: never, rawArgs: string) => void | Promise<void> }[] = [];
  const bridge = opts.bridge;

  const api: ExtensionAPI = {
    id: cand.id,
    dir: cand.dir,
    source: cand.path,
    cwd: rt.ctx.cwd,
    log: (text) => cliLog(rt, cand.id, text),
    on: (event, handler) => rt.bus.on((ev) => { if (event === "*" || ev.type === event) handler(ev as AgentEvent); }),
    registerTool: (tool) => { tools.push(tool); },
    registerCommand: (cmd) => {
      if (!bridge) { opts.ui.info(`extensión «${cand.id}»: /${cmd.name} ignorado (solo TUI)`); return; }
      if (!/^[a-zA-Z0-9_-]+$/.test(cmd.name)) { opts.ui.info(`extensión «${cand.id}»: comando «${cmd.name}» descartado (nombre inválido)`); return; }
      commands.push(cmd as never);
      bridge.registerCommand(cmd as never);
    },
    registerShortcut: (key, handler) => {
      if (!bridge) { opts.ui.info(`extensión «${cand.id}»: atajo ignorado (solo TUI)`); return; }
      const parsed = parseShortcut(key);
      if (!parsed) { opts.ui.info(`extensión «${cand.id}»: atajo «${key}» rechazado (usa modificadores, p. ej. ctrl+g)`); return; }
      bridge.registerShortcut(parsed, handler);
    },
    ui: {
      setSlot: (slot: SlotName, component: Component | null) => {
        if (!bridge) { opts.ui.info(`extensión «${cand.id}»: slot ignorado (solo TUI)`); return; }
        bridge.setSlot(slot, component);
      },
      addWidget: (component: Component) => {
        if (!bridge) { opts.ui.info(`extensión «${cand.id}»: widget ignorado (solo TUI)`); return; }
        bridge.addWidget(component);
      },
      setTheme: (theme: Theme) => {
        if (!bridge) { opts.ui.info(`extensión «${cand.id}»: tema ignorado (solo TUI)`); return; }
        if (!theme?.name || typeof theme.tokens !== "object") { opts.ui.info(`extensión «${cand.id}»: tema inválido (falta name/tokens)`); return; }
        if (bridge.registerTheme(theme)) bridge.applyTheme(theme.name);
      },
      refresh: () => bridge?.refresh(),
    },
  };

  try {
    const mod = (await import(pathToFileURL(cand.path).href)) as Record<string, unknown>;
    const activateFn = [mod.default, mod.activate, mod.setup].find((f) => typeof f === "function") as ((api: ExtensionAPI) => void | Promise<void>) | undefined;
    if (!activateFn) throw new Error("la extensión no exporta `export default function activate(api)`, `export function activate(api)` ni `export function setup(api)`");
    await activateFn(api);
  } catch (err) {
    report.status = "failed";
    report.error = (err as Error).message;
    opts.ui.info(`extensión «${cand.id}» FALLÓ: ${report.error}`);
    return report;
  }

  // registrar tools DESPUÉS de activar (si activate falló, no se registra nada)
  for (const tool of tools) rt.tools.push(tool);
  report.tools = tools.length;
  report.commands = commands.length;
  return report;
}

function cliLog(rt: Runtime, id: string, text: string): void {
  rt.ctx.ui.info(`[ext ${id}] ${text}`);
}

/** "ctrl+g" → {ctrl:true, alt:false, name:"g"}; exige al menos ctrl o alt. */
export function parseShortcut(key: string): { ctrl: boolean; alt: boolean; name: string } | null {
  const parts = key.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const name = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  const ctrl = mods.has("ctrl") || mods.has("control");
  const alt = mods.has("alt") || mods.has("meta");
  if (!ctrl && !alt) return null; // sin modificador: se rechazaría para no robar teclas de escritura
  // solo letras, dígitos y f1..f12: las teclas de envío/diálogo (enter, tab, escape…) quedan fuera
  if (!/^[a-z0-9]$/.test(name) && !/^f([1-9]|1[0-2])$/.test(name)) return null;
  return { ctrl, alt, name };
}
