// Comandos de archivo de otras CLIs y de nicotine-compat:
//   .claude/commands/**/*.md          (Claude Code; subdirs → namespace a:b:c)
//   .opencode/commands/*.md           (OpenCode)
//   .pi/prompts/*.md                  (Pi)
//   <plugin>/commands/**/*.md         (plugins, namespaced <plugin>:…)
//   ~/.config/opencode/commands/*.md, ~/.pi/agent/prompts/*.md, ~/.claude/commands/**/*.md (global)
// Markdown con frontmatter opcional (yaml-lite): description, argument-hint.
// Cuerpo con $ARGUMENTS (todo el resto) y $1..$9 (posicionales, splitArgs).
// model/agent del frontmatter se ignoran con aviso (nicotine no los honra).

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { parseFrontmatter } from "./yaml-lite.js";
import { parseToml } from "./toml-lite.js";
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
    if (fm["model"] !== undefined) warnings.push(`${file}: «model» no se honra (nicotine usa el modelo de la sesión)`);
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

/**
 * Sustituye $ARGUMENTS y $1..$9 en el cuerpo del comando (spec commands de
 * OpenCode, verificado 2026-11):
 *   - $ARGUMENTS = cadena completa tal cual;
 *   - $N posicional = n-ésimo argumento; el marcador de mayor número consume
 *     su argumento y TODO lo posterior (/compare $1 con $2 → «api» «stable branch»);
 *   - posicionales ausentes → "";
 *   - si la plantilla no tiene $ARGUMENTS/$N y hay argumentos, se anexan tras un
 *     salto de línea ("fallback" de la spec).
 */
export function renderCommandBody(cmd: FileCommand, rawArgs: string): string {
  const trimmed = rawArgs.trim();
  const args = splitArgs(trimmed);
  let out = cmd.body;
  const placeholders = [...out.matchAll(/\$([1-9])\b/g)].map((m) => Number(m[1]));
  const highest = placeholders.length ? Math.max(...placeholders) : 0;
  out = out.replace(/\$ARGUMENTS\b/g, trimmed);
  for (let i = 1; i <= 9; i++) {
    const rep = i === highest ? args.slice(i - 1).join(" ") : (args[i - 1] ?? "");
    out = out.replace(new RegExp(`\\$${i}\\b`, "g"), rep);
  }
  if (!/\$ARGUMENTS\b|\$[1-9]\b/.test(cmd.body) && trimmed) out += `\n\n${trimmed}`;
  return out;
}

export interface TomlCommandSource { name: string; root: string; origin: "global" | "project" }

// Comandos TOML de extensiones de Gemini CLI (VERIFICADO contra geminicli.com):
//   <extension>/commands/**/*.toml ; prompt (string, requerido) ; description (string, opcional)
//   subdirectorios → namespace con DOS PUNTOS: commands/gcs/sync.toml → gcs:sync
//   en nicotine se registran SIEMPRE con el prefijo de la extensión (<ext>:cmd) para no
//   pisar comandos de usuario/proyecto (gemini usa el nombre pelado con precedencia menor;
//   el prefijo es la vía que nicotine ya usa para plugins).
//   Sustitución: {{args}} → $ARGUMENTS · {{args[N]}} → $N+1.
export function scanTomlCommands(sources: TomlCommandSource[]): { commands: FileCommand[]; warnings: string[] } {
  const warnings: string[] = [];
  const out: FileCommand[] = [];
  const walk = (d: string, depth: number, base: string, cb: (f: string) => void): void => {
    if (depth > 3) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1, base, cb);
      else if (e.isFile() && /\.toml$/i.test(e.name)) cb(p);
    }
  };
  for (const src of sources) {
    const cmdsDir = join(src.root, "commands");
    if (!existsSync(cmdsDir)) continue;
    walk(cmdsDir, 0, cmdsDir, (file) => {
      if (out.length >= MAX_COMMANDS) return;
      const rel = relative(cmdsDir, file).replace(/\\/g, "/").replace(/\.toml$/i, "");
      const nameParts = rel.split("/").filter(Boolean).map(sanitizeSegment).filter(Boolean);
      if (!nameParts.length) { warnings.push(`${file}: comando TOML sin nombre; se ignora`); return; }
      const slash = [sanitizeSegment(src.name), ...nameParts].join(":");
      if (!/^[a-zA-Z0-9:_-]+$/.test(slash)) { warnings.push(`${file}: nombre inválido «${slash}»; se ignora`); return; }
      let raw: string;
      try { raw = readFileSync(file, "utf8"); } catch { warnings.push(`no se pudo leer ${file}`); return; }
      const parsed = parseToml(raw);
      if (!parsed.value) { warnings.push(`${file}: TOML no soportado (${parsed.error ?? "?"}); comando ignorado`); return; }
      const v = parsed.value as Record<string, unknown>;
      const prompt = typeof v["prompt"] === "string" ? v["prompt"] : "";
      if (!prompt.trim()) { warnings.push(`${file}: falta «prompt» (requerido); comando ignorado`); return; }
      const description = typeof v["description"] === "string" && v["description"].trim()
        ? v["description"].trim()
        : (prompt.split("\n").find((l) => l.trim()) ?? basename(file, ".toml")).trim();
      // gemini {{args}} / {{args[N]}} → equivalente nicotine
      const body = prompt
        .replace(/\{\{\s*args\s*\}\}/g, "$ARGUMENTS")
        .replace(/\{\{\s*args\[(\d+)\]\s*\}\}/g, (_m, n) => `$${Number(n) + 1}`);
      const bytes = Buffer.byteLength(body);
      out.push({
        name: slash,
        hint: description.slice(0, 60),
        description,
        body: bytes > MAX_BODY ? body.slice(0, MAX_BODY) : body,
        source: file,
        origin: src.origin,
        plugin: src.name,
      });
    });
  }
  return { commands: out, warnings };
}
