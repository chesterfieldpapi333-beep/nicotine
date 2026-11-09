// Skills: descubrimiento, precedencia, frontmatter, listado en prompt y tool `skill`.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillIndex, skillBodyForModel, MAX_BODY_CHARS } from "../src/compat/skills.js";
import { skillTool } from "../src/tools/skill.js";
import type { ToolContext, UiHooks } from "../src/core/types.js";

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vireo-skill-proj-"));
  home = mkdtempSync(join(tmpdir(), "vireo-skill-home-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const writeSkill = (base: string, id: string, frontmatter: string, body = "instrucciones detalladas\n") => {
  const dir = join(base, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
  return dir;
};

const baseFm = (name: string, desc = "lista revisión exhaustiva de diffs") => `name: ${name}\ndescription: ${desc}`;

describe("loadSkillIndex — descubrimiento y precedencia", () => {
  test("proyecto: .agents/skills gana a .claude/skills; proyecto gana a global", () => {
    writeSkill(join(home, ".claude", "skills"), "revisor", baseFm("revisor", "GLOBAL-CLAUDE"));
    writeSkill(join(home, ".agents", "skills"), "revisor", baseFm("revisor", "GLOBAL-AGENTS"));
    writeSkill(join(root, ".claude", "skills"), "revisor", baseFm("revisor", "PROY-CLAUDE"));
    const projAgents = writeSkill(join(root, ".agents", "skills"), "revisor", baseFm("revisor", "PROY-AGENTS"));
    const { byId, warnings } = loadSkillIndex(root, {}, { home });
    expect(byId.get("revisor")!.description).toBe("PROY-AGENTS");
    expect(byId.get("revisor")!.dir).toBe(projAgents);
    expect(warnings.some((w) => w.includes("revisor"))).toBe(true); // aviso de pisado
  });

  test("config `skills` añade fuentes y gana sobre las carpetas por convención", () => {
    writeSkill(join(root, ".agents", "skills"), "custom", baseFm("custom", "POR-CONVENCION"));
    writeSkill(join(root, "mis-skills"), "custom", baseFm("custom", "POR-CONFIG"));
    const { byId } = loadSkillIndex(root, { skills: ["./mis-skills"] }, { home });
    expect(byId.get("custom")!.description).toBe("POR-CONFIG");
  });

  test("config `skills` HTTP → aviso con instrucción de `vireo skills update`", () => {
    const { warnings } = loadSkillIndex(root, { skills: ["https://example.com/catalog.json"] }, { home });
    expect(warnings.some((w) => w.includes("vireo skills update"))).toBe(true);
  });

  test("gemini global/proyecto solo con compat.geminiSkills", () => {
    writeSkill(join(home, ".gemini", "skills"), "gemini-thing", baseFm("gemini-thing"));
    const off = loadSkillIndex(root, {}, { home });
    expect(off.byId.has("gemini-thing")).toBe(false);
    const on = loadSkillIndex(root, { compat: { geminiSkills: true } }, { home });
    expect(on.byId.has("gemini-thing")).toBe(true);
  });

  test("block lista nombre+descripción, oculta disable-model-invocation", () => {
    writeSkill(join(root, ".agents", "skills"), "visible", baseFm("visible", "hacer cosas visibles"));
    writeSkill(join(root, ".agents", "skills"), "oculta", `${baseFm("oculta", "hacer cosas ocultas")}\ndisable-model-invocation: true`);
    const { block, hidden, byId } = loadSkillIndex(root, {}, { home });
    expect(block).toContain("visible: hacer cosas visibles");
    expect(block).not.toContain("oculta: hacer cosas ocultas");
    expect(hidden).toEqual(["oculta"]);
    expect(byId.has("oculta")).toBe(true); // sigue siendo cargable
  });

  test("metadata.opencode.autoinvoke: false también oculta", () => {
    writeSkill(join(root, ".agents", "skills"), "meta-oculta", `${baseFm("meta-oculta")}\nmetadata:\n  opencode:\n    autoinvoke: false`);
    const { hidden, block } = loadSkillIndex(root, {}, { home });
    expect(hidden).toEqual(["meta-oculta"]);
    expect(block).toBe("");
  });

  test("frontmatter completo: license, compatibility, allowed-tools, metadata", () => {
    writeSkill(join(root, ".agents", "skills"), "completa", [
      "name: completa",
      "description: skill con todo",
      "license: MIT",
      "compatibility: vireo >= 1",
      "allowed-tools: [read, grep]",
      "metadata:",
      "  autor: tests",
    ].join("\n"));
    const { byId, warnings } = loadSkillIndex(root, {}, { home });
    const rec = byId.get("completa")!;
    expect(rec.name).toBe("completa");
    expect(warnings.filter((w) => w.includes("clave desconocida"))).toEqual([]);
  });

  test("clave desconocida → aviso, no error", () => {
    writeSkill(join(root, ".agents", "skills"), "con-x", `${baseFm("con-x")}\nx-custom: algo`);
    const { warnings, byId } = loadSkillIndex(root, {}, { home });
    expect(byId.has("con-x")).toBe(true);
    expect(warnings.some((w) => w.includes("x-custom"))).toBe(true);
  });

  test("sin description o sin name → se descarta con aviso", () => {
    writeSkill(join(root, ".agents", "skills"), "sin-desc", "name: sin-desc");
    writeSkill(join(root, ".agents", "skills"), "sin-nombre", "description: solo descripcion");
    const { byId, warnings } = loadSkillIndex(root, {}, { home });
    expect(byId.size).toBe(0);
    expect(warnings.some((w) => w.includes("sin-desc"))).toBe(true);
    expect(warnings.some((w) => w.includes("sin-nombre"))).toBe(true);
  });

  test("name inválido o no casa con el dir → aviso, se carga igual", () => {
    writeSkill(join(root, ".agents", "skills"), "Mi_Dir", baseFm("Mi_Name"));
    const { byId, warnings } = loadSkillIndex(root, {}, { home });
    expect(byId.has("Mi_Dir")).toBe(true);
    expect(warnings.some((w) => w.includes("Mi_Name"))).toBe(true);
  });
});

describe("tool skill — carga bajo demanda", () => {
  const mkCtx = (skills: ReturnType<typeof loadSkillIndex>): ToolContext => ({
    cwd: root, sessionId: "s", signal: new AbortController().signal,
    ui: { confirm: async () => "once", question: async () => null, info: () => {} } as UiHooks,
    readFiles: new Set(), emit: () => {}, skills,
  });

  test("devuelve cuerpo, directorio y archivos de soporte (≤10)", async () => {
    const dir = writeSkill(join(root, ".agents", "skills"), "pdf", baseFm("pdf", "leer pdfs"), "PASO 1: abrir\nPASO 2: leer\n");
    writeFileSync(join(dir, "plantilla.py"), "print('x')\n");
    mkdirSync(join(dir, "refs"), { recursive: true });
    writeFileSync(join(dir, "refs", "tabla.md"), "referencia\n");
    const skills = loadSkillIndex(root, {}, { home });
    const res = await skillTool.run({ id: "pdf" }, mkCtx(skills));
    expect(res.output).toContain("PASO 1: abrir");
    expect(res.output).toContain(dir);
    expect(res.output).toContain("plantilla.py");
    expect(res.output).toContain("refs/tabla.md");
    expect(res.output).not.toContain("name: pdf"); // frontmatter fuera
  });

  test("id desconocido lista los disponibles; sin id → error claro", async () => {
    writeSkill(join(root, ".agents", "skills"), "una", baseFm("una"));
    const skills = loadSkillIndex(root, {}, { home });
    const ctx = mkCtx(skills);
    const res = await skillTool.run({ id: "no-existe" }, ctx);
    expect(res.output).toContain("desconocida");
    expect(res.output).toContain("una");
    const res2 = await skillTool.run({}, ctx);
    expect(res2.output).toContain("falta");
  });

  test("cuerpo > 16 KiB se trunca con aviso", async () => {
    const big = "linea de instrucciones\n".repeat(Math.ceil(MAX_BODY_CHARS / 22) + 50);
    writeSkill(join(root, ".agents", "skills"), "grande", baseFm("grande"), big);
    const rec = loadSkillIndex(root, {}, { home }).byId.get("grande")!;
    const out = skillBodyForModel(rec);
    expect(out).toContain("cuerpo truncado");
    expect(out.length).toBeLessThan(MAX_BODY_CHARS + 500);
  });
});
