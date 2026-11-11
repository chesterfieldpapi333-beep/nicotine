// Cliente LSP (diagnostics de un archivo) contra un servidor SIMULADO local.
import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { lspServersFromConfig, diagnosticsFor, findRoot, languageIdFor } from "../src/compat/lsp.js";
import { makeLspTool } from "../src/tools/lsp.js";

const FIXTURE = join(import.meta.dir, "fixtures", "mock-lsp.mjs");
const def = { name: "mock", command: [process.execPath, FIXTURE], extensions: [".ts"], rootMarkers: ["tsconfig.json"] };

describe("lspServersFromConfig", () => {
  test("config válida → defs; rota inválida → avisos; sin lsp → vacío", () => {
    expect(lspServersFromConfig({}).defs).toHaveLength(0);
    expect(lspServersFromConfig({ lsp: [] }).warnings.length).toBe(1);
    const bad = lspServersFromConfig({ lsp: { malo: { extensions: [".ts"] } } });
    expect(bad.defs).toHaveLength(0);
    expect(bad.warnings[0]).toContain("malo");
    const good = lspServersFromConfig({ lsp: { ts: { command: "typescript-language-server", args: ["--stdio"], extensions: ["ts", ".TSX"] } } });
    expect(good.defs[0].command).toEqual(["typescript-language-server", "--stdio"]);
    expect(good.defs[0].extensions).toEqual([".ts", ".tsx"]);
  });
});

describe("languageIdFor / findRoot", () => {
  test("mapea extensiones conocidas y cae a plaintext", () => {
    expect(languageIdFor("a.ts")).toBe("typescript");
    expect(languageIdFor("a.PY")).toBe("python");
    expect(languageIdFor("a.xyz")).toBe("plaintext");
  });
  test("findRoot localiza rootMarker hacia arriba", () => {
    const dir = mkdtempSync(join(tmpdir(), "nicotine-lsp-root-"));
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    const { mkdirSync } = require("node:fs");
    const sub = join(dir, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(findRoot({ name: "m", command: ["x"], extensions: [".ts"], rootMarkers: ["tsconfig.json"] }, sub)).toBe(dir);
  });
});

describe("diagnosticsFor contra mock-lsp", () => {
  test("initialize → didOpen → publica diagnósticos; el cliente los normaliza", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nicotine-lsp-"));
    const file = join(dir, "sample.ts");
    writeFileSync(file, "const x: number = 'nope';\nconst y = 1;\n", "utf8");
    const res = await diagnosticsFor(def, file, dir, 5000);
    expect(res.server).toBe("mock");
    expect(res.diagnostics).toHaveLength(2);
    expect(res.diagnostics[0]).toMatchObject({ line: 1, character: 3, severity: "error", code: "T0001" });
    expect(res.diagnostics[1].severity).toBe("warning");
  });

  test("la tool formatea la salida con file:line:col", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nicotine-lsp-tool-"));
    const file = join(dir, "sample.ts");
    writeFileSync(file, "const x = 1;\n", "utf8");
    const tool = makeLspTool([def]);
    const ctx = { cwd: dir, sessionId: "t", signal: new AbortController().signal, ui: { confirm: async () => "once" as const, question: async () => null, info: () => {} }, readFiles: new Set<string>(), emit: () => {}, isSubagent: false } as any;
    const out = await tool.run({ action: "diagnostics", path: "sample.ts", timeoutMs: 5000 }, ctx);
    expect(out.output).toContain("sample.ts:1:3");
    expect(out.output).toContain("[error]");
    expect(out.output).toContain("T0001");
  });
});
