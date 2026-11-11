// Arreglos pre-fase 8 (TODOs verificados): shell-scan conservador, ancho CJK/emoji,
// skills de Codex, plugins de Codex (.codex-plugin), comandos TOML de extensiones gemini.
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellSegments } from "../src/core/shell-scan.js";
import { visibleWidth, wrapAnsi, fitAnsi } from "../src/ui/ansi-wrap.js";
import { cellWidth } from "../src/ui/width.js";
import { PermissionEngine, baseRules } from "../src/core/permissions.js";
import { loadSkillIndex } from "../src/compat/skills.js";
import { discoverPlugins } from "../src/compat/plugins.js";
import { renderCommandBody } from "../src/compat/file-commands.js";

describe("shellSegments — splitter conservador", () => {
  test("divide &&, ||, ;, | y newline en el nivel superior", () => {
    expect(shellSegments("git status && rm -rf /")).toEqual(["git status", "rm -rf /"]);
    expect(shellSegments("a || b ; c | d\ne")).toEqual(["a", "b", "c", "d", "e"]);
  });
  test("respeta comillas simples y dobles (no divide dentro)", () => {
    expect(shellSegments(`echo "a && b" && echo 'c; d'`)).toEqual([`echo "a && b"`, `echo 'c; d'`]);
  });
  test("analiza $(…) y backticks como segmentos propios", () => {
    const segs = shellSegments("echo $(git rev-parse HEAD) && echo listo");
    expect(segs).toContain("git rev-parse HEAD");
    expect(segs[segs.length - 1]).toBe("echo listo");
    const bt = shellSegments("diff <(git show a) <(git show b); echo `uname -a`");
    expect(bt).toContain("uname -a");
  });
  test("heredoc → el cuerpo como segmento no existe; el resto sí (G2)", () => {
    const cmd = "cat <<EOF && echo nope\nhola\nEOF";
    // G2 (aprobado 2026-11-11): cuerpo y delimitador NO son comandos; el resto del
    // comando sí. Esto corrige el falso negativo de D1 («congelar ≠ bendecir»).
    expect(shellSegments(cmd)).toEqual(["cat <<EOF", "echo nope"]);
  });
  test("comilla sin cerrar → comando completo (conservador)", () => {
    const cmd = 'echo "sin cerrar && rm -rf /';
    expect(shellSegments(cmd)).toEqual([cmd]);
  });
  test("comando trivial / vacío", () => {
    expect(shellSegments("   ")).toEqual([]);
    expect(shellSegments("ls")).toEqual(["ls"]);
  });
});

describe("permisos bash con subcomandos — deny > ask > allow por segmento", () => {
  test("un deny en un segmento deniega aunque otro permita", () => {
    const e = new PermissionEngine([...baseRules(), { action: "bash", resource: "rm *", effect: "deny" }]);
    const segs = shellSegments("git status && rm -rf /tmp/x");
    const results = segs.map((s) => e.check("bash", s));
    expect(results.some((r) => r.effect === "deny")).toBe(true);
    // checkAll compone deny > ask > allow
    expect(e.checkAll("bash", segs).effect).toBe("deny");
  });
});

describe("width — CJK / emoji / combinantes", () => {
  test("ancho por punto de código", () => {
    expect(cellWidth("a".codePointAt(0)!)).toBe(1);
    expect(cellWidth("中".codePointAt(0)!)).toBe(2);
    expect(cellWidth("🎉".codePointAt(0)!)).toBe(2);
    expect(cellWidth(0x0301)).toBe(0); // ́  combining acute
    expect(cellWidth(0xfe0f)).toBe(0); // variation selector-16
  });
  test("visibleWidth cuenta celdas, no UTF-16 units", () => {
    expect(visibleWidth("abc")).toBe(3);
    expect(visibleWidth("中文")).toBe(4);
    expect(visibleWidth("é")).toBe(1); // e + acento combinante
    expect(visibleWidth("a🎉b")).toBe(4);
  });
  test("wrapAnsi respeta el ancho con caracteres anchos", () => {
    const out = wrapAnsi("中中中中", 4); // 8 celdas → 2 líneas de 2 ideogramas
    expect(out).toHaveLength(2);
    expect(out[0].text.replace(/\x1b\[0m/g, "")).toBe("中中");
    expect(out[0].continuation).toBe(false);
    expect(out[1].continuation).toBe(true);
  });
  test("un ideograma no se parte por la mitad en un límite impar", () => {
    const out = wrapAnsi("ab中cd", 3); // cells: a1 b2 中(+2→4>3 → salta de línea) ; 中(2) c(3) ⇒ llena ; d va sola
    expect(out[0].text.replace(/\x1b\[0m/g, "")).toBe("ab");
    expect(out[1].text.replace(/\x1b\[0m/g, "")).toBe("中c");
    expect(out[2].text.replace(/\x1b\[0m/g, "")).toBe("d");
  });
  test("fitAnsi padea por celdas", () => {
    expect(fitAnsi("中", 4)).toBe("中  ");
  });
});

describe("skills — Codex VERIFICADO ($CODEX_HOME/skills, defecto ~/.codex/skills; proyecto .codex/skills)", () => {
  let home: string, root: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "nicotine-fix-home-"));
    root = mkdtempSync(join(tmpdir(), "nicotine-fix-cwd-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    delete process.env.CODEX_HOME;
  });
  const writeSkill = (base: string, id: string, desc: string) => {
    const d = join(base, id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${id}\ndescription: ${desc}\n---\ncuerpo\n`);
  };
  test("global ~/.codex/skills se descubre", () => {
    writeSkill(join(home, ".codex", "skills"), "ship", "publica releases");
    const { byId } = loadSkillIndex(root, {}, { home });
    expect(byId.get("ship")?.description).toBe("publica releases");
  });
  test("proyecto .codex/skills se descubre", () => {
    writeSkill(join(root, ".codex", "skills"), "localship", "publica en este repo");
    const { byId } = loadSkillIndex(root, {}, { home });
    expect(byId.get("localship")).toBeTruthy();
  });
  test("$CODEX_HOME reemplaza ~/.codex", () => {
    const alt = mkdtempSync(join(tmpdir(), "nicotine-codexhome-"));
    process.env.CODEX_HOME = alt;
    writeSkill(join(alt, "skills"), "altship", "vive en CODEX_HOME");
    writeSkill(join(home, ".codex", "skills"), "novis", "no debe verse");
    const { byId } = loadSkillIndex(root, {}, { home });
    expect(byId.get("altship")).toBeTruthy();
    rmSync(alt, { recursive: true, force: true });
  });
});

describe("plugins — Codex .codex-plugin (VERIFICADO layout) y Gemini TOML commands (VERIFICADO)", () => {
  let home: string, root: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "nicotine-fix-home-"));
    root = mkdtempSync(join(tmpdir(), "nicotine-fix-cwd-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const write = (path: string, content: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); };

  test("codex plugin global: .codex-plugin/plugin.json + skills/ + .mcp.json en la RAÍZ", () => {
    write(join(home, ".codex/plugins/cool/.codex-plugin/plugin.json"), JSON.stringify({ name: "cool", version: "1.0.0", skills: "./skills/", mcpServers: "./.mcp.json" }));
    write(join(home, ".codex/plugins/cool/skills/revisor/SKILL.md"), "---\nname: revisor\ndescription: revisa\n---\ncuerpo\n");
    write(join(home, ".codex/plugins/cool/.mcp.json"), JSON.stringify({ mcpServers: { coolsrv: { command: "bun", args: ["srv.ts"] } } }));
    write(join(home, ".codex/plugins/cool/hooks/hooks.json"), JSON.stringify({ hooks: {} }));
    const r = discoverPlugins(root, { home });
    const p = r.plugins.find((p) => p.kind === "codex")!;
    expect(p.name).toBe("cool");
    expect(p.origin).toBe("global");
    expect(r.skillSources.some((s) => s.dir.endsWith(join("cool", "skills")))).toBe(true);
    expect(r.mcp.find((m) => m.name === "coolsrv" && m.origin === "global")).toBeTruthy();
    // hooks: reportados, NUNCA ejecutados
    expect(r.unsupported.some((u) => u.includes("cool") && u.includes("hooks"))).toBe(true);
    expect(r.hooks).toHaveLength(0);
  });

  test("codex plugin en caché de marketplace: ~/.codex/plugins/cache/<mkt>/<plugin>", () => {
    write(join(home, ".codex/plugins/cache/mkt/deep/.codex-plugin/plugin.json"), JSON.stringify({ name: "deep", version: "0.1.0" }));
    const r = discoverPlugins(root, { home });
    expect(r.plugins.find((p) => p.kind === "codex" && p.name === "deep")).toBeTruthy();
  });

  test("codex plugin de PROYECTO: raíz→cwd, compuerta como el resto de origen project", () => {
    write(join(root, ".codex/plugins/proj/.codex-plugin/plugin.json"), JSON.stringify({ name: "proj" }));
    write(join(root, ".codex/plugins/proj/.mcp.json"), JSON.stringify({ mcpServers: { projsrv: { command: "x" } } }));
    const r = discoverPlugins(root, { home });
    expect(r.plugins.find((p) => p.kind === "codex" && p.name === "proj" && p.origin === "project")).toBeTruthy();
    expect(r.mcp.find((m) => m.name === "projsrv" && m.origin === "project")).toBeTruthy();
  });

  test("gemini extension TOML commands: subdirs → namespace <ext>:a:b; {{args}} se normaliza", () => {
    write(join(home, ".gemini/extensions/gcp/gemini-extension.json"), JSON.stringify({ name: "gcp" }));
    write(join(home, ".gemini/extensions/gcp/commands/deploy.toml"), 'description = "despliega"\nprompt = "Despliega {{args}} a producción"\n');
    write(join(home, ".gemini/extensions/gcp/commands/gcs/sync.toml"), 'prompt = "Sincroniza el bucket {{args[0]}} con {{args[1]}}"\n');
    const r = discoverPlugins(root, { home });
    const dep = r.commands.find((c) => c.name === "gcp:deploy")!;
    expect(dep).toBeTruthy();
    expect(dep.plugin).toBe("gcp");
    expect(dep.body).toContain("$ARGUMENTS");
    expect(renderCommandBody(dep, "staging")).toContain("staging");
    const sync = r.commands.find((c) => c.name === "gcp:gcs:sync")!;
    expect(sync.body).toContain("$1");
    expect(sync.body).toContain("$2");
  });

  test("gemini TOML sin prompt → ignorado con aviso; TOML roto → aviso", () => {
    write(join(home, ".gemini/extensions/e/gemini-extension.json"), JSON.stringify({ name: "e" }));
    write(join(home, ".gemini/extensions/e/commands/broken.toml"), "no es = = toml válido {{{\n");
    write(join(home, ".gemini/extensions/e/commands/empty.toml"), 'description = "sin prompt"\n');
    const r = discoverPlugins(root, { home });
    expect(r.commands.find((c) => c.plugin === "e")).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("empty.toml"))).toBe(true);
  });
});
