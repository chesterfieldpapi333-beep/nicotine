// Provider OpenAI-compatible falso para probar el bucle end-to-end sin APIs.
// Uso:  bun run scripts/mock-provider.ts   (escucha en 127.0.0.1:8799)
// Comportamiento: si la conversación aún no contiene una tool result, pide la
// tool `bash` con `echo vireo-funciona`; si ya la contiene, responde texto final.
// Escenarios extra vía VIREO_MOCK_SCENARIO:
//   fileedit  → pide la tool `write` con demo-output.txt (para probar /undo)

const port = Number(process.env.MOCK_PORT ?? 8799);
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const body = (await req.json()) as any;
    const hasToolResult = body.messages?.some((m: any) => m.role === "tool");
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

    const scenario = process.env.VIREO_MOCK_SCENARIO ?? "";
    let payload: string[];
    if (hasTools && !hasToolResult && scenario === "fileedit") {
      payload = [
        sse({ choices: [{ delta: { content: "Voy a crear el archivo demo. " } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: "write", arguments: '{"path":"demo-output.txt","content":"creado por vireo-mock\\n"}' } }] } }] }),
        "data: [DONE]\n\n",
      ];
    } else if (hasTools && !hasToolResult) {
      payload = [
        sse({ choices: [{ delta: { content: "Voy a comprobar el entorno. " } }] }),
        sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: "bash", arguments: '{"command":"echo vireo-funciona"}' } }] } }] }),
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
