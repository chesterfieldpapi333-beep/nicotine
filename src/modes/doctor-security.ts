// doctor --security: chequeos defensivos de entorno y datos. Nunca imprime secretos.
// Exit 0 = limpio; 1 = hallazgos; --json imprime { ok, checks, findings }.

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../core/config.js";
import { PermissionEngine } from "../core/permissions.js";
import { dataHome, sessionsDir } from "../core/session.js";
import { envAlias } from "../core/env.js";
import { containsCredential } from "../compat/obsidian-vault.js";

export interface SecurityFinding { id: string; detail: string }
export interface SecurityCheck { id: string; ok: boolean; detail: string }
export interface SecurityReport { ok: boolean; checks: SecurityCheck[]; findings: SecurityFinding[] }

const MAX_SCAN_BYTES = 1024 * 1024; // 1 MiB por archivo
const MAX_SCAN_FILES = 500;
const LITERAL_KEY = /"(apiKey|api_key|secret|token|password|passwd)"\s*:\s*"([^"]{16,})"/i;

function modeOf(path: string): number | null {
  try { return statSync(path).mode & 0o777; } catch { return null; }
}

function scanFileForCredentials(path: string, budget: { files: number }, onHit: (rel: string, lines: number) => void) {
  // Recursiva acotada para directorios (p. ej. sesiones); un archivo suelto usa el mismo camino.
  if (budget.files >= MAX_SCAN_FILES) return;
  budget.files++;
  let text = "";
  try { text = readFileSync(path, "utf8").slice(0, MAX_SCAN_BYTES); } catch { return; }
  let hits = 0;
  for (const line of text.split("\n")) if (containsCredential(line)) hits++;
  if (hits > 0) onHit(path, hits);
}

export function buildSecurityReport(opts: { cwd: string; configDir?: string }): SecurityReport {
  const checks: SecurityCheck[] = [];
  const findings: SecurityFinding[] = [];
  const fail = (id: string, detail: string) => { findings.push({ id, detail }); };

  // 1) Permisos de archivos de credenciales (0600)
  for (const rel of ["auth.json", "oauth.json"]) {
    const p = join(dataHome(), rel);
    if (!existsSync(p)) { checks.push({ id: `perms:${rel}`, ok: true, detail: "ausente (nada que proteger)" }); continue; }
    const m = modeOf(p);
    const ok = m !== null && (m & 0o077) === 0;
    checks.push({ id: `perms:${rel}`, ok, detail: ok ? `mode ${(m!).toString(8).padStart(4, "0")}` : `mode ${m === null ? "?" : m.toString(8).padStart(4, "0")} — grupo/otros tienen acceso` });
    if (!ok) fail(`perms:${rel}`, `${p}: permisos demasiado abiertos; chmod 600`);
  }

  // 2) Sesiones con patrones de credencial (por ruta y conteo de líneas; nunca contenido)
  const sessions = sessionsDir();
  let sessionSecrets = 0;
  const budget = { files: 0 };
  if (existsSync(sessions)) {
    let files: string[] = [];
    try { files = readdirSync(sessions).filter((f) => f.endsWith(".jsonl")); } catch { /* ignora */ }
    for (const f of files.sort()) {
      scanFileForCredentials(join(sessions, f), budget, () => sessionSecrets++);
    }
  }
  checks.push({ id: "sessions:secretos", ok: sessionSecrets === 0, detail: sessionSecrets === 0 ? "sin patrones de credencial en sesiones" : `${sessionSecrets} archivo(s) con patrones de credencial` });
  if (sessionSecrets > 0) fail("sessions:secretos", `${sessionSecrets} archivo(s) de sesión contienen patrones de credencial; revisar y purgar manualmente`);

  // 3) Config cargada: literal secrets (valores embebidos, no {env:})
  let layers: string[] = [];
  try { layers = loadConfig(opts.cwd, { configDir: opts.configDir }).layers; } catch { /* config rota: doctor normal lo reporta */ }
  let literalSecrets = 0;
  for (const layer of layers) {
    let text = "";
    try { text = readFileSync(layer, "utf8").slice(0, MAX_SCAN_BYTES); } catch { continue; }
    const keyHits = new Set<string>();
    for (const line of text.split("\n")) {
      const m = LITERAL_KEY.exec(line);
      if (!m) continue;
      const value = m[2];
      if (value.includes("{env:") || value.includes("{file:")) continue; // referencia, no literal
      keyHits.add(m[1].toLowerCase());
    }
    for (const key of keyHits) { literalSecrets++; fail("config:literal", `${layer}: clave «${key}» con valor literal (preferir {env:…} o NICOTINE_*)`); }
  }
  checks.push({ id: "config:literal", ok: literalSecrets === 0, detail: literalSecrets === 0 ? "sin secretos literales en capas de config" : `${literalSecrets} hallazgo(s)` });

  // 4) umask (sh -c umask; en Windows puede no estar disponible → info)
  const umaskRaw = spawnSync("sh", ["-c", "umask"], { encoding: "utf8" });
  if (umaskRaw.status === 0) {
    const u = parseInt(umaskRaw.stdout.trim(), 8);
    const ok = Number.isFinite(u) && (u & 0o022) === 0o022;
    checks.push({ id: "umask", ok, detail: `umask ${umaskRaw.stdout.trim()}` });
    if (!ok) fail("umask", `umask ${umaskRaw.stdout.trim()}: grupo u otros pueden escribir archivos nuevos`);
  } else {
    checks.push({ id: "umask", ok: true, detail: "no disponible (no-POSIX)" });
  }

  // 5) .git/config con credenciales embebidas en URLs
  const gitConfig = join(opts.cwd, ".git", "config");
  if (existsSync(gitConfig)) {
    let found = false;
    try {
      for (const line of readFileSync(gitConfig, "utf8").split("\n")) {
        if (/https?:\/\/[^/\s"']*@[^/\s"']*/.test(line)) { found = true; break; }
      }
    } catch { /* ignora */ }
    checks.push({ id: "git:config", ok: !found, detail: found ? "URL con credenciales embebidas" : "sin credenciales en .git/config" });
    if (found) fail("git:config", `${gitConfig}: credencial en URL; rotar token y corregir remote (no se muestra)`);
  } else {
    checks.push({ id: "git:config", ok: true, detail: "sin .git/config" });
  }

  // 6) deny-wins efectivo (sonda sintética; no depende de la config del usuario)
  const probe = new PermissionEngine([
    { action: "__probe", resource: "__probe", effect: "allow" },
    { action: "__probe", resource: "__probe", effect: "deny" },
  ], []);
  const denyWins = probe.check("__probe", "__probe").effect === "deny";
  checks.push({ id: "policy:deny-wins", ok: denyWins, detail: denyWins ? "deny gana sobre allow" : "FALLO: allow ganó sobre deny (bug)" });
  if (!denyWins) fail("policy:deny-wins", "el motor de permisos no respeta deny-wins");

  // 7) serve: info, no hallazgo (apagado por defecto es el estado correcto)
  const servePass = envAlias("SERVER_PASSWORD") ?? process.env.OPENCODE_SERVER_PASSWORD;
  checks.push({ id: "serve:password", ok: true, detail: servePass ? "password definida (serve podría habilitarse con auth básica)" : "sin password → serve no arranca (correcto por defecto)" });

  return { ok: findings.length === 0, checks, findings };
}

export function runDoctorSecurity(opts: { cwd: string; configDir?: string; json?: boolean }): number {
  const report = buildSecurityReport(opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify(report) + "\n");
    return report.ok ? 0 : 1;
  }
  const out: string[] = [];
  out.push("nicotine doctor --security");
  out.push("========================");
  for (const c of report.checks) out.push(`  ${c.ok ? "✓" : "!"} ${c.id}: ${c.detail}`);
  if (report.findings.length) {
    out.push("");
    out.push("Hallazgos:");
    for (const f of report.findings) out.push(`  ✗ [${f.id}] ${f.detail}`);
  } else {
    out.push("");
    out.push("✓ sin hallazgos (los secretos nunca se imprimen)");
  }
  process.stdout.write(out.join("\n") + "\n");
  return report.ok ? 0 : 1;
}
