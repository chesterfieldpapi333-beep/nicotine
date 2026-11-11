// Compactación de contexto: cuando el historial estimado supera el umbral, se
// resume lo antiguo en un único mensaje y se conserva la cola reciente.
//
// OJO honesto: los tokens se estiman (chars/4) — no hay tokenizer real.
// DOS PASOS: (1) poda sin LLM — trunca salidas de tool enormes y argumentos
// de tool_calls gigantes (JSON → minimal válido); si con eso basta, listo.
// (2) resumen LLM de lo antiguo (conserva la cola keep_tokens). Si el paso 2
// falla, el historial del usuario NO se modifica. El system prompt
// (messages[0]) nunca se resume.

import type { ChatMessage } from "./types.js";
import { streamChat, type ProviderConfig } from "./provider.js";
import type { AgentEvent } from "./events.js";

export interface CompactionConfig {
  /** false = nunca compactar automáticamente (solo /compact manual). */
  auto: boolean;
  thresholdTokens: number;
  /** Cuántos tokens de cola se conservan verbatim (tras el resumen). */
  keepTokens: number;
}

const DEFAULTS: CompactionConfig = { auto: true, thresholdTokens: 100_000, keepTokens: 12_000 };

/** Lee la sección `compaction` de opencode.json (claves snake_case). */
export function compactionFromConfig(config: Record<string, unknown>): CompactionConfig {
  const c = (config["compaction"] ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback);
  return {
    auto: c["auto"] !== false,
    thresholdTokens: num(c["threshold_tokens"], DEFAULTS.thresholdTokens),
    keepTokens: num(c["keep_tokens"], DEFAULTS.keepTokens),
  };
}

const msgTokens = (m: ChatMessage): number => {
  let chars = (m.content ?? "").length;
  if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  return Math.ceil(chars / 4);
};

export function estimateTokens(messages: ChatMessage[]): number {
  return messages.reduce((acc, m) => acc + msgTokens(m), 0);
}

/** Tope de salida de tool que sobrevive a la poda del paso 1. */
export const PRUNE_TOOL_CHARS = 1_200;
/** Cabeza conservada de una salida de tool podada. */
export const PRUNE_TOOL_HEAD = 600;
/** Argumentos de tool_call por encima de esto se sustituyen por JSON mínimo válido. */
export const PRUNE_TOOL_ARGS_CHARS = 800;

const cloneForWork = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((m) => ({ ...m, tool_calls: m.tool_calls?.map((tc) => ({ ...tc, function: { ...tc.function } })) }));

/** Paso 1 (sin LLM): poda salidas de tools enormes y argumentos gigantes. Devuelve chars podados. */
export function pruneForCompaction(messages: ChatMessage[]): number {
  let saved = 0;
  for (const m of messages) {
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > PRUNE_TOOL_CHARS) {
      const removed = m.content.length - PRUNE_TOOL_HEAD - 80;
      m.content = m.content.slice(0, PRUNE_TOOL_HEAD) + `\n…[truncado por nicotine: ${removed} caracteres omitidos]`;
      saved += removed;
    }
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        const args = tc.function?.arguments;
        if (typeof args === "string" && args.length > PRUNE_TOOL_ARGS_CHARS) {
          const removed = args.length - 40;
          tc.function.arguments = '{"_nicotine_truncated":true}'; // JSON mínimo válido: el historial sigue siendo parseable
          saved += removed;
        }
      }
    }
  }
  return saved;
}

export interface MaybeCompactOptions {
  messages: ChatMessage[];
  provider: ProviderConfig;
  config: CompactionConfig;
  emit?: (ev: AgentEvent) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** true = compactar aunque no se llegue al umbral (comando /compact). */
  force?: boolean;
}

export interface CompactResult {
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
  /** 0 = sin compactar · 1 = podado sin LLM · 2 = resumen LLM (tras poda). */
  pass: 0 | 1 | 2;
}

const replaceAll = (target: ChatMessage[], withMsgs: ChatMessage[]) => {
  target.length = 0;
  target.push(...withMsgs);
};

/** Compacta si toca (o si force). Muta `messages` in-place. No toca la sesión en disco. */
export async function maybeCompact(opts: MaybeCompactOptions): Promise<CompactResult> {
  const beforeTokens = estimateTokens(opts.messages);
  if (!opts.force && (!opts.config.auto || beforeTokens <= opts.config.thresholdTokens)) {
    return { compacted: false, beforeTokens, afterTokens: beforeTokens, pass: 0 };
  }

  // —— Paso 1 (sin LLM): poda. Se trabaja sobre una COPIA: si no basta o el
  // resumen falla, el historial del usuario queda intacto.
  const working = cloneForWork(opts.messages);
  pruneForCompaction(working);
  const afterPrune = estimateTokens(working);
  if (!opts.force && afterPrune <= opts.config.thresholdTokens) {
    replaceAll(opts.messages, working);
    opts.emit?.({ type: "compaction", beforeTokens, afterTokens: afterPrune, pass: 1 });
    return { compacted: true, beforeTokens, afterTokens: afterPrune, pass: 1 };
  }
  // —— Paso 2 (LLM): resumen de lo antiguo sobre la copia podada. ——
  // Corte: cola que cabe en keepTokens, empezando en mensaje seguro (no `tool`)
  let cut = working.length;
  let acc = 0;
  for (let i = working.length - 1; i > 0; i--) {
    acc += msgTokens(working[i]);
    if (acc > opts.config.keepTokens && i > 1) { cut = i + 1; break; }
    if (i === 1) cut = 1;
  }
  while (cut < working.length && working[cut].role === "tool") cut++;
  if (cut <= 1) {
    // La poda ya se aplicó sobre la copia; si el corte no da para resumir, aplica solo la poda.
    replaceAll(opts.messages, working);
    const afterTokens = estimateTokens(opts.messages);
    opts.emit?.({ type: "compaction", beforeTokens, afterTokens, pass: 1 });
    return { compacted: true, beforeTokens, afterTokens, pass: 1 };
  }

  const transcript = serializeTranscript(working.slice(1, cut));
  const summaryPrompt: ChatMessage[] = [
    {
      role: "system",
      content:
        "Resume esta conversación de un agente de código de forma DENSA y accionable, en español: " +
        "objetivo del usuario, hechos verificados, archivos tocados y su contenido relevante, decisiones " +
        "tomadas, errores encontrados y estado actual. Sin herramientas, sin relleno. Entre 400 y 900 palabras.",
    },
    { role: "user", content: transcript },
  ];

  let summary: string;
  try {
    const { message } = await streamChat({
      provider: opts.provider,
      messages: summaryPrompt,
      tools: undefined,
      signal: opts.signal,
      onText: () => {},
      fetchImpl: opts.fetchImpl,
    });
    summary = (message.content ?? "").trim();
    if (!summary) throw new Error("el proveedor devolvió un resumen vacío");
  } catch (err) {
    opts.emit?.({ type: "error", message: `compactación (paso 2) falló (el historial NO se modificó): ${(err as Error).message}` });
    return { compacted: false, beforeTokens, afterTokens: beforeTokens, pass: 0 };
  }

  const summaryMsg: ChatMessage = {
    role: "system",
    content: `<nicotine:compaction>Resumen del contexto previo (compactado automáticamente):\n${summary}\n</nicotine:compaction>`,
  };
  working.splice(1, cut - 1, summaryMsg);
  replaceAll(opts.messages, working);
  const afterTokens = estimateTokens(opts.messages);
  opts.emit?.({ type: "compaction", beforeTokens, afterTokens, pass: 2 });
  return { compacted: true, beforeTokens, afterTokens, pass: 2 };
}

function serializeTranscript(messages: ChatMessage[]): string {
  const out: string[] = [];
  let chars = 0;
  const CAP = 120_000;
  for (const m of messages) {
    let line: string;
    if (m.role === "assistant" && m.tool_calls?.length) {
      const calls = m.tool_calls.map((c) => `${c.function.name}(${c.function.arguments.slice(0, 200)})`).join(", ");
      line = `assistant → tools: ${calls}${m.content ? `\n${m.content}` : ""}`;
    } else if (m.role === "tool") {
      line = `tool result: ${(m.content ?? "").slice(0, 600)}`;
    } else {
      line = `${m.role}: ${m.content ?? ""}`;
    }
    if (chars + line.length > CAP) { out.push("…(transcript truncado para el resumen)"); break; }
    out.push(line);
    chars += line.length;
  }
  return out.join("\n");
}
