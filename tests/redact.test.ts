import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "../src/core/redact.js";
import { Session } from "../src/core/session.js";

test("redactSecrets cubre formatos comunes y no toca texto inocuo", () => {
  const cases: [string, string][] = [
    ["clave sk-proj-abcdefghijklmnop1234", "sk-***"],
    ["ghp_abcdefghijklmnopqrstUVwxyz12", "gh*_***"],
    ["github_pat_abcdefghij_1234567890", "github_pat_***"],
    ["AIzaSyA1234567890abcdefghijklm", "AIza***"],
    ["xoxb-1234567890-abcdefghijkl", "xox*-***"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQss5c", "eyJ***"],
    ["password: supersecretvalue1234", "password: ***"],
    ["api_key=abcd1234efgh5678ijkl", "api_key=***"],
    ["git clone https://ghp_abcdefghijklmnopqrstUVwxyz@github.com/x/y", "https://***@github.com"],
  ];
  for (const [input, expected] of cases) {
    expect(redactSecrets(input)).toContain(expected);
    expect(redactSecrets(input)).not.toBe(input);
  }
  expect(redactSecrets("el cielo es azul, 2 + 2 = 4")).toBe("el cielo es azul, 2 + 2 = 4");
});

test("bloque de clave privada completo se reemplaza", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nAAAA\n-----END RSA PRIVATE KEY-----";
  const out = redactSecrets(`antes\n${pem}\ndespués`);
  expect(out).toContain("clave privada redactada");
  expect(out).not.toContain("MIIEpAIBAAKCAQEA");
  expect(out.startsWith("antes\n")).toBe(true);
  expect(out.endsWith("\ndespués")).toBe(true);
});

let tmp: string;
let saved: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nicotine-redact-"));
  saved = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(tmp, "data");
});
afterEach(() => {
  if (saved === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

test("Session.appendMessage persiste redactado pero parsea JSON válido", () => {
  const s = Session.create(tmp);
  const secret = "sk-proj-persistedsecret1234567890abc";
  s.appendMessage({ role: "user", content: `mi clave es ${secret}` });
  const raw = readFileSync(s.path, "utf8");
  expect(raw).not.toContain(secret);
  expect(raw).toContain("sk-***");
  const line = JSON.parse(raw.trim().split("\n").pop()!);
  expect(line.content).toContain("sk-***");
});
