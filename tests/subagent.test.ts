// Integración: el bucle padre delega en un subagente (tool `task`) y recibe
// su respuesta; el subagente corre en una sesión JSONL hija. fetch inyectado.
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../src/core/events.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vireo-subagent-"));
  process.env.XDG_DATA_HOME = join(tmp, "data");
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:8799/v1"; // localhost: no exige API key
});

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

test("padre → task(explore) → subagente responde → padre termina", async () => {
  const { buildRuntime, prepareContext } = await import("../src/modes/common.js");
  const { runAgentLoop } = await import("../src/core/loop.js");
  const { Session } = await import("../src/core/session.js");
  const project = join(tmp, "proj");
  mkdirSync(project);

  const events: AgentEvent[] = [];
  let calls = 0;
  const fetchImpl = (async (_url: unknown, _init?: unknown) => {
    calls++;
    let delta: unknown;
    if (calls === 1) {
      delta = { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "task", arguments: '{"prompt":"responde con el código secreto","subagent_type":"general","description":"prueba sub"}' } }] } }] };
    } else if (calls === 2) {
      delta = { choices: [{ delta: { content: "subagente-completo-42" } }] };
    } else {
      delta = { choices: [{ delta: { content: "padre-completo" } }] };
    }
    return new Response(sse(delta) + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;

  const rt = buildRuntime({ cwd: project, auto: false, modelFlag: "mock-model", attachUi: false, fetchImpl });
  rt.bus.on((ev) => events.push(ev));
  await prepareContext(rt, fetchImpl);
  rt.ctx.undo?.beginTurn("delega");
  rt.messages.push({ role: "user", content: "delega por favor" });
  const reason = await runAgentLoop({ provider: rt.provider, permissions: rt.permissions, messages: rt.messages, tools: rt.tools, ctx: rt.ctx, fetchImpl });

  expect(reason).toBe("stop");
  const toolEnd = events.find((e) => e.type === "tool_end") as Extract<AgentEvent, { type: "tool_end" }> | undefined;
  expect(toolEnd?.output).toContain("subagente-completo-42");
  // el tool-call quedó etiquetado para la UI como subagente
  // (solo tool_start/tool_end llevan el prefijo)
  const toolStart = events.find((e) => e.type === "tool_start") as Extract<AgentEvent, { type: "tool_start" }> | undefined;
  expect(toolStart?.name).toBe("task");
  // la sesión hija existe con su título y su historial
  const child = Session.list().find((s) => s.title.startsWith("task:"));
  expect(child).toBeDefined();
  const childMsgs = Session.load(child!.id)!.messages();
  expect(childMsgs[0].role).toBe("user");
  expect(childMsgs[childMsgs.length - 1].content).toBe("subagente-completo-42");
  // el padre terminó y su tool message incluye la respuesta del subagente
  const toolMsg = rt.messages.find((m) => m.role === "tool");
  expect(toolMsg?.content).toContain("subagente-completo-42");
  expect(rt.messages[rt.messages.length - 1].content).toBe("padre-completo");
});
