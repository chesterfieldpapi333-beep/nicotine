// Compactación de contexto: cuando el historial estimado supera el umbral, se
// resume lo antiguo en un único mensaje y se conserva la cola reciente.
//
// OJO honesto: los tokens se estiman (chars/4) — no hay tokenizer real.
// La fase 2 deja margen: esta es la versión de UN paso (resumir todo lo viejo).
// La de dos pasos (primero podar salidas de herramientas, luego resumir) llega
// con la fase 8. El system prompt (messages[0]) nunca se resume.

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

/** Compacta si toca (o si force). Muta `messages` in-place. No toca la sesión en disco. */
export async function maybeCompact(opts: MaybeCompactOptions): Promise<{ compacted: boolean; beforeTokens: number; afterTokens: number }> {
  const beforeTokens = estimateTokens(opts.messages);
  if (!opts.force && (!opts.config.auto || beforeTokens <= opts.config.thresholdTokens)) {
    return { compacted: false, beforeTokens, afterTokens: beforeTokens };
  }
  // Corte: cola que cabe en keepTokens, empezando en mensaje seguro (no `tool`)
  let cut = opts.messages.length;
  let acc = 0;
  for (let i = opts.messages.length - 1; i > 0; i--) {
    acc += msgTokens(opts.messages[i]);
    if (acc > opts.config.keepTokens && i > 1) { cut = i + 1; break; }
    if (i === 1) cut = 1;
  }
  while (cut < opts.messages.length && opts.messages[cut].role === "tool") cut++;
  if (cut <= 1) return { compacted: false, beforeTokens, afterTokens: beforeTokens };

  const transcript = serializeTranscript(opts.messages.slice(1, cut));
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
    opts.emit?.({ type: "error", message: `compactación falló (el historial NO se modificó): ${(err as Error).message}` });
    return { compacted: false, beforeTokens, afterTokens: beforeTokens };
  }

  const summaryMsg: ChatMessage = {
    role: "system",
    content: `<vireo:compaction>Resumen del contexto previo (compactado automáticamente):\n${summary}\n</vireo:compaction>`,
  };
  opts.messages.splice(1, cut - 1, summaryMsg);
  const afterTokens = estimateTokens(opts.messages);
  opts.emit?.({ type: "compaction", beforeTokens, afterTokens });
  return { compacted: true, beforeTokens, afterTokens };
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
