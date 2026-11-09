// Archivos de contexto: AGENTS.md / CLAUDE.md / GEMINI.md (raíz→cwd),
// AGENTS.override.md por directorio, `instructions` por path/glob, truncado 32 KiB.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContextFiles, MAX_FILE_BYTES } from "../src/compat/context-files.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "vireo-ctx-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const w = (rel: string, content: string) => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  return p;
};

describe("loadContextFiles", () => {
  test("raíz→cwd, en orden; CLAUDE.md y GEMINI.md incluidos", () => {
    w("AGENTS.md", "reglas-raiz\n");
    const sub = join(root, "proj");
    mkdirSync(join(sub, "deep"), { recursive: true });
    w("proj/AGENTS.md", "reglas-proyecto\n");
    w("proj/deep/CLAUDE.md", "claude-reglas\n");
    w("proj/deep/GEMINI.md", "gemini-reglas\n");
    const cwd = join(root, "proj", "deep");
    const { files, block, warnings } = loadContextFiles(cwd, {});
    expect(warnings).toEqual([]);
    expect(files.map((f) => f.kind)).toEqual(["agents", "agents", "claude", "gemini"]);
    const iRoot = block.indexOf("reglas-raiz");
    const iProj = block.indexOf("reglas-proyecto");
    expect(iRoot).toBeGreaterThanOrEqual(0);
    expect(iProj).toBeGreaterThan(iRoot);
    expect(block).toContain("claude-reglas");
    expect(block).toContain("gemini-reglas");
    expect(block).toContain("# Contexto del proyecto");
  });

  test("AGENTS.override.md gana a AGENTS.md dentro del MISMO directorio", () => {
    w("AGENTS.md", "no-debe-aparecer\n");
    w("AGENTS.override.md", "override-gana\n");
    const { block, files } = loadContextFiles(root, {});
    expect(block).toContain("override-gana");
    expect(block).not.toContain("no-debe-aparecer");
    expect(files).toHaveLength(1);
    expect(files[0].kind).toBe("agents-override");
  });

  test("override en directorio hijo no afecta al padre", () => {
    w("AGENTS.md", "raiz-visible\n");
    const sub = join(root, "s");
    mkdirSync(sub, { recursive: true });
    w("s/AGENTS.override.md", "solo-hijo\n");
    const { block } = loadContextFiles(sub, {});
    expect(block).toContain("raiz-visible");
    expect(block).toContain("solo-hijo");
  });

  test("sin archivos: block vacío", () => {
    const deep = join(root, "nada", "aqui");
    mkdirSync(deep, { recursive: true });
    const { block, files } = loadContextFiles(deep, {});
    expect(files).toEqual([]);
    expect(block).toBe("");
  });

  test("instructions: path directo, glob y archivo ausente (aviso, no error)", () => {
    w("docs/guia.md", "instrucciones-path\n");
    w("docs/extra-1.md", "glob-1\n");
    w("docs/extra-2.md", "glob-2\n");
    const { block, files, warnings } = loadContextFiles(root, { instructions: ["docs/guia.md", "docs/*.md", "docs/no-existe.md"] });
    expect(block).toContain("instrucciones-path");
    expect(block).toContain("glob-1");
    expect(block).toContain("glob-2");
    expect(warnings.some((x) => x.includes("docs/no-existe.md"))).toBe(true);
    // guia.md entra por path y por glob → duplicado posible; al menos 3 entradas instructions
    expect(files.filter((f) => f.kind === "instructions").length).toBeGreaterThanOrEqual(3);
  });

  test("instructions: URL se recoge para prepareUrlContext (no se descarga en el arranque)", () => {
    const { warnings, block, urls } = loadContextFiles(root, { instructions: ["https://example.com/spec.md"] });
    expect(urls).toEqual(["https://example.com/spec.md"]);
    expect(block).not.toContain("example.com");
    expect(warnings.some((x) => x.includes("URL"))).toBe(false);
  });

  test("fetchInstructionUrls: descarga, inyecta y respeta timeout/topes", async () => {
    const { fetchInstructionUrls } = await import("../src/compat/context-files.js");
    const mk = (body: string, init: { status?: number; type?: string } = {}) =>
      new Response(body, { status: init.status ?? 200, headers: { "content-type": init.type ?? "text/plain; charset=utf-8" } });
    // éxito
    const ok = await fetchInstructionUrls(["https://a.example/spec.md"], { fetchImpl: (async () => mk("# reglas remotas")) as unknown as typeof fetch });
    expect(ok.blocks).toHaveLength(1);
    expect(ok.blocks[0]).toContain("instrucciones remotas|reglas remotas".split("|")[1]);
    expect(ok.warnings).toHaveLength(0);
    // HTTP error → aviso y omisión
    const bad = await fetchInstructionUrls(["https://a.example/missing.md"], { fetchImpl: (async () => mk("nope", { status: 404 })) as unknown as typeof fetch });
    expect(bad.blocks).toHaveLength(0);
    expect(bad.warnings[0]).toContain("404");
    // content-type no textual → omitida
    const bin = await fetchInstructionUrls(["https://a.example/bin.png"], { fetchImpl: (async () => mk("PNGDATA", { type: "image/png" })) as unknown as typeof fetch });
    expect(bin.blocks).toHaveLength(0);
    expect(bin.warnings[0]).toContain("content-type");
    // fetch que lanza (red caída) → aviso, jamás lanza
    const down = await fetchInstructionUrls(["https://a.example/x.md"], { fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
    expect(down.blocks).toHaveLength(0);
    expect(down.warnings[0]).toContain("ECONNREFUSED");
    // timeout (AbortError) → aviso con "timeout"
    const slow = await fetchInstructionUrls(["https://a.example/slow.md"], { timeoutMs: 20, fetchImpl: ((_url: unknown, init: unknown) => new Promise<Response>((_res, reject) => {
      const signal = (init as RequestInit).signal;
      signal?.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
    })) as unknown as typeof fetch });
    expect(slow.blocks).toHaveLength(0);
    expect(slow.warnings[0]).toContain("timeout");
    // tope 32 KiB
    const big = "x".repeat(40 * 1024);
    const capped = await fetchInstructionUrls(["https://a.example/big.md"], { fetchImpl: (async () => mk(big)) as unknown as typeof fetch });
    expect(capped.blocks[0]).toContain("TRUNCADA");
    expect(capped.blocks[0].length).toBeLessThan(34 * 1024);
  });

  test("prepareUrlContext: inyecta bloques en el system prompt (una vez)", async () => {
    const { buildRuntime, prepareUrlContext, closeMcp } = await import("../src/modes/common.js");
    const cwd = root;
    writeFileSync(join(cwd, "opencode.json"), JSON.stringify({ model: "openai/mock-model", provider: { baseURL: "http://127.0.0.1:9/v1", apiKey: "test-key" } }));
    const rt = buildRuntime({ cwd, auto: false, attachUi: false, modelFlag: "mock-model", fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch });
    rt.contextFiles.urls = ["https://a.example/remote-rules.md"];
    rt.fetchImpl = (async () => new Response("# reglas_remotas_marcador", { status: 200, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    await prepareUrlContext(rt);
    expect(rt.messages[0].content).toContain("reglas_remotas_marcador");
    expect(rt.messages[0].content).toContain("Instrucciones remotas");
    // segunda llamada es no-op (urls vaciada)
    const before = rt.messages[0].content;
    await prepareUrlContext(rt);
    expect(rt.messages[0].content).toBe(before);
    await closeMcp(rt);
  });

  test("instrucciones no-array → aviso y se ignora", () => {
    const { warnings } = loadContextFiles(root, { instructions: "no-soy-array" });
    expect(warnings.some((x) => x.includes("array"))).toBe(true);
  });

  test("archivo > 32 KiB se trunca con nota", () => {
    w("AGENTS.md", "x".repeat(MAX_FILE_BYTES + 100));
    const { block, files } = loadContextFiles(root, {});
    expect(files[0].truncated).toBe(true);
    expect(block).toContain("TRUNCADA");
  });
});
