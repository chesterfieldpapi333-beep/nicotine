import { describe, test, expect } from "bun:test";
import { PermissionEngine, baseRules, configToRules, matchPattern } from "../src/core/permissions.js";

describe("matchPattern", () => {
  test("* casa cualquier cosa incluyendo /", () => {
    expect(matchPattern("*.env", "src/secret.env")).toBe(true);
    expect(matchPattern("src/*", "src/a/b/c.ts")).toBe(true);
  });
  test("? casa exactamente un carácter", () => {
    expect(matchPattern("a?c", "abc")).toBe(true);
    expect(matchPattern("a?c", "abbc")).toBe(false);
  });
  test("patrón que termina en ' *' también casa la cadena escueta", () => {
    expect(matchPattern("git status *", "git status")).toBe(true);
    expect(matchPattern("git status *", "git status --short")).toBe(true);
    expect(matchPattern("git status *", "git push")).toBe(false);
  });
  test("valor completo, no substring", () => {
    expect(matchPattern("config", "myconfig")).toBe(false);
  });
});

describe("PermissionEngine", () => {
  test("la última regla que casa gana", () => {
    const e = new PermissionEngine([
      { action: "bash", resource: "*", effect: "ask" },
      { action: "bash", resource: "git status *", effect: "allow" },
    ]);
    expect(e.check("bash", "git status --short").effect).toBe("allow");
    expect(e.check("bash", "npm install").effect).toBe("ask");
  });
  test("defaults: *.env pide, *.env.example permite", () => {
    const e = new PermissionEngine(baseRules());
    expect(e.check("read", "/proj/.env").effect).toBe("ask");
    expect(e.check("read", "/proj/.env.local").effect).toBe("ask");
    expect(e.check("read", "/proj/.env.example").effect).toBe("allow");
  });
  test("external_directory: ask por defecto (spec Nicotine)", () => {
    const e = new PermissionEngine(baseRules());
    const r = e.checkPath("/proyecto", "read", "/etc/passwd");
    expect(r.effect).toBe("ask");
  });
  test("external_directory allow + read dentro permite", () => {
    const e = new PermissionEngine([...baseRules(), { action: "external_directory", resource: "/etc/*", effect: "allow" }]);
    expect(e.checkPath("/proyecto", "read", "/etc/passwd").effect).toBe("allow");
  });
  test("deny del config pisa un allow guardado en sesión", () => {
    const e = new PermissionEngine([...baseRules(), { action: "bash", resource: "git push *", effect: "deny" }]);
    e.addSavedAllow({ action: "bash", resource: "git push *", effect: "allow" });
    expect(e.check("bash", "git push origin main").effect).toBe("deny");
  });
  test("checkAll: deny > ask > allow", () => {
    const e = new PermissionEngine([
      { action: "edit", resource: "a.ts", effect: "allow" },
      { action: "edit", resource: "b.ts", effect: "deny" },
      { action: "edit", resource: "c.ts", effect: "ask" },
    ]);
    expect(e.checkAll("edit", ["a.ts", "b.ts"]).effect).toBe("deny");
    expect(e.checkAll("edit", ["a.ts", "c.ts"]).effect).toBe("ask");
    expect(e.checkAll("edit", ["a.ts"]).effect).toBe("allow");
  });
});

describe("configToRules", () => {
  test("objeto v1 (string y mapa de patrones)", () => {
    const rules = configToRules({ bash: { "git status *": "allow", "rm *": "deny" }, read: "allow" }, undefined);
    expect(rules).toContainEqual({ action: "bash", resource: "git status *", effect: "allow" });
    expect(rules).toContainEqual({ action: "bash", resource: "rm *", effect: "deny" });
    expect(rules).toContainEqual({ action: "read", resource: "*", effect: "allow" });
  });
  test("array v2 + alias shell→bash y write→edit", () => {
    const rules = configToRules(undefined, [
      { action: "shell", resource: "npm test", effect: "allow" },
      { action: "write", resource: "docs/*", effect: "deny" },
    ]);
    expect(rules).toContainEqual({ action: "bash", resource: "npm test", effect: "allow" });
    expect(rules).toContainEqual({ action: "edit", resource: "docs/*", effect: "deny" });
  });
  test("expande ~ en patrones de ruta (no en bash)", () => {
    const rules = configToRules({ read: { "~/secrets/*": "deny" }, bash: { "~/solo": "allow" } }, undefined);
    expect(rules.find((r) => r.action === "read")!.resource).not.toContain("~");
    expect(rules.find((r) => r.action === "bash")!.resource).toBe("~/solo");
  });
  test("efecto desconocido lanza", () => {
    expect(() => configToRules({ bash: "permiso" }, undefined)).toThrow(/allow\|ask\|deny/);
  });
});

describe("checkPath — deny-wins entre external_directory y la acción", () => {
  test("--readonly (deny edit *) gana sobre external_directory ask fuera del proyecto", () => {
    const rules = [...baseRules(), { action: "edit", resource: "*", effect: "deny" as const }];
    const e = new PermissionEngine(rules);
    const r = e.checkPath("/proyecto", "edit", "/tmp/ro-fixture-h10/secret.txt");
    expect(r.effect).toBe("deny");
  });
  test("deny de la acción fuera del proyecto gana aunque external_directory sea allow", () => {
    const rules = [
      ...baseRules(),
      { action: "external_directory", resource: "/tmp/*", effect: "allow" as const },
      { action: "edit", resource: "*", effect: "deny" as const },
    ];
    const e = new PermissionEngine(rules);
    expect(e.checkPath("/proyecto", "edit", "/tmp/x.ts").effect).toBe("deny");
  });
  test("external_directory deny gana sobre allow de la acción fuera del proyecto", () => {
    const rules = [
      ...baseRules(),
      { action: "external_directory", resource: "/etc/*", effect: "deny" as const },
      { action: "read", resource: "*", effect: "allow" as const },
    ];
    const e = new PermissionEngine(rules);
    expect(e.checkPath("/proyecto", "read", "/etc/passwd").effect).toBe("deny");
  });
  test("sin denies: external ask sigue mandando (comportamiento previo)", () => {
    const e = new PermissionEngine(baseRules());
    expect(e.checkPath("/proyecto", "read", "/etc/passwd").effect).toBe("ask");
  });
});
