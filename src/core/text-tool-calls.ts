// Rescate conservador de tool-calls emitidos como TEXTO (modelos sin
// function-calling nativo). SOLO se aplica cuando el mensaje NO trae
// `tool_calls` nativos — nunca pisa una respuesta nativa.
//
// Formatos soportados:
//   A) <tool_call>{json name+arguments}</tool_call>          (Hermes/Qwen)
//   B) bloque ```json|```tool_call … ``` cuyo contenido es un objeto name+arguments, o un array de objetos
//   C) <name>NOMBRE</name><arguments>{json}</arguments>      (XML clásico)
//   D) <invoke name="NOMBRE"><parameter name="k">v</parameter></invoke>   (Anthropic)
//   E) <function=NOMBRE><parameter=clave>valor</parameter></function>      (MLF)
//   F) JSON desnudo al final del texto con name+arguments (p. ej. salida sin marcado, pretty-printed)
// Las marcas que no parsean se dejan intactas. Nombres desconocidos se descartan
// si se pasa `knownTools`. Nunca se procesa nada antes que un `tool_calls` nativo.
//
// Observabilidad: si hubo candidatos, se anota UNA línea JSONL (sin argumentos)
// en <data-home>/toolcall-stats.jsonl: {ts, ok, fail, formats}. Desactivar con
// NICOTINE_TOOLCALL_STATS_OFF=1.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "./session.js";
import type { ToolCall } from "./types.js";

export interface TextToolCallsResult {
  calls: ToolCall[];
  /** Texto sin las marcas rescatadas (trim); "" si no quedaba prosa. */
  remainingText: string;
}

type Format = "tool_call" | "fence" | "xml" | "invoke" | "mlf" | "bare-json";

interface Candidate { inner: string; raw: string; fmt: Format; }

const NAME_RE = /^[a-zA-Z0-9_.-]{1,64}$/;

function* tagCandidates(text: string): Generator<Candidate> {
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) yield { inner: m[1], raw: m[0], fmt: "tool_call" };
}

function* fenceCandidates(text: string): Generator<Candidate> {
  const re = /```(?:json|tool_call)\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) yield { inner: m[1].trim(), raw: m[0], fmt: "fence" };
}

function* xmlCandidates(text: string): Generator<Candidate> {
  const re = /<name>\s*([A-Za-z0-9_.-]{1,64})\s*<\/name>\s*<arguments>([\s\S]*?)<\/arguments>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) yield { inner: JSON.stringify({ name: m[1], arguments: m[2].trim() }), raw: m[0], fmt: "xml" };
}

function* invokeCandidates(text: string): Generator<Candidate> {
  const re = /<invoke\s+name="([^"]{1,64})"\s*>([\s\S]*?)<\/invoke>/g;
  let m: RegExpExecArray | null;
  const paramRe = /<parameter\s+name="([^"]{1,128})"\s*>([\s\S]*?)<\/parameter>/g;
  while ((m = re.exec(text))) {
    const args: Record<string, unknown> = {};
    let p: RegExpExecArray | null;
    while ((p = paramRe.exec(m[2]))) args[p[1]] = coerceScalar(p[2].trim());
    yield { inner: JSON.stringify({ name: m[1].trim(), arguments: args }), raw: m[0], fmt: "invoke" };
  }
}

function* mlfCandidates(text: string): Generator<Candidate> {
  const re = /<function=([A-Za-z0-9_.-]{1,64})>([\s\S]*?)(?:<\/function>|(?=<function=|$))/g;
  let m: RegExpExecArray | null;
  const paramRe = /<parameter=([A-Za-z0-9_.-]{1,128})>([\s\S]*?)(?:<\/parameter>|(?=<parameter=|<function=|<\/function>|$))/g;
  while ((m = re.exec(text))) {
    const args: Record<string, unknown> = {};
    let p: RegExpExecArray | null;
    while ((p = paramRe.exec(m[2]))) args[p[1]] = coerceScalar(p[2].trim());
    yield { inner: JSON.stringify({ name: m[1].trim(), arguments: args }), raw: m[0], fmt: "mlf" };
  }
}

/** Convierte "true"/"42"/"{…}" a valor JSON si encaja; si no, devuelve el texto. */
function coerceScalar(v: string): unknown {
  const t = v.trim();
  if (!t) return "";
  try { return JSON.parse(t); } catch { return t; }
}

// Localiza el último bloque {…} balanceado del texto (consciente de strings).
function locateTrailingJsonObject(text: string): string | null {
  for (let end = text.length - 1; end >= 0; end--) {
    if (text[end] !== "}") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = end; i >= 0; i--) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\" && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "}") depth++;
      else if (ch === "{") depth--;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return null;
}

const tryJson = (s: string): unknown => {
  const trimmed = s.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(trimmed); } catch { return undefined; }
};

function normalizeRecord(rec: unknown): Record<string, unknown> | null {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  return rec as Record<string, unknown>;
}

function normalizeCall(rec: Record<string, unknown>, index: number, known?: Set<string>): ToolCall | null {
  const name = rec["name"];
  if (typeof name !== "string" || !NAME_RE.test(name)) return null;
  if (known && !known.has(name)) return null;
  let args = rec["arguments"];
  if (args === undefined) args = rec["parameters"] ?? rec["args"] ?? {};
  const argsStr = typeof args === "string" ? args : JSON.stringify(args ?? {});
  try { JSON.parse(argsStr); } catch { return null; }
  return { id: `call_text_${index}`, type: "function", function: { name, arguments: argsStr } };
}

function fromRecord(parsed: unknown, index: number, known?: Set<string>): ToolCall[] {
  const out: ToolCall[] = [];
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const rec = normalizeRecord(item);
      const call = rec ? normalizeCall(rec, index + out.length + 1, known) : null;
      if (call) out.push(call);
    }
    return out;
  }
  const rec = normalizeRecord(parsed);
  const call = rec ? normalizeCall(rec, index + 1, known) : null;
  return call ? [call] : [];
}

function recordStats(formats: Format[], ok: number, fail: number): void {
  if (process.env.NICOTINE_TOOLCALL_STATS_OFF === "1") return;
  if (process.env.NODE_ENV === "test") return;
  if (ok + fail === 0) return;
  try {
    const dir = dataHome();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "toolcall-stats.jsonl"), JSON.stringify({ ts: Date.now(), ok, fail, formats: [...new Set(formats)] }) + "\n", { mode: 0o600 });
  } catch { /* stats nunca rompen el loop */ }
}

/**
 * Extrae tool-calls del texto. `remainingText` conserva la prosa sin las marcas
 * rescatadas; las marcas que no parsean se dejan intactas.
 */
export function parseTextToolCalls(text: string, knownTools?: Set<string>): TextToolCallsResult {
  if (!text) return { calls: [], remainingText: text ?? "" };
  const seen = [...tagCandidates(text), ...fenceCandidates(text), ...xmlCandidates(text), ...invokeCandidates(text), ...mlfCandidates(text)];
  const tagRaws = seen.filter((c) => c.fmt === "tool_call").map((c) => c.raw);
  const merged = seen.filter((c) => c.fmt === "tool_call" || !tagRaws.some((t) => t.includes(c.raw)));
  const calls: ToolCall[] = [];
  const formats: Format[] = [];
  let remaining = text;
  let fail = 0;
  for (const { inner, raw, fmt } of merged) {
    const parsed = fromRecord(tryJson(inner), calls.length, knownTools);
    if (!parsed.length) { fail++; continue; }
    calls.push(...parsed);
    formats.push(fmt);
    remaining = remaining.replace(raw, "");
  }
  // (F) JSON desnudo al final, solo si aún no hay nada rescatado.
  if (calls.length === 0) {
    const bare = locateTrailingJsonObject(text);
    if (bare) {
      const parsed = fromRecord(tryJson(bare), 0, knownTools);
      const at = text.indexOf(bare);
      if (parsed.length) {
        calls.push(...parsed);
        formats.push("bare-json");
        if (at >= 0) remaining = (text.slice(0, at) + text.slice(at + bare.length)).trim();
      } else {
        fail++;
      }
    }
  }
  recordStats(formats, calls.length, fail);
  remaining = remaining.replace(/\n{3,}/g, "\n\n").trim();
  return { calls, remainingText: remaining };
}
