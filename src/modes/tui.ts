// Modo TUI: alt screen + motor intercambiable (opentui | ansi). Paridad de fase 2.
// El núcleo nunca imprime: aquí solo suscribimos el bus de eventos a los widgets.

import { runAgentLoop } from "../core/loop.js";
import { findAgent } from "../core/agents.js";
import { buildSystemPrompt } from "../core/context.js";
import { Session } from "../core/session.js";
import type { ChatMessage } from "../core/types.js";
import type { UiHooks } from "../core/types.js";
import { buildRuntime, persistNewMessages, prepareContext, compactNow, forkCurrentSession, type RuntimeOptions } from "./common.js";
import { loadTuiConfig } from "../ui/tui-config.js";
import { loadThemes, defaultThemes } from "../ui/theme.js";
import { TuiApp, type SlashCommand } from "../ui/app.js";
import { type DisplayMessage } from "../ui/components.js";
import { createAnsiEngine, type UiEngine } from "../ui/ansi.js";
import { createOpenTuiEngine } from "../ui/opentui.js";

export interface TuiOptions extends RuntimeOptions {
  /** Fuerza el motor: "opentui" (defecto) | "ansi". */
  engine?: string;
}

export async function runTui(opts: TuiOptions): Promise<number> {
  const rt = buildRuntime({ ...opts, attachUi: false });
  const cwd = rt.ctx.cwd;
  const tuiCfg = loadTuiConfig(cwd);
  const themes = loadThemes(cwd);
  let theme = themes.get(tuiCfg.theme) ?? themes.get("vireo-dark") ?? defaultThemes[0];

  const cycleAgent = (): string => {
    const order = rt.agent.list();
    const idx = Math.max(0, order.indexOf(rt.agent.current()));
    const next = order[(idx + 1) % order.length];
    rt.agent.set(next); // reconstruye permisos + system prompt
    return next;
  };

  let baseCount = rt.messages.length; // índice desde el que persistir (excluye system+historial cargado)
  let turnAbort: AbortController | null = null;
  let inFlight = false;

  const app = new TuiApp({
    theme,
    setTheme: (name) => {
      const t = themes.get(name);
      if (t) { theme = t; app.deps.theme = t; app.requestRender(); }
    },
    tui: tuiCfg,
    cwd,
    themes: [...themes.keys()].sort(),
    commands: [], // se rellena abajo (necesita `app`)
    submit: (prompt) => submitTurn(prompt),
    abortTurn: () => turnAbort?.abort(),
    cycleAgent: () => cycleAgent(),
    newSession: () => newSession(),
    switchSession: (id) => switchSession(id),
    listSessions: () => Session.list(),
    renameSession: (id, title) => { Session.load(id)?.setTitle(title); },
    deleteSession: (id) => { if (id !== rt.session.id) Session.remove(id); },
    fetchModels: () => fetchModels(),
    setModel: (model) => { rt.provider.model = model; },
    currentModel: () => rt.provider.model,
    currentAgent: () => rt.agent.current(),
    currentSession: () => rt.session.id,
    exit: () => engine.stop(),
  });

  const tuiUi: UiHooks = {
    // --auto: aprueba una vez sin diálogo (paridad con la FlatUi; deny sigue denegado)
    confirm: (req) => (opts.auto ? Promise.resolve("once" as const) : app.confirmPermission(req)),
    question: (qs) => app.askQuestions(qs),
    info: (text) => app.info(text),
  };
  rt.ctx.ui = tuiUi;

  // ————— acciones —————
  function submitTurn(prompt: string): void {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
    turnAbort = new AbortController();
    rt.ctx.signal = turnAbort.signal;
    try {
      await prepareContext(rt); // compacta si toca, antes de tocar el historial
    } catch (err) {
      app.error(`compactación falló: ${(err as Error).message}`);
    }
    rt.ctx.undo?.beginTurn(prompt.replace(/\s+/g, " ").slice(0, 80));
    const startIndex = rt.messages.length;
    rt.messages.push({ role: "user", content: prompt });
    if (rt.messages.filter((m) => m.role === "user").length === 1) {
      rt.session.setTitle(prompt.replace(/\s+/g, " ").slice(0, 80));
    }
    app.turnStarted();
    runAgentLoop({
      provider: rt.provider,
      permissions: rt.permissions,
      messages: rt.messages,
      tools: rt.tools,
      ctx: rt.ctx,
    })
      .then(() => {
        persistNewMessages(rt, startIndex);
        rt.bus.emit({ type: "session_saved", sessionId: rt.session.id });
      })
      .catch((err: unknown) => {
        app.error(String((err as Error)?.message ?? err));
        app.turnEnd("aborted");
      })
      .finally(() => {
        inFlight = false;
        rt.ctx.signal = turnAbort!.signal; // se sustituye en el próximo turno
      });
    })().catch((err: unknown) => {
      inFlight = false;
      app.error(String((err as Error)?.message ?? err));
    });
  }

  function newSession(): Session {
    persistNewMessages(rt, baseCount);
    const s = Session.create(cwd);
    rt.session = s;
    rt.ctx.sessionId = s.id;
    rt.messages.length = 0;
    rt.messages.push({ role: "system", content: buildSystemPrompt({ cwd, agent: findAgent(rt.agent.current()) }) });
    baseCount = 1;
    return s;
  }

  function switchSession(id: string): boolean {
    const s = Session.load(id);
    if (!s) return false;
    persistNewMessages(rt, baseCount);
    const loaded = s.messages();
    rt.session = s;
    rt.ctx.sessionId = s.id;
    rt.messages.length = 0;
    rt.messages.push({ role: "system", content: buildSystemPrompt({ cwd, agent: findAgent(rt.agent.current()) }) }, ...loaded);
    baseCount = rt.messages.length;
    app.setHistory(displayHistory(loaded));
    return true;
  }

  async function fetchModels(): Promise<string[] | null> {
    try {
      const res = await fetch(`${rt.provider.baseURL}/models`, {
        headers: rt.provider.apiKey ? { authorization: `Bearer ${rt.provider.apiKey}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: { id?: string }[] };
      const ids = (json.data ?? []).map((d) => d.id).filter((x): x is string => !!x).sort();
      return ids.length ? ids : null;
    } catch {
      return null;
    }
  }

  function runUndo(): void {
    const mgr = rt.ctx.undo;
    if (!mgr) { app.info("snapshots no disponibles en este modo"); return; }
    const res = mgr.undo();
    app.info(res.message);
    for (const line of res.skipped) app.info(`  omitido: ${line}`);
    if (res.backupDir) app.info(`  tu estado previo quedó respaldado en ${res.backupDir}`);
  }

  function runRedo(): void {
    const mgr = rt.ctx.undo;
    if (!mgr) { app.info("snapshots no disponibles en este modo"); return; }
    const res = mgr.redo();
    app.info(res.message);
    for (const line of res.skipped) app.info(`  omitido: ${line}`);
    if (res.backupDir) app.info(`  tu estado previo quedó respaldado en ${res.backupDir}`);
  }

  async function runCompact(): Promise<void> {
    try {
      app.info("compactando…");
      const res = await compactNow(rt);
      app.info(res.compacted ? `contexto compactado: ${res.beforeTokens} → ${res.afterTokens} tokens` : "historial demasiado corto para compactar");
    } catch (err) {
      app.error(`compactación falló: ${(err as Error).message}`);
    }
  }

  function runFork(): void {
    persistNewMessages(rt, baseCount);
    const forked = forkCurrentSession(rt);
    if (switchSession(forked.id)) app.info(`bifurcada como sesión ${forked.id} (la original queda intacta)`);
    else app.error("no se pudo bifurcar la sesión");
  }

  // ————— comandos slash / paleta —————
  const commands: SlashCommand[] = [
    { name: "help", hint: "atajos y comandos", run: () => app.openHelp() },
    { name: "new", hint: "nueva sesión", run: () => app.startNewSession() },
    { name: "sessions", hint: "listar sesiones", run: () => app.openSessions() },
    { name: "models", hint: "seleccionar modelo (esta sesión)", run: () => void app.openModels() },
    { name: "themes", hint: "cambiar tema", run: () => app.openThemes() },
    { name: "agent", hint: "alternar build/plan", run: () => { const id = cycleAgent(); app.info(`agente: ${id}`); } },
    { name: "thinking", hint: "razonamiento del modelo", run: () => app.info("razonamiento visible: se mostrará cuando el proveedor emita `reasoning_content` (la mayoría no lo hace); placeholder en fase 3") },
    { name: "compact", hint: "compactar contexto ahora", run: () => void runCompact() },
    { name: "undo", hint: "deshacer cambios de archivos del último turno", run: () => runUndo() },
    { name: "redo", hint: "rehacer el último undo", run: () => runRedo() },
    { name: "fork", hint: "bifurcar la sesión actual", run: () => runFork() },
    { name: "init", hint: "generar/actualizar AGENTS.md", run: () => submitTurn(INIT_PROMPT) },
    { name: "doctor", hint: "informe de carga", run: () => app.info("doctor: ejecuta `vireo doctor` en otra terminal (informe legible en stdout)") },
    { name: "exit", hint: "salir", run: () => engine.stop() },
  ];
  app.deps.commands = commands;

  // ————— bus de eventos → widgets —————
  rt.bus.on((ev) => {
    switch (ev.type) {
      case "text_delta": app.appendAssistantDelta(ev.text); break;
      case "tool_start": app.toolStart(ev.id, ev.name, ev.args); break;
      case "tool_end": app.toolEnd(ev.id, ev.name, ev.output, ev.isError, ev.durationMs); break;
      case "turn_end": {
        if (ev.usage?.totalTokens) rt.usageTotals.totalTokens = (rt.usageTotals.totalTokens ?? 0) + ev.usage.totalTokens;
        app.turnEnd(ev.reason, rt.usageTotals.totalTokens);
        break;
      }
      case "error": app.error(ev.message); break;
      case "todos_updated": app.todosUpdated(ev.todos); break;
      case "session_saved": break;
    }
  });

  // ————— arranque de la UI —————
  if (opts.sessionId || opts.continueLatest) app.setHistory(displayHistory(rt.messages.slice(1)));
  app.info(`vireo 0.1.0 — sesión ${rt.session.id} · ${rt.provider.model} · esc aborta · ctrl+p comandos`);

  const engineName = (opts.engine ?? process.env.VIREO_UI_ENGINE ?? "opentui").toLowerCase();
  let engine: UiEngine;
  if (engineName === "ansi") {
    engine = createAnsiEngine(app);
  } else {
    // OpenTUI con fallback automático a ANSI si el arranque falla
    const openTui = createOpenTuiEngine(app);
    let active: UiEngine = openTui;
    engine = {
      start: async () => {
        try {
          return await openTui.start();
        } catch (err) {
          process.stderr.write(`[vireo] OpenTUI falló (${(err as Error)?.message ?? err}); usando motor ANSI\n`);
          active = createAnsiEngine(app);
          return active.start();
        }
      },
      stop: () => active.stop(),
    };
  }

  // tick de 1s para el indicador "pensando… Ns" mientras hay un turno en vuelo
  const ticker = setInterval(() => { if (inFlight) app.requestRender(); }, 1000);
  try {
    await engine.start();
  } finally {
    clearInterval(ticker);
  }
  return 0;
}

function displayHistory(messages: ChatMessage[]): DisplayMessage[] {
  const out: DisplayMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", text: String(m.content ?? "") });
    else if (m.role === "assistant") out.push({ role: "assistant", text: String(m.content ?? "") });
    else if (m.role === "tool") out.push({ role: "tool", text: "resultado de herramienta", toolName: "tool", output: String(m.content ?? "") });
    // system y otros: no se muestran
  }
  return out;
}

const INIT_PROMPT =
  "Analiza este repositorio para crear o actualizar AGENTS.md en la raíz. " +
  "Primero explora: README, package.json/pyproject.toml/Cargo.toml, configs de build/test, y la estructura de src/. " +
  "El AGENTS.md debe incluir: propósito del proyecto; comandos exactos de build, test y run; convenciones de código y de commits; y una guía rápida de estructura. " +
  "Si AGENTS.md ya existe, ACTUALÍZALO fusionando con lo que hay (no borres nada). Usa las herramientas (read/glob/grep/write/edit); no inventes comandos.";
