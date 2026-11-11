import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatchTool, parsePatch } from "../src/tools/apply_patch.js";
import type { ToolContext, UiHooks } from "../src/core/types.js";

const ui: UiHooks = { confirm: async () => "once", question: async () => null, info: () => {} };
const ctxFor = (cwd: string, read: string[] = []): ToolContext => ({
  cwd, sessionId: "t", signal: new AbortController().signal, ui, readFiles: new Set(read), emit: () => {},
});

describe("apply_patch", () => {
  test("parsePatch extrae rutas en orden", () => {
    const { paths } = parsePatch("*** Add File: a\n+x\n*** Update File: b\n*** Move To: c\n*** Delete File: d\n");
    expect(paths).toEqual(["a", "b", "c", "d"]);
  });
  test("add + delete + update (con rename) en un patch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nicotine-patch-"));
    writeFileSync(join(dir, "keep.ts"), "const x = 1;\nsecond line\n");
    const patch = [
      "*** Add File: nuevo.ts",
      "+export const nuevo = true;",
      "*** Delete File: borrar.ts",
      "*** Update File: keep.ts",
      "-const x = 1;",
      "+const x = 42;",
    ].join("\n");
    writeFileSync(join(dir, "borrar.ts"), "bye\n");
    const ctx = ctxFor(dir, [join(dir, "keep.ts"), join(dir, "borrar.ts")]);
    const out = await applyPatchTool.run({ patchText: patch }, ctx);
    expect(out.output).toContain("apply_patch OK");
    expect(readFileSync(join(dir, "nuevo.ts"), "utf8")).toBe("export const nuevo = true;\n");
    expect(existsSync(join(dir, "borrar.ts"))).toBe(false);
    expect(readFileSync(join(dir, "keep.ts"), "utf8")).toContain("const x = 42;");
    rmSync(dir, { recursive: true, force: true });
  });
  test("update sin lectura previa falla", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nicotine-patch-"));
    writeFileSync(join(dir, "f.ts"), "a\n");
    const ctx = ctxFor(dir, []); // sin read
    await expect(applyPatchTool.run({ patchText: "*** Update File: f.ts\n-a\n+b\n" }, ctx)).rejects.toThrow(/lectura previa/);
    rmSync(dir, { recursive: true, force: true });
  });
  test("hunk no localizado → error que muestra el bloque buscado", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nicotine-patch-"));
    writeFileSync(join(dir, "f.ts"), "alpha\nbeta\n");
    const ctx = ctxFor(dir, [join(dir, "f.ts")]);
    await expect(applyPatchTool.run({ patchText: "*** Update File: f.ts\n-zzz\n+yyy\n" }, ctx)).rejects.toThrow(/no se localizó el hunk/);
    rmSync(dir, { recursive: true, force: true });
  });
  test("permissionResources cubre todos los archivos del patch", () => {
    const res = applyPatchTool.permissionResources!({ patchText: "*** Add File: a.ts\n+x\n*** Update File: b.ts\n*** Move To: c.ts\n" });
    expect(res).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});
