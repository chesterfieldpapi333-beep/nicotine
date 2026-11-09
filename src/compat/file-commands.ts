// Comandos de archivo de otras CLIs y de vireo-compat:
//   .claude/commands/**/*.md          (Claude Code; subdirs → namespace a:b:c)
//   .opencode/commands/*.md           (OpenCode)
//   .pi/prompts/*.md                  (Pi)
//   <plugin>/commands/**/*.md         (plugins, namespaced <plugin>:…)
//   ~/.config/opencode/commands/*.md, ~/.pi/agent/prompts/*.md, ~/.claude/commands/**/*.md (global)
// Markdown con frontmatter opcional (yaml-lite): description, argument-hint.
// Cuerpo con $ARGUMENTS (todo el resto) y $1..$9 (posicionales, splitArgs).
// model/agent del frontmatter se ignoran con aviso (vireo no los honra).

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { parseFrontmatter } from "./yaml-lite.js";
import { dirsRootToCwd, splitArgs } from "./util.js";

const MAX_BODY = 32 * 1024;
const MAX_COMMANDS = 200;

export interface FileCommand {
  /** nombre slash saneado (namespaced: "plugin:sub:cmd") */
  name: string;
  hint: string;
  description: string;
  /** cuerpo sin sustituir */
  body: string;
  source: string;
  origin: "global" | "project";
  /** nombre del plugin si proviene de uno */
  plugin?: string;
}

export interface PluginCommandSource { name: string; root: string; origin: "global" | "project" }

const sanitizeSegment = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");

export function scanFileCommands(
  cwd: string,
  opts: { home?: string; plugins?: PluginCommandSource[] } = {},
): { commands: FileCommand[]; warnings: string[] } {
  const home = opts.home ?? homedir();
  const warnings: string[] = [];
  const out: FileCommand[] = [];

  const addTree = (base: string, origin: "global" | "project", plugin?: string) => {
    const files = listMd(join(base, "commands"));
    for (const f of files) addFile(f, base, origin, plugin);
    const prompts = listMd(join(base, "prompts"));
    for (const f of prompts) addFile(f, base, origin, plugin);
  };

  const addFile = (file: string, base: string, origin: "global" | "project", plugin?: string) => {
    if (out.length >= MAX_COMMANDS) return;
    const rel = relative(base, file).replace(/\\/g, "/").replace(/\.md$/i, "");
    const parts = rel.split("/").filter(Boolean);
    // quita el primer segmento ("commands"/"prompts") para el nombre público
    const nameParts = parts.slice(1);
    const safe = nameParts.map(sanitizeSegment).filter(Boolean);
    if (!safe.length) { warnings.push(`comando sin nombre en ${file}; se ignora`); return; }
    const slash = (plugin ? [sanitizeSegment(plugin), ...safe] : safe).join(":");
    if (!/^[a-zA-Z0-9:_-]+$/.test(slash)) { warnings.push(`nombre inválido «${slash}» (${file}); se ignora`); return; }
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch { warnings.push(`no se pudo leer ${file}`); return; }
    const bytes = Buffer.byteLength(raw);
    const parsed = parseFrontmatter(raw);
    if (!parsed.fm) warnings.push(`${file}: frontmatter ilegible${parsed.error ? ` (${parsed.error})` : ""}; se usa el archivo entero`);
    const fm = parsed.fm ?? {};
    const body = (parsed.fm ? parsed.body : raw).replace(/^\s+/, "");
    for (const k of Object.keys(fm)) {
      if (["description", "argument-hint", "argument_hint", "model", "agent"].includes(k)) continue;
      warnings.push(`${file}: clave desconocida (ignorada): ${k}`);
    }
    if (fm["model"] !== undefined) warnings.push(`${file}: «model» no se honra (vireo usa el modelo de la sesión)`);
    if (fm["agent"] !== undefined) warnings.push(`${file}: «agent» no se honra en v1`);
    const description = typeof fm["description"] === "string" && fm["description"].trim()
      ? fm["description"].trim()
      : (body.split("\n").find((l) => l.trim()) ?? basename(file, ".md")).trim();
    const hint = typeof fm["argument-hint"] === "string" && fm["argument-hint"].trim()
      ? String(fm["argument-hint"]).trim()
      : description.slice(0, 60);
    out.push({
      name: slash,
      hint,
      description,
      body: bytes > MAX_BODY ? body.slice(0, MAX_BODY) : body,
      source: file,
      origin,
      plugin,
    });
  };

  // global (home)
  addTree(join(home, ".claude"), "global");
  addTree(join(home, ".config", "opencode"), "global");
  addTree(join(home, ".pi", "agent"), "global");
  // proyecto (raíz→cwd)
  for (const dir of dirsRootToCwd(cwd)) {
    addTree(join(dir, ".claude"), "project");
    addTree(join(dir, ".opencode"), "project");
    addTree(join(dir, ".pi"), "project");
  }
  // plugins (namespaced <plugin>:…)
  for (const p of opts.plugins ?? []) addTree(join(p.root), p.origin, p.name);

  // colisiones: primer gana (orden: global → proyecto raíz→cwd → plugins) + aviso
  const byName = new Map<string, FileCommand>();
  const deduped: FileCommand[] = [];
  for (const cmd of out) {
    const prev = byName.get(cmd.name);
    if (prev) { warnings.push(`comando «${cmd.name}»: ${cmd.source} ignorado (ya definido en ${prev.source})`); continue; }
    byName.set(cmd.name, cmd);
    deduped.push(cmd);
  }
  return { commands: deduped, warnings };
}

const listMd = (dir: string): string[] => {
  try {
    const out: string[] = [];
    const walk = (d: string, depth: number) => {
      if (depth > 3) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile() && /\.md$/i.test(e.name)) out.push(p);
      }
    };
    if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir, 0);
    return out.sort();
  } catch { return []; }
};

/** Sustituye $ARGUMENTS y $1..$9 en el cuerpo del comando. */
export function renderCommandBody(cmd: FileCommand, rawArgs: string): string {
  const args = splitArgs(rawArgs);
  let out = cmd.body.replace(/\$ARGUMENTS\b/g, rawArgs.trim());
  for (let i = 1; i <= 9; i++) out = out.replace(new RegExp(`\\$${i}\\b`, "g"), args[i - 1] ?? "");
  return out;
}
