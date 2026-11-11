// nic audit export [-o archivo] — vuelca el JSONL de auditoría (ya redactado al escribir).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditEnabled, auditPath } from "../core/audit.js";

export function runAudit(opts: { cwd: string; positional: string[] }): number {
  const { cwd, positional } = opts;
  const sub = positional[0] ?? "export";
  if (sub !== "export") {
    process.stderr.write("uso: nic audit export [-o archivo]\n");
    return 2;
  }
  const path = auditPath();
  if (!existsSync(path)) {
    process.stdout.write(`sin auditoría registrada (${path}). Activá con NICOTINE_AUDIT=1.\n`);
    return 0;
  }
  const rest = positional.slice(1);
  const oIdx = rest.indexOf("-o");
  if (oIdx >= 0) {
    const target = rest[oIdx + 1];
    if (!target) { process.stderr.write("nic audit export: falta el archivo tras -o\n"); return 2; }
    const abs = resolve(cwd, target);
    writeFileSync(abs, readFileSync(path));
    process.stdout.write(`auditoría exportada a ${abs}\n`);
  } else {
    process.stdout.write(readFileSync(path, "utf8"));
  }
  if (!auditEnabled()) process.stdout.write(`(nota: NICOTINE_AUDIT≠1; la exportación incluye lo registrado antes)\n`);
  return 0;
}
