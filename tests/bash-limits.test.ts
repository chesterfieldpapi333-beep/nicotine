import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool } from "../src/tools/bash.js";
import type { ToolContext } from "../src/core/types.js";

let tmp: string;
let saved: Record<string, string | undefined>;
const KEYS = ["HOME", "XDG_DATA_HOME", "NICOTINE_MAX_TOOL_OUTPUT_BYTES", "NICOTINE_BASH_ENV_ALLOW", "ALLOWED_VAR", "SECRET_VAR"];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nicotine-bash-"));
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.HOME = tmp;
  process.env.XDG_DATA_HOME = join(tmp, "data");
  delete process.env.NICOTINE_MAX_TOOL_OUTPUT_BYTES;
  delete process.env.NICOTINE_BASH_ENV_ALLOW;
  process.env.ALLOWED_VAR = "ok";
  process.env.SECRET_VAR = "leak";
});
afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return {
    cwd: tmp, sessionId: "test", signal: new AbortController().signal,
    ui: { confirm: async () => "once", question: async () => null, info: () => {} },
    readFiles: new Set(), emit: () => {},
  };
}

test("NICOTINE_MAX_TOOL_OUTPUT_BYTES trunca la cola y deja log 0600", async () => {
  process.env.NICOTINE_MAX_TOOL_OUTPUT_BYTES = "1024";
  const res = await bashTool.run({ command: "seq 1 10000" }, ctx());
  const m = res.output.match(/\[salida completa: ([^\]]+)\]/);
  expect(m).not.toBeNull();
  expect(statSync(m![1]).mode & 0o777).toBe(0o600);
  expect(res.output.length).toBeLessThan(2048);
  expect(res.output).toContain("10000"); // cola, no cabeza
  expect(res.output).not.toContain("\n1\n2\n3");
});

test("tools.bash.envAllow limpia el entorno del hijo (solo allowlist + básicos)", async () => {
  writeFileSync(join(tmp, "opencode.json"), JSON.stringify({ tools: { bash: { envAllow: ["ALLOWED_VAR"] } } }));
  const res = await bashTool.run({ command: 'echo "A=$ALLOWED_VAR"; echo "S=${SECRET_VAR:-ausente}"; echo "H=${HOME:-ausente}"' }, ctx());
  expect(res.output).toContain("A=ok");
  expect(res.output).toContain("S=ausente");
  expect(res.output).toContain(`H=${tmp}`); // HOME básico siempre presente
});

test("NICOTINE_BASH_ENV_ALLOW también funciona (coma-separada)", async () => {
  process.env.NICOTINE_BASH_ENV_ALLOW = "ALLOWED_VAR";
  const res = await bashTool.run({ command: 'echo "A=$ALLOWED_VAR"; echo "S=${SECRET_VAR:-ausente}"' }, ctx());
  expect(res.output).toContain("A=ok");
  expect(res.output).toContain("S=ausente");
});

test("sin envAllow: entorno heredado (comportamiento clásico)", async () => {
  const res = await bashTool.run({ command: 'echo "S=$SECRET_VAR"' }, ctx());
  expect(res.output).toContain("S=leak");
});
