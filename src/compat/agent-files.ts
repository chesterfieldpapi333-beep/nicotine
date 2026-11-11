// Agentes de archivo (.claude/agents/**/*.md, .opencode/agents/**/*.md, .pi/agents/**/*.md,
// <plugin>/agents/*.md) → AgentDef de nicotine. Markdown + frontmatter (spec agents#markdown):
//   name?        (def: ruta relativa con "/" — team/reviewer; plugins <plugin>:<dir>/<name>)
//   description  (REQUERIDA — define cuándo usarlo; sin ella se descarta)
//   mode?        primary | subagent | all   (def: subagent)
//   tools?       "Read, Grep" o lista YAML — mapeadas a tools de nicotine
//   model?       honrado por subagentes (vendor/ y #variant se descartan al aplicarlo)
//   permissions? lista de {action, resource, effect} — reglas anexadas tras las globales
//   hidden? / disabled?  booleanos
// Cuerpo = systemPrompt (sustituye la identidad/estilo, como `system` en JSON).
// Nunca ejecutan código; son datos.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { homedir } from "node:os";
import { parseFrontmatter } from "./yaml-lite.js";
import { configToRules } from "../core/permissions.js";
import { dirsRootToCwd } from "./util.js";
import type { AgentDef } from "../core/agents.js";

const MAX_AGENTS = 100;

// claude → nicotine
const TOOL_MAP: Record<string, string> = {
  read: "read", edit: "edit", write: "write", bash: "bash", glob: "glob", grep: "grep",
  ls: "list", list: "list", todowrite: "todowrite", skill: "skill",
  webfetch: "webfetch", websearch: "websearch",
};

export interface AgentFileSource { name: string; root: string; origin: "global" | "project" }

export function scanAgentFiles(
  cwd: string,
  opts: { home?: string; plugins?: AgentFileSource[] } = {},
): { agents: AgentDef[]; warnings: string[] } {
  const home = opts.home ?? homedir();
  const warnings: string[] = [];
  const agents: AgentDef[] = [];
  const seen = new Set<string>();

  const addDir = (dir: string, origin: "global" | "project", namespace?: string) => {
    let files: string[] = [];
    try { files = listMd(dir); } catch { return; }
    for (const f of files) addFile(f, origin, namespace, dir);
  };

  const addFile = (file: string, _origin: "global" | "project", namespace: string | undefined, root: string) => {
    if (agents.length >= MAX_AGENTS) return;
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch { warnings.push(`${file}: ilegible`); return; }
    const parsed = parseFrontmatter(raw);
    if (!parsed.fm) { warnings.push(`${file}: falta frontmatter; agente descartado`); return; }
    const fm = parsed.fm;
    // ID: nombre relativo con "/" para los directorios normales (spec: team/reviewer);
    // plugins: <plugin>:<dir>/<name>. `name` explícito en frontmatter pisa la ruta.
    const segs = relSegments(file, root);
    const baseName = sanitizeName(String(fm["name"] ?? segs.at(-1) ?? basename(file, ".md"))) || sanitizeName(basename(file, ".md"));
    const pathId = (fm["name"] !== undefined ? baseName : segs.join("/")) || baseName;
    if (!pathId) { warnings.push(`${file}: nombre inválido; agente descartado`); return; }
    const id = namespace ? `${sanitizeName(namespace)}:${pathId}` : pathId;
    const description = typeof fm["description"] === "string" ? fm["description"].trim() : "";
    if (!description) { warnings.push(`${file}: falta "description"; agente «${id}» descartado`); return; }
    const modeRaw = String(fm["mode"] ?? "subagent").toLowerCase();
    const mode = modeRaw === "primary" || modeRaw === "all" || modeRaw === "subagent" ? modeRaw : "subagent";
    if (fm["mode"] !== undefined && modeRaw !== mode) warnings.push(`${file}: modo «${String(fm["mode"])}» inválido; se usa subagent`);
    const model = typeof fm["model"] === "string" && fm["model"].trim() ? String(fm["model"]).trim() : undefined;
    const permissionRules: import("../core/permissions.js").Rule[] = [];
    const perms = fm["permissions"];
    if (Array.isArray(perms)) {
      for (const item of perms) {
        try { permissionRules.push(...configToRules(undefined, [item])); }
        catch { warnings.push(`${file}: permissions — effect desconocido (se omite): ${JSON.stringify(item)}`); }
      }
    } else if (perms !== undefined) warnings.push(`${file}: «permissions» debe ser una lista de {action, resource, effect}; se ignora`);
    const toolsRaw = fm["tools"];
    let toolAllow: string[] | undefined;
    if (toolsRaw !== undefined) {
      const names = Array.isArray(toolsRaw) ? toolsRaw.map(String) : String(toolsRaw).split(",").map((s) => s.trim()).filter(Boolean);
      const mapped: string[] = [];
      const dropped: string[] = [];
      for (const n of names) {
        const m = TOOL_MAP[n.toLowerCase().replace(/[_-]/g, "")];
        if (m) { if (!mapped.includes(m)) mapped.push(m); } else dropped.push(n);
      }
      if (dropped.length) warnings.push(`${file}: tools sin equivalente ignoradas: ${dropped.join(", ")}`);
      toolAllow = mapped.length ? mapped : undefined;
      if (!mapped.length && names.length) warnings.push(`${file}: ninguna tool reconocida; «${id}» tendrá el set completo (menos task/plan)`);
    }
    const hidden = fm["hidden"] === true || String(fm["hidden"] ?? "").toLowerCase() === "true" ? true : undefined;
    const disabled = fm["disabled"] === true || String(fm["disabled"] ?? "").toLowerCase() === "true" ? true : undefined;
    for (const k of Object.keys(fm)) {
      if (["name", "description", "mode", "model", "tools", "permissions", "hidden", "disabled"].includes(k)) continue;
      warnings.push(`${file}: clave desconocida (ignorada): ${k}`);
    }
    if (seen.has(id)) { warnings.push(`agente «${id}»: ${file} ignorado (ya definido)`); return; }
    seen.add(id);
    agents.push({
      id,
      mode: mode as AgentDef["mode"],
      description: description.slice(0, 512),
      systemPrompt: parsed.body.trim() ? parsed.body.trim().slice(0, 16 * 1024) : undefined,
      permissionRules,
      toolAllow,
      model,
      hidden,
      disabled,
    });
  };

  addDir(join(home, ".claude", "agents"), "global");
  addDir(join(home, ".config", "opencode", "agents"), "global");
  addDir(join(home, ".pi", "agent", "agents"), "global");
  for (const dir of dirsRootToCwd(cwd)) {
    addDir(join(dir, ".claude", "agents"), "project");
    addDir(join(dir, ".opencode", "agents"), "project");
    addDir(join(dir, ".pi", "agents"), "project");
  }
  for (const p of opts.plugins ?? []) addDir(join(p.root, "agents"), p.origin, p.name);
  return { agents, warnings };
}

/** Segmentos de ruta relativos a la raíz del directorio de agentes (para IDs con "/"). */
const relSegments = (file: string, root: string): string[] => {
  const rel = relative(root, file).replace(/\\/g, "/").replace(/\.md$/i, "");
  return rel.split("/").filter(Boolean).map((s) => sanitizeName(s)).filter(Boolean);
};

const sanitizeName = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

const listMd = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 2) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push(p);
    }
  };
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir, 0);
  return out.sort();
};
