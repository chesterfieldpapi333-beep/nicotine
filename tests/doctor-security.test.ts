import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSecurityReport, runDoctorSecurity } from "../src/modes/doctor-security.js";

let tmp: string;
let work: string;
let savedEnv: Record<string, string | undefined>;
let savedUmask: number;

const ENV_KEYS = ["HOME", "XDG_DATA_HOME", "NICOTINE_SERVER_PASSWORD", "OPENCODE_SERVER_PASSWORD", "OPENAI_API_KEY"];

function restoreEnv() {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nicotine-sec-"));
  work = join(tmp, "work");
  mkdirSync(work, { recursive: true });
  mkdirSync(join(tmp, "data", "nicotine", "sessions"), { recursive: true });
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HOME = tmp;
  process.env.XDG_DATA_HOME = join(tmp, "data");
  delete process.env.NICOTINE_SERVER_PASSWORD;
  delete process.env.OPENCODE_SERVER_PASSWORD;
  delete process.env.OPENAI_API_KEY;
  savedUmask = process.umask(0o022);
});

afterEach(() => {
  process.umask(savedUmask);
  restoreEnv();
  rmSync(tmp, { recursive: true, force: true });
});

test("entorno limpio: exit 0, sin hallazgos, deny-wins OK", () => {
  writeFileSync(join(tmp, "data", "nicotine", "auth.json"), JSON.stringify({ openai: "sk-fakefakefakefakefakefake" }), { mode: 0o600 });
  const report = buildSecurityReport({ cwd: work });
  expect(report.ok).toBe(true);
  expect(report.findings).toEqual([]);
  expect(report.checks.find((c) => c.id === "policy:deny-wins")?.ok).toBe(true);
  expect(report.checks.find((c) => c.id === "serve:password")?.detail).toContain("correcto por defecto");
});

test("auth.json con permisos abiertos: hallazgo, sin contenido", () => {
  const secret = "sk-fakefakefakefakefakefakeAAAA";
  writeFileSync(join(tmp, "data", "nicotine", "auth.json"), JSON.stringify({ openai: secret }), { mode: 0o644 });
  chmodSync(join(tmp, "data", "nicotine", "auth.json"), 0o644);
  const report = buildSecurityReport({ cwd: work });
  expect(report.ok).toBe(false);
  expect(report.findings.some((f) => f.id === "perms:auth.json")).toBe(true);
  expect(JSON.stringify(report)).not.toContain(secret);
});

test("sesión con patrón de credencial: detecta y redacta", () => {
  const secret = "sk-fakefakefakefakefakefakeBBBB";
  writeFileSync(join(tmp, "data", "nicotine", "sessions", "abc.jsonl"), `{"type":"message","text":"clave ${secret} pegada"}\n`);
  const report = buildSecurityReport({ cwd: work });
  expect(report.ok).toBe(false);
  expect(report.findings.some((f) => f.id === "sessions:secretos")).toBe(true);
  expect(JSON.stringify(report)).not.toContain(secret);
});

test("config con secreto literal: hallazgo redactado (solo clave, no valor)", () => {
  const secret = "sk-proj-fakeLiteralSecret1234567890abcdef";
  writeFileSync(join(work, "opencode.json"), JSON.stringify({ provider: { openai: { apiKey: secret } } }));
  const report = buildSecurityReport({ cwd: work });
  expect(report.ok).toBe(false);
  expect(report.findings.some((f) => f.id === "config:literal")).toBe(true);
  expect(JSON.stringify(report)).not.toContain(secret);
});

test("config con referencia {env:} no es literal", () => {
  writeFileSync(join(work, "opencode.json"), JSON.stringify({ provider: { openai: { apiKey: "{env:OPENAI_API_KEY}" } } }));
  const report = buildSecurityReport({ cwd: work });
  expect(report.findings.some((f) => f.id === "config:literal")).toBe(false);
});

test(".git/config con credencial en URL: hallazgo redactado", () => {
  const secret = "ghp_fakeFakeFakeFakeFakeFakeFakeFake00";
  mkdirSync(join(work, ".git"), { recursive: true });
  writeFileSync(join(work, ".git", "config"), `[remote "origin"]\n\turl = https://${secret}@github.com/x/y.git\n`);
  const report = buildSecurityReport({ cwd: work });
  expect(report.ok).toBe(false);
  expect(report.findings.some((f) => f.id === "git:config")).toBe(true);
  expect(JSON.stringify(report)).not.toContain(secret);
});

test("runDoctorSecurity: exit 0 limpio, 1 con hallazgo, y --json no filtra el secreto", () => {
  const secret = "sk-fakefakefakefakefakefakeCCCC";
  const capture = (fn: () => number): { code: number; out: string } => {
    const orig = process.stdout.write.bind(process.stdout);
    let buf = "";
    process.stdout.write = ((chunk: unknown) => { buf += String(chunk); return true; }) as typeof process.stdout.write;
    try { return { code: fn(), out: buf }; } finally { process.stdout.write = orig; }
  };
  let res = capture(() => runDoctorSecurity({ cwd: work, json: true }));
  expect(res.code).toBe(0);
  expect(JSON.parse(res.out).ok).toBe(true);

  writeFileSync(join(tmp, "data", "nicotine", "oauth.json"), JSON.stringify({ m: { token: secret } }), { mode: 0o600 });
  chmodSync(join(tmp, "data", "nicotine", "oauth.json"), 0o644); // 0644 → hallazgo
  res = capture(() => runDoctorSecurity({ cwd: work, json: true }));
  expect(res.code).toBe(1);
  expect(JSON.parse(res.out).ok).toBe(false);
  expect(res.out).not.toContain(secret);
});
