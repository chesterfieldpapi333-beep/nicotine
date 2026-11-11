import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import { bashTool } from "../src/tools/bash.js";
import { htmlToText } from "../src/tools/webfetch.js";
import type { ToolContext, UiHooks } from "../src/core/types.js";

const ui: UiHooks = { confirm: async () => "once", question: async () => null, info: () => {} };
const ctxFor = (cwd: string): ToolContext => ({
  cwd, sessionId: "t", signal: new AbortController().signal, ui, readFiles: new Set(), emit: () => {},
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "nicotine-tools-"));
  mkdirSync(join(dir, "src", "sub"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const alpha = 1;\n");
  writeFileSync(join(dir, "src", "b.ts"), "export const beta = 2;\n");
  writeFileSync(join(dir, "src", "sub", "c.test.ts"), "import { alpha } from '../a.ts';\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.ts\n");
  writeFileSync(join(dir, "ignored.ts"), "const alpha = 'ignored';\n");
  return dir;
}

describe("glob", () => {
  test("encuentra por patrón y respeta .gitignore", async () => {
    const dir = fixture();
    const out = await globTool.run({ pattern: "src/**/*.ts" }, ctxFor(dir));
    expect(out.output).toContain("src/a.ts");
    expect(out.output).toContain("src/sub/c.test.ts");
    const all = await globTool.run({ pattern: "*.ts" }, ctxFor(dir));
    expect(all.output).not.toContain("ignored.ts");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("grep", () => {
  test("localiza patrón con línea y número", async () => {
    const dir = fixture();
    const out = await grepTool.run({ pattern: "alpha" }, ctxFor(dir));
    expect(out.output).toMatch(/a\.ts:1:/);
    expect(out.output).not.toContain("ignored.ts");
    rmSync(dir, { recursive: true, force: true });
  });
  test("literal y sin coincidencias", async () => {
    const dir = fixture();
    const out = await grepTool.run({ pattern: "alpha = ", literal: true }, ctxFor(dir));
    expect(out.output).toMatch(/a\.ts/);
    expect((await grepTool.run({ pattern: "zzzzqqqq" }, ctxFor(dir))).output).toContain("sin coincidencias");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("bash", () => {
  test("echo y exit code", async () => {
    const out = await bashTool.run({ command: "echo hola-nicotine && exit 3" }, ctxFor(process.cwd()));
    expect(out.output).toContain("hola-nicotine");
    expect(out.output).toContain("[exit 3]");
  });
  test("timeout mata el proceso", async () => {
    const out = await bashTool.run({ command: "sleep 5", timeout: 300 }, ctxFor(process.cwd()));
    expect(out.output).toContain("timeout");
  }, 5000);
});

describe("webfetch htmlToText", () => {
  test("título, enlace, lista", () => {
    const md = htmlToText(`<html><head><style>x{}</style><script>y()</script></head><body><h1>Title</h1><ul><li>one</li><li>two</li></ul><a href="https://x.dev">link</a></body></html>`, true);
    expect(md).toContain("# Title");
    expect(md).toContain("- one");
    expect(md).toContain("- two");
    expect(md).toContain("[link](https://x.dev)");
    expect(md).not.toContain("script");
  });
});
