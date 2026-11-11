// /connect (auth.json 0600 + fallback en resolveProvider) y /export (Markdown de sesión).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { readFileSync as rfs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONNECT_CATALOG, authPath, matchAuth, readAuth, writeAuthEntry, DEFAULT_BASE_URL } from "../src/core/auth.js";
import { resolveProvider } from "../src/core/provider.js";
import { dataHome, Session } from "../src/core/session.js";
import { exportSessionMarkdown } from "../src/modes/export-session.js";

let tmp: string;
let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nicotine-connect-"));
  savedEnv = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_API_KEYS: process.env.OPENAI_API_KEYS, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL };
  process.env.XDG_DATA_HOME = join(tmp, "data");
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEYS;
  delete process.env.OPENAI_BASE_URL;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("auth store (/connect)", () => {
  test("writeAuthEntry crea auth.json 0600, hace roundtrip y reemplaza entradas", () => {
    const { path, replaced } = writeAuthEntry("openai", { baseURL: DEFAULT_BASE_URL, apiKey: "sk-test-123" });
    expect(replaced).toBe(false);
    expect(path).toBe(authPath());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readAuth()["openai"].apiKey).toBe("sk-test-123");
    const again = writeAuthEntry("openai", { baseURL: DEFAULT_BASE_URL + "/", apiKey: "sk-otro" });
    expect(again.replaced).toBe(true);
    expect(readAuth()["openai"].baseURL).toBe(DEFAULT_BASE_URL); // normalizada sin slash
    expect(readAuth()["openai"].apiKey).toBe("sk-otro");
    expect(CONNECT_CATALOG.length).toBeGreaterThanOrEqual(5);
  });

  test("matchAuth: encaje exacto por baseURL; default openai como fallback; incompatible → undefined", () => {
    writeAuthEntry("groq", { baseURL: "https://api.groq.com/openai/v1", apiKey: "gsk-1" });
    expect(matchAuth("https://api.groq.com/openai/v1/")?.apiKey).toBe("gsk-1"); // tolera slash final
    expect(matchAuth("https://api.other.com/v1")).toBeUndefined();
    expect(matchAuth(DEFAULT_BASE_URL)).toBeUndefined(); // sin entrada openai
    writeAuthEntry("openai", { baseURL: DEFAULT_BASE_URL, apiKey: "sk-o" });
    expect(matchAuth(DEFAULT_BASE_URL)?.apiKey).toBe("sk-o");
  });

  test("resolveProvider: auth.json rescata cuando no hay clave config/env; config/env ganan si existen", () => {
    writeAuthEntry("openai", { baseURL: DEFAULT_BASE_URL, apiKey: "sk-auth" });
    const via = resolveProvider({ model: "openai/gpt-4o-mini" });
    expect(via.apiKey).toBe("sk-auth");
    // config gana sobre auth
    const viaCfg = resolveProvider({ model: "openai/gpt-4o-mini", provider: { apiKey: "sk-cfg" } });
    expect(viaCfg.apiKey).toBe("sk-cfg");
    // env gana sobre auth
    process.env.OPENAI_API_KEY = "sk-env";
    const viaEnv = resolveProvider({ model: "openai/gpt-4o-mini" });
    expect(viaEnv.apiKey).toBe("sk-env");
    delete process.env.OPENAI_API_KEY;
    // sin match alguno → error explícito
    writeAuthEntry("groq", { baseURL: "https://api.groq.com/openai/v1", apiKey: "gsk-X" });
    const orphan = readAuth(); delete orphan.openai;
    writeFileSync(authPath(), JSON.stringify({ groq: { baseURL: "https://api.groq.com/openai/v1", apiKey: "gsk-X" } }), "utf8");
    expect(() => resolveProvider({ model: "openai/gpt-4o-mini" })).toThrow(/Falta API key/);
  });
});

describe("/export", () => {
  test("la sesión se exporta a Markdown con roles y sin system; archivo con permisos 0600", () => {
    const project = join(tmp, "proj");
    mkdirSync(project, { recursive: true });
    const s = Session.create(project);
    s.appendMessage({ role: "user", content: "hola" });
    s.appendMessage({ role: "assistant", content: "buenas", tool_calls: [{ id: "1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] } as never);
    s.appendMessage({ role: "tool", content: "a.txt", tool_call_id: "1" } as never);
    const { path, messages } = exportSessionMarkdown({ session: s, provider: { model: "mock-model" }, ctx: { cwd: project } });
    expect(messages).toBe(3);
    const md = rfs(path, "utf8");
    expect(md).toContain("## Usuario");
    expect(md).toContain("hola");
    expect(md).toContain("## Asistente");
    expect(md).toContain("tool_call: bash(");
    expect(md).toContain("## Resultado de tool");
    expect(md).not.toContain("Eres Nicotine"); // el system prompt no se filtra a la exportación
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
