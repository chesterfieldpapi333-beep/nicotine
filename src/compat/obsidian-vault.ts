// Vault de Obsidian del usuario (memoria persistente). Archivos planos; sin API.
// Activación: NICOTINE_VAULT o `memory.vaultPath`. Apagado: NICOTINE_MEMORY_OFF=1
// o `memory.enabled: false`. Toda ruta se resuelve dentro del vault; `02-Sesiones`
// jamás se escribe ni se reconfigura; contenido con credenciales nunca sale del
// vault hacia el modelo: se filtra en digest, se omite en búsqueda y se bloquea
// en lectura (fail-closed).

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep, basename, extname } from "node:path";

export const VAULT_ENV = "NICOTINE_VAULT";
export const MEMORY_OFF_ENV = "NICOTINE_MEMORY_OFF";

export const DEFAULT_WRITE_ZONES = ["00-Inbox", "01-Decisiones", "03-Contexto"];
export const RESERVED_WRITE_ZONES = ["02-Sesiones"];

const DENY_CONTENT: RegExp[] = [
  /sk-[a-zA-Z0-9_-]{16,}/,
  /gh[opsu]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /xox[baprs]-[0-9A-Za-z-]{10,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{16,}/i,
];

export function containsCredential(content: string): boolean {
  return DENY_CONTENT.some((re) => re.test(content));
}

export function stripCredentialLines(text: string): string {
  return text.split("\n").filter((l) => !containsCredential(l)).join("\n");
}

export interface VaultState {
  enabled: boolean;
    reason: string;
  root: string | null;
  writeZones: string[];
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function sanitizeZone(z: unknown): string | null {
  if (typeof z !== "string") return null;
  const t = z.trim();
  if (!t || t.includes("/") || t.includes("\\") || t.includes("..")) return null;
  if (t.startsWith(".")) return null;
  return t;
}

export function resolveVault(config: Record<string, unknown> | undefined): VaultState {
  const memory = ((config ?? {})["memory"] ?? {}) as Record<string, unknown>;
  if (process.env[MEMORY_OFF_ENV] === "1" || memory["enabled"] === false) {
    return { enabled: false, reason: "desactivado (NICOTINE_MEMORY_OFF=1 o memory.enabled=false)", root: null, writeZones: [] };
  }
  const raw = String(memory["vaultPath"] ?? process.env[VAULT_ENV] ?? "").trim();
  if (!raw) return { enabled: false, reason: `sin ruta (define NICOTINE_VAULT o memory.vaultPath)`, root: null, writeZones: [] };
  const root = resolve(expandHome(raw));
  try {
    if (!statSync(root).isDirectory()) return { enabled: false, reason: `no es un directorio: ${root}`, root: null, writeZones: [] };
  } catch {
    return { enabled: false, reason: `no existe: ${root}`, root: null, writeZones: [] };
  }
  let zones = DEFAULT_WRITE_ZONES.slice();
  if (Array.isArray(memory["vaultWriteZones"])) {
    const custom = (memory["vaultWriteZones"] as unknown[]).map(sanitizeZone).filter((z): z is string => z !== null);
    zones = [...new Set(custom)];
  }
  zones = zones.filter((z) => !RESERVED_WRITE_ZONES.includes(z));
  return { enabled: true, reason: "", root, writeZones: zones };
}

export function safeJoin(root: string, rel: string): string {
  const t = String(rel).trim();
  if (!t) throw new Error("ruta vacía");
  const candidate = resolve(root, t);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) {
    throw new Error(`la ruta sale del vault: ${t}`);
  }
  return candidate;
}

export function vaultRelPath(root: string, abs: string): string {
  const r = relative(root, abs);
  return r === "" ? "." : r.split(sep).join("/");
}

const SKIP_DIRS = new Set([".obsidian", ".trash", "node_modules", ".git"]);

export function listMarkdown(root: string, maxFiles = 5000): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= maxFiles || depth > 8) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(join(dir, e.name), depth + 1);
      } else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) {
        out.push(join(dir, e.name));
      }
    }
  };
  walk(root, 0);
  return out;
}

export function firstLevelZone(rel: string): string {
  return rel.split("/")[0] ?? "";
}

export function isWritableRel(state: VaultState, rel: string): boolean {
  const zone = firstLevelZone(rel);
  if (!zone || RESERVED_WRITE_ZONES.includes(zone)) return false;
  return state.writeZones.includes(zone);
}

export function newestMarkdown(dir: string, n = 3): string[] {
  const files = listMarkdown(dir, 500)
    .map((f) => ({ f, m: safeMtime(f) }))
    .sort((a, b) => b.m - a.m)
    .slice(0, n)
    .map((x) => x.f);
  return files;
}

function safeMtime(f: string): number {
  try { return statSync(f).mtimeMs; } catch { return 0; }
}

export function excerpt(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max).trimEnd() + "…" : flat;
}

export function vaultDigest(state: VaultState, maxBytes = 8192): string {
  if (!state.enabled || !state.root) return "";
  const root = state.root;
  const lines: string[] = [
    `Memoria persistente (vault: ${root}) — notas Markdown planas entre sesiones.`,
    "Reglas: escribe SOLO con la tool `vault_write` (zonas permitidas: " + (state.writeZones.join(", ") || "(ninguna)") + ");",
    "`02-Sesiones` está reservada; nada de credenciales en el contenido; frontmatter mínimo automático.",
  ];
  try {
    const decisionsDir = join(root, "01-Decisiones");
    if (existsSync(decisionsDir)) {
      const recent = newestMarkdown(decisionsDir, 3);
      if (recent.length) {
        lines.push("Decisiones recientes (nombra el fichero con `vault_read` si necesitas el detalle):");
        for (const d of recent) {
          const name = basename(d, extname(d));
          let first = "";
          try { first = excerpt(stripCredentialLines(readFileSync(d, "utf8").replace(/^---[\s\S]*?---\s*/, "")), 120); } catch { /* ignora */ }
          lines.push(`- ${name}${first ? ` — ${first}` : ""}`);
        }
      }
    }
    const contextDir = join(root, "03-Contexto");
    if (existsSync(contextDir)) {
      const recent = newestMarkdown(contextDir, 2);
      if (recent.length) {
        lines.push("Bitácora/contexto reciente:");
        for (const c of recent) {
          const name = basename(c, extname(c));
          let first = "";
          try { first = excerpt(stripCredentialLines(readFileSync(c, "utf8").replace(/^---[\s\S]*?---\s*/, "")), 120); } catch { /* ignora */ }
          lines.push(`- ${name}${first ? ` — ${first}` : ""}`);
        }
      }
    }
  } catch { /* digest best-effort: nunca rompe arranque */ }
  let out = lines.join("\n");
  if (out.length > maxBytes) out = out.slice(0, maxBytes) + "\n…(digest truncado)";
  return out;
}

export function searchVault(state: VaultState, query: string, folder: string | undefined, limit: number): string[] {
  if (!state.enabled || !state.root) throw new Error("vault no activo");
  const q = String(query ?? "").trim();
  if (!q) throw new Error("consulta vacía");
  const lim = Math.min(50, Math.max(1, limit || 20));
  const base = folder && String(folder).trim() ? safeJoin(state.root, String(folder).trim()) : state.root;
  const files = listMarkdown(base, 5000);
  const ql = q.toLowerCase();
  const hits: string[] = [];
  let scanned = 0;
  for (const f of files) {
    if (hits.length >= lim) break;
    scanned++;
    let text = "";
    try {
      const st = statSync(f);
      if (st.size > 512 * 1024) continue;
      text = readFileSync(f, "utf8");
    } catch { continue; }
    const rel = vaultRelPath(state.root, f);
    if (rel.toLowerCase().includes(ql)) hits.push(`${rel} (nombre)`);
    let line = 0;
    for (const l of text.split("\n")) {
      if (hits.length >= lim) break;
      line++;
      if (containsCredential(l)) continue;
      if (l.toLowerCase().includes(ql)) {
        const snippet = l.trim().slice(0, 200);
        hits.push(`${rel}:${line}: ${snippet}`);
      }
    }
  }
  if (!hits.length) return [`sin resultados para «${q}» (${scanned} archivos revisados)`];
  if (hits.length >= lim) hits.push(`…(límite ${lim} resultados)`);
  return hits;
}
