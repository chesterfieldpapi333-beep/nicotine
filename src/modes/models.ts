// nic models — lista/clasifica los modelos del proveedor configurado.
// Sin inventar precios ni contextos: heurística conservadora + overrides del usuario.

import { resolveProvider } from "../core/provider.js";
import { loadConfig } from "../core/config.js";
import { fetchModelIds, loadOverrides, saveOverrides, classify, formatRow, overridesPath, type OverrideEntry } from "../core/model-catalog.js";

export interface ModelsOptions {
  cwd: string;
  configDir?: string;
  json?: boolean;
  filter?: string;
  fetchImpl?: typeof fetch;
}

export async function runModelsList(opts: ModelsOptions): Promise<number> {
  const { config } = loadConfig(opts.cwd, { configDir: opts.configDir });
  let provider;
  try { provider = resolveProvider(config, process.env.NICOTINE_MODEL); } catch {
    provider = { baseURL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY ?? "", model: process.env.NICOTINE_MODEL ?? "", headers: {}, engine: "fetch" as const };
  }
  let ids: string[];
  try {
    ids = await fetchModelIds(provider.baseURL, provider.apiKey, opts.fetchImpl ?? fetch);
  } catch (err) {
    process.stderr.write(`nic models: no se pudo listar modelos: ${(err as Error).message}\n`);
    process.stderr.write("  (¿backend caído o modelo no disponible? Revisa OPENAI_BASE_URL/OPENAI_API_KEY y la red)\n");
    return 1;
  }
  if (opts.filter) { const f = opts.filter.toLowerCase(); ids = ids.filter((i) => i.toLowerCase().includes(f)); }
  const overrides = loadOverrides();
  const rows = ids.map((id) => classify(id, overrides));
  if (opts.json) {
    process.stdout.write(JSON.stringify({ provider: { baseURL: provider.baseURL }, model: provider.model, rows }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`proveedor: ${provider.baseURL} (modelo actual: ${provider.model || "(sin configurar)"})\n`);
  process.stdout.write(`${rows.length} modelo(s). Fuente: ${overridesPath()} (overrides) — heurística = nombre del modelo, sin precios ni ctx.\n\n`);
  for (const r of rows) process.stdout.write(formatRow(r) + "\n");
  process.stdout.write("\ncambiar para esta sesión en la TUI: /models · permanente: opencode.json → model · o NICOTINE_MODEL=<id>\n");
  return 0;
}

export function runModelsOverride(rest: string[]): number {
  const [id, ...choices] = rest;
  if (!id) {
    process.stderr.write("uso: nic models override <id> [tools|no-tools] [censored|uncensored|unknown]\n");
    return 2;
  }
  const ov = loadOverrides();
  const entry: OverrideEntry = { ...(ov[id] ?? {}) };
  for (const c of choices) {
    switch (c) {
      case "tools": entry.tools = true; break;
      case "no-tools": entry.tools = false; break;
      case "censored": entry.censored = true; break;
      case "uncensored": entry.censored = false; break;
      case "unknown": entry.censored = null; break; // restaura "desconocido"
      default:
        process.stderr.write(`opción desconocida «${c}» (tools|no-tools|censored|uncensored|unknown)\n`);
        return 2;
    }
  }
  ov[id] = entry;
  saveOverrides(ov);
  process.stdout.write(`override guardado para «${id}»: ${JSON.stringify(entry)}\n  en ${overridesPath()}\n`);
  return 0;
}

export function runModelsOverrides(): number {
  const ov = loadOverrides();
  const n = Object.keys(ov).length;
  process.stdout.write(`${n} override(s) en ${overridesPath()}\n`);
  for (const [id, e] of Object.entries(ov)) process.stdout.write(`${id}\t${JSON.stringify(e)}\n`);
  return 0;
}

