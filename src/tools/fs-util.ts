// Utilidades compartidas por las tools: resolución de rutas y diff simple.

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** Resuelve una ruta del usuario (~, absolutas y relativas al cwd). */
export function resolvePath(cwd: string, p: string): string {
  const expanded = p.startsWith("~/") ? joinHome(p) : p;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}
function joinHome(p: string): string { return homedir() + p.slice(1); }

/** Heurística de binario: NUL en los primeros 8 KiB. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export interface DiffHunk { oldStart: number; newStart: number; body: string[] }

/**
 * Diff unificado de UN hunk: recorta prefijo/sufijo común con 3 líneas de
 * contexto. No es un Myers completo — suficiente para diálogos de permiso y
 * para mostrarlo tras un edit. Archivos enormes: se recorta el medio mostrado.
 */
export function unifiedDiff(path: string, oldText: string, newText: string, maxBodyLines = 200): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ctx = 3;
  const from = Math.max(0, start - ctx);
  const toA = Math.min(a.length, endA + ctx);
  const toB = Math.min(b.length, endB + ctx);
  const body: string[] = [];
  for (let i = from; i < start; i++) body.push(" " + a[i]);
  for (let i = start; i < endA; i++) body.push("-" + a[i]);
  for (let i = start; i < endB; i++) body.push("+" + b[i]);
  for (let i = endA; i < toA; i++) body.push(" " + a[i]);
  const shown = body.length > maxBodyLines ? [...body.slice(0, maxBodyLines), `… (${body.length - maxBodyLines} líneas más)`] : body;
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${from + 1},${toA - from} +${from + 1},${toB - from} @@`,
    ...shown,
  ].join("\n");
}
