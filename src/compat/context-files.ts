// Archivos de contexto: AGENTS.md, CLAUDE.md, GEMINI.md (+ override de Codex)
// y la clave `instructions` de la config.
//
// Orden de carga (raíz del FS → cwd; lo más cercano gana y se concatena al final):
//   por directorio: AGENTS.override.md > AGENTS.md  (override gana dentro del MISMO directorio)
//                   CLAUDE.md
//                   GEMINI.md
//   fuera del recorrido: entradas de `instructions` (paths o globs; las URLs se
//   avisan y se ignoran — arrancar no debe depender de la red).
//   solo cwd:        .vireo/memory.md — MEMORIA DEL PROYECTO (kind "memory"), la
//   escribe el propio agente con write/edit (con permisos normales); vireo la
//   carga automáticamente al arrancar. Carga SOLO desde el cwd (un proyecto =
//   un cwd), no desde cada nivel del recorrido.
// Se concatena todo bajo un encabezado común para que el system prompt lo incluya.
// Los archivos se truncan a MAX_FILE_BYTES; el total de `instructions` a MAX_INSTRUCTIONS_FILES.

import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { dirsRootToCwd, isUrl, resolvePath } from "./util.js";

export const MAX_FILE_BYTES = 32 * 1024;
export const MAX_INSTRUCTIONS_FILES = 20;

export type ContextFileKind = "agents" | "agents-override" | "claude" | "gemini" | "instructions" | "memory";

export interface ContextFileEntry {
  path: string;
  kind: ContextFileKind;
  bytes: number;
  truncated: boolean;
}

export interface ContextFilesResult {
  files: ContextFileEntry[];
  /** Bloque listo para insertar en el system prompt ("" si no hay nada). */
  block: string;
  warnings: string[];
}

function readCapped(path: string): { text: string; truncated: boolean; bytes: number } | null {
  try {
    const buf = readFileSync(path);
    const truncated = buf.length > MAX_FILE_BYTES;
    const slice = truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf;
    return { text: slice.toString("utf8"), truncated, bytes: buf.length };
  } catch {
    return null;
  }
}

function section(entry: ContextFileEntry, cwd: string): string {
  const rel = relative(cwd, entry.path) || entry.path;
  const note = entry.truncated ? " — TRUNCADA a 32 KiB" : "";
  const extra = entry.kind === "memory"
    ? "\n(memoria del proyecto: decisiones y convenciones persistentes. Mantenla al día con write/edit cuando aprendas algo que deba sobrevivir a esta sesión.)\n"
    : "";
  return `## ${rel} (${entry.kind})${note}${extra}\n${readCapped(entry.path)?.text ?? ""}`.trimEnd() + "\n";
}

export function loadContextFiles(cwd: string, config: Record<string, unknown>): ContextFilesResult {
  const files: ContextFileEntry[] = [];
  const warnings: string[] = [];

  for (const dir of dirsRootToCwd(cwd)) {
    // AGENTS.override.md sustituye a AGENTS.md DENTRO del mismo directorio (Codex).
    const override = join(dir, "AGENTS.override.md");
    const plain = join(dir, "AGENTS.md");
    const agentsPath = isFile(override) ? override : isFile(plain) ? plain : null;
    if (agentsPath) files.push(mk(agentsPath, agentsPath === override ? "agents-override" : "agents"));
    for (const [name, kind] of [["CLAUDE.md", "claude"], ["GEMINI.md", "gemini"]] as const) {
      const p = join(dir, name);
      if (isFile(p)) files.push(mk(p, kind));
    }
  }

  // `instructions`: paths/globs relativos al cwd (o absolutos/~). URLs: aviso y omisión.
  const raw = config["instructions"];
  if (raw !== undefined && !Array.isArray(raw)) {
    warnings.push('config "instructions" debe ser un array de strings; se ignora');
  } else if (Array.isArray(raw)) {
    let consumed = 0;
    for (const item of raw) {
      if (consumed >= MAX_INSTRUCTIONS_FILES) { warnings.push(`instructions: máximo ${MAX_INSTRUCTIONS_FILES} archivos; el resto se ignora`); break; }
      if (typeof item !== "string" || !item.trim()) { warnings.push("instructions: entrada vacía o no-string; se ignora"); continue; }
      if (isUrl(item)) { warnings.push(`instructions URL omitida (sin fetch en arranque): ${item}`); continue; }
      if (/[*?[\]{}]/.test(item)) { // glob
        try {
          const glob = new Bun.Glob(item);
          let matched = 0;
          for (const entry of glob.scanSync({ cwd, onlyFiles: true, dot: false })) {
            if (consumed >= MAX_INSTRUCTIONS_FILES) break;
            const abs = resolvePath(entry, cwd);
            if (!isFile(abs)) continue;
            files.push(mk(abs, "instructions"));
            consumed++; matched++;
          }
          if (matched === 0) warnings.push(`instructions: el glob no casó nada: ${item}`);
        } catch (e) {
          warnings.push(`instructions: glob inválido "${item}": ${(e as Error).message}`);
        }
        continue;
      }
      const abs = resolvePath(item, cwd);
      if (!isFile(abs)) { warnings.push(`instructions: no existe o no es archivo: ${item}`); continue; }
      files.push(mk(abs, "instructions"));
      consumed++;
    }
  }

  // memoria por proyecto: <cwd>/.vireo/memory.md (solo cwd; el agente la mantiene)
  const memoryPath = join(cwd, ".vireo", "memory.md");
  if (isFile(memoryPath)) files.push(mk(memoryPath, "memory"));

  for (const f of files) if (!readCapped(f.path)) warnings.push(`no se pudo leer ${f.path}`);

  const block = files.length === 0 ? "" : [
    "# Contexto del proyecto",
    "Estos archivos vienen del proyecto/tu máquina y explican cómo trabajar aquí. Respétalos salvo que el usuario diga lo contrario.",
    "",
    ...files.map((f) => section(f, cwd)),
  ].join("\n").trimEnd() + "\n";

  return { files, block, warnings };

  function mk(path: string, kind: ContextFileKind): ContextFileEntry {
    const bytes = statSync(path).size;
    return { path, kind, bytes, truncated: bytes > MAX_FILE_BYTES };
  }
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}
