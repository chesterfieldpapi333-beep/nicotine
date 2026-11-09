// Plugins multi-CLI (fase 7): descubrimiento (datos, nunca ejecución), comandos
// de archivo, temas ajenos, agentes de archivo, hooks, MCP extra y su compuerta.
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPlugins } from "../src/compat/plugins.js";
import { renderCommandBody } from "../src/compat/file-commands.js";
import { collectHooks, runHooks } from "../src/compat/hooks.js";
import { registerExtraAgents, clearExtraAgents, findAgent, allAgents } from "../src/core/agents.js";
import { connectMcpServers, closeMcpClients } from "../src/compat/mcp/manager.js";
import type { UiHooks } from "../src/core/types.js";

let home: string;
let root: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vireo-home-"));
  root = mkdtempSync(join(tmpdir(), "vireo-cwd-"));
  clearExtraAgents();
});
afterEach(() => {
  clearExtraAgents();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});
afterAll(() => clearExtraAgents());

const write = (path: string, content: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); };

const mkClaudePlugin = () => {
  write(join(home, ".claude/plugins/cool/.claude-plugin/plugin.json"), JSON.stringify({ name: "cool", version: "1.0.0", description: "demo" }));
  write(join(home, ".claude/plugins/cool/commands/deploy.md"), "---\ndescription: despliega\nargument-hint: <env>\n---\nDeploya a $ARGUMENTS con $1 (token $2)");
  write(join(home, ".claude/plugins/cool/agents/reviewer.md"), "---\ndescription: revisor de diffs\ntools: Read, Grep\n---\nRevisa con rigor.");
  write(join(home, ".claude/plugins/cool/skills/ship/SKILL.md"), "---\nname: ship\ndescription: envía releases\n---\nship body");
  write(join(home, ".claude/plugins/cool/hooks/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "^bash$", hooks: [{ type: "command", command: "echo pre >> /tmp/vireo-hook-test.marker" }] }] } }));
};

describe("discoverPlugins — datos multi-CLI", () => {
  test("claude plugin global: manifest, comandos namespaced, agentes, skills, hooks", () => {
    mkClaudePlugin();
    const r = discoverPlugins(root, { home });
    const plugin = r.plugins.find((p) => p.kind === "claude")!;
    expect(plugin.name).toBe("cool");
    expect(plugin.origin).toBe("global");
    expect(r.commands.find((c) => c.name === "cool:deploy")).toBeTruthy();
    expect(r.commands.find((c) => c.name === "cool:deploy")!.hint).toBe("<env>");
    expect(r.agents.find((a) => a.id === "cool:reviewer")?.toolAllow).toEqual(["read", "grep"]);
    expect(r.skillSources.some((s) => s.dir.endsWith(join("cool", "skills")))).toBe(true);
    expect(r.hooks.length).toBe(1);
    expect(r.hooks[0].pluginRoot).toBeTruthy();
    expect(r.warnings).toHaveLength(0);
  });

  test("proyecto: .mcp.json + .codex/config.toml + .opencode/commands + agentes", () => {
    write(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { desdejson: { command: "bun", args: ["srv.ts"] } } }));
    write(join(root, ".codex", "config.toml"), '[mcp_servers.desdetoml]\ncommand = "bun"\nargs = ["codex-srv.ts"]\nenv = { TOKEN = "x" }\n');
    write(join(root, ".opencode", "commands", "review.md"), "---\ndescription: revisa el PR\n---\nRevisa $ARGUMENTS");
    write(join(root, ".claude", "agents", "critic.md"), "---\ndescription: critica el plan\n---\nCritica.");
    const r = discoverPlugins(root, { home });
    expect(r.mcp.find((m) => m.name === "desdejson" && m.origin === "project")).toBeTruthy();
    expect(r.mcp.find((m) => m.name === "desdetoml" && m.origin === "project")).toBeTruthy();
    expect(r.mcp.find((m) => m.name === "desdetoml")!.raw["command"]).toBe("bun");
    expect(r.commands.find((c) => c.name === "review" && c.origin === "project")).toBeTruthy();
    expect(r.agents.find((a) => a.id === "critic" && a.mode === "subagent")).toBeTruthy();
  });

  test(".opencode/plugins/*.ts → reporte unsupported, nunca se ejecuta", () => {
    write(join(root, ".opencode", "plugins", "watcher.ts"), "process.exit(1) // jamás debe correr\n");
    const r = discoverPlugins(root, { home });
    expect(r.unsupported.some((u) => u.includes("watcher.ts"))).toBe(true);
  });

  test("gemini extension global: mcpServers + excludeTools + contextFileName", () => {
    write(join(home, ".gemini/extensions/gem/gemini-extension.json"), JSON.stringify({
      name: "gem",
      contextFileName: "GEMINI.md",
      mcpServers: { gemsrv: { command: "bun", args: ["gem-srv.ts"] } },
      excludeTools: ["fail"],
    }));
    write(join(home, ".gemini/extensions/gem/GEMINI.md"), "contexto gem");
    const r = discoverPlugins(root, { home });
    const srv = r.mcp.find((m) => m.name === "gemsrv")!;
    expect(srv.origin).toBe("global");
    expect(srv.excludeTools).toEqual(["fail"]);
    expect(r.contextFiles.some((c) => c.path.endsWith("GEMINI.md"))).toBe(true);
  });

  test("temas opencode shape B: primary/text/background mapean; sin mapeo → descartado", () => {
    write(join(root, ".opencode", "themes", "midnight.json"), JSON.stringify({ theme: { primary: "#fabd2f", text: "#ebdbb2", background: "#282828", weirdUnmapped: "x" } }));
    write(join(root, ".opencode", "themes", "broken.json"), JSON.stringify({ theme: { zzz: "nope", yyy: "nada" } }));
    const r = discoverPlugins(root, { home });
    const t = r.themes.find((t) => t.name === "midnight")!;
    expect(t.tokens.accent).toBe("#fabd2f");
    expect(t.tokens.fg).toBe("#ebdbb2");
    expect(t.tokens.bg).toBe("#282828");
    expect(r.themes.find((t) => t.name === "broken")).toBeUndefined();
  });

  test("codex TOML ilegible → aviso, no crash", () => {
    write(join(root, ".codex", "config.toml"), "[mcp_servers.roto\nesta línea no es toml = = =\n");
    const r = discoverPlugins(root, { home });
    expect(r.warnings.some((w) => w.includes("config.toml"))).toBe(true);
  });
});

describe("renderCommandBody", () => {
  test("$ARGUMENTS y posicionales $1..$9", () => {
    const cmd = { name: "x", hint: "", description: "", body: "a=$ARGUMENTS b=$1 c=$2 d=$9", source: "x", origin: "project" as const };
    expect(renderCommandBody(cmd, "uno dos tres")).toBe("a=uno dos tres b=uno c=dos d=");
    expect(renderCommandBody(cmd, '"con comillas" segundo')).toBe('a="con comillas" segundo b=con comillas c=segundo d=');
  });
});

describe("hooks — ejecución", () => {
  const markerPath = () => join(root, "marker.log");
  test("PreToolUse matcher casa → marca; exit 2 bloquea con razón", async () => {
    write(join(root, ".claude", "settings.json"), JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "^bash$", hooks: [{ type: "command", command: `printf pre-bash >> ${markerPath()}` }] },
          { matcher: "^bash$", hooks: [{ type: "command", command: "echo no-pasa >&2; exit 2" }] },
        ],
      },
    }));
    const r = collectHooks(root, { home });
    expect(r.hooks.length).toBe(2);
    const res = await runHooks(r.hooks, "PreToolUse", "bash", { command: "ls" }, { cwd: root, projectDir: root });
    expect(res.blocked).toBe(true);
    expect(res.reason).toContain("no-pasa");
    const resWrite = await runHooks(r.hooks, "PreToolUse", "write", {}, { cwd: root, projectDir: root });
    expect(resWrite.blocked).toBe(false);
  });

  test("PreToolUse no bloquea en read; PostToolUse fire-and-forget", async () => {
    write(join(root, ".claude", "settings.json"), JSON.stringify({
      hooks: { PostToolUse: [{ hooks: [{ type: "command", command: `printf post >> ${markerPath()}` }] }] },
    }));
    const r = collectHooks(root, { home });
    const res = await runHooks(r.hooks, "PostToolUse", "write", { path: "x" }, { cwd: root, projectDir: root });
    expect(res.blocked).toBe(false);
    expect(readFileSync(markerPath(), "utf8")).toBe("post");
  });

  test("hooks sin matcher (= todas) y variables ${CLAUDE_PROJECT_DIR}", async () => {
    write(join(root, ".claude", "settings.json"), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: 'test "$CLAUDE_PROJECT_DIR" = "' + root + '" && exit 2' }] }] },
    }));
    const r = collectHooks(root, { home });
    const res = await runHooks(r.hooks, "PreToolUse", "read", {}, { cwd: root, projectDir: root });
    expect(res.blocked).toBe(true);
  });

  test("eventos sin equivalente → skipped, no ejecución", () => {
    write(join(root, ".claude", "settings.json"), JSON.stringify({
      hooks: { Notification: [{ hooks: [{ type: "command", command: "exit 2" }] }], UserPromptSubmit: [{ hooks: [{ type: "command", command: "exit 2" }] }] },
    }));
    const r = collectHooks(root, { home });
    expect(r.hooks).toHaveLength(0);
    expect(r.skipped.length).toBe(2);
  });
});

describe("agentes de archivo — registro y allowlist", () => {
  test("registerExtraAgents → findAgent los resuelve; toolAllow filtra", () => {
    write(join(root, ".claude", "agents", "solo-read.md"), "---\ndescription: solo lectura\ntools: read, grep\n---\nLee.");
    const r = discoverPlugins(root, { home });
    registerExtraAgents(r.agents);
    const def = findAgent("solo-read");
    expect(def.toolAllow).toEqual(["read", "grep"]);
    expect(allAgents().some((a) => a.id === "solo-read")).toBe(true);
  });
});

describe("MCP extra (otras CLIs) — compuerta y merge", () => {
  const FIXTURE = join(import.meta.dir, "fixtures", "fake-mcp-server.ts");
  const BUN = process.execPath;
  const ui = (decision: "once" | "reject"): UiHooks & { confirms: number } => {
    const self = { confirms: 0, confirm: async () => { self.confirms++; return decision; }, question: async () => null, info: () => {} };
    return self as never;
  };
  const stdioRaw = { command: BUN, args: [FIXTURE], environment: { FAKE_MCP_MODE: "legacy" } };

  test("extraDef de proyecto pide confirmación; rechazo → untrusted, 0 tools", async () => {
    const u = ui("reject");
    const rt = await connectMcpServers({ config: {}, mcpOrigins: {}, ui: u, cwd: root, extraDefs: [{ name: "exta", raw: stdioRaw, origin: "project", source: "/tmp/.mcp.json" }] });
    expect(rt.servers[0].state).toBe("untrusted");
    expect(rt.tools).toHaveLength(0);
    await closeMcpClients(rt);
  });

  test("extraDef conectado; excludeTools oculta la tool", async () => {
    const u = ui("once");
    const rt = await connectMcpServers({ config: {}, mcpOrigins: {}, ui: u, cwd: root, extraDefs: [{ name: "extb", raw: stdioRaw, origin: "project", source: "/tmp/.mcp.json", excludeTools: ["echo"] }] });
    expect(rt.servers[0].state).toBe("connected");
    expect(rt.tools.find((t) => t.name === "extb_echo")).toBeUndefined();
    expect(rt.tools.find((t) => t.name === "extb_fail")).toBeDefined();
    await closeMcpClients(rt);
  });

  test("colisión con config nativa: la nativa gana", async () => {
    const u = ui("once");
    const rt = await connectMcpServers({
      config: { mcp: { mezclado: { command: [BUN, FIXTURE], environment: { FAKE_MCP_MODE: "legacy" } } } },
      mcpOrigins: { mezclado: "global" },
      ui: u,
      cwd: root,
      extraDefs: [{ name: "mezclado", raw: stdioRaw, origin: "project", source: "/tmp/.mcp.json" }],
    });
    expect(rt.servers[0].origin).toBe("global"); // no project → no preguntó
    expect(u.confirms).toBe(0);
    await closeMcpClients(rt);
  });
});
