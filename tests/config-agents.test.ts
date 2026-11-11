// Agentes custom en JSON `agents: {}` — spec oficial (opencode.ai/docs/agents, 2026-11):
// merge escalares-reemplazan/permissions-ANEXAN; disabled elimina; hidden oculta;
// system sustituye la base (entorno/contexto conservados); modelo de subagentes honrado.
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfigAgents } from "../src/compat/config-agents.js";
import {
  allAgents, findAgent, registerConfigAgents, registerExtraAgents, clearExtraAgents, BUILTIN_AGENTS,
} from "../src/core/agents.js";
import { buildSystemPrompt } from "../src/core/context.js";
import { buildRuntime } from "../src/modes/common.js";
import { loadConfig } from "../src/core/config.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nicotine-agents-"));
  process.env.XDG_DATA_HOME = join(tmp, "data");
  clearExtraAgents();
});

const proj = (config: unknown): string => {
  const dir = join(tmp, "proj");
  mkdirSync(dir);
  writeFileSync(join(dir, "opencode.json"), JSON.stringify(config));
  return dir;
};

const BASE = { model: "openai/mock-model", provider: { baseURL: "http://127.0.0.1:8799/v1", apiKey: "test-key" } };

describe("parseConfigAgents", () => {
  test("objeto mínimo nuevo → agent con permissions [], sin mode (el registry resuelve primary)", () => {
    const r = parseConfigAgents({ reviewer: { description: "rev" } });
    expect(r.agents).toHaveLength(1);
    expect(r.agents[0].id).toBe("reviewer");
    expect(r.agents[0].mode).toBeUndefined();
    expect(r.agents[0].permissionRules).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test("campos V1/heredados e ids inválidos se avisan y se ignoran", () => {
    const r = parseConfigAgents({
      "bad id!": { description: "x" },
      ok: { description: "ok", temperature: 0.2, steps: 8, color: "#fff", request: { headers: {} } },
    });
    expect(r.agents.map((a) => a.id)).toEqual(["ok"]);
    for (const legacy of ["temperature", "steps", "color", "request"]) {
      expect(r.warnings.some((w) => w.includes(legacy))).toBe(true);
    }
    expect(r.warnings.some((w) => w.includes("bad id!"))).toBe(true);
  });

  test("mode inválido → omitido con aviso; válido se conserva", () => {
    const r = parseConfigAgents({ a: { description: "a", mode: "mega" }, b: { description: "b", mode: "ALL" } });
    expect(r.agents.find((x) => x.id === "a")!.mode).toBeUndefined();
    expect(r.agents.find((x) => x.id === "b")!.mode).toBe("all");
    expect(r.warnings.some((w) => w.includes("mega"))).toBe(true);
  });

  test("permissions válidas → reglas; effect inválido o item malformado → aviso, resto entra", () => {
    const r = parseConfigAgents({
      sec: {
        description: "s",
        permissions: [
          { action: "edit", resource: "*", effect: "deny" },
          { action: "shell", resource: "git push *", effect: "ask" },
          { action: "read", resource: "*", effect: "quizá" },
          { resource: "*" },
        ],
      },
    });
    const rules = r.agents[0].permissionRules;
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ action: "edit", resource: "*", effect: "deny" });
    expect(r.warnings.filter((w) => w.includes("permissions"))).toHaveLength(2);
  });

  test("hidden/disabled respetados; top-level no objeto avisa", () => {
    const r = parseConfigAgents(["no", "es", "objeto"]);
    expect(r.agents).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    const r2 = parseConfigAgents({ h: { description: "h", hidden: true, disabled: false }, d: { description: "d", disabled: true } });
    expect(r2.agents.find((a) => a.id === "h")!.hidden).toBe(true);
    expect(r2.agents.find((a) => a.id === "h")!.disabled).toBe(false);
    expect(r2.agents.find((a) => a.id === "d")!.disabled).toBe(true);
  });
});

describe("registry (merge spec)", () => {
  test("agente nuevo sin mode → registry lo resuelve a «primary»", () => {
    registerConfigAgents(parseConfigAgents({ w: { description: "w" } }).agents);
    expect(findAgent("w").mode).toBe("primary");
    registerConfigAgents([]);
  });

  test("override de built-in: escalares reemplazan, permissions se AÑADEN", () => {
    registerConfigAgents(parseConfigAgents({
      plan: { permissions: [{ action: "bash", resource: "git push *", effect: "ask" }] },
    }).agents);
    const plan = findAgent("plan");
    expect(plan.permissionRules).toContainEqual({ action: "edit", resource: "*", effect: "deny" }); // la del built-in
    expect(plan.permissionRules).toContainEqual({ action: "bash", resource: "git push *", effect: "ask" }); // la de config
    expect(plan.mode).toBe("primary"); // mode del built-in conservado
    registerConfigAgents([]);
  });

  test("disabled elimina incluso un built-in; hidden lo oculta pero no lo impide", () => {
    registerConfigAgents(parseConfigAgents({ plan: { disabled: true } }).agents);
    expect(allAgents().some((a) => a.id === "plan")).toBe(false);
    expect(() => findAgent("plan")).toThrow();
    registerConfigAgents(parseConfigAgents({ plan: { hidden: true } }).agents);
    expect(allAgents().find((a) => a.id === "plan")!.hidden).toBe(true);
    expect(findAgent("plan").id).toBe("plan"); // explícito: sigue resolviendo
    registerConfigAgents([]);
  });

  test("agentes de archivo nunca pisan un built-in; config sí (precedencia config > archivo > built-in)", () => {
    registerExtraAgents([{ id: "plan", mode: "subagent", description: "archivo", permissionRules: [] }]);
    expect(findAgent("plan").description).not.toBe("archivo");
    registerConfigAgents([{ id: "plan", mode: "all", description: "config", permissionRules: [] }]);
    expect(findAgent("plan").description).toBe("config");
    expect(findAgent("plan").mode).toBe("all");
    clearExtraAgents();
  });

  test("re-registrar sustituye el estado de config (no acumula entre cargas)", () => {
    registerConfigAgents(parseConfigAgents({ a: { description: "a" } }).agents);
    registerConfigAgents(parseConfigAgents({ b: { description: "b" } }).agents);
    expect(allAgents().some((x) => x.id === "a")).toBe(false);
    expect(findAgent("b").description).toBe("b");
    registerConfigAgents([]);
  });
});

describe("carga por capas (deepMerge concatena permissions de agentes entre capas)", () => {
  test("proyecto raíz + .opencode/ interno: permissions de agents.x concatenan en orden", () => {
    const root = join(tmp, "root");
    mkdirSync(root);
    writeFileSync(join(root, "opencode.json"), JSON.stringify({
      model: "openai/mock-model",
      agents: { sec: { description: "raíz", permissions: [{ action: "bash", resource: "a *", effect: "ask" }] } },
    }));
    const inner = join(root, ".opencode");
    mkdirSync(inner);
    writeFileSync(join(inner, "opencode.json"), JSON.stringify({
      agents: { sec: { permissions: [{ action: "bash", resource: "b *", effect: "deny" }] } },
    }));
    const { config } = loadConfig(root);
    const sec = (config["agents"] as Record<string, Record<string, unknown>>)["sec"];
    const perms = sec["permissions"] as Array<{ resource: string }>;
    expect(perms.map((p) => p.resource)).toEqual(["a *", "b *"]); // orden de aplicación
    expect((sec as { description?: string }).description).toBe("raíz"); // scalar conservado (no reemplazado por la capa interna)
  });
});

describe("integración buildRuntime", () => {
  test("config: system sustituye identity y resuelve default_agent; hidden fuera de tab; task cataloga config subagentes", () => {
    const project = proj({
      ...BASE,
      agents: {
        reviewer: { description: "rev", mode: "primary", system: "Soy un revisor estricto." },
        helper: { description: "helper", mode: "subagent", model: "openai/helper-x" },
        ghost: { description: "ghost", mode: "subagent", hidden: true },
      },
      default_agent: "reviewer",
    });
    const rt = buildRuntime({ cwd: project, auto: false, attachUi: false });
    expect(rt.messages[0].content).toContain("Soy un revisor estricto.");
    expect(rt.messages[0].content).not.toContain("Eres Nicotine");
    expect(rt.messages[0].content).toContain("Entorno:"); // entorno conservado
    expect(rt.messages[0].content).not.toContain("Forma de trabajo");
    expect(findAgent("reviewer").mode).toBe("primary");
    expect(rt.agent.list()).toContain("reviewer");
    expect(rt.agent.list()).not.toContain("ghost"); // hidden
    expect(rt.agent.list()).not.toContain("helper"); // subagente
    const task = rt.tools.find((t) => t.name === "task") as unknown as { parameters: { properties: { subagent_type: { enum: string[] } } } };
    expect(task.parameters.properties.subagent_type.enum).toContain("helper");
    expect(task.parameters.properties.subagent_type.enum).not.toContain("ghost"); // hidden
    expect(task.parameters.properties.subagent_type.enum).toContain("general");
    registerConfigAgents([]); // limpia para otros tests del mismo proceso
    clearExtraAgents();
  });
});

describe("modelo de subagentes en config (spec: el subagente usa SU modelo; el primario no cambia)", () => {
  test("helper con model «openai/helper-x#high» → el loop hijo pide «helper-x»; el padre sigue con mock-model", async () => {
    const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    const project = proj({
      ...BASE,
      agents: { helper: { description: "helper", mode: "subagent", model: "openai/helper-x#high" } },
    });
    const models: string[] = [];
    let calls = 0;
    const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
      calls++;
      try { models.push(JSON.parse(String(init?.body ?? "{}")).model); } catch { models.push("?"); }
      let delta: unknown;
      if (calls === 1) {
        delta = { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "task", arguments: '{"prompt":"hola","subagent_type":"helper","description":"t"}' } }] } }] };
      } else if (calls === 2) {
        delta = { choices: [{ delta: { content: "hijo-ok" } }] };
      } else {
        delta = { choices: [{ delta: { content: "padre-ok" } }] };
      }
      return new Response(sse(delta) + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const rt = buildRuntime({ cwd: project, auto: false, attachUi: false, modelFlag: "mock-model", fetchImpl });
    const { runAgentLoop } = await import("../src/core/loop.js");
    rt.messages.push({ role: "user", content: "delega" });
    await runAgentLoop({ provider: rt.provider, permissions: rt.permissions, messages: rt.messages, tools: rt.tools, ctx: rt.ctx, fetchImpl });
    expect(models).toEqual(["mock-model", "helper-x", "mock-model"]); // padre, hijo, padre
    clearExtraAgents();
  });
});

describe("agentes de archivo .md — frontmatter completo (spec agents#markdown)", () => {
  const write = (p: string, c: string) => { const { mkdirSync: mk, writeFileSync: wf } = require("node:fs"); mk(require("node:path").dirname(p), { recursive: true }); wf(p, c); };

  test("subdirectorio → ID «team/reviewer»; body sustituye identidad; permissions del frontmatter se aplican", async () => {
    const home = join(tmp, "home-fresh");
    const project = join(tmp, "proj-md");
    mkdirSync(project, { recursive: true });
    write(join(project, ".opencode/agents/team/reviewer.md"), `---
description: Revisor de diffs
mode: subagent
model: openai/helper-x#high
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: shell
    resource: "git status *"
    effect: ask
hidden: false
---
Revisa con rigor. Nunca edites.`);
    const { scanAgentFiles } = await import("../src/compat/agent-files.js");
    const r = scanAgentFiles(project, { home });
    const a = r.agents.find((x) => x.id === "team/reviewer");
    expect(a, "team/reviewer debe existir con ID con /").toBeDefined();
    expect(a!.mode).toBe("subagent");
    expect(a!.model).toBe("openai/helper-x#high");
    expect(a!.systemPrompt).toContain("Revisa con rigor");
    expect(a!.systemPrompt).not.toContain("Eres Nicotine");
    expect(a!.permissionRules).toContainEqual({ action: "edit", resource: "*", effect: "deny" });
    // normalizeAction mapea «shell» → «bash» (alias nicotine)
    expect(a!.permissionRules).toContainEqual({ action: "bash", resource: "git status *", effect: "ask" });
    expect(r.warnings).toEqual([]);
  });

  test("name explícito pisa la ruta; disabled/hidden parsean; permissions inline malformada se avisa", async () => {
    const home = join(tmp, "home-fresh2");
    const project = join(tmp, "proj-md2");
    mkdirSync(project, { recursive: true });
    write(join(project, ".opencode/agents/hidden.md"), `---
name: Fantasma
description: oculto
hidden: true
disabled: true
permissions:
  - action: edit
    resource: "*"
    effect: quizas
---
soy oculto`);
    const { scanAgentFiles } = await import("../src/compat/agent-files.js");
    const r = scanAgentFiles(project, { home });
    expect(r.agents[0].id).toBe("fantasma"); // sanitize lowercases
    expect(r.agents[0].hidden).toBe(true);
    expect(r.agents[0].disabled).toBe(true);
    expect(r.agents[0].permissionRules).toEqual([]); // effect inválido → omitido
    expect(r.warnings.some((w) => w.includes("effect desconocido"))).toBe(true);
  });
});
