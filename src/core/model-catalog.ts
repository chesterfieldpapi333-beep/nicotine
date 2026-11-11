// Catálogo de modelos expuestos por el proveedor configurado + clasificación
// honesta de capacidades (tools) y censura.
//
// Principio de honestidad:
//  - Solo afirmamos lo que sabemos. Sin señal → «desconocido», nunca una
//    afirmación falsa sobre modelos de terceros.
//  - La señal viene de (a) overrides del usuario (fuente gana siempre),
//    (b) heurísticas de nombre amplias y conservadoras (documentadas abajo).
//  - NO hay precios ni ventanas de contexto: los /models de OpenAI y la mayoría
//    de gateways no los exponen, y inventarlos sería mentir.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface OverrideEntry { tools?: boolean; censored?: boolean | null }
export type Overrides = Record<string, OverrideEntry>;

export interface CatalogRow {
  id: string;
  tools: boolean | null;
  censored: boolean | null;
  /** Qué alimentó esta fila. */
  source: "override" | "heurística";
}

export function overridesPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "nicotine", "models-overrides.json");
}

export function loadOverrides(path = overridesPath()): Overrides {
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Overrides = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const rec = v as Record<string, unknown>;
      const entry: OverrideEntry = {};
      if (typeof rec["tools"] === "boolean") entry.tools = rec["tools"];
      if (rec["censored"] === true || rec["censored"] === false || rec["censored"] === null) entry.censored = rec["censored"];
      out[k] = entry;
    }
    return out;
  } catch { return {}; }
}

export function saveOverrides(overrides: Overrides, path = overridesPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(overrides, null, 2) + "\n", "utf8");
}

// ————— Heurísticas conservadoras (SOLO nombre; nunca precios ni ctx) —————

const TOOLS_LIKELY = /(?:gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o[134](?:-(?:mini|pro|high|low|full))?|claude|gemini|llama-[34].*(?:instruct|70b|405b)|qwen3?[.-].*(?:coder|max|plus|32b|72b|235b)|deepseek-(?:v3|chat|coder)|mistral-(?:large|medium|small)|command-r|phi-4)/i;
const NO_TOOLS_LIKELY = /(?:embed|whisper|tts|speech|moderation|rerank|dall-e|stable-diffusion)/i;
const UNCENSORED_MARKERS = /(?:uncensor|de[-_]?censor|abliterat|de-?obliterat|heretic)/i;

export function toolsHeuristic(id: string): boolean | null {
  if (NO_TOOLS_LIKELY.test(id)) return false;
  if (TOOLS_LIKELY.test(id)) return true;
  return null;
}

/** Solo detectamos «libre» (abliterated/uncensored); «censurado» nunca se afirma heurísticamente. */
export function censorshipHeuristic(id: string): boolean | null {
  if (UNCENSORED_MARKERS.test(id)) return false;
  return null;
}

export function classify(id: string, overrides: Overrides): CatalogRow {
  const ov = overrides[id];
  const toolsH = toolsHeuristic(id);
  const censH = censorshipHeuristic(id);
  const fromOverride = !!ov && (ov.tools !== undefined || ov.censored !== undefined);
  return {
    id,
    tools: ov?.tools !== undefined ? ov.tools : toolsH,
    censored: ov?.censored !== undefined ? ov.censored : censH,
    source: fromOverride ? "override" : "heurística",
  };
}

export async function fetchModelIds(baseURL: string, apiKey: string, fetchImpl: typeof fetch = fetch, timeoutMs = 12_000): Promise<string[]> {
  const root = baseURL.replace(/\/$/, "");
  const url = root.endsWith("/models") ? root : `${root}/models`;
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} al pedir ${url}`);
  const json = (await res.json()) as { data?: { id?: string }[] };
  const ids = (json.data ?? []).map((d) => d.id).filter((x): x is string => typeof x === "string" && !!x);
  return [...new Set(ids)].sort();
}

export function formatRow(r: CatalogRow): string {
  const tools = r.tools === true ? "tools ✓" : r.tools === false ? "tools ✗" : "tools ?";
  const cens = r.censored === false ? "libre" : r.censored === true ? "censurado" : "censura ?";
  return `${r.id.padEnd(44)} ${tools.padEnd(9)} ${cens.padEnd(12)} ${r.source}`;
}
