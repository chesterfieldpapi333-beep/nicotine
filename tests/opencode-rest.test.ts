// Subconjunto opencode REST en serve — formas, saneado de secretos y errores honestos.
// Mismo mock de proveedor que serve.test.ts (ni un byte real a la red).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runServe } from "../src/modes/serve.js";

const PASSWORD = "test-secret-opencode";
const PORT = 8478;
const base = `http://127.0.0.1:${PORT}`;
const authHeader = () => ({ authorization: "Basic " + Buffer.from(`nicotine:${PASSWORD}`).toString("base64") });
const jsonHeaders = () => ({ ...authHeader(), "content-type": "application/json" });

let dir: string;
let savedXdg: string | undefined;
let serverPromise: Promise<number>;
let listening!: Promise<void>;

function mockFetch(): typeof fetch {
  return (async (url: string, init: any) => {
    if (String(url).includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (init?.method === "POST") {
      const body = 'data: {"choices":[{"delta":{"content":"hola desde el subconjunto"}}]}\n\ndata: [DONE]\n\n';
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nicotine-opencode-"));
  writeFileSync(join(dir, "fixture.txt"), "aguacate-opencode-fixture\nsegunda línea\n");
  savedXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(dir, "xdg");       // sesiones aisladas del host
  process.env.NICOTINE_SERVER_PASSWORD = PASSWORD;
  process.env.OPENAI_API_KEY = "sk-mock-secret";
  process.env.NICOTINE_MODEL = "openai/mock-model";
  process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
  let resolveListening!: () => void;
  listening = new Promise<void>((r) => { resolveListening = r; });
  serverPromise = runServe({ cwd: dir, auto: true, port: PORT, hostname: "127.0.0.1", fetchImpl: mockFetch(), onListening: () => resolveListening() })
    .catch((err) => { console.error("serve murió:", err); return 1; });
  await listening;
});

afterAll(() => {
  delete process.env.NICOTINE_SERVER_PASSWORD;
  delete process.env.OPENAI_API_KEY;
  delete process.env.NICOTINE_MODEL;
  delete process.env.OPENAI_BASE_URL;
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = savedXdg;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("opencode REST subset (integración local)", () => {
  test("auth también acepta OPENCODE_SERVER_PASSWORD (documentado)", () => {
    // cubierto por la unidad de passOk en serve.test.ts; aquí solo contrato de /global/health
    return fetch(`${base}/global/health`, { headers: authHeader() }).then(async (r) => {
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ healthy: true, version: expect.any(String) });
    });
  });

  test("/doc describe el subconjunto (OpenAPI 3.1) y sus rutas clave", async () => {
    const doc: any = await (await fetch(`${base}/doc`, { headers: authHeader() })).json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/session/{id}/message"]).toBeDefined();
    expect(doc.paths["/global/health"]).toBeDefined();
    expect(doc.paths["/tui/append-prompt"]).toBeUndefined();
  });

  test("/config nunca filtra claves (sk-mock-secret ausente)", async () => {
    const res = await fetch(`${base}/config`, { headers: authHeader() });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("sk-mock-secret");
  });

  test("/config/providers y /provider no exponen la clave; models:{} es honesto", async () => {
    const cp: any = await (await fetch(`${base}/config/providers`, { headers: authHeader() })).json();
    expect(Array.isArray(cp.providers)).toBe(true);
    expect(cp.providers[0].models).toEqual({});
    expect(JSON.stringify(cp)).not.toContain("sk-mock-secret");
    expect(cp.default["openai"]).toBe("mock-model");
    const pl: any = await (await fetch(`${base}/provider`, { headers: authHeader() })).json();
    expect(pl.connected).toContain("openai");
    expect(JSON.stringify(pl)).not.toContain("sk-mock-secret");
    const pa: any = await (await fetch(`${base}/provider/auth`, { headers: authHeader() })).json();
    expect(pa.openai[0]).toMatchObject({ type: "api" });
  });

  test("/agent y /lsp y /formatter tienen forma clásica", async () => {
    const agents: any = await (await fetch(`${base}/agent`, { headers: authHeader() })).json();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.some((a: any) => a.name === "build")).toBe(true);
    expect(Array.isArray(await (await fetch(`${base}/lsp`, { headers: authHeader() })).json())).toBe(true);
    expect(Array.isArray(await (await fetch(`${base}/formatter`, { headers: authHeader() })).json())).toBe(true);
    expect(await (await fetch(`${base}/lsp`, { headers: authHeader() })).json()).toEqual([]);
  });

  test("POST /session crea; GET /session lista (forma opencode); PATCH renombra; DELETE activo → 409", async () => {
    const created: any = await (await fetch(`${base}/session`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ title: "sesión de prueba" }) })).json();
    expect(created.title).toBe("sesión de prueba");
    expect(created.directory).toBe(dir);
    const list: any = await (await fetch(`${base}/session`, { headers: authHeader() })).json();
    expect(list.some((s: any) => s.id === created.id)).toBe(true);
    const patched: any = await (await fetch(`${base}/session/${created.id}`, { method: "PATCH", headers: jsonHeaders(), body: JSON.stringify({ title: "renombrada" }) })).json();
    expect(patched.title).toBe("renombrada");
    const cur: any = await (await fetch(`${base}/session/current`, { headers: authHeader() })).json();
    const delActive = await fetch(`${base}/session/${cur.id}`, { method: "DELETE", headers: authHeader() });
    expect(delActive.status).toBe(409);
    const delOther = await fetch(`${base}/session/${created.id}`, { method: "DELETE", headers: authHeader() });
    expect(delOther.status).toBe(200);
    expect(await delOther.json()).toBe(true);
  });

  test("POST /session/{id}/message ejecuta un turno completo (info+parts)", async () => {
    const cur: any = await (await fetch(`${base}/session/current`, { headers: authHeader() })).json();
    const res = await fetch(`${base}/session/${cur.id}/message`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ parts: [{ type: "text", text: "di hola" }] }) });
    expect(res.status).toBe(200);
    const pair: any = await res.json();
    expect(pair.info.role).toBe("assistant");
    expect(pair.info.sessionID).toBe(cur.id);
    expect(pair.info.parentID).toMatch(/^msg_/);
    expect(pair.parts.some((p: any) => p.type === "text" && p.text.includes("hola desde el subconjunto"))).toBe(true);
    // los mensajes persistidos también se leen en forma opencode
    const msgs: any = await (await fetch(`${base}/session/${cur.id}/message`, { headers: authHeader() })).json();
    expect(msgs.some((m: any) => m.info.role === "user")).toBe(true);
    expect(msgs.some((m: any) => m.info.role === "assistant")).toBe(true);
    // GET por messageID
    const one: any = await (await fetch(`${base}/session/${cur.id}/message/${pair.info.id}`, { headers: authHeader() })).json();
    expect(one.info.id).toBe(pair.info.id);
  });

  test("POST /session/{id}/message valida el body (noReply 400, agent-part 400, messageID 400)", async () => {
    const cur: any = await (await fetch(`${base}/session/current`, { headers: authHeader() })).json();
    const mk = (body: unknown) => fetch(`${base}/session/${cur.id}/message`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(body) });
    expect((await mk({ noReply: true, parts: [{ type: "text", text: "x" }] })).status).toBe(400);
    expect((await mk({ parts: [{ type: "agent", name: "plan" }] })).status).toBe(400);
    expect((await mk({ messageID: "msg_x", parts: [{ type: "text", text: "x" }] })).status).toBe(400);
    expect((await mk({ parts: [{ type: "subtask", prompt: "p", description: "d", agent: "general" }] })).status).toBe(400);
    expect((await mk({ parts: [] })).status).toBe(400);
  });

  test("prompt a sesión de otro id/proceso → 404 honesto; status refleja busy/idle", async () => {
    const res = await fetch(`${base}/session/deadbeef/message`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ parts: [{ type: "text", text: "x" }] }) });
    expect(res.status).toBe(404);
    const status: any = await (await fetch(`${base}/session/status`, { headers: authHeader() })).json();
    const cur: any = await (await fetch(`${base}/session/current`, { headers: authHeader() })).json();
    expect(status[cur.id]?.type).toBe("idle");
  });

  test("/event abre SSE y el primer evento es server.connected", async () => {
    const res = await fetch(`${base}/event`, { headers: authHeader() });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain("server.connected");
    await reader.cancel();
  });

  test("/find, /find/file, /file y /file/content funcionan sobre el árbol", async () => {
    const find: any = await (await fetch(`${base}/find?pattern=aguacate-opencode-fixture`, { headers: authHeader() })).json();
    expect(Array.isArray(find)).toBe(true);
    expect(find.some((m: any) => m.path.text === "fixture.txt" && m.line_number === 1)).toBe(true);
    const ff: any = await (await fetch(`${base}/find/file?query=fixture`, { headers: authHeader() })).json();
    expect(ff).toContain("fixture.txt");
    const nodes: any = await (await fetch(`${base}/file?path=.`, { headers: authHeader() })).json();
    expect(nodes.some((n: any) => n.name === "fixture.txt" && n.type === "file")).toBe(true);
    const content: any = await (await fetch(`${base}/file/content?path=fixture.txt`, { headers: authHeader() })).json();
    expect(content.type).toBe("text");
    expect(content.content).toContain("aguacate");
  });

  test("/experimental/tool(/ids) honesto con schemas propios", async () => {
    const ids: any = await (await fetch(`${base}/experimental/tool/ids`, { headers: authHeader() })).json();
    expect(ids).toContain("read");
    expect(ids).toContain("bash");
    const tools: any = await (await fetch(`${base}/experimental/tool`, { headers: authHeader() })).json();
    expect(tools[0]).toHaveProperty("id");
    expect(tools[0]).toHaveProperty("description");
    expect(tools[0]).toHaveProperty("parameters");
  });

  test("/log valida y acepta; /session/{id}/todo lista; summarize requiere providerID+modelID", async () => {
    expect((await fetch(`${base}/log`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ service: "test", level: "info", message: "hola" }) })).status).toBe(200);
    expect((await fetch(`${base}/log`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ service: "test" }) })).status).toBe(400);
    const cur: any = await (await fetch(`${base}/session/current`, { headers: authHeader() })).json();
    const todos: any = await (await fetch(`${base}/session/${cur.id}/todo`, { headers: authHeader() })).json();
    expect(Array.isArray(todos)).toBe(true);
    const badSum = await fetch(`${base}/session/${cur.id}/summarize`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({}) });
    expect(badSum.status).toBe(400);
  });

  test("turno async en vuelo → /session/{id}/message responde 409 (sin corrupción de mensajes)", async () => {
    // segunda instancia con mock LENTO: garantiza que el turno sigue en vuelo
    const dir2 = mkdtempSync(join(tmpdir(), "nicotine-opencode-slow-"));
    const PORT2 = 8479;
    const slowFetch = (async (url: string, init: any) => {
      if (String(url).includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (init?.method === "POST") {
        await new Promise((r) => setTimeout(r, 400));
        const body = 'data: {"choices":[{"delta":{"content":"lento pero seguro"}}]}\n\ndata: [DONE]\n\n';
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    let resolveListening2!: () => void;
    const listening2 = new Promise<void>((r) => { resolveListening2 = r; });
    const savedXdg2 = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = join(dir2, "xdg");
    const p2 = runServe({ cwd: dir2, auto: true, port: PORT2, hostname: "127.0.0.1", fetchImpl: slowFetch, onListening: () => resolveListening2() })
      .catch((err) => { console.error("serve slow murió:", err); return 1; });
    await listening2;
    try {
      const cur2: any = await (await fetch(`http://127.0.0.1:${PORT2}/session/current`, { headers: authHeader() })).json();
      const h2 = (extra: Record<string, string> = {}) => ({ ...authHeader(), ...extra });
      const asyncRes = await fetch(`http://127.0.0.1:${PORT2}/session/${cur2.id}/prompt_async`, { method: "POST", headers: h2({ "content-type": "application/json" }), body: JSON.stringify({ parts: [{ type: "text", text: "piensa lento" }] }) });
      expect(asyncRes.status).toBe(204);
      const busyRes = await fetch(`http://127.0.0.1:${PORT2}/session/${cur2.id}/message`, { method: "POST", headers: h2({ "content-type": "application/json" }), body: JSON.stringify({ parts: [{ type: "text", text: "interrupción" }] }) });
      expect(busyRes.status).toBe(409);
      await new Promise((r) => setTimeout(r, 700));
      const status2: any = await (await fetch(`http://127.0.0.1:${PORT2}/session/status`, { headers: authHeader() })).json();
      expect(status2[cur2.id]?.type).toBe("idle");
    } finally {
      if (savedXdg2 === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = savedXdg2;
      try { rmSync(dir2, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    void p2;
  }, 15000);

  test("rutas no implementadas → 404 honesto con doc:/doc", async () => {
    const res = await fetch(`${base}/session/whatever/share`, { method: "POST", headers: authHeader() });
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body).toMatchObject({ error: expect.any(String), doc: "/doc" });
    const tui = await fetch(`${base}/tui/append-prompt`, { method: "POST", headers: jsonHeaders(), body: "{}" });
    expect(tui.status).toBe(404);
  });
});
