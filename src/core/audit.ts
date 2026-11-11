// Auditoría opt-in (NICOTINE_AUDIT=1): JSONL append-only en dataHome/audit.jsonl.
// Sin cuerpos de mensajes ni secretos: tool, action, recurso REDACTADO, decisión, ms.
// Rotación simple de una generación al superar NICOTINE_AUDIT_MAX_BYTES (def. 5 MiB).
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "./session.js";
import { redactSecrets } from "./redact.js";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export function auditEnabled(): boolean {
  return process.env.NICOTINE_AUDIT === "1";
}
export function auditPath(): string {
  return join(dataHome(), "audit.jsonl");
}
function maxBytes(): number {
  const n = Number(process.env.NICOTINE_AUDIT_MAX_BYTES);
  return Number.isFinite(n) && n >= 1024 ? Math.floor(n) : DEFAULT_MAX_BYTES;
}
function rotateIfNeeded(): void {
  const p = auditPath();
  try {
    if (statSync(p).size > maxBytes()) renameSync(p, p + ".1");
  } catch { /* sin archivo previo */ }
}

export interface AuditEvent {
  tool: string;
  action: string;
  resource: string;
  decision: "allow" | "deny" | "error";
  durationMs: number;
  session?: string;
}

export function auditEvent(ev: AuditEvent): void {
  if (!auditEnabled()) return;
  try {
    mkdirSync(dataHome(), { recursive: true });
    rotateIfNeeded();
    const rec = { ts: new Date().toISOString(), tool: ev.tool, action: ev.action, resource: redactSecrets(ev.resource).slice(0, 300), decision: ev.decision, durationMs: ev.durationMs, ...(ev.session ? { session: ev.session } : {}) };
    appendFileSync(auditPath(), redactSecrets(JSON.stringify(rec)) + "\n");
  } catch { /* la auditoría nunca rompe la ejecución */ }
}
