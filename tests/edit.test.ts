import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool, applyEdit } from "../src/tools/edit.js";
import { EventBus } from "../src/core/events.js";
import type { ToolContext, UiHooks } from "../src/core/types.js";

const ui: UiHooks = {
  confirm: async () => "once",
  question: async () => null,
  info: () => {},
};

function ctxFor(cwd: string, read: string[] = []): ToolContext {
  const readFiles = new Set(read);
  return { cwd, sessionId: "test", signal: new AbortController().signal, ui, readFiles, emit: () => {} };
}

describe("applyEdit — escalera de estrategias", () => {
  test("1) exacta", () => {
    const { after, strategy } = applyEdit("a\nb\nc\n", "b", "B", false);
    expect(after).toBe("a\nB\nc\n");
    expect(strategy).toBe("exacta");
  });
  test("1) exacta múltiple sin replaceAll → error", () => {
    expect(() => applyEdit("x\nx\n", "x", "y", false)).toThrow(/2 veces/);
    expect(applyEdit("x\nx\n", "x", "y", true).after).toBe("y\ny\n");
  });
  test("2) ignora espacios finales de línea", () => {
    const { after, strategy } = applyEdit("const a = 1;   \nconst b = 2;\n", "const a = 1;\nconst b = 2;", "const a = 3;\nconst b = 2;", false);
    expect(after).toContain("const a = 3;");
    expect(strategy).toBe("trimEnd por línea");
  });
  test("3) ignora indentación y re-indenta newString", () => {
    const before = "function f() {\n    if (x) {\n        doA();\n    }\n}\n";
    const { after, strategy } = applyEdit(before, "if (x) {\n    doA();\n}", "if (y) {\n    doB();\n}", false);
    expect(after).toBe("function f() {\n    if (y) {\n        doB();\n    }\n}\n");
    expect(strategy).toBe("trim + re-indent");
  });
  test("no encontrado → error accionable", () => {
    expect(() => applyEdit("a\nb\n", "zzz", "y", false)).toThrow(/no encontrado/);
  });
});

describe("tool edit — contrato", () => {
  test("exige lectura previa", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nicotine-edit-"));
    const file = join(dir, "f.ts");
    writeFileSync(file, "let a = 1;\n");
    await expect(editTool.run({ path: file, oldString: "1", newString: "2" }, ctxFor(dir))).rejects.toThrow(/lectura previa/);
    const out = await editTool.run({ path: file, oldString: "let a = 1;", newString: "let a = 2;" }, ctxFor(dir, [file]));
    expect(out.output).toContain("edit OK");
    expect(readFileSync(file, "utf8")).toBe("let a = 2;\n");
    rmSync(dir, { recursive: true, force: true });
  });
  test("rechaza oldString === newString", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nicotine-edit-"));
    const file = join(dir, "f.ts");
    writeFileSync(file, "x\n");
    await expect(editTool.run({ path: file, oldString: "x", newString: "x" }, ctxFor(dir, [file]))).rejects.toThrow(/idénticos/);
    rmSync(dir, { recursive: true, force: true });
  });
  test("preview genera diff sin escribir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nicotine-edit-"));
    const file = join(dir, "f.ts");
    writeFileSync(file, "const a = 1;\n");
    const { diff } = await editTool.preview!({ path: file, oldString: "const a = 1;", newString: "const a = 2;" }, ctxFor(dir, [file]));
    expect(diff).toContain("-const a = 1;");
    expect(diff).toContain("+const a = 2;");
    expect(readFileSync(file, "utf8")).toBe("const a = 1;\n");
    rmSync(dir, { recursive: true, force: true });
  });
});
