import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCanonicalPath, isPathBlocked, hardPathCheck } from "../src/security/paths.js";
import { runAgentLoop } from "../src/core/loop.js";
import { PermissionEngine, baseRules } from "../src/core/permissions.js";
import { readTool } from "../src/tools/read.js";
import { bashTool } from "../src/tools/bash.js";
import type { ChatMessage, ToolContext, UiHooks } from "../src/core/types.js";

let tmp: string;
let work: string;
let savedHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nicotine-paths-"));
  work = join(tmp, "work");
  mkdirSync(work, { recursive: true });
  savedHome = process.env.HOME;
  process.env.HOME = tmp; // home «de juguete» con .ssh/.aws/.gnupg
  mkdirSync(join(tmp, ".ssh"));
  writeFileSync(join(tmp, ".ssh", "config"), "host x\n");
  mkdirSync(join(tmp, ".gitconfig")); // no es ruta .git; debe pasar
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

test("getCanonicalPath: archivo existente → realpath", () => {
  writeFileSync(join(work, "a.txt"), "hola");
  const res = getCanonicalPath("a.txt", work);
  expect(res.existed).toBe(true);
  expect(res.path).toBe(join(work, "a.txt"));
});

test("getCanonicalPath: archivo inexistente → padre real + cola (para crear)", () => {
  const res = getCanonicalPath(join("nuevo", "sub", "x.txt"), work);
  expect(res.existed).toBe(false);
  expect(res.path).toBe(join(work, "nuevo", "sub", "x.txt"));
});

test("getCanonicalPath: symlink a directorio externo se resuelve al destino real", () => {
  const outside = join(tmp, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secreto.txt"), "s");
  symlinkSync(outside, join(work, "link"), "dir");
  const res = getCanonicalPath(join("link", "secreto.txt"), work);
  expect(res.path).toBe(join(outside, "secreto.txt"));
});

test("getCanonicalPath: symlink colgante → unresolvableSymlink (fail-closed)", () => {
  symlinkSync(join(tmp, "no-existe"), join(work, "dangling"));
  const res = getCanonicalPath("dangling", work);
  expect(res.unresolvableSymlink).toBe(true);
});

test("isPathBlocked: ~/.ssh ~/.aws ~/.gnupg y cualquier .git; repo normal pasa", () => {
  const home = join(tmp, "home");
  expect(isPathBlocked(join(home, ".ssh", "config"), home)).toBe(true);
  expect(isPathBlocked(join(home, ".aws", "credentials"), home)).toBe(true);
  expect(isPathBlocked(join(home, ".gnupg", "secring.gpg"), home)).toBe(true);
  expect(isPathBlocked(join(work, ".git", "config"), home)).toBe(true);
  expect(isPathBlocked(join(work, ".git", "objects", "ab", "cd"), home)).toBe(true);
  expect(isPathBlocked(join(work, "src", "index.ts"), home)).toBe(false);
  // otra home ajena no hereda el bloqueo (el home se inyecta)
  expect(isPathBlocked(join(home, ".ssh", "config"), join(tmp, "otro"))).toBe(false);
});

test("hardPathCheck: ~/.ssh bloqueado aunque el usuario tenga allow para todo", () => {
  const chk = hardPathCheck(join(tmp, "home", ".ssh", "config"), work, join(tmp, "home"));
  expect(chk.blocked).toBe(true);
});

function mockProvider(call: { name: string; arguments: string }) {
  let calls = 0;
  return (async () => {
    calls++;
    const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    const delta = calls === 1
      ? { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: call }] } }] }
      : { choices: [{ delta: { content: "fin" } }] };
    return new Response(sse(delta) + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

const confirmOnce: UiHooks = { confirm: async () => "once", question: async () => null, info: () => {} };

test("bucle: read de ~/.ssh/config → bloqueo duro ANTES de tocar disco (con allow-all)", async () => {
  const ctx: ToolContext = {
    cwd: work, sessionId: "t", signal: new AbortController().signal,
    ui: confirmOnce, readFiles: new Set(), emit: () => {},
  };
  const messages: ChatMessage[] = [{ role: "user", content: "leé ~/.ssh/config" }];
  await runAgentLoop({
    provider: { baseURL: "http://mock/v1", apiKey: "k", model: "mock", headers: {}, engine: "fetch" },
    permissions: new PermissionEngine(baseRules()), // allow-all
    messages, tools: [readTool], ctx,
    fetchImpl: mockProvider({ name: "read", arguments: JSON.stringify({ path: "~/.ssh/config" }) }),
  });
  const toolMsg = messages.find((m) => m.role === "tool");
  expect(String(toolMsg?.content)).toContain("bloqueo duro");
});

test("bucle: bash destructivo fuerza ask aunque haya allow-all; 'reject' detiene", async () => {
  let confirmCalls = 0;
  const ui: UiHooks = {
    confirm: async () => { confirmCalls++; return "reject"; },
    question: async () => null, info: () => {},
  };
  const ctx: ToolContext = {
    cwd: work, sessionId: "t", signal: new AbortController().signal,
    ui, readFiles: new Set(), emit: () => {},
  };
  const messages: ChatMessage[] = [{ role: "user", content: "borrá todo" }];
  await runAgentLoop({
    provider: { baseURL: "http://mock/v1", apiKey: "k", model: "mock", headers: {}, engine: "fetch" },
    permissions: new PermissionEngine(baseRules()), // allow-all: NO debe bastar
    messages, tools: [bashTool], ctx,
    fetchImpl: mockProvider({ name: "bash", arguments: JSON.stringify({ command: "rm -rf /tmp/mission-seguro" }) }),
  });
  expect(confirmCalls).toBe(1); // preguntó pese al allow-all
  const toolMsg = messages.find((m) => m.role === "tool");
  expect(String(toolMsg?.content)).toContain("no aprobó");
});

test("bucle: bash destructivo con «always» se guarda como «once» — pregunta de nuevo", async () => {
  let confirmCalls = 0;
  const ui: UiHooks = {
    confirm: async () => { confirmCalls++; return "always"; },
    question: async () => null, info: () => {},
  };
  const target = join(tmp, "mission-chmod.txt");
  writeFileSync(target, "x");
  const ctx: ToolContext = {
    cwd: work, sessionId: "t", signal: new AbortController().signal,
    ui, readFiles: new Set(), emit: () => {},
  };
  const messages: ChatMessage[] = [{ role: "user", content: "chmod" }];
  const opts = {
    provider: { baseURL: "http://mock/v1", apiKey: "k", model: "mock", headers: {}, engine: "fetch" as const },
    permissions: new PermissionEngine(baseRules()),
    tools: [bashTool], // ctx se pasa por loop
  };
  const run = () => runAgentLoop({
    ...opts, messages: [{ role: "user", content: "chmod" }], ctx,
    fetchImpl: mockProvider({ name: "bash", arguments: JSON.stringify({ command: `chmod 644 ${target}` }) }),
  });
  await run();
  await run();
  expect(confirmCalls).toBe(2); // nunca se persiste el "always" de un destructivo
});
