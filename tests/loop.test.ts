import { describe, test, expect } from "bun:test";
import { runAgentLoop } from "../src/core/loop.js";
import { PermissionEngine, baseRules } from "../src/core/permissions.js";
import { bashTool } from "../src/tools/bash.js";
import type { AgentEvent } from "../src/core/events.js";
import type { ChatMessage, ToolContext, UiHooks } from "../src/core/types.js";

// SSE falso: primer turno pide bash; segundo devuelve texto final.
function mockFetch(): typeof fetch {
  let calls = 0;
  return (async (_url: unknown, _init?: unknown) => {
    calls++;
    const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    const delta = calls === 1
      ? { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"echo desde-mock"}' } }] } }] }
      : { choices: [{ delta: { content: "respuesta final del mock" } }] };
    const body = sse(delta) + "data: [DONE]\n\n";
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

const ui: UiHooks = { confirm: async () => "once", question: async () => null, info: () => {} };

describe("runAgentLoop con proveedor mock", () => {
  test("tool call → tool_end → texto final; eventos en orden", async () => {
    const ctx: ToolContext = {
      cwd: process.cwd(), sessionId: "test", signal: new AbortController().signal,
      ui, readFiles: new Set(), emit: (ev) => events.push(ev),
    };
    const events: AgentEvent[] = [];
    const messages: ChatMessage[] = [{ role: "user", content: "hola" }];
    const reason = await runAgentLoop({
      provider: { baseURL: "http://mock/v1", apiKey: "k", model: "mock", headers: {} },
      permissions: new PermissionEngine(baseRules()),
      messages,
      tools: [bashTool],
      ctx,
      fetchImpl: mockFetch(),
    });
    expect(reason).toBe("stop");
    const types = events.map((e) => e.type);
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");
    expect(types).toContain("text_delta");
    expect(types[types.length - 1]).toBe("turn_end");
    // el resultado de la tool quedó en el historial como role: tool
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("desde-mock");
    // el assistant final cierra el bucle
    const last = messages[messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.content).toBe("respuesta final del mock");
  });
  test("permission deny → la tool no ejecuta y el modelo recibe el error", async () => {
    const ctx: ToolContext = {
      cwd: process.cwd(), sessionId: "test", signal: new AbortController().signal,
      ui, readFiles: new Set(), emit: () => {},
    };
    const messages: ChatMessage[] = [{ role: "user", content: "hola" }];
    await runAgentLoop({
      provider: { baseURL: "http://mock/v1", apiKey: "k", model: "mock", headers: {} },
      permissions: new PermissionEngine([...baseRules(), { action: "bash", resource: "*", effect: "deny" }]),
      messages,
      tools: [bashTool],
      ctx,
      fetchImpl: mockFetch(),
    });
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("permission denied");
  });
});

describe("proposeAlwaysPattern", () => {
  test("read/edit/write/list → carpeta con /*; bash y otros → recurso exacto", async () => {
    const { proposeAlwaysPattern } = await import("../src/core/loop.js");
    expect(proposeAlwaysPattern("read", "/tmp/proj/src/a.ts")).toBe("/tmp/proj/src/*");
    expect(proposeAlwaysPattern("edit", "/tmp/proj/src/a.ts")).toBe("/tmp/proj/src/*");
    expect(proposeAlwaysPattern("write", "/tmp/proj/src/a.ts")).toBe("/tmp/proj/src/*");
    expect(proposeAlwaysPattern("list", "/tmp/proj/src/")).toBe("/tmp/proj/src/*");
    expect(proposeAlwaysPattern("bash", "npm test")).toBe("npm test");
    expect(proposeAlwaysPattern("bash", "echo a; echo b")).toBe("echo a; echo b");
    expect(proposeAlwaysPattern("read", "/")).toBe("/"); // sin carpeta padre: recurso exacto
  });
});
