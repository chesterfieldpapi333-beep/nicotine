// Rescate conservador de tool-calls emitidos como TEXTO (modelos sin
// function-calling nativo, o con formato Hermes/Qwen). SOLO se aplica cuando el
// mensaje NO trae `tool_calls` nativos — nunca pisa una respuesta nativa.
//
// Formatos (cuerpo JSON con `name` y `arguments`):
//   A) <tool_call>{...}</tool_call>            (Hermes/Qwen, uno o varios)
//   B) bloque ```json … ``` o ```tool_call … ``` cuyo contenido es un único
//      objeto name+arguments (uno o más bloques)
// `arguments` puede ser objeto (se re-serializa) o string JSON. Los objetos
// que no casen se dejan intactos en el texto. Nombres de tool desconocidos
// (alucinaciones) se descartan si se pasa `knownTools`.

import type { ToolCall } from "./types.js";

export interface TextToolCallsResult {
  calls: ToolCall[];
  /** Texto sin las marcas rescatadas (trim); "" si no quedaba prosa. */
  remainingText: string;
}

interface Candidate { inner: string; raw: string }

function* candidates(text: string): Generator<Candidate> {
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text))) yield { inner: m[1], raw: m[0] };
  const fenceRe = /```(?:json|tool_call)\s*\n([\s\S]*?)```/g;
  while ((m = fenceRe.exec(text))) yield { inner: m[1].trim(), raw: m[0] };
}

const tryJson = (s: string): unknown => {
  const trimmed = s.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(trimmed); } catch { return undefined; }
};

function toToolCall(obj: unknown, index: number, known?: Set<string>): ToolCall | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  const name = rec["name"];
  if (typeof name !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/.test(name)) return null;
  if (known && !known.has(name)) return null; // alucinación: nombre que no existe
  let args = rec["arguments"];
  if (args === undefined) args = rec["parameters"] ?? rec["args"] ?? {};
  const argsStr = typeof args === "string" ? args : JSON.stringify(args ?? {});
  try { JSON.parse(argsStr); } catch { return null; } // argumentos no-JSON: no lo tocamos
  return { id: `call_text_${index}`, type: "function", function: { name, arguments: argsStr } };
}

/**
 * Extrae tool-calls del texto. `remainingText` conserva la prosa sin las marcas
 * rescatadas; las marcas que no parsean se dejan intactas.
 */
export function parseTextToolCalls(text: string, knownTools?: Set<string>): TextToolCallsResult {
  if (!text || (!text.includes("<tool_call>") && !text.includes("```"))) {
    return { calls: [], remainingText: text ?? "" };
  }
  const all = [...candidates(text)];
  // un bloque ``` DENTRO de <tool_call> no es un candidato aparte (doble conteo)
  const tagRaw = all.filter((c) => c.raw.startsWith("<tool_call>")).map((c) => c.raw);
  const merged = all.filter((c) => c.raw.startsWith("<tool_call>") || !tagRaw.some((t) => t.includes(c.raw)));
  const calls: ToolCall[] = [];
  let remaining = text;
  for (const { inner, raw } of merged) {
    const call = toToolCall(tryJson(inner), calls.length + 1, knownTools);
    if (!call) continue;
    calls.push(call);
    remaining = remaining.replace(raw, "");
  }
  remaining = remaining.replace(/\n{3,}/g, "\n\n").trim();
  return { calls, remainingText: remaining };
}
