// Canonicalización defensiva de rutas (DeepSeek mission adaptada): realpath para
// symlinks, bloqueo DURO de rutas sensibles sin importar las reglas de permiso.
import { existsSync, realpathSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, dirname, basename, join, sep } from "node:path";
import { expandHome } from "../core/permissions.js";

export interface CanonicalResult {
  /** Ruta absoluta canónica (nearest-existing realpath + cola). */
  path: string;
  existed: boolean;
  /** Symlink terminal que no se pudo resolver (no existe el destino): fail-closed. */
  unresolvableSymlink?: boolean;
}

const isWin = process.platform === "win32";
const norm = (p: string) => { const r = p.replaceAll("\\", "/"); return isWin ? r.toLowerCase() : r; };
const HARD_HOME_PARTS = [".ssh", ".aws", ".gnupg"];

export function getCanonicalPath(requested: string, cwd: string): CanonicalResult {
  const abs = isAbsolute(expandHome(requested)) ? resolve(expandHome(requested)) : resolve(cwd, requested);
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return { path: tail.length ? join(real, ...tail.reverse()) : real, existed: tail.length === 0 };
    } catch {
      try {
        if (lstatSync(cur).isSymbolicLink()) return { path: abs, existed: false, unresolvableSymlink: true };
      } catch { /* cur tampoco existe */ }
      const parent = dirname(cur);
      if (parent === cur) return { path: abs, existed: false };
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/** Bloqueo duro: ~/.ssh ~/.aws ~/.gnupg (y su contenido) y cualquier segmento .git. */
export function isPathBlocked(canonicalPath: string, home: string = homedir()): boolean {
  const p = norm(canonicalPath);
  const home2 = norm(home);
  for (const part of HARD_HOME_PARTS) {
    const prefix = `${home2}/${part}`;
    if (p === prefix || p.startsWith(prefix + "/")) return true;
  }
  // Segmentos «.git» en cualquier posición (posix y windows ya normalizados a /)
  return p.split("/").includes(".git");
}

/** Chequeo completo: canónico + bloqueo. Fail-closed ante symlink irresoluble. */
export function hardPathCheck(requested: string, cwd: string, home: string = homedir()): { blocked: boolean; reason?: string; canonical: string } {
  const canon = getCanonicalPath(requested, cwd);
  if (canon.unresolvableSymlink) return { blocked: true, reason: "symlink no resoluble (fail-closed)", canonical: canon.path };
  if (isPathBlocked(canon.path, home)) return { blocked: true, reason: "bloqueo duro de seguridad (ruta sensible)", canonical: canon.path };
  return { blocked: false, canonical: canon.path };
}
