import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "../src/core/loop.js";
import { PermissionEngine, baseRules } from "../src/core/permissions.js";
import { bashTool } from "../src/tools/bash.js";
import { auditPath } from "../src/core/audit.js";
import type { ChatMessage, ToolContext, UiHooks } from "../src/core/types.js";

let tmp: string;
let saved: Record<string, string | undefined>;
const KEYS = ["HOME", "XDG_DATA_HOME", "NICOTINE_AUDIT", "NICOTINE_AUDIT_MAX_BYTES"];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nicotine-audit-"));
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.HOME = tmp;
  process.env.XDG_DATA_HOME = join(tmp, "data");
  process.env.NICOTINE_AUDIT = "1";
  delete process.env.NICOTINE_AUDIT_MAX_BYTES;
});
afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function mockFetch(command: string): typeof fetch {
  let calls = 0;
  return (async () => {
    calls++;
    const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    const delta = calls === 1
      ? { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] } }] }
      : { choices: [{ delta: { content: "listo" } }] };
    return new Response(sse(delta) + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

const ui: UiHooks = { confirm: async () => "once", question: async () => null, info: () => {} };

async function runWith(command: string) {
  const ctx: ToolContext = {
    cwd: tmp, sessionId: "test-session", signal: new AbortController().signal,
    ui, readFiles: new Set(), emit: () => {},
  };
  const messages: ChatMessage[] = [{ role: "user", content: "hola" }];
  await runAgentLoop({
    provider: { baseURL: "http://mock/v1", apiKey: "k", model: "mock", headers: {}, engine: "fetch" as const },
    permissions: new PermissionEngine(baseRules()),
    messages, tools: [bashTool], ctx, fetchImpl: mockFetch(command),
  });
}

test("con NICOTINE_AUDIT=1: JSONL con tool/action/decisión, sin secretos del recurso", async () => {
  const secret = "sk-proj-auditsecret1234567890abcd";
  await runWith(`echo ${secret}`);
  const path = auditPath();
  expect(existsSync(path)).toBe(true);
  const raw = readFileSync(path, "utf8");
  expect(raw).not.toContain(secret);
  const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
  const rec = lines.find((l) => l.tool === "bash");
  expect(rec).toBeDefined();
  expect(rec.action).toBe("bash");
  expect(rec.decision).toBe("allow");
  expect(rec.session).toBe("test-session");
  expect(typeof rec.durationMs).toBe("number");
});

test("deny queda auditado como deny", async () => {
  const ctx: ToolContext = {
    cwd: tmp, sessionId: "deny-session", signal: new AbortController().signal,
    ui, readFiles: new Set(), emit: () => {},
  };
  const messages: ChatMessage[] = [{ role: "user", content: "hola" }];
  await runAgentLoop({
    provider: { baseURL: "http://mock/v1", apiKey: "k", model: "mock", headers: {}, engine: "fetch" as const },
    permissions: new PermissionEngine([...baseRules(), { action: "bash", resource: "*", effect: "deny" }]),
    messages, tools: [bashTool], ctx, fetchImpl: mockFetch("echo hola"),
  });
  const raw = readFileSync(auditPath(), "utf8");
  expect(raw).toContain('"decision":"deny"');
});

test("rotación de una generación al superar NICOTINE_AUDIT_MAX_BYTES", async () => {
  process.env.NICOTINE_AUDIT_MAX_BYTES = "1024";
  for (let i = 0; i < 30; i++) await runWith("echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  expect(existsSync(auditPath() + ".1")).toBe(true);
});

test("sin NICOTINE_AUDIT: no escribe nada", async () => {
  delete process.env.NICOTINE_AUDIT;
  await runWith("echo hola");
  expect(existsSync(auditPath())).toBe(false);
});
