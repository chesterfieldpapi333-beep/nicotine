// Fase 8 — entregables de la fase: edit near-match, compactación 2 pasos,
// failover de claves, tool-calls en texto, memoria por proyecto, architect/editor,
// policies v2 (hard-deny) y PermissionDenied acotado.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdit } from "../src/tools/edit.js";
import { maybeCompact, estimateTokens, pruneForCompaction, type CompactionConfig } from "../src/core/compact.js";
import { resolveProvider, streamChat, ProviderError, type ProviderConfig } from "../src/core/provider.js";
import { runAgentLoop } from "../src/core/loop.js";
import { PermissionEngine, baseRules, policiesFromConfig, PermissionDenied } from "../src/core/permissions.js";
import { bashTool } from "../src/tools/bash.js";
import { parseTextToolCalls } from "../src/core/text-tool-calls.js";
import { loadConfig } from "../src/core/config.js";
import { loadContextFiles } from "../src/compat/context-files.js";
import { BUILTIN_AGENTS, allAgents, findAgent } from "../src/core/agents.js";
import type { ChatMessage, ToolContext, UiHooks } from "../src/core/types.js";
import type { AgentEvent } from "../src/core/events.js";

// ————— edit: fragmento más parecido —————
describe("edit — «fragmento más parecido» cuando oldString no casa", () => {
  const file = "line one\n  const total = sum(items);\n  return total;\n}\n";
  test("falla e incluye la ventana parecida con números de línea", () => {
    let msg = "";
    try { applyEdit(file, "  const total = sum(item);\n  return totals;", "  const total = 0;", false); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("Fragmento más parecido");
    expect(msg).toContain("2 |");
    expect(msg).toContain("const total = sum(items);");
  });
  test("sin parecido razonable → no sugiere nada inventado", () => {
    let msg = "";
    try { applyEdit(file, "zzzz qqqq xxxx\nvvv jjj kkk", "x", false); } catch (e) { msg = (e as Error).message; }
    expect(msg).not.toContain("Fragmento más parecido");
    expect(msg).toContain("oldString no encontrado");
  });
});

// ————— compactación 2 pasos —————
const big = "palabra ".repeat(2000); // ~2000 tokens
const toolMsg = (id: string, n: number): ChatMessage => ({ role: "tool", tool_call_id: id, content: "salida ".repeat(n) });
const asst = (content: string): ChatMessage => ({ role: "assistant", content });
const compactCfg: CompactionConfig = { auto: true, thresholdTokens: 200, keepTokens: 50 };

describe("compactación en dos pasos", () => {
  test("paso 1 (poda sin LLM): con salidas de tool gigantes basta y NO llama al modelo", async () => {
    let llmCalls = 0;
    const fetchImpl = (async () => { llmCalls++; throw new Error("no debería llamarse"); }) as unknown as typeof fetch;
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      asst("a"), toolMsg("c1", 3000), toolMsg("c2", 3000), { role: "user", content: "hola" },
    ];
    const events: AgentEvent[] = [];
    const res = await maybeCompact({ messages, provider: { baseURL: "http://x", apiKey: "k", model: "m", headers: {}, engine: "fetch" as const }, config: { ...compactCfg, thresholdTokens: 400 }, emit: (e) => events.push(e), fetchImpl });
    expect(res.pass).toBe(1);
    expect(res.compacted).toBe(true);
    expect(llmCalls).toBe(0);
    expect(messages[1].content).toBe("a"); // intacto
    expect(messages.some((m) => m.role === "tool" && String(m.content).includes("truncado por nicotine"))).toBe(true);
    expect(events[0]).toMatchObject({ type: "compaction", pass: 1 });
  });

  test("paso 2 (resumen LLM) cuando podar no basta", async () => {
    const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    const fetchImpl = (async () => new Response(sse({ choices: [{ delta: { content: "resumen-denso-mock" } }] }) + "data: [DONE]\n\n", { status: 200 })) as unknown as typeof fetch;
    const messages: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 30; i++) { messages.push(asst(big)); messages.push({ role: "user", content: "haz algo" }); }
    const before = messages.length;
    const events: AgentEvent[] = [];
    const res = await maybeCompact({ messages, provider: { baseURL: "http://x", apiKey: "k", model: "m", headers: {}, engine: "fetch" as const }, config: compactCfg, emit: (e) => events.push(e), fetchImpl });
    expect(res.pass).toBe(2);
    expect(messages.length).toBeLessThan(before);
    expect(messages[0].content).toBe("sys");
    expect(messages.some((m) => String(m.content).includes("resumen-denso-mock"))).toBe(true);
    expect(events[0]).toMatchObject({ type: "compaction", pass: 2 });
  });

  test("paso 2 falla → historial del usuario intacto y error emitido", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const messages: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 30; i++) { messages.push(asst(big)); messages.push({ role: "user", content: "haz algo" }); }
    const snapshot = JSON.parse(JSON.stringify(messages));
    const events: AgentEvent[] = [];
    const res = await maybeCompact({ messages, provider: { baseURL: "http://x", apiKey: "k", model: "m", headers: {}, engine: "fetch" as const }, config: compactCfg, emit: (e) => events.push(e), fetchImpl });
    expect(res.pass).toBe(0);
    expect(res.compacted).toBe(false);
    expect(messages).toEqual(snapshot);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  test("pruneForCompaction devuelve chars y respeta el corte de argumentos", () => {
    const m: ChatMessage[] = [{ role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "bash", arguments: "x".repeat(5000) } }] }];
    const saved = pruneForCompaction(m);
    expect(saved).toBeGreaterThan(4000);
    expect(JSON.parse(m[0].tool_calls![0].function.arguments)).toEqual({ _nicotine_truncated: true });
  });
});

// ————— failover / rotación de claves —————
const sseOk = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
const providerWith = (apiKeys: string[]): ProviderConfig => ({ baseURL: "http://mock/v1", apiKey: apiKeys[0] ?? "", apiKeys, model: "m", headers: {}, engine: "fetch" as const });

describe("failover de claves (401/403/429/5xx)", () => {
  test("resolveProvider construye el pool: config apiKeys + env OPENAI_API_KEYS, dedup", () => {
    process.env.OPENAI_API_KEYS = " e1, e2 ,e1 ,e3 ";
    const p = resolveProvider({ provider: { apiKey: "c0", apiKeys: ["c1", "c0", "  "] } }, "m");
    expect(p.apiKeys).toEqual(["c1", "c0", "e1", "e2", "e3"]);
    delete process.env.OPENAI_API_KEYS;
  });

  test("429 → 429 → 200: rota k1,k2,k3; onRetry informa; el stream funciona", async () => {
    const seen: string[] = [];
    let call = 0;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>)?.authorization));
      call++;
      if (call < 3) return new Response("rate limited", { status: 429 });
      return new Response(sseOk("ok-final"), { status: 200 });
    }) as unknown as typeof fetch;
    const retries: { attempt: number; status: number; total: number; model?: string; nextModel?: string }[] = [];
    const res = await streamChat({ provider: providerWith(["k1", "k2", "k3"]), messages: [{ role: "user", content: "hi" }], fetchImpl, onRetry: (i) => retries.push(i) });
    expect(res.message.content).toBe("ok-final");
    expect(seen).toEqual(["Bearer k1", "Bearer k2", "Bearer k3"]);
    expect(retries).toEqual([{ attempt: 1, status: 429, total: 3, model: "m", nextModel: "m" }, { attempt: 2, status: 429, total: 3, model: "m", nextModel: "m" }]);
  });

  test("400 no rota (error del cliente no es failover)", async () => {
    let call = 0;
    const fetchImpl = (async () => { call++; return new Response("bad request", { status: 400 }); }) as unknown as typeof fetch;
    await expect(streamChat({ provider: providerWith(["k1", "k2"]), messages: [{ role: "user", content: "hi" }], fetchImpl })).rejects.toBeInstanceOf(ProviderError);
    expect(call).toBe(1);
  });

  test("todas las claves agotadas (401) → ProviderError con el último status", async () => {
    let call = 0;
    const fetchImpl = (async () => { call++; return new Response("nope", { status: 401 }); }) as unknown as typeof fetch;
    await expect(streamChat({ provider: providerWith(["k1", "k2"]), messages: [{ role: "user", content: "hi" }], fetchImpl })).rejects.toMatchObject({ status: 401 });
    expect(call).toBe(2);
  });
});

// ————— tool-calls en texto —————
describe("tool-calls en texto (Hermes/Qwen) — solo sin tool_calls nativos", () => {
  test("parsea <tool_call>…</tool_call> y limpia el texto", () => {
    const r = parseTextToolCalls('Voy a leer el archivo.\n<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>', new Set(["read"]));
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].function.name).toBe("read");
    expect(JSON.parse(r.calls[0].function.arguments)).toEqual({ path: "a.ts" });
    expect(r.remainingText).toBe("Voy a leer el archivo.");
  });
  test("bloque ```json con name+arguments también cuenta; tool desconocida se descarta", () => {
    const ok = parseTextToolCalls('```json\n{"name":"glob","arguments":{"pattern":"**/*.ts"}}\n```', new Set(["glob"]));
    expect(ok.calls).toHaveLength(1);
    const bad = parseTextToolCalls('```json\n{"name":"nope","arguments":{}}\n```', new Set(["glob"]));
    expect(bad.calls).toHaveLength(0);
    expect(bad.remainingText).toContain("```json");
  });
  test("argumentos string JSON pasan tal cual; JSON roto → no rescata", () => {
    const ok = parseTextToolCalls('<tool_call>{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}</tool_call>', new Set(["bash"]));
    expect(ok.calls[0].function.arguments).toBe('{"command":"ls"}');
    const bad = parseTextToolCalls('<tool_call>{"name":"bash","arguments":"{not json"}</tool_call>');
    expect(bad.calls).toHaveLength(0);
  });
  test("loop: el modelo responde en TEXTO y la tool se ejecuta igualmente", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      const delta = calls === 1
        ? { choices: [{ delta: { content: '<tool_call>{"name":"bash","arguments":{"command":"echo via-texto"}}</tool_call>' } }] }
        : { choices: [{ delta: { content: "fin" } }] };
      return new Response(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`, { status: 200 });
    }) as unknown as typeof fetch;
    const ui: UiHooks = { confirm: async () => "once", question: async () => null, info: () => {} };
    const ctx: ToolContext = { cwd: process.cwd(), sessionId: "t", signal: new AbortController().signal, ui, readFiles: new Set(), emit: () => {} };
    const messages: ChatMessage[] = [{ role: "user", content: "hola" }];
    const reason = await runAgentLoop({ provider: providerWith(["k"]), permissions: new PermissionEngine(baseRules()), messages, tools: [bashTool], ctx, fetchImpl });
    expect(reason).toBe("stop");
    expect(messages.some((m) => m.role === "tool" && String(m.content).includes("via-texto"))).toBe(true);
  });
  test("con textToolCalls=false el texto queda intacto y la tool NO corre", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '<tool_call>{"name":"bash","arguments":{"command":"echo NO-DEBE-CORRER"}}</tool_call>' } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
    }) as unknown as typeof fetch;
    const ui: UiHooks = { confirm: async () => "once", question: async () => null, info: () => {} };
    const ctx: ToolContext = { cwd: process.cwd(), sessionId: "t", signal: new AbortController().signal, ui, readFiles: new Set(), emit: () => {}, textToolCalls: false };
    const messages: ChatMessage[] = [{ role: "user", content: "hola" }];
    await runAgentLoop({ provider: providerWith(["k"]), permissions: new PermissionEngine(baseRules()), messages, tools: [bashTool], ctx, fetchImpl });
    expect(messages.some((m) => m.role === "tool")).toBe(false);
  });
});

// ————— memoria por proyecto —————
describe("memoria por proyecto (.nicotine/memory.md, solo cwd)", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "nicotine-mem-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test("se carga con kind memory y la nota para el agente", () => {
    mkdirSync(join(root, ".nicotine"), { recursive: true });
    writeFileSync(join(root, ".nicotine", "memory.md"), "# decisiones\n- usar bun siempre\n");
    const { files, block } = loadContextFiles(root, {});
    const mem = files.find((f) => f.kind === "memory")!;
    expect(mem.path).toBe(join(root, ".nicotine", "memory.md"));
    expect(block).toContain(".nicotine/memory.md (memory)");
    expect(block).toContain("memoria del proyecto");
  });
  test("la memoria de un directorio PADRE no se carga (un proyecto = su cwd)", () => {
    mkdirSync(join(root, "padre", ".nicotine"), { recursive: true });
    writeFileSync(join(root, "padre", ".nicotine", "memory.md"), "no-es-mía\n");
    const sub = join(root, "padre", "sub");
    mkdirSync(sub, { recursive: true });
    const { files } = loadContextFiles(sub, {});
    expect(files.some((f) => f.kind === "memory")).toBe(false);
  });
});

// ————— architect / editor —————
describe("agentes architect y editor", () => {
  test("ambos primary; architect deniega edit; editor hereda defaults", () => {
    const arch = findAgent("architect");
    const editor = findAgent("editor");
    expect(arch.mode).toBe("primary");
    expect(editor.mode).toBe("primary");
    expect(arch.permissionRules).toEqual([{ action: "edit", resource: "*", effect: "deny" }]);
    expect(editor.permissionRules).toEqual([]);
    expect(arch.systemAppend).toContain("ARCHITECT");
    expect(editor.systemAppend).toContain("EDITOR");
  });
  test("aparecen en el ciclo (allAgents sin subagentes) y --agent los acepta", () => {
    const primaries = allAgents().filter((a) => a.mode !== "subagent").map((a) => a.id);
    expect(primaries).toEqual(expect.arrayContaining(["build", "plan", "architect", "editor"]));
    expect(BUILTIN_AGENTS.some((a) => a.id === "architect")).toBe(true);
  });
});

// ————— policies v2 + PermissionDenied acotado —————
describe("policies v2 (hard-deny post-reglas) y PermissionDenied", () => {
  test("policy deniega aunque el default permita (y un always guardado no la pisa)", () => {
    const policies = policiesFromConfig([{ action: "bash", resource: "rm *" }]);
    const e = new PermissionEngine(baseRules(), policies);
    e.addSavedAllow({ action: "bash", resource: "rm *", effect: "allow" });
    const r = e.check("bash", "rm -rf /tmp/x");
    expect(r.effect).toBe("deny");
    expect(r.policy).toBe(true);
    // no afectada por prefijos `cmd *`: otra cosa sigue pasando
    expect(e.check("bash", "ls").effect).toBe("allow");
  });
  test("policiesFromConfig filtra basura y expande ~ en rutas (no en bash)", () => {
    expect(policiesFromConfig(undefined)).toEqual([]);
    expect(policiesFromConfig("nope")).toEqual([]);
    expect(policiesFromConfig([{ action: "bash" }, "x", null, { action: "edit", resource: "/etc/*" }])).toEqual([{ action: "edit", resource: "/etc/*" }]);
  });
  test("config: policies de capas se acumulan y las aplica el motor", () => {
    const root = mkdtempSync(join(tmpdir(), "nicotine-pol-"));
    try {
      writeFileSync(join(root, "opencode.json"), JSON.stringify({ policies: [{ action: "bash", resource: "rm *" }] }));
      const { policies } = loadConfig(root);
      expect(policies).toEqual([{ action: "bash", resource: "rm *" }]);
      const engine = new PermissionEngine(baseRules(), policies);
      expect(engine.check("bash", "rm -rf /").effect).toBe("deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("PermissionDenied acota la causa a UNA regla/policy (legado: volcaba todo el ruleset)", () => {
    const d = new PermissionDenied("bash", "rm -rf /", "policy v2 «rm *»");
    expect(d.message).toBe("permission denied: bash → rm -rf / (policy v2 «rm *»)");
    const d2 = new PermissionDenied("edit", "/etc/passwd");
    expect(d2.message).toBe("permission denied: edit → /etc/passwd"); // sin ruleset completo, jamás
  });
});

// ————— sanity: estimación de tokens sigue viva —————
test("estimateTokens > 0 y escala con el contenido", () => {
  expect(estimateTokens([{ role: "user", content: "abcd" }])).toBe(1);
  expect(estimateTokens([{ role: "user", content: big }])).toBeGreaterThan(1000);
});

describe("failover de modelos (NICOTINE_MODEL_FALLBACKS / provider.fallbackModels)", () => {
  test("todas las claves 429 en modelo A → salta a modelo B y tiene éxito", async () => {
    const calls: { model: string; key: string }[] = [];
    const fetchImpl = (async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      const key = (init.headers.authorization ?? "").replace("Bearer ", "");
      calls.push({ model: body.model, key });
      if (body.model === "modelo-a") return new Response("rate", { status: 429 });
      return new Response('data: {"choices":[{"delta":{"content":"ok-B"}}]}\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const provider = { model: "modelo-a", baseURL: "http://127.0.0.1:9/v1", apiKey: "k1", apiKeys: ["k1", "k2"], fallbackModels: ["modelo-b"], headers: {}, engine: "fetch" as const };
    const seen: any[] = [];
    const res = await streamChat({ provider, messages: [{ role: "user", content: "hi" }], fetchImpl, onRetry: (i) => seen.push(i) });
    expect(res.message.content).toBe("ok-B");
    expect(calls.map((c) => c.model)).toEqual(["modelo-a", "modelo-a", "modelo-b"]);
    expect(seen.length).toBe(2);
    expect(provider.model).toBe("modelo-b"); // failover pega en la sesión
  });

  test("400 NO rota ni salta al fallback", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init: any) => { calls.push(JSON.parse(init.body).model); return new Response("bad request", { status: 400 }); }) as unknown as typeof fetch;
    const provider = { model: "mal", baseURL: "http://127.0.0.1:9/v1", apiKey: "k1", apiKeys: ["k1", "k2"], fallbackModels: ["bueno"], headers: {}, engine: "fetch" as const };
    let caught: any = null;
    try { await streamChat({ provider, messages: [{ role: "user", content: "hi" }], fetchImpl }); } catch (e) { caught = e; }
    expect(caught?.name).toBe("ProviderError");
    expect(calls).toEqual(["mal"]); // una sola petición, ninguna rotación
  });

  test("cadena agotada → ProviderError con el último status", async () => {
    const provider = { model: "a", baseURL: "http://127.0.0.1:9/v1", apiKey: "k1", apiKeys: ["k1", "k2"], fallbackModels: ["b"], headers: {}, engine: "fetch" as const };
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    let caught: any = null;
    try { await streamChat({ provider, messages: [{ role: "user", content: "hi" }], fetchImpl }); } catch (e) { caught = e; }
    expect(caught?.status).toBe(500);
  });
});
