// Compactación: estimación de tokens, corte seguro (nunca empieza por `tool`),
// resumen vía proveedor mock, fallo limpio sin tocar el historial.
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ToolContext } from "../src/core/types.js";

beforeEach(() => {
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "nicotine-compact-"));
});

const history = (): ChatMessage[] => [
  { role: "system", content: "system prompt" },
  { role: "user", content: "primera tarea ".repeat(50) },
  { role: "assistant", content: "trabajando ".repeat(50), tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } }] },
  { role: "tool", tool_call_id: "c1", content: "salida de bash ".repeat(50) },
  { role: "user", content: "segunda tarea, importante" },
  { role: "assistant", content: "entendido, siguiendo" },
];

const summaryFetch = (body: string, status = 200): typeof fetch =>
  (async (_url: unknown, _init?: unknown) => {
    if (status !== 200) return new Response("boom", { status });
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: body } }] })}\n\ndata: [DONE]\n\n`;
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;

const provider = { baseURL: "http://mock/v1", apiKey: "k", model: "m", headers: {}, engine: "fetch" as const };

describe("estimateTokens", () => {
  test("~4 chars por token", async () => {
    const { estimateTokens } = await import("../src/core/compact.js");
    expect(estimateTokens([{ role: "user", content: "a".repeat(400) }])).toBe(100);
  });
});

describe("maybeCompact", () => {
  test("bajo el umbral: no compacta", async () => {
    const { maybeCompact } = await import("../src/core/compact.js");
    const messages = history();
    const res = await maybeCompact({ messages, provider, config: { auto: true, thresholdTokens: 1_000_000, keepTokens: 100 }, fetchImpl: summaryFetch("x") });
    expect(res.compacted).toBe(false);
    expect(messages.length).toBe(6);
  });

  test("force: resume lo viejo, conserva system y cola; el corte no empieza en tool", async () => {
    const { maybeCompact, estimateTokens } = await import("../src/core/compact.js");
    const messages = history();
    const res = await maybeCompact({ messages, provider, config: { auto: true, thresholdTokens: 1, keepTokens: 60 }, fetchImpl: summaryFetch("RESUMEN-DE-PRUEBA"), force: true });
    expect(res.compacted).toBe(true);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("system");
    expect(messages[1].content).toContain("RESUMEN-DE-PRUEBA");
    // ningún mensaje del corte empieza por `tool` (huérfano de su tool_call)
    expect(messages[2]?.role).not.toBe("tool");
    // y la última respuesta original sigue presente
    expect(messages[messages.length - 1].content).toBe("entendido, siguiendo");
    expect(estimateTokens(messages)).toBeLessThan(res.beforeTokens);
  });

  test("sobre el umbral con auto: compacta", async () => {
    const { maybeCompact } = await import("../src/core/compact.js");
    const messages = history();
    const res = await maybeCompact({ messages, provider, config: { auto: true, thresholdTokens: 10, keepTokens: 60 }, fetchImpl: summaryFetch("AUTO-RESUMEN") });
    expect(res.compacted).toBe(true);
  });

  test("el proveedor falla: el historial no se toca y se emite error", async () => {
    const { maybeCompact } = await import("../src/core/compact.js");
    const messages = history();
    const before = JSON.parse(JSON.stringify(messages));
    const events: string[] = [];
    const res = await maybeCompact({
      messages, provider, config: { auto: true, thresholdTokens: 10, keepTokens: 60 },
      fetchImpl: summaryFetch("", 500),
      emit: (ev) => events.push(ev.type),
    });
    expect(res.compacted).toBe(false);
    expect(messages).toEqual(before);
    expect(events).toContain("error");
  });
});

describe("compactionFromConfig", () => {
  test("defaults y lectura de claves snake_case", async () => {
    const { compactionFromConfig } = await import("../src/core/compact.js");
    const d = compactionFromConfig({});
    expect(d.auto).toBe(true);
    expect(d.thresholdTokens).toBeGreaterThan(0);
    const custom = compactionFromConfig({ compaction: { auto: false, threshold_tokens: 5000, keep_tokens: 900 } });
    expect(custom).toEqual({ auto: false, thresholdTokens: 5000, keepTokens: 900 });
  });
});

describe("task / plan tools", () => {
  const baseCtx = (extra: Partial<ToolContext> = {}) => {
    return {
      cwd: process.cwd(), sessionId: "s", signal: new AbortController().signal,
      ui: { confirm: async () => "once" as const, question: async () => null, info: () => {} },
      readFiles: new Set<string>(), emit: () => {}, ...extra,
    } as ToolContext;
  };

  test("task: usa ctx.runSubagent y devuelve su salida", async () => {
    const { taskTool } = await import("../src/tools/task.js");
    const ctx = baseCtx({ runSubagent: async ({ agentId, prompt }) => `subagente ${agentId} recibió: ${prompt.slice(0, 20)}` });
    const res = await taskTool.run({ prompt: "investiga el módulo de permisos por favor", subagent_type: "explore" }, ctx);
    expect(res.output).toContain("explore");
  });

  test("task: un subagente no puede anidar", async () => {
    const { taskTool } = await import("../src/tools/task.js");
    const ctx = baseCtx({ isSubagent: true, runSubagent: async () => "no debería llamarse" });
    const res = await taskTool.run({ prompt: "otra tarea" }, ctx);
    expect(res.output).toContain("profundidad máxima 1");
  });

  test("task: sin runSubagent (modo no interactivo viejo) no rompe", async () => {
    const { taskTool } = await import("../src/tools/task.js");
    const res = await taskTool.run({ prompt: "algo" }, baseCtx());
    expect(res.output).toContain("no soportada");
  });

  test("plan-enter cambia a plan via switchAgent", async () => {
    const { planEnterTool } = await import("../src/tools/plan.js");
    const switched: string[] = [];
    const ctx = baseCtx({ switchAgent: (id: string) => { switched.push(id); return true; } });
    const res = await planEnterTool.run({}, ctx);
    expect(switched).toEqual(["plan"]);
    expect(res.output).toContain("plan");
  });

  test("plan-exit con rechazo del usuario no cambia de agente", async () => {
    const { planExitTool } = await import("../src/tools/plan.js");
    const switched: string[] = [];
    const ctx = baseCtx({
      switchAgent: () => { switched.push("build"); return true; },
      ui: { confirm: async () => "reject" as const, question: async () => null, info: () => {} },
    });
    const res = await planExitTool.run({}, ctx);
    expect(switched).toEqual([]);
    expect(res.output).toContain("seguir en modo plan");
  });

  test("plan-exit con aprobación cambia a build", async () => {
    const { planExitTool } = await import("../src/tools/plan.js");
    const switched: string[] = [];
    const ctx = baseCtx({ switchAgent: () => { switched.push("build"); return true; } });
    const res = await planExitTool.run({}, ctx);
    expect(switched).toEqual(["build"]);
    expect(res.output).toContain("build");
  });
});

describe("pruneForCompaction (Q3)", () => {
  test("trunca salidas de tool largas: conserva la cabeza y dice cuánto omitió", async () => {
    const { pruneForCompaction, PRUNE_TOOL_CHARS, PRUNE_TOOL_HEAD } = await import("../src/core/compact.js");
    const big = "z".repeat(PRUNE_TOOL_CHARS + 500);
    const messages: ChatMessage[] = [{ role: "tool", tool_call_id: "c", content: big }];
    const saved = pruneForCompaction(messages);
    const pruned = messages[0].content!;
    expect(pruned.length).toBeLessThan(big.length);
    expect(pruned.startsWith("z".repeat(PRUNE_TOOL_HEAD))).toBe(true);
    expect(pruned).toContain("truncado por nicotine");
    expect(saved).toBeGreaterThan(0);
  });

  test("argumentos de tool_call gigantes → JSON mínimo válido y parseable", async () => {
    const { pruneForCompaction, PRUNE_TOOL_ARGS_CHARS } = await import("../src/core/compact.js");
    const messages: ChatMessage[] = [{
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "a.txt", content: "x".repeat(PRUNE_TOOL_ARGS_CHARS) }) } }],
    }];
    const saved = pruneForCompaction(messages);
    const args = messages[0].tool_calls![0].function.arguments;
    expect(JSON.parse(args)).toEqual({ _nicotine_truncated: true });
    expect(saved).toBeGreaterThan(0);
  });

  test("contenido corto no se toca y no hay ahorro", async () => {
    const { pruneForCompaction } = await import("../src/core/compact.js");
    const messages: ChatMessage[] = [
      { role: "tool", tool_call_id: "c", content: "corto" },
      { role: "assistant", content: "hola" },
    ];
    expect(pruneForCompaction(messages)).toBe(0);
    expect(messages[0].content).toBe("corto");
    expect(messages[1].content).toBe("hola");
  });
});

describe("estimateTokens con tool_calls (Q3)", () => {
  test("suma el contenido y los argumentos serializados", async () => {
    const { estimateTokens } = await import("../src/core/compact.js");
    const msg: ChatMessage = {
      role: "assistant",
      content: "a".repeat(40),
      tool_calls: [{ id: "c", type: "function", function: { name: "bash", arguments: "b".repeat(40) } }],
    };
    expect(estimateTokens([msg])).toBe(Math.ceil((40 + JSON.stringify(msg.tool_calls).length) / 4));
  });
});

describe("maybeCompact — paso 1 y bordes (Q3)", () => {
  const neverFetch = (() => { throw new Error("el proveedor no debe llamarse en el paso 1"); }) as unknown as typeof fetch;

  test("solo poda (pass 1) cuando truncar las salidas basta, sin llamar al proveedor", async () => {
    const { maybeCompact, estimateTokens } = await import("../src/core/compact.js");
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "tool", tool_call_id: "c", content: "y".repeat(6000) },
      { role: "user", content: "fin" },
    ];
    const before = estimateTokens(messages);
    const events: string[] = [];
    const res = await maybeCompact({
      messages, provider, config: { auto: true, thresholdTokens: 200, keepTokens: 10 },
      fetchImpl: neverFetch, emit: (ev) => events.push(ev.type),
    });
    expect(res.pass).toBe(1);
    expect(res.compacted).toBe(true);
    expect(res.afterTokens).toBeLessThan(before);
    expect(messages[1].content).toContain("truncado por nicotine");
    expect(events).toEqual(["compaction"]);
  });

  test("resumen vacío del proveedor: error y historial intacto", async () => {
    const { maybeCompact } = await import("../src/core/compact.js");
    const messages = history();
    const before = JSON.parse(JSON.stringify(messages));
    const events: string[] = [];
    const res = await maybeCompact({
      messages, provider, config: { auto: true, thresholdTokens: 10, keepTokens: 60 },
      fetchImpl: summaryFetch(""), emit: (ev) => events.push(ev.type),
    });
    expect(res.compacted).toBe(false);
    expect(messages).toEqual(before);
    expect(events).toContain("error");
  });

  test("force con historial mínimo (corte ≤ 1): aplica solo la poda", async () => {
    const { maybeCompact } = await import("../src/core/compact.js");
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "solo esto" },
    ];
    const res = await maybeCompact({
      messages, provider, config: { auto: true, thresholdTokens: 1, keepTokens: 100 },
      force: true, fetchImpl: neverFetch,
    });
    expect(res.pass).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe("solo esto");
  });

  test("el system prompt nunca se resume", async () => {
    const { maybeCompact } = await import("../src/core/compact.js");
    const messages = history();
    const res = await maybeCompact({
      messages, provider, config: { auto: true, thresholdTokens: 1, keepTokens: 60 },
      force: true, fetchImpl: summaryFetch("RESUMEN"),
    });
    expect(res.pass).toBe(2);
    expect(messages[0]).toEqual({ role: "system", content: "system prompt" });
  });
});

describe("compactionFromConfig — valores inválidos (Q3)", () => {
  test("números no positivos o no numéricos caen a los defaults", async () => {
    const { compactionFromConfig } = await import("../src/core/compact.js");
    const defaults = compactionFromConfig({});
    const bad = compactionFromConfig({ compaction: { threshold_tokens: 0, keep_tokens: -5, auto: false } });
    expect(bad.thresholdTokens).toBe(defaults.thresholdTokens);
    expect(bad.keepTokens).toBe(defaults.keepTokens);
    expect(bad.auto).toBe(false);
    const nan = compactionFromConfig({ compaction: { threshold_tokens: Number.NaN, keep_tokens: "muchos" } });
    expect(nan.thresholdTokens).toBe(defaults.thresholdTokens);
    expect(nan.keepTokens).toBe(defaults.keepTokens);
  });
});

describe("serializeTranscript — tope del transcript (P5)", () => {
  test("un transcript enorme se trunca antes de ir al resumen y lo avisa", async () => {
    const { maybeCompact } = await import("../src/core/compact.js");
    const cuerpos: string[] = [];
    const fetchQueGraba = (async (_url: unknown, init?: { body?: string }) => {
      if (typeof init?.body === "string") cuerpos.push(init.body);
      const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: "R" } }] })}\n\ndata: [DONE]\n\n`;
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const messages: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 1; i <= 40; i++) messages.push({ role: "user", content: `m${i} ${"x".repeat(4000)}` });
    messages.push({ role: "assistant", content: "cola" });

    const res = await maybeCompact({
      messages, provider, config: { auto: true, thresholdTokens: 1, keepTokens: 10 },
      force: true, fetchImpl: fetchQueGraba,
    });
    expect(res.pass).toBe(2);
    expect(cuerpos.join("")).toContain("transcript truncado para el resumen");
  });
});
