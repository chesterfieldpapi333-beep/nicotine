import { matchAuth } from "./auth.js";
// Proveedor OpenAI-compatible con streaming (chat/completions + SSE).
// Multiproveedor de verdad (adapters Anthropic/Gemini nativos, Vercel AI SDK)
// queda fuera del lite v1; cualquier endpoint OpenAI-compatible funciona:
// OpenAI, OpenRouter, proxies, Ollama (--openai compatible), LM Studio…
// Resolución de modelo: --model > config.model > VIREO_MODEL > OPENAI_MODEL.
// Si el modelo lleva "proveedor/" se usa solo el sufijo con OPENAI_API_KEY/OPENAI_BASE_URL.

import type { ChatMessage, ToolCall, ToolSchema } from "./types.js";
import type { TokenUsage } from "./events.js";

export class ProviderError extends Error {
  constructor(public readonly status: number, body: string) {
    super(`HTTP ${status} del proveedor: ${body.slice(0, 500)}`);
    this.name = "ProviderError";
  }
}

export interface ProviderConfig {
  baseURL: string;
  /** Primera del pool (compat con el código que la lee directamente). */
  apiKey: string;
  /**
   * Pool de rotación de claves (failover). Orden: `provider.apiKey`/`apiKeys`
   * (config) → `OPENAI_API_KEYS` (coma-separadas, env). Deduplicada. Ante
   * 401/403/429/5xx se prueba la siguiente. `resolveProvider` siempre lo define.
   */
  apiKeys?: string[];
  model: string;
  /**
   * Modelos alternativos si TODAS las claves fallan con 401/403/429/5xx.
   * Orden: `provider.fallbackModels: string[]` (config) → `VIREO_MODEL_FALLBACKS`
   * (env, coma-separados). Mismas reglas de prefijo vendor/ y #variant que `model`.
   */
  fallbackModels?: string[];
  headers: Record<string, string>;
}

/** Quita el prefijo vendor/ (informativo) y la variante #… de un string de modelo. */
export function stripModel(raw: string): string {
  const noVariant = raw.split("#", 1)[0].trim();
  const i = noVariant.indexOf("/");
  return i >= 0 ? noVariant.slice(i + 1) : noVariant;
}

export function resolveProvider(config: Record<string, unknown>, flagModel?: string): ProviderConfig {
  const raw = flagModel ?? (config["model"] as string | undefined) ?? process.env.VIREO_MODEL ?? process.env.OPENAI_MODEL;
  if (!raw) throw new Error("No hay modelo configurado. Usa --model, config `model` o VIREO_MODEL (ej. openai/gpt-4o-mini).");
  // "vendor/model" → el vendor es informativo; el endpoint es OpenAI-compatible.
  const model = stripModel(raw);
  const providerCfg = (config["provider"] ?? {}) as Record<string, unknown>;
  const baseURL = String(providerCfg["baseURL"] ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const apiKey = String(providerCfg["apiKey"] ?? process.env.OPENAI_API_KEY ?? "");
  const extra: string[] = [];
  if (Array.isArray(providerCfg["apiKeys"])) {
    for (const k of providerCfg["apiKeys"] as unknown[]) if (typeof k === "string" && k.trim()) extra.push(k.trim());
  }
  if (process.env.OPENAI_API_KEYS) {
    for (const k of process.env.OPENAI_API_KEYS.split(",")) { const t = k.trim(); if (t) extra.push(t); }
  }
  const apiKeys = [...new Set([...extra, apiKey].filter(Boolean))];
  const fallback: string[] = [];
  if (Array.isArray(providerCfg["fallbackModels"])) {
    for (const m of providerCfg["fallbackModels"] as unknown[]) if (typeof m === "string" && m.trim()) fallback.push(stripModel(m));
  }
  if (process.env.VIREO_MODEL_FALLBACKS) {
    for (const m of process.env.VIREO_MODEL_FALLBACKS.split(",")) { const t = m.trim(); if (t) fallback.push(stripModel(t)); }
  }
  const fallbackModels = [...new Set(fallback.filter((m) => m && m !== model))];
  const headers = (providerCfg["headers"] ?? {}) as Record<string, string>;
  if (!apiKeys.length && !/localhost|127\.0\.0\.1/.test(baseURL)) {
    // Último recurso: auth.json de /connect — SOLO si la baseURL encaja (exacto)
    // o es el default de openai. Nunca se registra ni se muestra la clave.
    const found = matchAuth(baseURL);
    if (found) apiKeys.push(found.apiKey);
  }
  if (!apiKeys.length && !/localhost|127\.0\.0\.1/.test(baseURL)) {
    throw new Error(`Falta API key para ${baseURL}. Exporta OPENAI_API_KEY (o OPENAI_API_KEYS=lista) o pon provider.apiKey / provider.apiKeys en opencode.json (acepta {env:VAR}) o usa /connect.`);
  }
  return { baseURL, apiKey: apiKeys[0] ?? "", apiKeys, model, fallbackModels, headers };
}

export interface StreamChatOptions {
  provider: ProviderConfig;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  signal?: AbortSignal;
  /** Llamada por cada token de texto; úsala para `text_delta`. */
  onText?: (text: string) => void;
  /** Inyectable para tests. */
  fetchImpl?: typeof fetch;
  /** Aviso de rotación de clave (sin exponer la clave). */
  onRetry?: (info: { attempt: number; status: number; total: number; model?: string; nextModel?: string }) => void;
}

export interface StreamChatResult {
  message: ChatMessage;
  usage?: TokenUsage;
}

export async function streamChat(opts: StreamChatOptions): Promise<StreamChatResult> {
  const provider = opts.provider;
  const body: Record<string, unknown> = {
    model: provider.model,
    messages: opts.messages,
    stream: true,
  };
  if (opts.tools?.length) body["tools"] = opts.tools;

  const doFetch = opts.fetchImpl ?? fetch;
  const FAILOVER = new Set([401, 403, 429, 500, 502, 503, 504]);
  const modelChain = [provider.model, ...(provider.fallbackModels ?? [])];
  const pool: string[] = provider.apiKeys?.length ? provider.apiKeys : [provider.apiKey];
  let res: Response | undefined;
  let usedModel = provider.model;
  let lastStatus = 0, totalAttempts = 0;
  // Cadena completa: model1[key1..keyN] → model2[key1..keyN] → … (máx. 12 peticiones)
  outer:
  for (const modelName of modelChain) {
    for (let attempt = 0; attempt < pool.length; attempt++) {
      if (totalAttempts >= 12) break outer;
      totalAttempts++;
      usedModel = modelName;
      body["model"] = modelName;
      res = await doFetch(`${provider.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(pool[attempt] ? { authorization: `Bearer ${pool[attempt]}` } : {}),
          ...provider.headers,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      if (res.ok) break outer;
      const status = res.status;
      lastStatus = status;
      const bodyText = await res.text();
      const isLastKeyOfModel = attempt + 1 >= pool.length;
      const isLastModel = modelName === modelChain[modelChain.length - 1];
      if (!FAILOVER.has(status)) throw new ProviderError(status, bodyText); // 400 y demás: no rotar
      if (isLastKeyOfModel && isLastModel) throw new ProviderError(status, bodyText);
      // aviso de failover (sin exponer claves); incluye el modelo al que se salta
      opts.onRetry?.({ attempt: totalAttempts, status, total: Math.min(modelChain.length * pool.length, 12), model: modelName, nextModel: !isLastKeyOfModel ? modelName : modelChain[modelChain.indexOf(modelName) + 1] });
    }
  }
  if (!res) throw new ProviderError(lastStatus || 0, "agotadas todas las claves y modelos");
  if (usedModel !== provider.model) provider.model = usedModel; // failover pega en la sesión (visible en /models)
  if (!res.body) throw new Error("El proveedor no devolvió stream (res.body vacío).");

  let text = "";
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  let usage: TokenUsage | undefined;

  // SSE: líneas "data: {json}" separadas por línea en blanco; termina con [DONE].
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { continue; } // keep-alives y demás
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        opts.onText?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const acc = toolCalls.get(i) ?? { id: "", name: "", args: "" };
        if (tc.id) acc.id += tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        toolCalls.set(i, acc);
      }
    }
  }

  const message: ChatMessage = { role: "assistant", content: text || null };
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, t]): ToolCall => ({ id: t.id || `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name: t.name, arguments: t.args || "{}" } }));
  }
  return { message, usage };
}
