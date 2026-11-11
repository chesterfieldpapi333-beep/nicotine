import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntime } from "../src/modes/common.js";
import { buildPolicyExport, explainDecision, readPolicyFile, policyFilePath, POLICY_VERSION } from "../src/core/policy.js";
import { runPolicy } from "../src/modes/policy.js";
import { loadConfig } from "../src/core/config.js";

let tmp: string;
let work: string;
let savedEnv: Record<string, string | undefined>;
const ENV_KEYS = ["HOME", "XDG_DATA_HOME", "NICOTINE_MODEL", "OPENAI_API_KEY"];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nicotine-pol-"));
  work = join(tmp, "work");
  mkdirSync(work, { recursive: true });
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HOME = tmp;
  process.env.XDG_DATA_HOME = join(tmp, "data");
  process.env.NICOTINE_MODEL = "openai/gpt-4o-mini";
  process.env.OPENAI_API_KEY = "sk-test-mock-not-a-real-key";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

test("--readonly: edit/bash/vault-write denegados; read/list/grep no", () => {
  const rt = buildRuntime({ cwd: work, auto: false, readonly: true });
  expect(rt.permissions.check("edit", "src/x.ts").effect).toBe("deny");
  expect(rt.permissions.check("bash", "git status").effect).toBe("deny");
  expect(rt.permissions.check("bash", "ls").effect).toBe("deny"); // todo bash en readonly
  expect(rt.permissions.check("vault", "write:03-Contexto/nota.md").effect).toBe("deny");
  expect(rt.permissions.check("vault", "read:03-Contexto/nota.md").effect).not.toBe("deny");
  expect(rt.permissions.check("read", "src/x.ts").effect).not.toBe("deny");
  expect(rt.permissions.check("grep", "TODO").effect).not.toBe("deny");
});

test("--readonly: deny gana sobre allow explícito y sobre allows guardados", () => {
  writeFileSync(join(work, "opencode.json"), JSON.stringify({ permissions: [{ action: "bash", resource: "git push*", effect: "allow" }] }));
  const rt = buildRuntime({ cwd: work, auto: false, readonly: true });
  expect(rt.permissions.check("bash", "git push origin").effect).toBe("deny");
});

test("policy export → import → loadConfig: ronda completa", () => {
  writeFileSync(join(work, "opencode.json"), JSON.stringify({ permissions: [{ action: "bash", resource: "git push*", effect: "deny" }] }));
  const exp = buildPolicyExport(work, undefined, false);
  expect(exp.version).toBe(POLICY_VERSION);
  const deny = exp.rules.find((r) => r.effect === "deny" && r.resource === "git push*");
  expect(deny?.source).toBe("project");

  const file = join(tmp, "policy.json");
  writeFileSync(file, JSON.stringify({ version: 1, permissions: [{ action: "bash", resource: "curl *", effect: "deny" }], policies: [] }));
  const code = runPolicy({ cwd: work, positional: ["import", file, "--yes"], readonly: false, json: false });
  expect(code).toBe(0);
  const imported = readPolicyFile(policyFilePath(work));
  expect(imported.rules).toEqual([{ action: "bash", resource: "curl *", effect: "deny" }]);
  // loadConfig la carga como capa «policy» después de la config del proyecto
  const cfg = loadConfig(work);
  expect(cfg.rules.some((r) => r.resource === "curl *" && r.effect === "deny")).toBe(true);
  expect(cfg.ruleSources[cfg.rules.findIndex((r) => r.resource === "curl *")]).toBe("policy");
});

test("policy import: rechaza archivo inválido sin tocar el proyecto", () => {
  const file = join(tmp, "policy.json");
  writeFileSync(file, JSON.stringify({ version: 1, permissions: [{ action: "bash", resource: "x", effect: "yolo" }] }));
  const code = runPolicy({ cwd: work, positional: ["import", file, "--yes"], readonly: false, json: false });
  expect(code).toBe(2);
  expect(existsSync(policyFilePath(work))).toBe(false);
});

test("policy explain: ganadora y origen", () => {
  writeFileSync(join(work, "opencode.json"), JSON.stringify({ permissions: [{ action: "bash", resource: "git push*", effect: "deny" }] }));
  const res = explainDecision(work, undefined, "bash", "git push origin master", false);
  expect(res.effect).toBe("deny");
  expect(res.source).toBe("project");
  expect(res.rule?.resource).toBe("git push*");
});

test("policy explain: defaults allow-* cuando no hay regla", () => {
  const res = explainDecision(work, undefined, "grep", "hola", false);
  expect(res.effect).toBe("allow");
  expect(res.source).toBe("defaults");
});

test("policy export incluye reglas cli:--readonly solo con el flag", () => {
  const plain = buildPolicyExport(work, undefined, false);
  const ro = buildPolicyExport(work, undefined, true);
  expect(plain.rules.some((r) => r.source === "cli:--readonly")).toBe(false);
  expect(ro.rules.some((r) => r.source === "cli:--readonly")).toBe(true);
  expect(ro.rules.find((r) => r.source === "cli:--readonly")?.effect).toBe("deny");
});

test("policy import: JSONC tolerado en el archivo de entrada", () => {
  const file = join(tmp, "policy.jsonc");
  writeFileSync(file, "{\n  // política de prueba\n  \"version\": 1,\n  \"permissions\": [{ \"action\": \"bash\", \"resource\": \"rm *\", \"effect\": \"deny\" }],\n}\n");
  const code = runPolicy({ cwd: work, positional: ["import", file, "--yes"], readonly: false, json: false });
  expect(code).toBe(0);
  expect(readPolicyFile(policyFilePath(work)).rules[0].resource).toBe("rm *");
});
