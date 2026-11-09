import { describe, test, expect } from "bun:test";
import { parseToml } from "../src/compat/toml-lite.js";

describe("toml-lite", () => {
  test("tablas dotted, strings, arrays, enteros, bools", () => {
    const r = parseToml(`
# comentario
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
startup_timeout_sec = 45
enabled = true
tags = ["a", "b"]
`)!;
    expect(r.error).toBeUndefined();
    const t = (r.value as Record<string, any>).mcp_servers.context7;
    expect(t.command).toBe("npx");
    expect(t.args).toEqual(["-y", "@upstash/context7-mcp"]);
    expect(t.startup_timeout_sec).toBe(45);
    expect(t.enabled).toBe(true);
  });

  test("inline table env + literal string + comillas escapadas", () => {
    const r = parseToml('[s]\nenv = { API_KEY = "x\\"1", MODE = \'lit\' }\ncmd = "a \\"quoted\\" b"\n');
    expect(r.error).toBeUndefined();
    const t = (r.value as Record<string, any>).s;
    expect(t.env).toEqual({ API_KEY: 'x"1', MODE: "lit" });
    expect(t.cmd).toBe('a "quoted" b');
  });

  test("comentario dentro de string no corta la línea", () => {
    const r = parseToml('[s]\ncmd = "echo # no-es-comentario" # comentario real\n');
    expect(r.error).toBeUndefined();
    expect((r.value as Record<string, any>).s.cmd).toBe("echo # no-es-comentario");
  });

  test("errores con número de línea", () => {
    expect(parseToml('a = "sin cerrar\n').error).toContain("línea 1");
    expect(parseToml("[s]\na = b c\n").error).toContain("línea 2");
    expect(parseToml("[s]\nn = 1\nn = 2\n").error).toContain("duplicada");
    expect(parseToml("[s\n]\n").error).toBeDefined();
  });

  test("tabla pisa valor escalar → error", () => {
    const r = parseToml('a = 1\n[a.b]\nc = 2\n');
    expect(r.error).toContain("pisa un valor");
  });
});
