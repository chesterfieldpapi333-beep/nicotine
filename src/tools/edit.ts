// edit: reemplaza texto en un archivo existente con una escalera de estrategias
// de estricta a laxa:
//   1. exacta            — oldString aparece tal cual (lo normal)
//   2. trimEnd por línea — ignora espacios/tabs al final de cada línea
//   3. trim por línea    — ignora indentación; re-indenta newString al bloque real
// Exige LECTURA PREVIA del archivo en esta sesión (spec). Si hay 0 o >1
// coincidencias se falla con un mensaje accionable (no se adivina).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentTool } from "../core/types.js";
import { resolvePath, unifiedDiff } from "./fs-util.js";

interface Match { startLine: number; endLine: number; indent: string }

export const editTool: AgentTool = {
  name: "edit",
  description:
    "Reemplaza `oldString` por `newString` en un archivo existente. oldString debe aparecer " +
    "exactamente una vez, salvo que replaceAll sea true. Debes leer el archivo (tool read) antes de editarlo. " +
    "Estrategias de matching: exacta → ignorar espacios finales de línea → ignorar indentación (re-indenta el reemplazo).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      oldString: { type: "string", description: "Texto a reemplazar." },
      newString: { type: "string", description: "Texto de reemplazo (distinto de oldString)." },
      replaceAll: { type: "boolean", description: "Reemplazar todas las apariciones. Por defecto false." },
    },
    required: ["path", "oldString", "newString"],
  },
  permission: { action: "edit", resource: (a) => String(a.path) },
  async preview(args, ctx) {
    const path = resolvePath(ctx.cwd, String(args.path));
    const before = readFileSync(path, "utf8");
    const after = applyEdit(before, String(args.oldString), String(args.newString), !!args.replaceAll).after;
    return { diff: unifiedDiff(String(args.path), before, after) };
  },
  async run(args, ctx) {
    const path = resolvePath(ctx.cwd, String(args.path));
    if (!existsSync(path)) throw new Error(`no existe: ${path}`);
    if (!ctx.readFiles.has(path)) throw new Error(`lectura previa obligatoria: usa read sobre ${path} antes de edit`);
    const oldString = String(args.oldString);
    const newString = String(args.newString);
    if (oldString === newString) throw new Error("oldString y newString son idénticos");
    const before = readFileSync(path, "utf8");
    const { after, strategy, count } = applyEdit(before, oldString, newString, !!args.replaceAll);
    writeFileSync(path, after);
    const diff = unifiedDiff(String(args.path), before, after);
    return { output: `edit OK (${strategy}, ${count} reemplazo${count === 1 ? "" : "s"}) en ${path}\n${diff}` };
  },
};

export function applyEdit(before: string, oldString: string, newString: string, replaceAll: boolean): { after: string; strategy: string; count: number } {
  // — 1) exacta
  const exact = countOccurrences(before, oldString);
  if (exact > 0) return replaceOccurrences(before, oldString, newString, exact, replaceAll, "exacta");

  const lines = before.split("\n");
  const oldLines = oldString.split("\n");

  // — 2) ignorando espacios/tabs al final de línea
  const trimEnd = (s: string) => s.replace(/[ \t]+$/g, "");
  const m2 = findMatches(lines, oldLines, trimEnd);
  if (m2.length) return spliceLines(before, lines, m2, oldString, newString, replaceAll, "trimEnd por línea");

  // — 3) ignorando indentación; re-indenta newString al indent del bloque real
  const trimBoth = (s: string) => s.trim();
  const m3 = findMatches(lines, oldLines, trimBoth);
  if (m3.length) {
    const indented = m3.map((m) => indentBlock(newString, m.indent, firstIndent(oldString)));
    return spliceLinesWithPrecomputed(before, lines, m3, indented, replaceAll, "trim + re-indent");
  }

  throw new Error(
    `oldString no encontrado en el archivo (ni exacto ni flexible). ` +
    `Copia el fragmento EXACTO del read (incluida indentación) o usa un bloque más pequeño.`
  );
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

function replaceOccurrences(hay: string, from: string, to: string, count: number, all: boolean, strategy: string) {
  if (count > 1 && !all) throw new Error(`oldString aparece ${count} veces; acota el bloque o usa replaceAll=true`);
  const after = all ? hay.split(from).join(to) : hay.replace(from, to);
  return { after, strategy, count: all ? count : 1 };
}

// Ventana deslizante de líneas; `norm` normaliza cada línea para comparar.
function findMatches(lines: string[], oldLines: string[], norm: (s: string) => string): Match[] {
  const out: Match[] = [];
  const target = oldLines.map(norm);
  for (let i = 0; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < target.length; j++) {
      if (norm(lines[i + j]) !== target[j]) { ok = false; break; }
    }
    if (ok) {
      const indent = lines[i].match(/^[ \t]*/)?.[0] ?? "";
      out.push({ startLine: i, endLine: i + oldLines.length, indent });
    }
  }
  return out;
}

function spliceLines(before: string, lines: string[], matches: Match[], oldString: string, newString: string, replaceAll: boolean, strategy: string) {
  if (matches.length > 1 && !replaceAll) throw new Error(`oldString (match ${strategy}) aparece ${matches.length} veces; acota el bloque o usa replaceAll=true`);
  return spliceLinesWithPrecomputed(before, lines, matches, matches.map(() => newString), replaceAll, strategy);
}

function spliceLinesWithPrecomputed(before: string, lines: string[], matches: Match[], replacements: string[], replaceAll: boolean, strategy: string) {
  const sel = replaceAll ? matches : matches.slice(0, 1);
  // De atrás hacia adelante para no invalidar índices.
  const ordered = sel.map((m, i) => ({ m, rep: replacements[i] })).sort((a, b) => b.m.startLine - a.m.startLine);
  const result = [...lines];
  for (const { m, rep } of ordered) result.splice(m.startLine, m.endLine - m.startLine, ...rep.split("\n"));
  return { after: result.join("\n"), strategy, count: ordered.length };
}

function firstIndent(s: string): string { return s.split("\n")[0].match(/^[ \t]*/)?.[0] ?? ""; }

// Re-indenta cada línea de newString: quita el indent original relativo y añade el real.
function indentBlock(newString: string, targetIndent: string, sourceIndent: string): string {
  return newString.split("\n").map((line) => {
    if (!line.trim()) return line;
    if (sourceIndent && line.startsWith(sourceIndent)) return targetIndent + line.slice(sourceIndent.length);
    // Sin indent común: prefijar el delta carácter a carácter de espacios.
    const delta = targetIndent.length - sourceIndent.length;
    return delta >= 0 ? " ".repeat(delta) + line : line.slice(Math.min(-delta, line.length));
  }).join("\n");
}
