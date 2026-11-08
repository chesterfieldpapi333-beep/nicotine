// Arranque común de todos los modos: config → permisos → sesión → contexto.

import { PermissionEngine } from "../core/permissions.js";
import { loadConfig } from "../core/config.js";
import { findAgent, BUILTIN_AGENTS } from "../core/agents.js";
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
import type { AgentTool, ChatMessage, ToolContext } from "../core/types.js";
import { ALL_TOOLS } from "../tools/index.js";
import { runAgentLoop } from "../core/loop.js";

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
  mcp: { servers: McpServerStatus[] };
  /** Clientes MCP vivos (para cerrar al final). */
  mcpClients?: McpRuntime;
}

export function buildRuntime(opts: RuntimeOptions): Runtime {
  const { config, rules, layers, warnings: configWarnings, mcpOrigins } = loadConfig(opts.cwd, { configDir: opts.configDir });
  const contextFiles = loadContextFiles(opts.cwd, config);
  const skillIndex = loadSkillIndex(opts.cwd, config);
  const compatWarnings = [...contextFiles.warnings, ...skillIndex.warnings];
  const agent = findAgent(opts.agentId ?? (config["default_agent"] as string | undefined));
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
  const readFiles = new Set<string>();
  const undo = new UndoManager(session.id);
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
  };

  const promptOpts = { contextBlock: contextFiles.block, skillBlock: skillIndex.block };
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt({ cwd: opts.cwd, agent, ...promptOpts }) },
    ...session.messages(),
  ];

  let currentAgentId = agent.id;
  const agentCtl = {
    current: () => currentAgentId,
    list: () => BUILTIN_AGENTS.filter((a) => a.mode === "primary").map((a) => a.id),
    set: (id: string): boolean => {
      let next;
      try { next = findAgent(id); } catch { return false; }
      if (next.mode === "subagent") return false;
      currentAgentId = next.id;
      rt.permissions = new PermissionEngine([...rules, ...next.permissionRules]);
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
    };
    const subPermissions = new PermissionEngine([...rules, ...subAgent.permissionRules]);
    const subTools = ALL_TOOLS.filter((t) => !["task", "plan-enter", "plan-exit"].includes(t.name));
    const reason = await runAgentLoop({ provider, permissions: subPermissions, messages: childMessages, tools: subTools, ctx: childCtx, maxSteps: 30, fetchImpl: opts.fetchImpl });
    for (const m of childMessages.slice(1)) child.appendMessage(m);
    const final = [...childMessages].reverse().find((m) => m.role === "assistant" && m.content)?.content ?? "(sin respuesta final)";
    const truncated = final.length > 4000 ? `${final.slice(0, 4000)}\n…(respuesta truncada; ver sesión ${child.id})` : final;
    return `Subagente «${subAgent.id}» terminó (${reason}); sesión ${child.id}.\n${truncated}`;
  };
  ctx.runSubagent = runSubagent;

  const rt = {
    config, layers, provider, permissions: new PermissionEngine([...rules, ...agent.permissionRules]), session, bus, ui, ctx, messages,
    tools: ALL_TOOLS,
    usageTotals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    compaction: compactionFromConfig(config),
    agent: agentCtl,
    contextFiles,
    skills: skillIndex,
    warnings: [...configWarnings, ...compatWarnings],
    mcpOrigins,
    mcp: { servers: [] },
  };
  return rt;
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
  });
  rt.mcpClients = mcp;
  rt.mcp = { servers: mcp.servers };
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
