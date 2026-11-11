import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/core/config.js";
import { PermissionEngine } from "../src/core/permissions.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nicotine-config-"));
  mkdirSync(join(root, "sub", ".opencode"), { recursive: true });
  return root;
}

describe("loadConfig (capas proyecto)", () => {
  test("el más cercano gana; los escalares se conservan si no conflictúan", () => {
    const root = fixture();
    writeFileSync(join(root, "opencode.json"), JSON.stringify({ model: "raiz/modelo", username: "raiz" }));
    writeFileSync(join(root, "sub", "opencode.json"), JSON.stringify({ model: "sub/modelo" }));
    const { config, layers } = loadConfig(join(root, "sub"));
    expect(config["model"]).toBe("sub/modelo");
    expect(config["username"]).toBe("raiz");
    expect(layers.some((l) => l.endsWith("sub/opencode.json"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
  test(".opencode/opencode.jsongana al opencode.json del mismo directorio", () => {
    const root = fixture();
    writeFileSync(join(root, "sub", "opencode.json"), JSON.stringify({ model: "directo/modelo" }));
    writeFileSync(join(root, "sub", ".opencode", "opencode.json"), JSON.stringify({ model: "dot/modelo" }));
    const { config } = loadConfig(join(root, "sub"));
    expect(config["model"]).toBe("dot/modelo");
    rmSync(root, { recursive: true, force: true });
  });
  test("permissions v2 se CONCATENAN entre capas (orden = precedencia)", () => {
    const root = fixture();
    writeFileSync(join(root, "opencode.json"), JSON.stringify({ permissions: [{ action: "bash", resource: "git status *", effect: "ask" }] }));
    writeFileSync(join(root, "sub", "opencode.json"), JSON.stringify({ permissions: [{ action: "bash", resource: "git status *", effect: "allow" }] }));
    const { rules } = loadConfig(join(root, "sub"));
    const effects = rules.filter((r) => r.resource === "git status *").map((r) => r.effect);
    expect(effects[effects.length - 1]).toBe("allow"); // la del proyecto, última
    const engine = new PermissionEngine(rules);
    expect(engine.check("bash", "git status").effect).toBe("allow");
    rmSync(root, { recursive: true, force: true });
  });
  test("{env:VAR} y {file:path} se sustituyen", () => {
    const root = fixture();
    process.env.NICOTINE_TEST_KEY = "secreto";
    writeFileSync(join(root, "clave.txt"), "contenido-clave\n");
    writeFileSync(join(root, "opencode.json"), JSON.stringify({ provider: { apiKey: "{env:NICOTINE_TEST_KEY}", baseURL: "{file:clave.txt}" } }));
    const { config } = loadConfig(root);
    expect((config["provider"] as any).apiKey).toBe("secreto");
    expect((config["provider"] as any).baseURL).toBe("contenido-clave");
    delete process.env.NICOTINE_TEST_KEY;
    rmSync(root, { recursive: true, force: true });
  });
  test("JSONC con comentarios en el proyecto", () => {
    const root = fixture();
    writeFileSync(join(root, "opencode.jsonc"), `{\n// comentario\n"model": "jsonc/modelo", // final\n}\n`);
    const { config } = loadConfig(root);
    expect(config["model"]).toBe("jsonc/modelo");
    rmSync(root, { recursive: true, force: true });
  });
  test("--config-dir añade la capa custom por encima del proyecto", () => {
    const root = fixture();
    const custom = join(root, "custom");
    mkdirSync(custom);
    writeFileSync(join(root, "opencode.json"), JSON.stringify({ model: "proyecto/modelo" }));
    writeFileSync(join(custom, "opencode.json"), JSON.stringify({ model: "custom/modelo" }));
    const { config, layers } = loadConfig(root, { configDir: custom });
    expect(config["model"]).toBe("custom/modelo");
    expect(layers[layers.length - 1]).toContain("custom");
    rmSync(root, { recursive: true, force: true });
  });
});
