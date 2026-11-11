// Motor opcional «vercel-ai» (item «Vercel AI SDK adapter» de «todo»): OFF por
// defecto, import dinámico, cero deps en el núcleo. Estos tests cubren la
// conversión OpenAI→AI SDK y todo el flujo con módulos inyectados (sin instalar
// nada). NICOTINE_LIVE_VERCEL_AI=1 ejecuta además una integración real contra un
// mock SSE local si los paquetes están instalados.
import { test, expect, describe } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { streamChat, ProviderError, resolveProvider, type ProviderConfig } from "../src/core/provider.js";
import { vercelStreamChat, toModelMessages, sdkToolSet, toolNameByCallId, type VercelModules } from "../src/core/provider-vercel.js";
import type { ChatMessage } from "../src/core/types.js";

const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  baseURL: "http://mock/v1", apiKey: "k1", apiKeys: ["k1"], model: "m", headers: {}, engine: "vercel-ai", ...over,
});

describe("vercel-ai — conversión OpenAI → AI SDK", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hola" },
    { role: "assistant", content: "voy", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_time", arguments: '{"tz":"UTC"}' } }] },
    { role: "tool", content: "12:00", tool_call_id: "call_1" },
    { role: "assistant", content: null },
  ];

  test("toModelMessages mapea roles, tool-calls y tool-results", () => {
    const out = toModelMessages(messages) as any[];
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    expect(out[1]).toEqual({ role: "user", content: "hola" });
    expect(out[2].role).toBe("assistant");
    expect(out[2].content).toEqual([
      { type: "text", text: "voy" },
      { type: "tool-call", toolCallId: "call_1", toolName: "get_time", input: { tz: "UTC" } },
    ]);
    expect(out[3].content[0]).toMatchObject({ type: "tool-result", toolCallId: "call_1", toolName: "get_time", output: { type: "text", value: "12:00" } });
    expect(out[4].content).toEqual([]); // assistant sin texto ni tool-calls → array vacío (el SDK lo tolera)
  });

  test("toolNameByCallId + argumentos JSON inválidos pasan como string", () => {
    expect(toolNameByCallId(messages).get("call_1")).toBe("get_time");
    const bad: ChatMessage[] = [{ role: "assistant", content: null, tool_calls: [{ id: "c9", type: "function", function: { name: "t", arguments: "{roto" } }] }];
    expect((toModelMessages(bad)[0] as any).content[0].input).toBe("{roto");
  });

  test("sdkToolSet envuelve schemas con jsonSchema inyectado", () => {
    const seen: unknown[] = [];
    const jsonSchema = (s: unknown) => { seen.push(s); return { __schema: s }; };
    const tools = sdkToolSet([{ type: "function", function: { name: "t", description: "d", parameters: { type: "object", properties: { a: { type: "string" } } } } }], jsonSchema) as any;
    expect(tools.t.description).toBe("d");
    expect(tools.t.inputSchema).toEqual({ __schema: { type: "object", properties: { a: { type: "string" } } } });
    expect(seen).toHaveLength(1);
    expect(sdkToolSet(undefined, jsonSchema)).toBeUndefined();
    expect(sdkToolSet([], jsonSchema)).toBeUndefined();
  });
});

// --- módulos mock inyectables (simula ai@7 / @ai-sdk/openai-compatible@3) ---
function mockModules(opts: {
  text?: string;
  streamError?: { statusCode?: number; message?: string; responseBody?: string };
  toolCalls?: { toolCallId: string; toolName: string; input: unknown }[];
  capture?: { url?: string; key?: string; model?: string; tools?: unknown };
} = {}): VercelModules {
  const capture = opts.capture ?? {};
  const ai = {
    jsonSchema: (s: unknown) => ({ __schema: s }),
    streamText: (args: any) => {
      capture.model = args.model?.modelId ?? args.model?.model ?? args.model;
      capture.tools = args.tools;
      const text = opts.text ?? "hola mundo";
      return {
        fullStream: (async function* () {
          if (opts.streamError) { yield { type: "error", error: Object.assign(new Error(opts.streamError.message ?? "boom"), { statusCode: opts.streamError.statusCode, responseBody: opts.streamError.responseBody }) }; return; }
          for (const t of text.split(" ")) yield { type: "text-delta", text: (t === text.split(" ")[0] ? "" : " ") + t };
        })(),
        usage: Promise.resolve({ inputTokens: 11, outputTokens: 7, totalTokens: 18 }),
        toolCalls: Promise.resolve(opts.toolCalls ?? []),
      };
    },
  };
  const openaiCompatible = {
    createOpenAICompatible: (cfg: any) => {
      capture.url = cfg.baseURL; capture.key = cfg.apiKey;
      return (model: string) => ({ modelId: model });
    },
  };
  return { ai, openaiCompatible };
}

describe("vercel-ai — flujo completo con módulos inyectados", () => {
  test("happy path: texto, onText, usage y tool-calls mapeados", async () => {
    const deltas: string[] = [];
    const capture: Record<string, unknown> = {};
    const modules = mockModules({ text: "hola mundo", toolCalls: [{ toolCallId: "c1", toolName: "get_time", input: { tz: "UTC" } }], capture });
    const out = await vercelStreamChat({
      provider: provider(),
      messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
      tools: [{ type: "function", function: { name: "get_time", description: "d", parameters: { type: "object", properties: {} } } }],
      onText: (t) => deltas.push(t),
    }, { modules });
    expect(out.message.content).toBe("hola mundo");
    expect(deltas.join("")).toBe("hola mundo");
    expect(out.usage).toEqual({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
    expect(out.message.tool_calls).toEqual([{ id: "c1", type: "function", function: { name: "get_time", arguments: '{"tz":"UTC"}' } }]);
    expect(capture.url).toBe("http://mock/v1");
    expect(capture.key).toBe("k1");
    expect((capture.tools as any).get_time).toBeDefined();
  });

  test("401 con 2 claves → failover a la segunda (sin exponer claves en onRetry)", async () => {
    const capture: Record<string, unknown> = {};
    let call = 0;
    const modules: VercelModules = {
      ai: { jsonSchema: (s: unknown) => s, streamText: () => {
        call++;
        return {
          fullStream: (async function* () { if (call === 1) yield { type: "error", error: Object.assign(new Error("bad key"), { statusCode: 401 }) }; else yield { type: "text-delta", text: "ok" }; })(),
          usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
          toolCalls: Promise.resolve([]),
        };
      } },
      openaiCompatible: { createOpenAICompatible: (cfg: any) => { capture.key = cfg.apiKey; return (model: string) => ({ modelId: model }); } },
    };
    const retries: { status: number; model?: string }[] = [];
    const out = await vercelStreamChat({ provider: provider({ apiKeys: ["k1", "k2"] }), messages: [{ role: "user", content: "u" }], onRetry: (i) => retries.push({ status: i.status, model: i.model }) }, { modules });
    expect(out.message.content).toBe("ok");
    expect(capture.key).toBe("k2"); // la segunda clave se usó
    expect(retries).toEqual([{ status: 401, model: "m" }]);
  });

  test("400 no rota claves: ProviderError inmediato", async () => {
    const modules = mockModules({ streamError: { statusCode: 400, message: "bad request" } });
    await expect(vercelStreamChat({ provider: provider({ apiKeys: ["k1", "k2"] }), messages: [{ role: "user", content: "u" }] }, { modules })).rejects.toMatchObject({ name: "ProviderError", status: 400 });
  });

  test("agotadas claves y modelo de respaldo: ProviderError con el último status", async () => {
    const modules = mockModules({ streamError: { statusCode: 503, message: "down" } });
    await expect(vercelStreamChat({ provider: provider({ apiKeys: ["k1", "k2"], fallbackModels: ["fb"] }), messages: [{ role: "user", content: "u" }] }, { modules })).rejects.toMatchObject({ name: "ProviderError", status: 503 });
  });

  test("failover de modelos: errores 429 en «m» → usa fallback «fb» y lo deja en provider.model", async () => {
    const capture: Record<string, unknown> = {};
    let call = 0;
    const modules: VercelModules = {
      ai: { jsonSchema: (s: unknown) => s, streamText: (args: any) => {
        call++;
        const failing = args.model.modelId === "m";
        return {
          fullStream: (async function* () { if (failing) yield { type: "error", error: Object.assign(new Error("rate"), { statusCode: 429 }) }; else yield { type: "text-delta", text: "desde-fallback" }; })(),
          usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
          toolCalls: Promise.resolve([]),
        };
      } },
      openaiCompatible: { createOpenAICompatible: () => (model: string) => ({ modelId: model }) },
    };
    const p = provider({ apiKeys: ["k1"], fallbackModels: ["fb"] });
    const out = await vercelStreamChat({ provider: p, messages: [{ role: "user", content: "u" }] }, { modules });
    expect(out.message.content).toBe("desde-fallback");
    expect(p.model).toBe("fb");
    expect(capture.model).toBeUndefined(); // capture vacío a propósito (createOpenAICompatible no inyectado con capture)
  });
});

describe("vercel-ai — selección de motor y paquetes ausentes", () => {
  test("falta «ai»/«@ai-sdk/openai-compatible» → error claro con instrucciones", async () => {
    // Determinista solo si los paquetes NO están instalados en el repo (lo habitual).
    const installed = await import("ai" as string).then(() => true, () => false);
    if (installed) { console.log("paquetes presentes en este entorno: caso «ausentes» no aplica"); return; }
    await expect(vercelStreamChat({ provider: provider(), messages: [{ role: "user", content: "u" }] }))
      .rejects.toMatchObject({ name: "ProviderError", status: 0 });
    try {
      await vercelStreamChat({ provider: provider(), messages: [{ role: "user", content: "u" }] });
      throw new Error("no lanzó");
    } catch (err) {
      expect(String((err as Error).message)).toContain("bun add ai @ai-sdk/openai-compatible");
    }
  });

  test("streamChat delega en vercel-ai cuando provider.engine=vercel-ai", async () => {
    // Sin paquetes → ProviderError de «faltan paquetes». Con paquetes → el stream
    // abre conexión a 127.0.0.1:1 (rechazada) → ProviderError de red. En ambos
    // casos debe ser ProviderError, nunca un crash ni una llamada al motor fetch.
    const p = provider({ baseURL: "http://127.0.0.1:1/v1", apiKeys: ["k"] });
    await expect(streamChat({ provider: p, messages: [{ role: "user", content: "u" }] }))
      .rejects.toMatchObject({ name: "ProviderError" });
  });

  test("resolveProvider: engine por defecto fetch; NICOTINE_PROVIDER_ENGINE respetado; valor inválido rechaza", () => {
    const saved = process.env.NICOTINE_PROVIDER_ENGINE;
    try {
      delete process.env.NICOTINE_PROVIDER_ENGINE;
      const a = resolveProvider({ model: "openai/x", provider: { baseURL: "http://127.0.0.1:9/v1", apiKey: "k" } });
      expect(a.engine).toBe("fetch");
      const b = resolveProvider({ model: "openai/x", provider: { baseURL: "http://127.0.0.1:9/v1", apiKey: "k", engine: "vercel-ai" } });
      expect(b.engine).toBe("vercel-ai");
      process.env.NICOTINE_PROVIDER_ENGINE = "vercel-ai";
      const c = resolveProvider({ model: "openai/x", provider: { baseURL: "http://127.0.0.1:9/v1", apiKey: "k" } });
      expect(c.engine).toBe("vercel-ai");
      expect(() => resolveProvider({ model: "openai/x", provider: { baseURL: "http://127.0.0.1:9/v1", apiKey: "k", engine: "otro" } })).toThrow(/engine/);
    } finally {
      if (saved === undefined) delete process.env.NICOTINE_PROVIDER_ENGINE; else process.env.NICOTINE_PROVIDER_ENGINE = saved;
    }
  });
});

// Integración opcional con los paquetes REALES (no forman parte del núcleo):
// NICOTINE_LIVE_VERCEL_AI=1 bun test tests/vercel.test.ts
const live = process.env.NICOTINE_LIVE_VERCEL_AI === "1";
(live ? describe : describe.skip)("vercel-ai — integración real (NICOTINE_LIVE_VERCEL_AI=1)", () => {
  test("mock SSE local: streamText real → texto, usage y tool-call", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ai: any, opc: any;
    try { [ai, opc] = await Promise.all([import("ai" as string), import("@ai-sdk/openai-compatible" as string)]); } catch {
      console.log("paquetes no instalados; bun add ai @ai-sdk/openai-compatible"); return;
    }
    const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const server: Server = createServer((req, res) => {
      let body = ""; req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        const wantsTool = (parsed.tools?.length ?? 0) > 0 && !JSON.stringify(parsed.messages).includes("get_time");
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (wantsTool) {
          res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_time", arguments: "" } }] } }] }));
          res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"tz":"UTC"}' } }] } }] }));
          res.write(sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }));
        } else {
          res.write(sse({ choices: [{ delta: { content: "vivo" } }] }));
          res.write(sse({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }));
        }
        res.write("data: [DONE]\n\n"); res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const p = provider({ baseURL: `http://127.0.0.1:${port}/v1`, apiKeys: ["k"], fallbackModels: [] });
    const tools = [{ type: "function" as const, function: { name: "get_time", description: "d", parameters: { type: "object" as const, properties: { tz: { type: "string" } } } } }];
    const out = await vercelStreamChat({ provider: p, messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], tools }, { modules: { ai, openaiCompatible: opc } });
    expect(out.message.tool_calls?.[0].function.name).toBe("get_time");
    expect(out.usage?.totalTokens).toBe(12);
    server.close();
  });
});
