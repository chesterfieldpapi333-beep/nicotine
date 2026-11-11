// Descubrimiento de CLIs en PATH: SOLO inspección de disco (existencia + bit de
// ejecución). Nada se ejecuta al escanear; ejecutar es opt-in vía `probeCliVersion`.
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { redactSecrets } from "../core/redact.js";

/** CLIs que interesan a nicotine para interoperar (skills, MCP, agentes). */
export const KNOWN_CLIS = [
  "git", "gh", "codex", "claude", "gemini", "opencode", "pi", "aider",
  "bun", "node", "python3", "rg", "jq", "curl", "docker", "ollama",
] as const;

export const VERSION_TIMEOUT_MS = 2000;
export const VERSION_MAX_CHARS = 120;
export const VERSION_UNAVAILABLE = "versión no disponible";

export interface CliFinding { name: string; path: string }
export interface DiscoveryResult {
  found: CliFinding[];
  missing: string[];
  searchedDirs: number;
}
export interface DiscoverOptions {
  pathEnv?: string;
  platform?: NodeJS.Platform;
  /** Extensiones ejecutables separadas por `;` (solo Windows). */
  pathExt?: string;
  /** Nombres a buscar; por defecto `KNOWN_CLIS`. */
  names?: readonly string[];
}

const isWindows = (platform: NodeJS.Platform) => platform === "win32";

/** Archivo regular y ejecutable. En Windows basta con que exista (access X_OK no aplica). */
export function isExecutableFile(path: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (isWindows(platform)) return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidates(dir: string, name: string, exts: string[]): string[] {
  const out = [join(dir, name)];
  for (const ext of exts) out.push(join(dir, name + ext));
  return out;
}

/** Escanea `PATH` y devuelve qué CLIs conocidas existen. No ejecuta ninguna. */
export function discoverClis(opts: DiscoverOptions = {}): DiscoveryResult {
  const platform = opts.platform ?? process.platform;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const names = opts.names ?? KNOWN_CLIS;
  const sep = isWindows(platform) ? ";" : delimiter;
  const dirs = pathEnv.split(sep).filter((d) => d.trim() !== "");
  const exts = isWindows(platform)
    ? (opts.pathExt ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [];
  const found: CliFinding[] = [];
  const missing: string[] = [];
  for (const name of names) {
    let hit: string | undefined;
    for (const dir of dirs) {
      if (!dir) continue;
      const candidate = candidates(dir, name, exts).find((p) => isExecutableFile(p, platform));
      if (candidate) { hit = candidate; break; }
    }
    if (hit) found.push({ name, path: hit });
    else missing.push(name);
  }
  return { found, missing, searchedDirs: dirs.length };
}

/**
 * Ejecuta `--version` (opt-in) con timeout y devuelve solo la primera línea,
 * acotada y con credenciales redactadas. Cualquier fallo → `VERSION_UNAVAILABLE`.
 */
export function probeCliVersion(binPath: string, timeoutMs: number = VERSION_TIMEOUT_MS): string {
  const res = spawnSync(binPath, ["--version"], {
    timeout: timeoutMs,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    maxBuffer: 64 * 1024,
  });
  if (res.error || res.status !== 0) return VERSION_UNAVAILABLE;
  return cleanVersionLine(res.stdout);
}

/** Primera línea de la salida, sin controles, ≤120 chars y sin secretos. */
export function cleanVersionLine(raw: string | null | undefined): string {
  const first = String(raw ?? "").split("\n")[0] ?? "";
  const clean = first.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  if (!clean) return VERSION_UNAVAILABLE;
  return redactSecrets(clean).slice(0, VERSION_MAX_CHARS);
}
