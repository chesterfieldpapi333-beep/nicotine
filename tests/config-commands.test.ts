// Comandos custom desde config `commands: {}` — spec JSON verificada en
// opencode.ai/docs/commands (2026-11): `template` requerido; misma sustitución
// que los comandos de archivo; `subagent`/`subtask` aceptados pero no honrados.

import { describe, expect, test } from "bun:test";
import { parseConfigCommands } from "../src/compat/config-commands.js";
import { renderCommandBody } from "../src/compat/file-commands.js";

const opts = (tpl: string) => ({ template: tpl });
const render = (body: string, args: string) =>
  renderCommandBody({ name: "x", hint: "", description: "", body, source: "t", origin: "project" as const }, args);

describe("parseConfigCommands", () => {
  test("objeto mínimo válido → un comando con body=template", () => {
    const r = parseConfigCommands({ review: opts("Review $ARGUMENTS.") });
    expect(r.warnings).toEqual([]);
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0].name).toBe("review");
    expect(r.commands[0].body).toBe("Review $ARGUMENTS.");
    expect(r.commands[0].hint).toBe("Review $ARGUMENTS.");
  });

  test("falta template (o vacío) → comando descartado con aviso", () => {
    const r = parseConfigCommands({ a: { description: "sin template" }, b: opts("   ") });
    expect(r.commands).toEqual([]);
    expect(r.warnings.filter((w) => w.includes("template"))).toHaveLength(2);
  });

  test("def no-objeto / nombre inválido / clave desconocida / duplicado estructural", () => {
    const r = parseConfigCommands({
      "bad name!": opts("x"),
      plain: "no-objeto",
      ok: { ...opts("do $ARGUMENTS"), bogus: 1 },
    });
    expect(r.commands.map((c) => c.name)).toEqual(["ok"]);
    expect(r.warnings.some((w) => w.includes("«plain»"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("bogus"))).toBe(true);
    // "bad name!" NO se sanitiza (nombre explícito del usuario): se descarta con aviso
    expect(r.warnings.some((w) => w.includes("bad name!"))).toBe(true);
  });

  test("no-objeto top-level → aviso y nada más; undefined → sin avisos", () => {
    expect(parseConfigCommands(undefined)).toEqual({ commands: [], warnings: [] });
    const r = parseConfigCommands(["no", "array"]);
    expect(r.commands).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });

  test("subagent/subtask → avisos (no honrados), subagent gana el alias", () => {
    const r = parseConfigCommands({ a: { ...opts("t"), subagent: true }, b: { ...opts("t"), subtask: true } });
    expect(r.commands).toHaveLength(2);
    expect(r.warnings.filter((w) => w.includes("subagent"))).toHaveLength(2);
  });

  test("model#variant → variant descartada con aviso; agent se conserva", () => {
    const r = parseConfigCommands({ d: { ...opts("t"), model: "openai/gpt-4o#high", agent: "plan" } });
    expect(r.commands[0].model).toBe("openai/gpt-4o");
    expect(r.commands[0].agent).toBe("plan");
    expect(r.warnings.some((w) => w.includes("variant"))).toBe(true);
  });

  test("bloques shell `!` «literales» con aviso con aviso", () => {
    const r = parseConfigCommands({ sh: opts("skip:\n!`git diff --stat`\nfin") });
    expect(r.commands[0].body).toContain("!`git diff --stat`");
    expect(r.warnings.some((w) => w.includes("shell"))).toBe(true);
  });
});

describe("renderCommandBody (spec posicionales)", () => {
  test("$N mayor consume su argumento y todo lo posterior", () => {
    expect(render("Compare $1 with $2.", "api stable branch")).toBe("Compare api with stable branch.");
    expect(render("$1 | $2 | $3", "a b c d e")).toBe("a | b | c d e");
  });

  test("posicionales ausentes → cadena vacía", () => {
    expect(render("a=$1 b=$2 c=$3", "solo")).toBe("a=solo b= c=");
  });

  test("fallback: sin $ARGUMENTS ni $N y con argumentos → se anexan tras \\n\\n", () => {
    expect(render("Explain this code clearly.", "src/cache.ts")).toBe("Explain this code clearly.\n\nsrc/cache.ts");
    expect(render("Sin args.", "")).toBe("Sin args.");
  });

  test("$ARGUMENTS es la cadena completa; mixtos $1.. y $9 no rompe", () => {
    expect(render("a=$ARGUMENTS b=$1 c=$2 d=$9", "uno dos tres")).toBe("a=uno dos tres b=uno c=dos d=");
    expect(render("q: $ARGUMENTS", "  espaciado  suelto  ")).toBe("q: espaciado  suelto");
  });
});

describe("buildRuntime + commands (integración)", () => {
  test("mapea los comandos de config a rt.configCommands; default_agent desconocido avisa y cae a build", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "nicotine-cmdcfg-"));
    process.env.XDG_DATA_HOME = join(tmp, "data");
    const project = join(tmp, "proj");
    mkdirSync(project);
    writeFileSync(join(project, "opencode.json"), JSON.stringify({
      model: "openai/mock-model",
      provider: { baseURL: "http://127.0.0.1:8799/v1", apiKey: "test-key" },
      default_agent: "no-existe-este-agente",
      commands: {
        review: { template: "Review $ARGUMENTS.", description: "Revisión", agent: "plan" },
        roto: 42,
      },
    }));
    const { buildRuntime } = await import("../src/modes/common.js");
    const rt = buildRuntime({ cwd: project, auto: false, attachUi: false });
    expect(rt.configCommands.map((c) => c.name)).toEqual(["review"]);
    expect(rt.configCommands[0].agent).toBe("plan");
    expect(rt.warnings.some((w) => w.includes("default_agent «no-existe-este-agente»"))).toBe(true);
    expect(rt.warnings.some((w) => w.includes("roto"))).toBe(true);
    expect(rt.agent.current()).toBe("build");
  });
});
