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

  test("instructions: URL se omite con aviso", () => {
    const { warnings, block } = loadContextFiles(root, { instructions: ["https://example.com/spec.md"] });
    expect(warnings.some((x) => x.includes("URL"))).toBe(true);
    expect(block).not.toContain("example.com");
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
