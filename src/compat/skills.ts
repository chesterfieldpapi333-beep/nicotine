// Skills (agentskills.io / SKILL.md). Formato de todas las CLIs compatibles.
//
// Descubrimiento (global → proyecto → config; lo último GANA por id):
//   global:  ~/.config/opencode/skills · ~/.claude/skills · ~/.agents/skills · ~/.pi/agent/skills
//            (~/.gemini/skills solo con `compat.geminiSkills: true` — ruta SIN VERIFICAR)
//            $CODEX_HOME/skills (defecto ~/.codex/skills) — VERIFICADO (agentskills/codex docs)
//   proyecto (raíz→cwd): .opencode/skills · .claude/skills · .agents/skills · .pi/skills
//            (.gemini/skills solo con el flag)
//            .codex/skills — VERIFICADO
//   config `skills: [...]`: carpeta a escanear (un nivel `*/SKILL.md` o `**/SKILL.md`) o un SKILL.md
//            directo. Las URLs apuntan a catálogos HTTP de skills (discovery): NO se
//            descargan al arrancar — vireo lee la CACHÉ de `vireo skills update`
//            (ver compat/skill-catalog.ts); sin caché → aviso.
//
// Carga: al arrancar SOLO nombre+descripción entran al system prompt; el body se
// carga bajo demanda con la tool `skill`. `disable-model-invocation` (o
// `metadata.opencode.autoinvoke: false`) oculta la skill del listado, pero sigue
// siendo cargable por id. name debe cumplir ^[a-z0-9]+(-[a-z0-9]+)*$ ≤64 y casar
// con el directorio — Vireo AVISA, no rechaza (OpenCode v2 tampoco enforcea).

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { dirsRootToCwd, isUrl, resolvePath } from "./util.js";
import { parseFrontmatter } from "./yaml-lite.js";
import { cachedCatalogSources } from "./skill-catalog.js";

export const MAX_BODY_CHARS = 16 * 1024; // lo que ve el modelo al cargar la skill
export const MAX_SKILLS = 200;

export interface SkillRecord {
  /** id = nombre del directorio (canónico para la tool `skill`). */
  id: string;
  name: string;
  description: string;
  /** Directorio absoluto que contiene el SKILL.md. */
  dir: string;
  /** Etiqueta de origen para doctor: p. ej. "global · opencode" / "proyecto · .agents/skills". */
  source: string;
  disableModelInvocation: boolean;
  unknownKeys: string[];
  warnings: string[];
  /** false = aviso (name inválido o no casa con el directorio). */
  validId: boolean;
  bytes: number;
}

export interface SkillIndex {
  skills: SkillRecord[];
  byId: Map<string, SkillRecord>;
  /** Bloque "# Skills disponibles" para el system prompt ("" si no hay ninguna invocable). */
  block: string;
  warnings: string[];
  /** Ids ocultados del listado por disable-model-invocation (siguen cargables). */
  hidden: string[];
}

interface ScanSource { dir: string; source: string; }

export function scanSkillSources(cwd: string, config: Record<string, unknown>, opts: { home?: string; extraSources?: { dir: string; origin: "global" | "project" }[]; catalogCacheRoot?: string } = {}): { sources: ScanSource[]; warnings: string[] } {
  const home = opts.home ?? homedir();
  const compat = (config["compat"] ?? {}) as Record<string, unknown>;
  const gemini = compat["geminiSkills"] === true;

  const codexHome = process.env.CODEX_HOME?.trim() || join(home, ".codex");
  const sources: ScanSource[] = [];
  // 1) global
  sources.push({ dir: join(home, ".config", "opencode", "skills"), source: "global · opencode" });
  sources.push({ dir: join(home, ".claude", "skills"), source: "global · claude" });
  sources.push({ dir: join(home, ".agents", "skills"), source: "global · agents" });
  sources.push({ dir: join(home, ".pi", "agent", "skills"), source: "global · pi" });
  sources.push({ dir: join(codexHome, "skills"), source: "global · codex" });
  if (gemini) sources.push({ dir: join(home, ".gemini", "skills"), source: "global · gemini (sin verificar)" });
  // 1b) skills de plugins (entre global y proyecto)
  for (const extra of opts.extraSources ?? []) {
    sources.push({ dir: extra.dir, source: `plugin · ${extra.dir}` });
  }
  // 2) proyecto, raíz → cwd (lo más cercano, al final → gana)
  for (const dir of dirsRootToCwd(cwd)) {
    for (const [sub, source] of [
      [".opencode/skills", "proyecto · .opencode/skills"],
      [".claude/skills", "proyecto · .claude/skills"],
      [".agents/skills", "proyecto · .agents/skills"],
      [".pi/skills", "proyecto · .pi/skills"],
      [".codex/skills", "proyecto · .codex/skills"],
    ] as const) sources.push({ dir: join(dir, sub), source });
    if (gemini) sources.push({ dir: join(dir, ".gemini/skills"), source: "proyecto · .gemini/skills (sin verificar)" });
  }
  // 3) config `skills`
  const warnings: string[] = [];
  const raw = config["skills"];
  const httpUrls: string[] = [];
  if (raw !== undefined && !Array.isArray(raw)) {
    warnings.push('config "skills" debe ser un array de paths o URLs; se ignora');
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string" || !item.trim()) { warnings.push("skills: entrada vacía o no-string; se ignora"); continue; }
      if (isUrl(item)) { httpUrls.push(item.trim()); continue; }
      sources.push({ dir: resolvePath(item, cwd), source: `config · ${item}` });
    }
  }
  // catálogos HTTP: solo caché (nunca red en el arranque)
  for (const url of httpUrls) {
    const [cached] = cachedCatalogSources([url], opts.catalogCacheRoot);
    if (cached) sources.push(cached);
    else warnings.push(`skills: catálogo HTTP sin descargar: ${url} — ejecuta \`vireo skills update\``);
  }
  return { sources, warnings };
}

/** Encuentra los SKILL.md de una fuente (carpeta o archivo directo). */
export function skillFilesInSource(dirOrFile: string): string[] {
  try {
    const st = statSync(dirOrFile);
    if (st.isFile()) return basename(dirOrFile) === "SKILL.md" ? [dirOrFile] : [];
    if (!st.isDirectory()) return [];
    // un nivel de entradas: cada subcarpeta con SKILL.md, o SKILL.md suelto en la raíz
    const out: string[] = [];
    if (existsSync(join(dirOrFile, "SKILL.md"))) out.push(join(dirOrFile, "SKILL.md"));
    for (const entry of readdirSync(dirOrFile, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const p = join(dirOrFile, entry.name, "SKILL.md");
      if (existsSync(p)) out.push(p);
    }
    return out;
  } catch {
    return [];
  }
}

const KNOWN_KEYS = new Set(["name", "description", "license", "compatibility", "allowed-tools", "metadata", "disable-model-invocation"]);
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function parseSkillFile(path: string, source: string): SkillRecord | { error: string } {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return { error: `no se pudo leer ${path}` }; }
  const bytes = Buffer.byteLength(raw);
  const parsed = parseFrontmatter(raw);
  if (!parsed.fm) return { error: `${path}: ${parsed.error ?? "frontmatter inválido"}` };
  const fm = parsed.fm;

  const warnings: string[] = [];
  const unknownKeys = parsed.keys.filter((k) => !KNOWN_KEYS.has(k));
  for (const k of unknownKeys) warnings.push(`clave desconocida (ignorada): ${k}`);

  const name = typeof fm["name"] === "string" ? fm["name"].trim() : "";
  const description = typeof fm["description"] === "string" ? fm["description"].trim() : "";
  if (!name) return { error: `${path}: falta "name" en el frontmatter` };
  if (!description) return { error: `${path}: falta "description" en el frontmatter` };
  if (name.length > 64) warnings.push(`name supera 64 chars (${name.length})`);
  if (description.length > 1024) warnings.push(`description supera 1024 chars (${description.length}); se trunca`);

  const dir = dirname(path);
  const id = basename(dir);
  if (!NAME_RE.test(name) || name !== id) {
    warnings.push(`name "${name}" ${NAME_RE.test(name) ? "no casa con el directorio" : "no cumple ^[a-z0-9]+(-[a-z0-9]+)*$"} (aviso, no se rechaza)`);
  }

  const meta = (fm["metadata"] ?? {}) as Record<string, unknown>;
  const metaOpen = (meta["opencode"] ?? {}) as Record<string, unknown>;
  const autoinvoke = metaOpen["autoinvoke"];
  const disableFlag = fm["disable-model-invocation"];
  const disableModelInvocation =
    disableFlag === true || (typeof disableFlag === "string" && /^(true|yes|1)$/i.test(disableFlag)) || autoinvoke === false;

  return {
    id,
    name,
    description: description.slice(0, 1024),
    dir,
    source,
    disableModelInvocation,
    unknownKeys,
    warnings,
    validId: NAME_RE.test(name) && name === id,
    bytes,
  };
}

export function loadSkillIndex(cwd: string, config: Record<string, unknown>, opts: { home?: string; extraSources?: { dir: string; origin: "global" | "project" }[]; catalogCacheRoot?: string } = {}): SkillIndex {
  const { sources, warnings } = scanSkillSources(cwd, config, opts);
  const byId = new Map<string, SkillRecord>();
  let count = 0;
  for (const { dir, source } of sources) {
    for (const file of skillFilesInSource(dir)) {
      if (count >= MAX_SKILLS) { warnings.push(`límite de ${MAX_SKILLS} skills; el resto se ignora`); break; }
      const rec = parseSkillFile(file, source);
      if ("error" in rec) { warnings.push(rec.error); continue; }
      if (byId.has(rec.id)) warnings.push(`skill "${rec.id}": ${source} pisa a ${byId.get(rec.id)!.source}`);
      byId.set(rec.id, rec); // última fuente gana
      count++;
    }
  }
  const skills = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const hidden = skills.filter((s) => s.disableModelInvocation).map((s) => s.id);
  for (const s of skills) for (const w of s.warnings) warnings.push(`${s.id}: ${w}`);

  const invocable = skills.filter((s) => !s.disableModelInvocation);
  const block = invocable.length === 0 ? "" : [
    "# Skills disponibles",
    "Conocimiento especializado por tarea. ANTES de trabajar en algo listado aquí, carga la skill con la tool `skill` (id) y sigue sus instrucciones.",
    ...invocable.map((s) => `- ${s.id}: ${s.description.split("\n")[0]}`),
  ].join("\n") + "\n";

  return { skills, byId, block, warnings, hidden };
}

const SUPPORT_SKIP = /(^|\/)(\.[^/]+|node_modules)(\/|$)/;

/** Cuerpo + metadatos que recibe el modelo al cargar la skill (tool `skill`). */
export function skillBodyForModel(rec: SkillRecord): string {
  let raw: string;
  try { raw = readFileSync(join(rec.dir, "SKILL.md"), "utf8"); } catch { return `Error: no se pudo leer ${join(rec.dir, "SKILL.md")}`; }
  const parsed = parseFrontmatter(raw);
  let body = (parsed.fm ? parsed.body : raw).trim();
  let note = "";
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS);
    note = `\n…(cuerpo truncado a ${MAX_BODY_CHARS} chars; lee el archivo con la tool read si necesitas el resto)`;
  }
  const support = listSupportFiles(rec.dir, 10);
  const supportBlock = support.length
    ? `\n\nArchivos de soporte (máx 10, relativos a ${rec.dir}):\n${support.map((f) => `- ${f}`).join("\n")}\nLéelos con la tool read (ruta absoluta: ${rec.dir}/<nombre>) si la skill lo indica.`
    : "";
  return `Skill «${rec.id}» (origen: ${rec.source}). Directorio: ${rec.dir}\n\n${body}${note}${supportBlock}`;
}

function listSupportFiles(dir: string, limit: number): string[] {
  const out: string[] = [];
  const walk = (sub: string): void => {
    if (out.length >= limit) return;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(join(dir, sub), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SUPPORT_SKIP.test(rel + "/")) walk(rel); continue; }
      if (rel === "SKILL.md" || SUPPORT_SKIP.test(rel)) continue;
      out.push(rel);
    }
  };
  walk("");
  return out;
}
