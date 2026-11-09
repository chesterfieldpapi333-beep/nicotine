// Hooks de otras CLIs → antes/después de cada tool call.
//  Orígenes: ~/.claude/settings.json (global), <raíz→cwd>/.claude/settings.json
//  (project), <…>/.claude/settings.local.json (project), <plugin>/hooks/hooks.json.
//  SOLO type:"command" se ejecuta. PreToolUse: exit 2 bloquea la tool (stderr →
//  modelo); otros códigos → aviso y continuar. PostToolUse: fire-and-forget.
//  matcher: regex sobre tool name (ausente = todas). timeout: seg (def 5, máx 30).
//  Eventos sin equivalente (Notification, Stop, …) y tipos sin soporte → aviso,
//  nunca ejecución. El comando corre con bash, stdin = JSON {tool_name, args},
//  env con CLAUDE_PROJECT_DIR / VIREO_PROJECT_DIR / CLAUDE_PLUGIN_ROOT.
//  Origen proyecto → NUNCA se ejecutan sin confirmación (la hace el llamador,
//  ver preparePlugins); este módulo solo coleta y ejecuta.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { dirsRootToCwd } from "./util.js";

export interface HookCommand {
  event: "PreToolUse" | "PostToolUse";
  matcher: RegExp | null;
  command: string;
  timeoutMs: number;
  source: string;
  origin: "global" | "project";
  pluginRoot?: string;
}

export interface HooksReport {
  hooks: HookCommand[];
  warnings: string[];
  skipped: { source: string; detail: string }[];
}

export interface HookPluginSource { name: string; root: string; origin: "global" | "project" }

export function collectHooks(
  cwd: string,
  opts: { home?: string; plugins?: HookPluginSource[] } = {},
): HooksReport {
  const home = opts.home ?? homedir();
  const hooks: HookCommand[] = [];
  const warnings: string[] = [];
  const skipped: { source: string; detail: string }[] = [];

  const ingest = (file: string, origin: "global" | "project", pluginRoot?: string) => {
    if (!existsSync(file)) return;
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch { warnings.push(`${file}: ilegible`); return; }
    let json: unknown;
    try { json = JSON.parse(raw); } catch (e) { warnings.push(`${file}: JSON inválido (${(e as Error).message})`); return; }
    const root = (json as Record<string, unknown>)?.hooks;
    if (root === undefined) return; // sin hooks: normal
    if (!root || typeof root !== "object") { warnings.push(`${file}: «hooks» debe ser un objeto`); return; }
    for (const [eventRaw, groups] of Object.entries(root as Record<string, unknown>)) {
      const event = normalizeEvent(eventRaw);
      if (!event) { skipped.push({ source: file, detail: `evento «${eventRaw}» sin equivalente en vireo; omitido` }); continue; }
      if (!Array.isArray(groups)) { warnings.push(`${file}: hooks.${eventRaw} debe ser un array; omitido`); continue; }
      for (const group of groups) {
        const g = (group ?? {}) as Record<string, unknown>;
        const matcher = parseMatcher(g["matcher"], file, warnings);
        const cmds = g["hooks"];
        if (!Array.isArray(cmds)) { warnings.push(`${file}: grupo de hooks sin «hooks»: []; omitido`); continue; }
        for (const c of cmds) {
          const hook = parseHook(c, event, matcher, file, origin, pluginRoot, warnings, skipped);
          if (hook) hooks.push(hook);
        }
      }
    }
  };

  ingest(join(home, ".claude", "settings.json"), "global");
  for (const dir of dirsRootToCwd(cwd)) {
    ingest(join(dir, ".claude", "settings.json"), "project");
    ingest(join(dir, ".claude", "settings.local.json"), "project");
  }
  for (const p of opts.plugins ?? []) ingest(join(p.root, "hooks", "hooks.json"), p.origin, p.root);

  return { hooks, warnings, skipped };
}

const normalizeEvent = (e: string): HookCommand["event"] | null => {
  const k = e.toLowerCase().replace(/[_-]/g, "");
  if (k === "pretooluse") return "PreToolUse";
  if (k === "posttooluse") return "PostToolUse";
  return null;
};

const parseMatcher = (m: unknown, file: string, warnings: string[]): RegExp | null => {
  if (m === undefined || m === null || m === "" || m === "*") return null;
  if (typeof m !== "string") { warnings.push(`${file}: matcher no-string; se ignora el grupo`); return null; }
  try { return new RegExp(m); } catch { warnings.push(`${file}: matcher regex inválida «${m}»; grupo omitido`); return /$^/; } // nunca casa
};

const parseHook = (
  c: unknown,
  event: HookCommand["event"],
  matcher: RegExp | null,
  file: string,
  origin: "global" | "project",
  pluginRoot: string | undefined,
  warnings: string[],
  skipped: { source: string; detail: string }[],
): HookCommand | null => {
  const obj = (c ?? {}) as Record<string, unknown>;
  const type = String(obj["type"] ?? "command");
  if (type !== "command") { skipped.push({ source: file, detail: `hook tipo «${type}» no soportado (solo command); omitido` }); return null; }
  if (obj["async"] === true) { skipped.push({ source: file, detail: "hook async omitido (vireo ejecuta hooks síncronos)" }); return null; }
  const command = typeof obj["command"] === "string" ? obj["command"].trim() : "";
  if (!command) { warnings.push(`${file}: hook command vacío; omitido`); return null; }
  const timeoutSec = typeof obj["timeout"] === "number" ? Math.min(Math.max(1, obj["timeout"]), 30) : 5;
  return { event, matcher, command, timeoutMs: timeoutSec * 1000, source: file, origin, pluginRoot };
};

export interface HookRunResult { blocked: boolean; reason?: string; warnings: string[] }

/** Ejecuta los hooks de un evento para (tool, args). */
export async function runHooks(
  hooks: HookCommand[],
  event: HookCommand["event"],
  toolName: string,
  args: Record<string, unknown>,
  env: { cwd: string; projectDir: string },
): Promise<HookRunResult> {
  const warnings: string[] = [];
  for (const hook of hooks) {
    if (hook.event !== event) continue;
    if (hook.matcher && !hook.matcher.test(toolName)) continue;
    const expanded = expandVars(hook.command, env.projectDir, hook.pluginRoot);
    const run = await execHook(expanded, toolName, args, env, hook);
    if (event === "PreToolUse" && run.code === 2) {
      const reason = (run.stderr || run.stdout || "bloqueado por hook").trim().slice(0, 500);
      return { blocked: true, reason, warnings };
    }
    if (run.code !== 0 && run.code !== 2) {
      warnings.push(`hook ${event} falló (exit ${run.code})${run.stderr ? `: ${run.stderr.trim().slice(0, 200)}` : ""}`);
    }
  }
  return { blocked: false, warnings };
}

const expandVars = (command: string, projectDir: string, pluginRoot?: string): string =>
  command
    .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, projectDir)
    .replace(/\$CLAUDE_PROJECT_DIR\b/g, projectDir)
    .replace(/\$\{VIREO_PROJECT_DIR\}/g, projectDir)
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot ?? projectDir)
    .replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, pluginRoot ?? projectDir);

function execHook(
  command: string,
  toolName: string,
  args: Record<string, unknown>,
  env: { cwd: string; projectDir: string },
  hook: HookCommand,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const payload = JSON.stringify({ tool_name: toolName, args });
    const child = execFile("bash", ["-lc", command], {
      cwd: env.cwd,
      timeout: hook.timeoutMs,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: env.projectDir,
        VIREO_PROJECT_DIR: env.projectDir,
        ...(hook.pluginRoot ? { CLAUDE_PLUGIN_ROOT: hook.pluginRoot, CLAUDE_PLUGIN_DATA: hook.pluginRoot } : {}),
      },
    }, (error, stdout, stderr) => {
      let code = 0;
      if (error) code = typeof error.code === "number" ? error.code : 1;
      if (child.killed) code = 124; // timeout
      resolveRun({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
    // el hijo puede salir sin leer stdin → EPIPE en el stream: silenciarlo
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.write(payload);
      child.stdin?.end();
    } catch { /* stdin ya cerrado */ }
  });
}
