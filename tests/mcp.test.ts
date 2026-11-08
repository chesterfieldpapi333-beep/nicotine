// MCP: cliente (handshake legacy/discover/auto), gestor (compuerta de confianza,
// registro de tools, sanitización/descarte), HTTP stateless y legacy con fallback.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectMcpServers, closeMcpClients, mcpServersFromConfig } from "../src/compat/mcp/manager.js";
import type { McpLayerKind } from "../src/compat/mcp/types.js";
import type { UiHooks } from "../src/core/types.js";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-mcp-server.ts");
const BUN = process.execPath;

const tmpdirs: string[] = [];
afterEach(() => { for (const d of tmpdirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ui = (confirm: "once" | "reject" = "once"): UiHooks & { confirms: unknown[] } => {
  const state = { confirms: [] as unknown[] };
  return {
    confirm: async (req: unknown) => { state.confirms.push(req); return confirm; },
    question: async () => null,
    info: () => {},
    ...state,
  };
};

const stdioConf = (name: string, mode: string, extra: Record<string, unknown> = {}) => ({
  mcp: { servers: { [name]: { type: "local", command: [BUN, FIXTURE], environment: { FAKE_MCP_MODE: mode }, ...extra } } },
});

const connect = (config: Record<string, unknown>, origins: Record<string, McpLayerKind>, u: UiHooks) =>
  connectMcpServers({ config, mcpOrigins: origins, ui: u, cwd: "/tmp" });

describe("mcpServersFromConfig", () => {
  test("acepta forma clásica (mcp.<nombre>) y v2 (mcp.servers.<nombre>)", () => {
    const legacy = mcpServersFromConfig({ mcp: { a: { command: ["x"] } } });
    expect(legacy.map((s) => s.name)).toEqual(["a"]);
    const v2 = mcpServersFromConfig({ mcp: { servers: { b: { command: ["x"] } } } });
    expect(v2.map((s) => s.name)).toEqual(["b"]);
    const both = mcpServersFromConfig({ mcp: { a: { command: ["viejo"] }, servers: { a: { command: ["nuevo"] }, c: { url: "https://x" } } } });
    expect(both.find((s) => s.name === "a")!.raw["command"]).toEqual(["nuevo"]); // v2 pisa a clásica
    expect(both.map((s) => s.name).sort()).toEqual(["a", "c"]);
  });
});

describe("connectMcpServers — stdio", () => {
  test("auto cae a initialize legacy cuando server/discover no existe", async () => {
    const u = ui("once");
    const rt = await connect(stdioConf("fake", "legacy"), { fake: "global" }, u);
    expect(rt.servers[0].state).toBe("connected");
    expect(rt.servers[0].protocol).toBe("legacy");
    expect(rt.servers[0].toolCount).toBe(2);
    const echo = rt.tools.find((t) => t.name === "fake_echo")!;
    expect(echo).toBeDefined();
    const res = await echo.run({ text: "hola" }, {} as never);
    expect(res.output).toBe("echo:hola");
    await closeMcpClients(rt);
  });

  test("stateless: discover gana y tool call funciona", async () => {
    const u = ui("once");
    const rt = await connect(stdioConf("fake2", "stateless", { protocol: "auto" }), { fake2: "global" }, u);
    expect(rt.servers[0].protocol).toBe("2026-07-28");
    const echo = rt.tools.find((t) => t.name === "fake2_echo")!;
    const res = await echo.run({ text: "stado" }, {} as never);
    expect(res.output).toBe("echo:stado");
    // resources anunciados: aparecen las tools compartidas
    expect(rt.tools.some((t) => t.name === "opencode_list_mcp_resources")).toBe(true);
    await closeMcpClients(rt);
  });

  test("protocol estricto 2026-07-28 falla limpio contra un servidor legacy", async () => {
    const u = ui("once");
    const rt = await connect(stdioConf("fake3", "legacy", { protocol: "2026-07-28" }), { fake3: "global" }, u);
    expect(rt.servers[0].state).toBe("failed");
    expect(rt.tools).toHaveLength(0);
    await closeMcpClients(rt);
  });

  test("escalera legacy: rechaza 2025-11-25, acepta 2025-06-18", async () => {
    const u = ui("once");
    const rt = await connect(stdioConf("fake4", "ladder"), { fake4: "global" }, u);
    expect(rt.servers[0].state).toBe("connected");
    expect(rt.servers[0].protocol).toBe("legacy");
    await closeMcpClients(rt);
  });

  test("startup timeout: servidor mudo → failed, no cuelga", async () => {
    const u = ui("once");
    const conf = stdioConf("fake5", "slow", { timeouts: { startup: 400, catalog: 300 } });
    const rt = await connect(conf, { fake5: "global" }, u);
    expect(rt.servers[0].state).toBe("failed");
    expect(rt.servers[0].error).toMatch(/timeout/i);
    await closeMcpClients(rt);
  });

  test("tool con isError → salida prefijada y metadata.isError", async () => {
    const u = ui("once");
    const rt = await connect(stdioConf("fake6", "legacy"), { fake6: "global" }, u);
    const fail = rt.tools.find((t) => t.name === "fake6_fail")!;
    const res = await fail.run({}, {} as never);
    expect(res.output).toContain("boom");
    expect(res.metadata?.isError).toBe(true);
    await closeMcpClients(rt);
  });

  test("enabled:false no lanza el proceso", async () => {
    const u = ui("once");
    const rt = await connect(stdioConf("fake7", "legacy", { enabled: false }), { fake7: "global" }, u);
    expect(rt.servers[0].state).toBe("disabled");
    expect(rt.tools).toHaveLength(0);
  });

  test("sanitización de nombres server/tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vireo-mcp-san-"));
    tmpdirs.push(dir);
    const u = ui("once");
    const rt = await connect(stdioConf("mi servidor.con@raro", "legacy"), { "mi servidor.con@raro": "global" }, u);
    expect(rt.tools.some((t) => t.name === "mi_servidor_con_raro_echo")).toBe(true);
    await closeMcpClients(rt);
  });
});

describe("connectMcpServers — compuerta de confianza (proyecto)", () => {
  test("proyecto + reject → untrusted, no se lanza", async () => {
    const u = ui("reject");
    const rt = await connect(stdioConf("proj", "legacy"), { proj: "project" }, u);
    expect(rt.servers[0].state).toBe("untrusted");
    expect(rt.tools).toHaveLength(0);
    expect(u.confirms.length).toBe(1);
  });

  test("proyecto + once → connected y se pregunta una vez", async () => {
    const u = ui("once");
    const rt = await connect(stdioConf("proj2", "legacy"), { proj2: "project" }, u);
    expect(rt.servers[0].state).toBe("connected");
    expect(u.confirms.length).toBe(1);
    const req = u.confirms[0] as { action: string; diff?: string };
    expect(req.action).toBe("mcp");
    expect(req.diff).toContain("proj2");
    expect(req.diff).not.toMatch(/FAKE_MCP_MODE=/); // valores de env NO se muestran
    await closeMcpClients(rt);
  });

  test("global no pregunta nunca", async () => {
    const u = ui("reject"); // rechazaría, pero global no debe preguntar
    const rt = await connect(stdioConf("glob", "legacy"), { glob: "global" }, u);
    expect(rt.servers[0].state).toBe("connected");
    expect(u.confirms.length).toBe(0);
    await closeMcpClients(rt);
  });
});

describe("connectMcpServers — HTTP (streamable)", () => {
  test("servidor stateless 2026-07-28: discover + tools/call con _meta y Mcp-Method", async () => {
    let sawStatelessHeaders = false;
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as { id?: number; method?: string; params?: Record<string, unknown> };
        const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
        if (body.method === "server/discover") {
          if (req.headers.get("mcp-method") === "server/discover" && (body.params?._meta as Record<string, unknown>)?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28") sawStatelessHeaders = true;
          return rpc({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, serverInfo: { name: "http-fake", version: "0.0.0" } });
        }
        if (body.method === "tools/list") return rpc({ tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] });
        if (body.method === "tools/call") {
          if (req.headers.get("mcp-method") !== "tools/call") return new Response("missing mcp-method", { status: 400 });
          return rpc({ content: [{ type: "text", text: "pong" }] });
        }
        if (body.method === "resources/list") return rpc({ resources: [] });
        return rpc({});
      },
    });
    try {
      const u = ui("once");
      const rt = await connect({ mcp: { servers: { web: { url: `http://127.0.0.1:${server.port}/mcp` } } } }, { web: "global" }, u);
      expect(rt.servers[0].state).toBe("connected");
      expect(rt.servers[0].protocol).toBe("2026-07-28");
      const ping = rt.tools.find((t) => t.name === "web_ping")!;
      const res = await ping.run({}, {} as never);
      expect(res.output).toBe("pong");
      expect(sawStatelessHeaders).toBe(true);
      await closeMcpClients(rt);
    } finally { server.stop(true); }
  });

  test("servidor legacy por HTTP: discover falla → fallback initialize", async () => {
    let initialized = false;
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as { id?: number; method?: string; params?: Record<string, unknown> };
        const rpc = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json", "mcp-session-id": "sesion-falsa" } });
        if (body.method === "server/discover") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } }), { headers: { "content-type": "application/json" } });
        }
        if (body.method === "initialize") { initialized = true; return rpc({ protocolVersion: body.params?.protocolVersion, capabilities: {}, serverInfo: { name: "legacy-http", version: "0.0.0" } }); }
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (body.method === "tools/list") return rpc({ tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] });
        if (body.method === "tools/call") return rpc({ content: [{ type: "text", text: "legacy-pong" }] });
        if (body.method === "resources/list") return rpc({ resources: [] });
        return rpc({});
      },
    });
    try {
      const u = ui("once");
      const rt = await connect({ mcp: { servers: { viejo: { type: "remote", url: `http://127.0.0.1:${server.port}/mcp` } } } }, { viejo: "global" }, u);
      expect(rt.servers[0].state).toBe("connected");
      expect(rt.servers[0].protocol).toBe("legacy");
      expect(initialized).toBe(true);
      const ping = rt.tools.find((t) => t.name === "viejo_ping")!;
      const res = await ping.run({}, {} as never);
      expect(res.output).toBe("legacy-pong");
      await closeMcpClients(rt);
    } finally { server.stop(true); }
  });

  test("respuesta SSE: el cliente lee hasta el id pedido", async () => {
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as { id?: number; method?: string };
        const sse = (result: unknown) => {
          const payload = `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`;
          // primera notificación intercalada, luego el resultado
          const noise = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\n`;
          return new Response(noise + payload, { headers: { "content-type": "text/event-stream" } });
        };
        if (body.method === "server/discover") return sse({ supportedVersions: ["2026-07-28"], capabilities: {}, serverInfo: { name: "sse-fake", version: "0.0.0" } });
        if (body.method === "tools/list") return sse({ tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] });
        if (body.method === "tools/call") return sse({ content: [{ type: "text", text: "sse-pong" }] });
        if (body.method === "resources/list") return sse({ resources: [] });
        return sse({});
      },
    });
    try {
      const u = ui("once");
      const rt = await connect({ mcp: { servers: { sse: { url: `http://127.0.0.1:${server.port}/mcp` } } } }, { sse: "global" }, u);
      expect(rt.servers[0].state).toBe("connected");
      const ping = rt.tools.find((t) => t.name === "sse_ping")!;
      const res = await ping.run({}, {} as never);
      expect(res.output).toBe("sse-pong");
      await closeMcpClients(rt);
    } finally { server.stop(true); }
  });
});

describe("MCP prompts — <server>:<prompt>", () => {
  test("prompts/list se expone en rt.prompts y prompts/get renderiza texto", async () => {
    const u = ui("once");
    const rt = await connect(stdioConf("prompter", "legacy"), { prompter: "global" }, u);
    expect(rt.servers[0].state).toBe("connected");
    expect(rt.prompts.map((p) => `${p.server}:${p.prompt.name}`)).toContain("prompter:review");
    const review = rt.prompts.find((p) => p.prompt.name === "review")!;
    expect(review.prompt.arguments?.[0]?.name).toBe("focus");
    const rendered = await rt.clients.get("prompter")!.getPrompt("review", { focus: "seguridad" });
    expect(rendered).toContain("seguridad");
    await closeMcpClients(rt);
  });
});
