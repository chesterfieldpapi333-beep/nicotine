// vireo serve — auth, endpoints y turno SSE contra un mock de proveedor (ni un byte real).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runServe } from "../src/modes/serve.js";

const PASSWORD = "test-secret-123";
let dir: string;
const port = 8476;
let serverPromise: Promise<number>;
let listening!: Promise<void>;

// mock fetch SSE: responde "hola desde serve" como stream
function mockFetch(): typeof fetch {
  return (async (url: string, init: any) => {
    if (String(url).includes("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (init?.method === "POST") {
      const body = 'data: {"choices":[{"delta":{"content":"hola desde serve"}}]}\n\ndata: [DONE]\n\n';
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function authHeader(): Record<string, string> {
  return { authorization: "Basic " + Buffer.from(`vireo:${PASSWORD}`).toString("base64") };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vireo-serve-"));
  process.env.VIREO_SERVER_PASSWORD = PASSWORD;
  process.env.OPENAI_API_KEY = "sk-mock";
  process.env.VIREO_MODEL = "openai/mock-model";
  const cdir = dir;
  let resolveListening!: () => void;
  listening = new Promise<void>((r) => { resolveListening = r; });
  serverPromise = runServe({ cwd: cdir, auto: true, port, hostname: "127.0.0.1", fetchImpl: mockFetch(), onListening: () => resolveListening() })
    .catch((err) => { console.error("serve murió:", err); return 1; });
  await listening;
});

afterAll(() => {
  delete process.env.VIREO_SERVER_PASSWORD;
  delete process.env.OPENAI_API_KEY;
  delete process.env.VIREO_MODEL;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("vireo serve (integración local)", () => {
  test("sin VIREO_SERVER_PASSWORD → no arranca (código 2)", async () => {
    const saved = process.env.VIREO_SERVER_PASSWORD;
    delete process.env.VIREO_SERVER_PASSWORD;
    const code = await runServe({ cwd: dir, auto: false, port: 0, hostname: "127.0.0.1" });
    expect(code).toBe(2);
    process.env.VIREO_SERVER_PASSWORD = saved;
  });

  test("auth requerida: sin header → 401; con header → 200", async () => {
    const r401 = await fetch(`http://127.0.0.1:${port}/health`);
    expect(r401.status).toBe(401);
    const r200 = await fetch(`http://127.0.0.1:${port}/health`, { headers: authHeader() });
    expect(r200.status).toBe(200);
    expect(await r200.json()).toMatchObject({ ok: true });
  });

  test("GET /session devuelve forma opencode (Array<Session>); GET /session/current devuelve la del proceso", async () => {
    const arr: any = await (await fetch(`http://127.0.0.1:${port}/session`, { headers: authHeader() })).json();
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBeGreaterThanOrEqual(1);
    expect(typeof arr[0].id).toBe("string");
    expect(typeof arr[0].projectID).toBe("string");
    expect(typeof arr[0].directory).toBe("string");
    expect(typeof arr[0].version).toBe("string");
    expect(typeof arr[0].time?.created).toBe("number");
    const cur: any = await (await fetch(`http://127.0.0.1:${port}/session/current`, { headers: authHeader() })).json();
    expect(typeof cur.id).toBe("string");
    expect(typeof cur.title).toBe("string");
    const all: any = await (await fetch(`http://127.0.0.1:${port}/sessions`, { headers: authHeader() })).json();
    expect(Array.isArray(all)).toBe(true);
  });

  test("POST /session/prompt → SSE con text_delta y stream_end", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/session/prompt`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ prompt: "di hola" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("text_delta");
    expect(text).toContain("hola desde serve");
    expect(text).toContain("stream_end");
  });

  test("POST /session/prompt sin prompt → 400; body inválido → 400", async () => {
    const r1 = await fetch(`http://127.0.0.1:${port}/session/prompt`, { method: "POST", headers: { ...authHeader(), "content-type": "application/json" }, body: JSON.stringify({}) });
    expect(r1.status).toBe(400);
    const r2 = await fetch(`http://127.0.0.1:${port}/session/prompt`, { method: "POST", headers: { ...authHeader(), "content-type": "application/json" }, body: "{nope" });
    expect(r2.status).toBe(400);
  });

  test("GET /session/export devuelve Markdown sin escribir archivos", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/session/export`, { headers: authHeader() });
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toContain("# Sesión vireo");
  });

  test("POST /session/abort responde ok (sin turno en curso)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/session/abort`, { method: "POST", headers: authHeader() });
    expect(res.status).toBe(200);
  });
});
