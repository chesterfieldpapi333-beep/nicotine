// Aprobaciones persistentes con alcance PROYECTO (opción "always" en el diálogo).
// Nunca pisan un deny configurado: el motor ya re-evalúa deny tras los allows
// guardados (ver permissions.ts), así que aquí solo guardamos/cargamos.
// Ubicación: $XDG_DATA_HOME/vireo/approvals/<sha1(cwd)>.json — fuera del repo,
// nada que gitignorar ni ensuciar el proyecto del usuario.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "./session.js";

export interface SavedApproval { action: string; resource: string; savedAt: string }

const MAX_ENTRIES = 500;

function approvalsPath(cwd: string): string {
  const dir = join(dataHome(), "approvals");
  const key = createHash("sha1").update(cwd).digest("hex").slice(0, 16);
  return join(dir, `${key}.json`);
}

export function loadProjectApprovals(cwd: string): SavedApproval[] {
  try {
    const p = approvalsPath(cwd);
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, "utf8")) as { approvals?: SavedApproval[] };
    return (raw.approvals ?? []).filter((a) => a && typeof a.action === "string" && typeof a.resource === "string").slice(-MAX_ENTRIES);
  } catch {
    return []; // archivo corrupto → no romper el arranque; se reescribe en el próximo save
  }
}

export function saveProjectApproval(cwd: string, action: string, resource: string): void {
  const items = loadProjectApprovals(cwd);
  const key = `${action}|${resource}`;
  const deduped = items.filter((a) => `${a.action}|${a.resource}` !== key);
  deduped.push({ action, resource, savedAt: new Date().toISOString() });
  const dir = join(dataHome(), "approvals");
  try {
    mkdirSync(dir, { recursive: true });
    const p = approvalsPath(cwd);
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, approvals: deduped.slice(-MAX_ENTRIES) }, null, 1));
    renameSync(tmp, p); // escritura atómica
  } catch { /* sin persistencia: no es fatal (el allow vive en memoria de sesión) */ }
}
