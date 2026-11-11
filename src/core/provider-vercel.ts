// Motor opcional «vercel-ai» (opt-in; DESACTIVADO por defecto).
//
// El núcleo de nicotine habla con endpoints OpenAI-compatible directamente
// (motor «fetch», ver provider.ts) con cero dependencias. Este módulo permite
// usar en su lugar el Vercel AI SDK como capa de transporte/streaming, sin
// añadir NINGUNA dependencia al núcleo: los paquetes se importan
// dinámicamente y solo hacen falta si activas el motor:
//
//   bun add ai @ai-sdk/openai-compatible
//   // opencode.json → provider: { "engine": "vercel-ai" }
//   // o env NICOTINE_PROVIDER_ENGINE=vercel-ai
//
// Probado con ai@7.0.166 + @ai-sdk/openai-compatible@3.0.87 (mock SSE local
// y petición real contra endpoint OpenAI-compatible). Si falta algún paquete
// → error claro con el comando exacto a ejecutar.
//
// Diferencias honestas con el motor fetch:
//   - Las tools NO se registran en el SDK: nicotine las ejecuta él mismo (igual
//     que en fetch). El SDK solo usa su schema (jsonSchema) y devuelve los
//     tool-calls ya parseados.
//   - nicotine compacta con mensajes role:"system" INTERMEDIOS; el SDK por
//     defecto los rechaza, así que se pasa `allowSystemInMessages: true`
//     (OpenAI los acepta en cualquier posición).
//   - El failover (claves × modelos, máx. 12 intentos, códigos 401/403/429/5xx)
//     replica el del motor fetch. Un error del stream a mitad de respuesta NO
//     se reintenta con el texto ya impreso (igual que en fetch).
//   - Abort (Ctrl+C) corta el stream del SDK; el loop de agente detecta la
//     señal y termina «aborted».

import { ProviderError, type ProviderConfig, type StreamChatOptions, type StreamChatResult } from "./provider.js";
import type { ChatMessage, ToolCall, ToolSchema } from "./types.js";
import type { TokenUsage } from "./events.js";

const FAILOVER = new Set([401, 403, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 12;

// Conversión de mensajes/tools (puro; exportado para tests)

/** Índice toolCallId → toolName (los mensajes role:"tool" de OpenAI no llevan nombre). */
export function toolNameByCallId(messages: ChatMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) for (const tc of m.tool_calls ?? []) map.set(tc.id, tc.function.name);
  return map;
}

function safeParseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return raw; } // input inválido: se pasa el string tal cual (el modelo lo ve)
}

/** OpenAI chat/completions → ModelMessage[] del AI SDK (formas crudas, JSON-safe). */
export function toModelMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const names = toolNameByCallId(messages);
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") { if (m.content) out.push({ role: "system", content: m.content }); continue; }
    if (m.role === "user") { out.push({ role: "user", content: m.content ?? "" }); continue; }
    if (m.role === "assistant") {
      const parts: Record<string, unknown>[] = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        parts.push({ type: "tool-call", toolCallId: tc.id, toolName: tc.function.name, input: safeParseArgs(tc.function.arguments) });
      }
      out.push({ role: "assistant", content: parts });
      continue;
    }
    // role: "tool"
    out.push({
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: m.tool_call_id ?? "",
        toolName: names.get(m.tool_call_id ?? "") ?? "unknown",
        output: { type: "text", value: m.content ?? "" },
      }],
    });
  }
  return out;
}

/**
 * OpenAI tools → ToolSet del SDK. `jsonSchema` se inyecta (viene del paquete
 * `ai`, que no depende del núcleo) para poder testear la conversión en seco.
 * Devuelve undefined si no hay tools (el SDK omite el campo).
 */
export function sdkToolSet(
  tools: ToolSchema[] | undefined,
  jsonSchema: (schema: unknown) => unknown,
): Record<string, unknown> | undefined {
  if (!tools?.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const t of tools) {
    if (t?.type !== "function" || !t.function?.name) continue;
    out[t.function.name] = {
      description: t.function.description,
      inputSchema: jsonSchema(t.function.parameters ?? { type: "object", properties: {} }),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

// Carga perezosa de los paquetes (cero deps en el núcleo)

export interface VercelModules {
  ai: any;
  openaiCompatible: any;
}

async function defaultLoadModules(): Promise<VercelModules> {
  // Especificadores en variables: TypeScript no intenta resolverlos (los paquetes
  // son opcionales y pueden no estar instalados).
  const aiName = "ai";
  const opcName = "@ai-sdk/openai-compatible";
  try {
    const [ai, openaiCompatible] = await Promise.all([import(aiName), import(opcName)]);
    return { ai, openaiCompatible };
  } catch {
    throw new ProviderError(0,
      "config pide el motor «vercel-ai» pero faltan los paquetes. Instálalos con:\n" +
      "  bun add ai @ai-sdk/openai-compatible\n" +
      "(probado con ai@7.0.166 + @ai-sdk/openai-compatible@3.0.87).\n" +
      "O vuelve al motor por defecto: provider.engine=\"fetch\" o NICOTINE_PROVIDER_ENGINE=fetch.");
  }
}

// Stream con el SDK

function statusOf(err: unknown): number {
  const e = err as { statusCode?: unknown; status?: unknown };
  const s = typeof e?.statusCode === "number" ? e.statusCode : typeof e?.status === "number" ? e.status : 0;
  return Number.isFinite(s) ? s : 0;
}

function messageOf(err: unknown): string {
  const e = err as { message?: string; responseBody?: string };
  const body = e?.responseBody ? ` — ${String(e.responseBody).slice(0, 400)}` : "";
  return `${e?.message ?? String(err)}${body}`;
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value ?? {}); } catch { return "{}"; }
}

/** Una pasada completa (una clave × un modelo). Lanza el error crudo del SDK. */
async function runOnce(
  provider: ProviderConfig,
  modelName: string,
  key: string,
  opts: StreamChatOptions,
  modules: VercelModules,
): Promise<StreamChatResult> {
  const { ai, openaiCompatible } = modules;
  if (typeof openaiCompatible?.createOpenAICompatible !== "function") {
    throw new ProviderError(0, "«@ai-sdk/openai-compatible» no exporta createOpenAICompatible; versión incompatible (probado con @ai-sdk/openai-compatible@3.0.87).");
  }
  if (typeof ai?.streamText !== "function" || typeof ai?.jsonSchema !== "function") {
    throw new ProviderError(0, "«ai» no exporta streamText/jsonSchema; versión incompatible (probado con ai@7.0.166).");
  }
  const sdk = openaiCompatible.createOpenAICompatible({
    name: "nicotine",
    baseURL: provider.baseURL,
    ...(key ? { apiKey: key } : {}),
    headers: provider.headers,
  });
  const tools = sdkToolSet(opts.tools, ai.jsonSchema);
  const result = ai.streamText({
    model: sdk(modelName),
    messages: toModelMessages(opts.messages),
    ...(tools ? { tools } : {}),
    // Sustituyen el retry interno del SDK (default 2) por el failover propio de
    // nicotine (claves × modelos, ver vercelStreamChat): 1 intento por clave.
    maxRetries: 0,
    // nicotine compacta con role:"system" intermedios (compact.ts); OpenAI los acepta.
    allowSystemInMessages: true,
    ...(opts.signal ? { abortSignal: opts.signal } : {}),
  });

  let text = "";
  let streamErr: any;
  for await (const part of result.fullStream as AsyncIterable<{ type: string; text?: unknown; error?: unknown }>) {
    if (part?.type === "text-delta") {
      const d = typeof part.text === "string" ? part.text : "";
      text += d;
      if (d) opts.onText?.(d);
    } else if (part?.type === "error") {
      streamErr = part.error;
    }
  }
  if (streamErr !== undefined) throw streamErr;
  if (opts.signal?.aborted) {
    const e = new Error("The operation was aborted");
    e.name = "AbortError";
    throw e;
  }

  let usage: TokenUsage | undefined;
  try {
    const u = await result.usage;
    const prompt = u?.inputTokens ?? 0, completion = u?.outputTokens ?? 0;
    usage = { promptTokens: prompt, completionTokens: completion, totalTokens: u?.totalTokens ?? prompt + completion };
  } catch { usage = undefined; }

  let toolCalls: ToolCall[] = [];
  try {
    const calls = ((await result.toolCalls) ?? []) as any[];
    toolCalls = calls.map((tc, i) => ({
      id: typeof tc?.toolCallId === "string" && tc.toolCallId ? tc.toolCallId : `call_${Date.now().toString(36)}_${i}`,
      type: "function" as const,
      function: { name: String(tc?.toolName ?? "unknown"), arguments: safeStringify(tc?.input ?? {}) },
    }));
  } catch { toolCalls = []; }

  const message: ChatMessage = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return { message, usage };
}

/**
 * Punto de entrada del motor «vercel-ai». Misma firma y semántica de failover
 * que el motor fetch (claves × modelos, máx. 12 intentos; 401/403/429/5xx →
 * siguiente clave/modelo; aviso onRetry sin exponer claves).
 * `inject.modules` evita los import() dinámicos (tests).
 */
export async function vercelStreamChat(opts: StreamChatOptions, inject?: { modules?: VercelModules }): Promise<StreamChatResult> {
  const provider = opts.provider;
  const modules = inject?.modules ?? await defaultLoadModules();
  const modelChain = [provider.model, ...(provider.fallbackModels ?? [])];
  const pool = provider.apiKeys?.length ? provider.apiKeys : [provider.apiKey];
  let totalAttempts = 0, lastStatus = 0, lastMessage = "";
  for (const modelName of modelChain) {
    for (let attempt = 0; attempt < pool.length; attempt++) {
      if (totalAttempts >= MAX_ATTEMPTS) break;
      totalAttempts++;
      try {
        const out = await runOnce(provider, modelName, pool[attempt], opts, modules);
        if (modelName !== provider.model) provider.model = modelName; // failover visible en /models (igual que fetch)
        return out;
      } catch (err) {
        const status = statusOf(err);
        // Un AbortError/no-HTTP: no hay failover ni wrappeado.
        if ((err as { name?: string })?.name === "AbortError") throw err;
        const message = err instanceof ProviderError ? err.message : messageOf(err);
        lastStatus = status;
        lastMessage = message;
        const isLastKeyOfModel = attempt + 1 >= pool.length;
        const isLastModel = modelName === modelChain[modelChain.length - 1];
        if (!FAILOVER.has(status)) throw new ProviderError(status, message);
        if (isLastKeyOfModel && isLastModel) throw new ProviderError(status, message);
        opts.onRetry?.({
          attempt: totalAttempts,
          status,
          total: Math.min(modelChain.length * pool.length, MAX_ATTEMPTS),
          model: modelName,
          nextModel: !isLastKeyOfModel ? modelName : modelChain[modelChain.indexOf(modelName) + 1],
        });
      }
    }
  }
  throw new ProviderError(lastStatus || 0, lastMessage || "agotadas todas las claves y modelos");
}
