// apply_patch: aplica un patch multi-archivo en formato "patch de OpenAI":
//   *** Begin Patch
//   *** Add File: ruta        (líneas con +)
//   *** Update File: ruta     (@@ opcional; líneas ' ' contexto, '-' borra, '+' añade;
//   ***   Move To: ruta       (opcional: renombra en el mismo Update)
//   *** Delete File: ruta
//   *** End Patch
// Exige lectura previa para archivos que se modifican/borran (igual que edit).

import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentTool } from "../core/types.js";
import { resolvePath, unifiedDiff } from "./fs-util.js";

export const applyPatchTool: AgentTool = {
  name: "apply_patch",
  description:
    "Aplica un patch multi-archivo. patchText usa secciones *** Add File / *** Update File / *** Delete File " +
    "(contenedor opcional *** Begin Patch / *** End Patch). Update puede renombrar con *** Move To: ruta.",
  parameters: {
    type: "object",
    properties: { patchText: { type: "string", description: "El patch completo en formato OpenAI." } },
    required: ["patchText"],
  },
  permission: { action: "edit", resource: (a) => parsePatch(String(a.patchText ?? "")).paths[0] ?? "(patch vacío)" },
  permissionResources: (a) => parsePatch(String(a.patchText ?? "")).paths,
  async preview(args, ctx) {
    return { diff: applyToMemory(String(args.patchText ?? ""), ctx).diffs.join("\n\n") };
  },
  async run(args, ctx) {
    const plan = applyToMemory(String(args.patchText), ctx);
    for (const op of plan.ops) {
      if (op.kind === "add") { mkdirSync(dirname(op.abs), { recursive: true }); writeFileSync(op.abs, op.after); }
      else if (op.kind === "delete") unlinkSync(op.abs);
      else if (op.kind === "update") { writeFileSync(op.abs, op.after); if (op.moveTo) { mkdirSync(dirname(op.moveToAbs!), { recursive: true }); renameSync(op.abs, op.moveToAbs!); } }
      ctx.readFiles.add(op.abs);
    }
    return { output: `apply_patch OK (${plan.ops.length} secciones)\n${plan.diffs.join("\n\n")}` };
  },
};

interface PatchOp { kind: "add" | "update" | "delete"; rel: string; abs: string; after: string; moveTo?: string; moveToAbs?: string }
interface ParsedPatch { paths: string[]; ops: { kind: string; rel: string; moveTo?: string }[] }

export function parsePatch(text: string): ParsedPatch {
  const paths: string[] = [];
  const ops: { kind: string; rel: string; moveTo?: string }[] = [];
  for (const line of text.split("\n")) {
    let m = /^\*\*\*\s+(Add|Update|Delete) File:\s*(.+)$/.exec(line);
    if (m) {
      const rel = m[2].trim();
      paths.push(rel);
      ops.push({ kind: m[1].toLowerCase(), rel });
      continue;
    }
    m = /^\*\*\*\s+Move To:\s*(.+)$/.exec(line);
    if (m) {
      const dest = m[1].trim();
      paths.push(dest);
      if (ops.length) ops[ops.length - 1].moveTo = dest;
    }
  }
  return { paths, ops };
}

interface MemoryPlan { ops: PatchOp[]; diffs: string[] }

export function applyToMemory(text: string, ctx: { cwd: string; readFiles: Set<string> }): MemoryPlan {
  const ops: PatchOp[] = [];
  const diffs: string[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = /^\*\*\*\s+(Add|Update|Delete) File:\s*(.+)$/.exec(line);
    if (!m) { i++; continue; } // "*** Begin Patch" y ruido
    const kind = m[1].toLowerCase() as "add" | "update" | "delete";
    const rel = m[2].trim();
    const abs = resolvePath(ctx.cwd, rel);
    i++;
    // Cuerpo de la sección
    const body: string[] = [];
    let moveTo: string | undefined;
    while (i < lines.length && !/^\*\*\*\s+(Add|Update|Delete|Move To|End Patch)/.test(lines[i])) { body.push(lines[i]); i++; }
    const mv = /^\*\*\*\s+Move To:\s*(.+)$/.exec(lines[i] ?? "");
    if (mv) { moveTo = mv[1].trim(); i++; }

    if (kind === "add") {
      const after = body.filter((l) => l.startsWith("+")).map((l) => l.slice(1)).join("\n");
      const afterFinal = body.every((l) => l.startsWith("+") || l.trim() === "") ? after + "\n" : after;
      ops.push({ kind, rel, abs, after: afterFinal });
      diffs.push(unifiedDiff(rel, "", afterFinal));
      continue;
    }
    if (!existsSync(abs)) throw new Error(`apply_patch: ${rel} no existe`);
    if (!ctx.readFiles.has(abs)) throw new Error(`apply_patch: lectura previa obligatoria de ${rel} (usa read)`);
    const before = readFileSync(abs, "utf8");
    if (kind === "delete") {
      ops.push({ kind, rel, abs, after: "" });
      diffs.push(unifiedDiff(rel, before, ""));
      continue;
    }
    // Update: agrupar en hunks por líneas @@ (o cuerpo único si no hay @@)
    const after = applyHunks(before, body, rel);
    ops.push({ kind, rel, abs, after, moveTo, moveToAbs: moveTo ? resolvePath(ctx.cwd, moveTo) : undefined });
    diffs.push(unifiedDiff(rel, before, after));
  }
  if (!ops.length) throw new Error("apply_patch: no se encontraron secciones '*** Add/Update/Delete File:'");
  return { ops, diffs };
}

function applyHunks(before: string, body: string[], rel: string): string {
  // 1) partir el cuerpo en hunks por líneas @@
  const hunks: string[][] = [[]];
  for (const l of body) {
    if (l.startsWith("@@")) hunks.push([]);
    else hunks[hunks.length - 1].push(l);
  }
  let current = before;
  for (const hunk of hunks) {
    if (!hunk.length) continue;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const l of hunk) {
      if (l.startsWith("-")) oldLines.push(l.slice(1));
      else if (l.startsWith("+")) newLines.push(l.slice(1));
      else if (l.startsWith(" ")) { oldLines.push(l.slice(1)); newLines.push(l.slice(1)); }
      else { oldLines.push(l); newLines.push(l); } // línea desnuda = contexto (leniente)
    }
    const idx = findSequence(current.split("\n"), oldLines);
    if (idx === -1) throw new Error(`apply_patch: no se localizó el hunk en ${rel}:\n${oldLines.join("\n")}`);
    const lines = current.split("\n");
    lines.splice(idx, oldLines.length, ...newLines);
    current = lines.join("\n");
  }
  return current;
}

// Localiza una secuencia de líneas; exacta, con respaldo ignorando espacios finales.
function findSequence(haystack: string[], needle: string[]): number {
  if (!needle.length) return 0;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return i;
  }
  const t = (s: string) => s.replace(/[ \t]+$/g, "");
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (t(haystack[i + j]) !== t(needle[j])) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}
