// Arranque común de todos los modos: config → permisos → sesión → contexto.

import { PermissionEngine } from "../core/permissions.js";
import { loadConfig } from "../core/config.js";
import { findAgent, allAgents, registerExtraAgents } from "../core/agents.js";
import { Session } from "../core/session.js";
import { buildSystemPrompt } from "../core/context.js";
import { EventBus, type TokenUsage, type AgentEvent } from "../core/events.js";
import { FlatUi } from "../ui/flat.js";
import { resolveProvider, type ProviderConfig } from "../core/provider.js";
import { compactionFromConfig, maybeCompact, estimateTokens, type CompactionConfig } from "../core/compact.js";
import { UndoManager } from "../core/undo.js";
import { loadContextFiles, type ContextFilesResult } from "../compat/context-files.js";
import { loadSkillIndex, type SkillIndex } from "../compat/skills.js";
import { connectMcpServers, closeMcpClients, type McpRuntime } from "../compat/mcp/manager.js";
import type { McpServerStatus } from "../compat/mcp/types.js";
import { loadProjectApprovals, saveProjectApproval } from "../core/approvals.js";
import type { McpPromptInfo } from "../compat/mcp/client.js";
import type { AgentTool, ChatMessage, ToolContext } from "../core/types.js";
import { ALL_TOOLS } from "../tools/index.js";
import { runAgentLoop } from "../core/loop.js";
import { discoverPlugins, type PluginsReport } from "../compat/plugins.js";
import { parseConfigCommands, type ConfigCommand } from "../compat/config-commands.js";
import { runHooks } from "../compat/hooks.js";
import { readFileSync } from "node:fs";

export interface RuntimeOptions {
  cwd: string;
  configDir?: string;
  auto: boolean;
  agentId?: string;
  modelFlag?: string;
  sessionId?: string;
  continueLatest?: boolean;
  /** false = no conectar la FlatUi al bus (modo --json). */
  attachUi?: boolean;
  /** Señal externa para Ctrl+C; si no se pasa, se crea una interna. */
  signal?: AbortSignal;
  /** Bifurca la sesión cargada (--fork): conserva historial, session id nuevo. */
  fork?: boolean;
  /** fetch inyectable (tests / serve). Los subagentes lo heredan. */
  fetchImpl?: typeof fetch;
}

export interface Runtime {
  config: Record<string, unknown>;
  layers: string[];
  provider: ProviderConfig;
  permissions: PermissionEngine;
  session: Session;
  bus: EventBus;
  ui: FlatUi;
  ctx: ToolContext;
  messages: ChatMessage[];
  tools: AgentTool[];
  /** Presente solo si common creó el suyo (compat). */
  abort?: AbortController;
  usageTotals: TokenUsage;
  compaction: CompactionConfig;
  /** Cambio de agente en caliente (reconstruye permisos + system prompt). */
  agent: { current(): string; set(id: string): boolean; list(): string[] };
  /** Archivos de contexto cargados (AGENTS.md/CLAUDE.md/GEMINI.md/instructions). */
  contextFiles: ContextFilesResult;
  /** Índice de skills cargado al arranque. */
  skills: SkillIndex;
  /** Avisos de config y de compat (skills/contexto) — para `doctor`. */
  warnings: string[];
  /** Nombre de servidor mcp → capa de origen. */
  mcpOrigins: Record<string, "system" | "global" | "project" | "custom">;
  /** Estado de los servidores MCP tras `prepareMcp` (vacío hasta entonces). */
  mcp: { servers: McpServerStatus[]; prompts: { server: string; prompt: McpPromptInfo }[] };
  /** Clientes MCP vivos (para cerrar al final). */
  mcpClients?: McpRuntime;
  /** Path tal como aparece en `extensions` → capa de origen. */
  extensionOrigins: Record<string, "system" | "global" | "project" | "custom">;
  /** Reporte del descubrimiento multi-CLI (fase 7). */
  plugins: PluginsReport;
  /** Comandos custom desde `commands: {}` en config (spec JSON, verificado). */
  configCommands: ConfigCommand[];
}

export function buildRuntime(opts: RuntimeOptions): Runtime {
  // Descubrimiento multi-CLI (fase 7): SOLO filesystem; nunca lanza y nunca
  // ejecuta código de terceros (plugins .ts → reporte «no soportado»).
  let plugins: PluginsReport;
  try {
    plugins = discoverPlugins(opts.cwd);
  } catch (err) {
    plugins = { plugins: [], warnings: [`descubrimiento multi-CLI falló: ${(err as Error).message}`], unsupported: [], mcp: [], commands: [], themes: [], agents: [], hooks: [], hooksSkipped: [], contextFiles: [], skillSources: [] };
  }
  registerExtraAgents(plugins.agents);
  const { config, rules, policies, layers, warnings: configWarnings, mcpOrigins, extensionOrigins } = loadConfig(opts.cwd, { configDir: opts.configDir });
  const savedApprovals = loadProjectApprovals(opts.cwd).map((a) => ({ action: a.action, resource: a.resource, effect: "allow" as const }));
  const contextFiles = loadContextFiles(opts.cwd, config);
  // contexto extra de plugins de Gemini (contextFileName)
  let contextBlock = contextFiles.block;
  for (const cf of plugins.contextFiles.slice(0, 4)) {
    try {
      const content = readFileSync(cf.path, "utf8").slice(0, 32 * 1024);
      contextBlock += `\n\n## ${cf.path} (gemini extension)\n\n${content}`;
    } catch { /* aviso ya emitido en el descubrimiento */ }
  }
  const skillIndex = loadSkillIndex(opts.cwd, config, { extraSources: plugins.skillSources });
  const configCommands = parseConfigCommands(config["commands"]);
  const compatWarnings = [...contextFiles.warnings, ...skillIndex.warnings, ...plugins.warnings, ...configCommands.warnings.map((w) => `commands: ${w}`)];
  // default_agent desconocido NO tumba la sesión: aviso + fallback a build
  // (--agent explícito sí es un error). Spec: fallback «build → primer primary visible».
  const defaultAgent = opts.agentId ?? (config["default_agent"] as string | undefined);
  let agent;
  try {
    agent = findAgent(defaultAgent);
  } catch (err) {
    if (opts.agentId) throw err;
    compatWarnings.push(`default_agent «${String(defaultAgent)}» desconocido; se usa «build» (${(err as Error).message})`);
    agent = findAgent(undefined);
  }
  const provider = resolveProvider(config, opts.modelFlag);

  let session: Session;
  if (opts.sessionId) {
    const s = Session.load(opts.sessionId);
    if (!s) throw new Error(`sesión no encontrada: ${opts.sessionId}`);
    session = s;
  } else if (opts.continueLatest) {
    session = Session.latest() ?? Session.create(opts.cwd);
  } else {
    session = Session.create(opts.cwd);
  }
  if (opts.fork) session = Session.forkFrom(session, opts.cwd);

  const abort: { signal: AbortSignal } = opts.signal ? { signal: opts.signal } : new AbortController();
  const bus = new EventBus();
  const ui = new FlatUi({ auto: opts.auto });
  if (opts.attachUi !== false) ui.attach(bus);
  for (const w of [...configWarnings, ...compatWarnings]) ui.info(`config: ${w}`);
  const compatCfg = (config["compat"] ?? {}) as Record<string, unknown>;
  const textToolCalls = compatCfg["text_tool_calls"] !== false;
  const readFiles = new Set<string>();
  // `snapshots: false` en config desactiva el undo por completo (ni gestor ni
  // directorios); cualquier otro valor lo deja activo.
  const undo = config["snapshots"] === false ? undefined : new UndoManager(session.id);
  const ctx: ToolContext = {
    cwd: opts.cwd,
    sessionId: session.id,
    signal: abort.signal,
    ui,
    readFiles,
    emit: (ev) => bus.emit(ev),
    isSubagent: false,
    undo,
    skills: skillIndex,
    textToolCalls,
    approvals: { save: (action, resource) => saveProjectApproval(opts.cwd, action, resource) },
  };

  const promptOpts = { contextBlock, skillBlock: skillIndex.block };
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt({ cwd: opts.cwd, agent, ...promptOpts }) },
    ...session.messages(),
  ];

  const withSaved = (agentRules: import("../core/permissions.js").Rule[]) =>
    new PermissionEngine([...rules, ...savedApprovals, ...agentRules], policies);

  let currentAgentId = agent.id;
  const agentCtl = {
    current: () => currentAgentId,
    list: () => allAgents().filter((a) => a.mode !== "subagent").map((a) => a.id),
    set: (id: string): boolean => {
      let next;
      try { next = findAgent(id); } catch { return false; }
      if (next.mode === "subagent") return false;
      currentAgentId = next.id;
      rt.permissions = withSaved(next.permissionRules);
      rt.messages[0] = { role: "system", content: buildSystemPrompt({ cwd: opts.cwd, agent: next, ...promptOpts }) };
      return true;
    },
  };
  ctx.switchAgent = (id) => agentCtl.set(id);

  // Subagentes: loop anidado, depth 1, sin `task` ni plan-*, en su propia sesión JSONL
  const runSubagent: ToolContext["runSubagent"] = async ({ agentId, prompt, description }) => {
    let subAgent;
    try { subAgent = findAgent(agentId); } catch { return `Error: subagente desconocido: ${agentId}. Disponibles: general, explore (y los definidos en agents/*)`; }
    const label = (description || prompt || "task").replace(/\s+/g, " ").slice(0, 80);
    const child = Session.create(opts.cwd);
    child.setTitle(`task: ${label}`);
    const childMessages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt({ cwd: opts.cwd, agent: subAgent, ...promptOpts }) },
      { role: "user", content: prompt },
    ];
    const childReadFiles = new Set<string>();
    const childCtx: ToolContext = {
      cwd: opts.cwd,
      sessionId: child.id,
      signal: ctx.signal,
      ui: { ...ctx.ui, question: async () => null }, // un subagente no debe interrumpir al usuario
      readFiles: childReadFiles,
      emit: (ev) => bus.emit(tagSubagentEvent(ev, subAgent.id)),
      isSubagent: true,
      undo, // comparte el gestor: sus ediciones quedan en el mismo undo por turno
      skills: skillIndex,
      textToolCalls,
    };
    const subPermissions = withSaved(subAgent.permissionRules);
    const subTools = ALL_TOOLS
      .filter((t) => (subAgent.toolAllow ? subAgent.toolAllow.includes(t.name) : true))
      .filter((t) => !["task", "plan-enter", "plan-exit"].includes(t.name));
    const reason = await runAgentLoop({ provider, permissions: subPermissions, messages: childMessages, tools: subTools, ctx: childCtx, maxSteps: 30, fetchImpl: opts.fetchImpl });
    for (const m of childMessages.slice(1)) child.appendMessage(m);
    const final = [...childMessages].reverse().find((m) => m.role === "assistant" && m.content)?.content ?? "(sin respuesta final)";
    const truncated = final.length > 4000 ? `${final.slice(0, 4000)}\n…(respuesta truncada; ver sesión ${child.id})` : final;
    return `Subagente «${subAgent.id}» terminó (${reason}); sesión ${child.id}.\n${truncated}`;
  };
  ctx.runSubagent = runSubagent;

  const rt = {
    config, layers, provider, permissions: withSaved(agent.permissionRules), session, bus, ui, ctx, messages,
    tools: ALL_TOOLS,
    usageTotals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    compaction: compactionFromConfig(config),
    agent: agentCtl,
    contextFiles,
    skills: skillIndex,
    warnings: [...configWarnings, ...compatWarnings],
    mcpOrigins,
    mcp: { servers: [], prompts: [] },
    extensionOrigins,
    plugins,
    configCommands: configCommands.commands,
  };
  return rt;
}

/**
 * Prepara hooks de otras CLIs (fase 7): los de origen PROYECTO piden
 * confirmación UNA vez por sesión aquí (antes del primer tool call);
 * los globales (home) se ejecutan sin preguntar. Si el usuario rechaza,
 * solo los globales quedan activos.
 */
export async function prepareHooks(rt: Runtime): Promise<void> {
  const all = rt.plugins.hooks;
  const projectHooks = all.filter((h) => h.origin === "project");
  let enabled = all;
  if (projectHooks.length) {
    const sources = [...new Set(projectHooks.map((h) => h.source))].map((s) => `  ${s}`).join("\n");
    const decision = await rt.ctx.ui.confirm({
      action: "hooks",
      resource: `${projectHooks.length} hook(s) de proyecto`,
      diff: `hooks de PROYECTO (se ejecutarán en CADA llamada a tool):\n${sources}\nSolo acepta si confías en este código.`,
    });
    if (decision === "reject") {
      enabled = all.filter((h) => h.origin === "global");
      rt.ctx.ui.info("hooks de proyecto: rechazados; NO se ejecutarán");
    }
  }
  const env = { cwd: rt.ctx.cwd, projectDir: rt.ctx.cwd };
  rt.ctx.hooks = {
    preTool: async (tool, args) => {
      const r = await runHooks(enabled, "PreToolUse", tool, args, env);
      for (const w of r.warnings) rt.ctx.ui.info(w);
      return r.blocked ? `bloqueado por hook PreToolUse: ${r.reason ?? ""}`.trim() : null;
    },
    postTool: async (tool, args) => {
      const r = await runHooks(enabled, "PostToolUse", tool, args, env);
      for (const w of r.warnings) rt.ctx.ui.info(w);
    },
  };
}

/**
 * Conecta los servidores MCP declarados en la config (await antes del primer
 * turno). Nunca rompe el arranque: fallos → aviso + servidor ausente.
 * Las tools MCP se registran en rt.tools y los subagentes NO las heredan.
 */
export async function prepareMcp(rt: Runtime): Promise<void> {
  const mcp = await connectMcpServers({
    config: rt.config,
    mcpOrigins: rt.mcpOrigins,
    ui: rt.ctx.ui,
    cwd: rt.ctx.cwd,
    extraDefs: rt.plugins.mcp,
  });
  rt.mcpClients = mcp;
  rt.mcp = { servers: mcp.servers, prompts: mcp.prompts };
  rt.tools.push(...mcp.tools);
  for (const st of mcp.servers) {
    const detail = st.state === "connected" ? `${st.protocol} · ${st.toolCount} tools`
      : st.state === "disabled" ? "deshabilitado"
      : st.state === "untrusted" ? "omitido (no confiado)"
      : `FALLO — ${st.error ?? "?"}`;
    rt.ctx.ui.info(`mcp «${st.name}»: ${detail}`);
  }
}

/** Cierra los clientes MCP (llamar al final de la sesión / en tests). */
export async function closeMcp(rt: Runtime): Promise<void> {
  await closeMcpClients(rt.mcpClients);
}

/** Compacta los mensajes si toca. Llamar justo antes de runAgentLoop. */
export async function prepareContext(rt: Runtime, fetchImpl?: typeof fetch): Promise<void> {
  await maybeCompact({
    messages: rt.messages,
    provider: rt.provider,
    config: rt.compaction,
    emit: (ev) => rt.bus.emit(ev),
    fetchImpl,
  });
}

/** Compactación manual (/compact). */
export async function compactNow(rt: Runtime): Promise<{ beforeTokens: number; afterTokens: number; compacted: boolean }> {
  const before = estimateTokens(rt.messages);
  const res = await maybeCompact({ messages: rt.messages, provider: rt.provider, config: rt.compaction, emit: (ev) => rt.bus.emit(ev), force: true });
  return { ...res, beforeTokens: before, afterTokens: estimateTokens(rt.messages) };
}

/** Bifurca la sesión actual en una NUEVA y devuelve la nueva (el historial se hereda). */
export function forkCurrentSession(rt: Runtime): Session {
  const fork = Session.forkFrom(rt.session, rt.ctx.cwd);
  return fork;
}

/** Prefija las tools de subagente en los eventos para que la UI los distinga. */
function tagSubagentEvent(ev: AgentEvent, agentId: string): AgentEvent {
  if (ev.type === "tool_start" || ev.type === "tool_end") return { ...ev, name: `[${agentId}] ${ev.name}` };
  return ev;
}

/** Persiste los mensajes nuevos de la sesión (los que no existían al arrancar). */
export function persistNewMessages(rt: Runtime, fromIndex: number): void {
  for (const msg of rt.messages.slice(fromIndex)) {
    if (msg.role === "system") continue; // el system prompt no se persiste
    rt.session.appendMessage(msg);
  }
}
