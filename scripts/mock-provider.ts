import { envAlias } from "../src/core/env.js";
// Provider OpenAI-compatible falso para probar el bucle end-to-end sin APIs.
// Uso:  bun run scripts/mock-provider.ts   (escucha en 127.0.0.1:8799)
// Comportamiento: si la conversación aún no contiene una tool result, pide la
// tool `bash` con `echo nicotine-funciona`; si ya la contiene, responde texto final.
// Escenarios extra vía NICOTINE_MOCK_SCENARIO:
//   fileedit  → pide la tool `write` con demo-output.txt (para probar /undo)
//   skillload → pide la tool `skill` con la skill `revisar-prs` (para probar skills)
//   extshout → pide la tool `ext_shout` de la extensión de referencia

const port = Number(process.env.MOCK_PORT ?? 8799);
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models") {
      return Response.json({ data: [
        { id: "openai/gpt-4o-mini" },
        { id: "uncensored-qwen-coder" },
        { id: "mi-modelo-raro" },
      ] });
    }
    if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const body = (await req.json()) as any;
    const hasToolResult = body.messages?.some((m: any) => m.role === "tool");
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

    const scenario = envAlias("MOCK_SCENARIO") ?? "";
    let payload: string[];
    if (hasTools && !hasToolResult && scenario === "extshout") {
      payload = [
        sse({ choices: [{ delta: { content: "Uso la extensión. " } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_mock_ext", type: "function", function: { name: "ext_shout", arguments: '{"text":"nicotine"}' } }] } }] }),
        "data: [DONE]\n\n",
      ];
    } else if (hasTools && !hasToolResult && scenario === "mcpecho") {
      payload = [
        sse({ choices: [{ delta: { content: "Uso la herramienta demo. " } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_mock_mcp", type: "function", function: { name: "demo_echo", arguments: '{"text":"nicotine"}' } }] } }] }),
        "data: [DONE]\n\n",
      ];
    } else if (hasTools && !hasToolResult && scenario === "skillload") {
      payload = [
        sse({ choices: [{ delta: { content: "Cargo la skill correspondiente. " } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_mock_skill", type: "function", function: { name: "skill", arguments: '{"id":"revisar-prs"}' } }] } }] }),
        "data: [DONE]\n\n",
      ];
    } else if (hasTools && !hasToolResult && scenario === "fileedit") {
      payload = [
        sse({ choices: [{ delta: { content: "Voy a crear el archivo demo. " } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: "write", arguments: '{"path":"demo-output.txt","content":"creado por nicotine-mock\\n"}' } }] } }] }),
        "data: [DONE]\n\n",
      ];
    } else if (hasTools && !hasToolResult) {
      payload = [
        sse({ choices: [{ delta: { content: "Voy a comprobar el entorno. " } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: "bash", arguments: '{"command":"echo nicotine-funciona"}' } }] } }] }),
        "data: [DONE]\n\n",
      ];
    } else {
      payload = [
        sse({ choices: [{ delta: { content: "Listo: la tool respondió correctamente." } }] }),
        sse({ usage: { prompt_tokens: 42, completion_tokens: 9, total_tokens: 51 } }),
        "data: [DONE]\n\n",
      ];
    }
    return new Response(payload.join(""), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  },
});
console.log(`mock provider en http://127.0.0.1:${port}/v1`);
