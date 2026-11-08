// Utilidades compartidas por los loaders de compat (fase 4+).

import { existsSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";

/** Directorios desde la raíz del FS hasta `cwd` (inclusive, de arriba abajo). */
export function* dirsRootToCwd(cwd: string): Generator<string> {
  const trail: string[] = [];
  let cur = resolve(cwd);
  for (;;) {
    trail.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  yield* trail.reverse();
}

/** Expande `~/` y `$HOME` al principio de una ruta; resuelve relativos contra `base`. */
export function resolvePath(p: string, base: string): string {
  const expanded = p.startsWith("~/") ? join(homedir(), p.slice(2)) : p.startsWith("$HOME/") ? join(homedir(), p.slice(6)) : p;
  return resolve(base, expanded);
}

export function isUrl(p: string): boolean {
  return /^https?:\/\//i.test(p);
}

/** Existe y es directorio. */
export function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export function exists(p: string): boolean {
  return existsSync(p);
}
