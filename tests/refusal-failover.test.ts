import { test, expect } from "bun:test";
import { streamChat, looksLikeRefusal, type ProviderConfig } from "../src/core/provider.js";

test("looksLikeRefusal: conservador (ES/EN) con umbrales", () => {
  expect(looksLikeRefusal("I cannot help with that request.")).toBe(true);
  expect(looksLikeRefusal("Lo siento, pero no puedo ayudar con esto.")).toBe(true);
  expect(looksLikeRefusal("I'm unable to assist with this.")).toBe(true);
  expect(looksLikeRefusal("As an AI language model, I can't do that.")).toBe(true);
  expect(looksLikeRefusal("Aquí tienes la implementación completa del parser en TypeScript.")).toBe(false);
  expect(looksLikeRefusal("")).toBe(false);
  expect(looksLikeRefusal("I cannot help with that." + " relleno".repeat(400))).toBe(false); // >1500 chars
  expect(looksLikeRefusal("```ts\nconst x = 1;\n``` no puedo ayudar")).toBe(false); // contiene código
});

function sseModel(model: string, content: string, usage = true): Response {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    usage ? `data: ${JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n` : "",
    "data: [DONE]\n\n",
  ];
  return new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function mockFetch(script: Record<string, string>) {
  const seen: string[] = [];
  const fn = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { model: string };
    seen.push(body.model);
    const content = script[body.model];
    if (content === undefined) return new Response("unexpected model", { status: 400 });
    return sseModel(body.model, content);
  }) as unknown as typeof fetch;
  return { fn, seen };
}

const baseProvider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  baseURL: "http://mock/v1", apiKey: "k", apiKeys: ["k"], model: "a", fallbackModels: ["b", "c"], headers: {}, engine: "fetch", ...over,
});

test("refusal-failover: 1º rechaza → 2º responde; texto del rechazo NUNCA se emite", async () => {
  const { fn, seen } = mockFetch({ a: "I cannot help with that request.", b: "respuesta final desde b" });
  const emitted: string[] = [];
  const p = baseProvider();
  const res = await streamChat({ provider: p, messages: [{ role: "user", content: "hola" }], fetchImpl: fn, refusalFailover: true, onText: (t) => emitted.push(t) });
  expect(seen).toEqual(["a", "b"]);
  expect(res.message.content).toBe("respuesta final desde b");
  expect(emitted.join("")).toBe("respuesta final desde b");
  expect(emitted.join("")).not.toContain("cannot help");
  expect(p.model).toBe("b");
});

test("refusal-failover desactivado: el rechazo se devuelve tal cual", async () => {
  const { fn, seen } = mockFetch({ a: "I cannot help with that request." });
  const res = await streamChat({ provider: baseProvider(), messages: [{ role: "user", content: "hola" }], fetchImpl: fn, onText: () => {} });
  expect(seen).toEqual(["a"]);
  expect(res.message.content).toBe("I cannot help with that request.");
});

test("refusal-failover: todos rechazan → devuelve el del último modelo sin romper", async () => {
  const { fn, seen } = mockFetch({ a: "I cannot help with that.", b: "I'm unable to assist with this.", c: "Lo siento, no puedo ayudar con eso." });
  const res = await streamChat({ provider: baseProvider(), messages: [{ role: "user", content: "hola" }], fetchImpl: fn, refusalFailover: true });
  expect(seen).toEqual(["a", "b", "c"]);
  expect(looksLikeRefusal(String(res.message.content))).toBe(true);
});

test("refusal-failover: respuesta con tool_calls no se trata como rechazo", async () => {
  const sseTool = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] } }] })}\n\ndata: [DONE]\n\n`;
  const fn = (async () => new Response(sseTool, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  const res = await streamChat({ provider: baseProvider(), messages: [{ role: "user", content: "hola" }], fetchImpl: fn, refusalFailover: true });
  expect(res.message.tool_calls?.length).toBe(1);
});
