// Arranque común de todos los modos: config → permisos → sesión → contexto.

import { PermissionEngine } from "../core/permissions.js";
import { loadConfig } from "../core/config.js";
import { findAgent } from "../core/agents.js";
import { Session } from "../core/session.js";
import { buildSystemPrompt } from "../core/context.js";
import { EventBus, type TokenUsage } from "../core/events.js";
import { FlatUi } from "../ui/flat.js";
import { resolveProvider, type ProviderConfig } from "../core/provider.js";
import type { AgentTool, ChatMessage, ToolContext } from "../core/types.js";
import { ALL_TOOLS } from "../tools/index.js";

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
}

export function buildRuntime(opts: RuntimeOptions): Runtime {
  const { config, rules, layers } = loadConfig(opts.cwd, { configDir: opts.configDir });
  const agent = findAgent(opts.agentId ?? (config["default_agent"] as string | undefined));
  const permissions = new PermissionEngine([...rules, ...agent.permissionRules]);
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

  const abort: { signal: AbortSignal } = opts.signal ? { signal: opts.signal } : new AbortController();
  const bus = new EventBus();
  const ui = new FlatUi({ auto: opts.auto });
  if (opts.attachUi !== false) ui.attach(bus);
  const readFiles = new Set<string>();
  const ctx: ToolContext = {
    cwd: opts.cwd,
    sessionId: session.id,
    signal: abort.signal,
    ui,
    readFiles,
    emit: (ev) => bus.emit(ev),
  };

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt({ cwd: opts.cwd, agent }) },
    ...session.messages(),
  ];

  return {
    config, layers, provider, permissions, session, bus, ui, ctx, messages,
    tools: ALL_TOOLS,
    usageTotals: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

/** Persiste los mensajes nuevos de la sesión (los que no existían al arrancar). */
export function persistNewMessages(rt: Runtime, fromIndex: number): void {
  for (const msg of rt.messages.slice(fromIndex)) {
    if (msg.role === "system") continue; // el system prompt no se persiste
    rt.session.appendMessage(msg);
  }
}
