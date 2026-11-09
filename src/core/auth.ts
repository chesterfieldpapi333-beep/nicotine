// /connect — añadir un proveedor con API key (spec tui#connect, verificada).
// La clave se guarda en $XDG_DATA_HOME/vireo/auth.json con permisos 0600, NUNCA
// en el repo ni en logs ni en doctor. El catálogo cubre los OpenAI-compatibles
// habituales; «personalizado» permite otra baseURL.
//
// Prioridad al resolver el modelo (unchanged): --model > config > env.
// auth.json solo SE USA si no hay ninguna API key por config/env, y únicamente
// cuando la baseURL resuelta coincide con la del proveedor guardado (encaje
// exacto), o es el default api.openai.com y auth.json tiene «openai».

import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "../core/session.js";

export interface AuthProvider { baseURL: string; apiKey: string }

export interface ConnectOption { id: string; label: string; baseURL: string }

export const CONNECT_CATALOG: ConnectOption[] = [
  { id: "openai", label: "OpenAI", baseURL: "https://api.openai.com/v1" },
  { id: "openrouter", label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1" },
  { id: "groq", label: "Groq", baseURL: "https://api.groq.com/openai/v1" },
  { id: "deepseek", label: "DeepSeek", baseURL: "https://api.deepseek.com/v1" },
  { id: "together", label: "Together", baseURL: "https://api.together.xyz/v1" },
];

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function authPath(): string { return join(dataHome(), "auth.json"); }

/** Lee auth.json (o {}). Nunca lanza. */
export function readAuth(): Record<string, AuthProvider> {
  try {
    if (!existsSync(authPath())) return {};
    const j = JSON.parse(readFileSync(authPath(), "utf8")) as Record<string, unknown>;
    const out: Record<string, AuthProvider> = {};
    for (const [k, v] of Object.entries(j ?? {})) {
      if (v && typeof v === "object") {
        const { baseURL, apiKey } = v as Record<string, unknown>;
        if (typeof baseURL === "string" && typeof apiKey === "string" && baseURL && apiKey) out[k] = { baseURL, apiKey };
      }
    }
    return out;
  } catch { return {}; }
}

/** Escribe/actualiza una entrada con permisos 0600 (reemplaza el proveedor si existía). */
export function writeAuthEntry(id: string, entry: AuthProvider): { path: string; replaced: boolean } {
  mkdirSync(dataHome(), { recursive: true });
  const cur = readAuth();
  const replaced = Object.prototype.hasOwnProperty.call(cur, id);
  cur[id] = { baseURL: entry.baseURL.replace(/\/$/, ""), apiKey: entry.apiKey };
  writeFileSync(authPath(), JSON.stringify(cur, null, 2), "utf8");
  chmodSync(authPath(), 0o600);
  return { path: authPath(), replaced };
}

/** Encaje exacto por baseURL (normalizada sin slash final). Solo lectura. */
export function matchAuth(baseURL: string): AuthProvider | undefined {
  const norm = baseURL.replace(/\/$/, "");
  const all = readAuth();
  for (const entry of Object.values(all)) if (entry.baseURL.replace(/\/$/, "") === norm) return entry;
  // token por defecto: sin baseURL configurada y auth tiene «openai» (su default)
  if (norm === DEFAULT_BASE_URL.replace(/\/$/, "") && all["openai"]) return all["openai"];
  return undefined;
}
