// Modo TUI: alt screen + motor intercambiable (opentui | ansi). Paridad de fase 2.
// El núcleo nunca imprime: aquí solo suscribimos el bus de eventos a los widgets.

import { envAlias } from "../core/env.js";
import { runAgentLoop } from "../core/loop.js";
import { findAgent } from "../core/agents.js";
import { buildSystemPrompt } from "../core/context.js";
import { resolveVault, vaultDigest } from "../compat/obsidian-vault.js";
import { Session } from "../core/session.js";
import type { ChatMessage } from "../core/types.js";
import type { UiHooks } from "../core/types.js";
import { buildRuntime, persistNewMessages, prepareContext, prepareMcp, prepareHooks, prepareUrlContext, compactNow, forkCurrentSession, type RuntimeOptions } from "./common.js";
import { loadTuiConfig } from "../ui/tui-config.js";
import { loadThemes, defaultThemes } from "../ui/theme.js";
import { TuiApp, type SlashCommand } from "../ui/app.js";
import { type DisplayMessage } from "../ui/components.js";
import { createAnsiEngine, type UiEngine } from "../ui/ansi.js";
import { createOpenTuiEngine } from "../ui/opentui.js";
import { prepareExtensions } from "../ext/loader.js";
import { renderCommandBody } from "../compat/file-commands.js";
import { stripModel } from "../core/provider.js";
import { CONNECT_CATALOG, writeAuthEntry } from "../core/auth.js";
import { exportSessionMarkdown } from "./export-session.js";
import { editInExternalEditor, openInExternalEditor } from "../ui/external-editor.js";
import type { UiBridge, ExtAppLike } from "../ext/api.js";
import { splitArgs } from "../compat/util.js";
import { sanitizeForTUI } from "../security/sanitize.js";
import { VERSION } from "../util/version.js";

export interface TuiOptions extends RuntimeOptions {
  /** Fuerza el motor: "opentui" (defecto) | "ansi". */
  engine?: string;
}

function promptFor(rt: import("./common.js").Runtime, cwd: string): string {
  const agent = findAgent(rt.agent.current());
  const digest = (() => { try { const v = resolveVault(rt.config); return v.enabled ? vaultDigest(v) : ""; } catch { return ""; } })();
  const contextBlock = digest ? `${rt.contextFiles.block}\n\n${digest}` : rt.contextFiles.block;
  return buildSystemPrompt({ cwd, agent, contextBlock, skillBlock: rt.skills.block });
}

export async function runTui(opts: TuiOptions): Promise<number> {
  const rt = buildRuntime({ ...opts, attachUi: false });
  await prepareMcp(rt);
  await prepareHooks(rt);
  const cwd = rt.ctx.cwd;
  const tuiCfg = loadTuiConfig(cwd);
  const themes = loadThemes(cwd);
  // temas JSON de otras CLIs (opencode/pi/plugins): shape B best-effort.
  // los que colisionan con un tema ya cargado se descartan (el existente gana).
  const foreignThemeWarnings: string[] = [];
  for (const ft of rt.plugins.themes) {
    if (themes.has(ft.name)) foreignThemeWarnings.push(`tema «${ft.name}» (${ft.source}) ignorado: ya existe`);
    else themes.set(ft.name, { name: ft.name, tokens: { ...defaultThemes[0].tokens, ...ft.tokens } });
  }
  let theme = themes.get(tuiCfg.theme) ?? themes.get("nicotine-dark") ?? defaultThemes[0];

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
      await prepareUrlContext(rt); // instrucciones-URL (una sola vez; fallos solo avisan)
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
    rt.messages.push({ role: "system", content: promptFor(rt, cwd) });
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
    rt.messages.push({ role: "system", content: promptFor(rt, cwd) }, ...loaded);
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

  // ————— comandos MCP prompts (<server>:<prompt>) —————
  const mcpPromptCommands: SlashCommand[] = rt.mcp.prompts.map(({ server, prompt }) => ({
    name: `${server}:${prompt.name}`.replace(/[^a-zA-Z0-9_:-]/g, "_"),
    hint: `[MCP ${server}] ${(prompt.description ?? prompt.name).slice(0, 60)}`,
    run: (_app, rawArgs) => {
      const argDefs = prompt.arguments ?? [];
      const values = splitArgs(rawArgs ?? "");
      const named: Record<string, string> = {};
      argDefs.forEach((def, i) => { if (values[i] !== undefined) named[def.name] = values[i]; });
      const missing = argDefs.filter((d) => d.required && named[d.name] === undefined);
      if (missing.length) { _app.error(`faltan argumentos: ${missing.map((m) => m.name).join(", ")} — uso: /${server}:${prompt.name} ${argDefs.map((d) => d.name).join(" ")}`); return; }
      void (async () => {
        try {
          const client = rt.mcpClients?.clients.get(server);
          if (!client) { _app.error(`servidor MCP «${server}» no conectado`); return; }
          const rendered = await client.getPrompt(prompt.name, named);
          _app.info(`prompt MCP ${server}:${prompt.name} cargado`);
          submitTurn(rendered);
        } catch (err) { _app.error(`prompt MCP falló: ${(err as Error).message}`); }
      })();
    },
  }));

  // Suspensión de la UI para editores externos (ambos motores la soportan)
  const suspendUI = async (fn: () => Promise<void>): Promise<void> => {
    if (!engine.withSuspendedUI) throw new Error("este motor no soporta suspender la UI");
    return engine.withSuspendedUI(fn);
  };

  // ————— /connect —————
  const runConnect = async () => {
    const ids = CONNECT_CATALOG.map((p) => `${p.id} — ${p.label}`);
    const picked = await app.askQuestions([{
      header: "Conectar proveedor",
      question: "Elige proveedor (1-5) o personalizado (6):",
      options: [...ids, "personalizado — otra base URL OpenAI-compatible"],
    }]);
    if (!picked) { app.info("/connect cancelado"); return; }
    const idx = CONNECT_CATALOG.findIndex((p) => picked[0]?.startsWith(`${p.id} — `));
    let baseURL = idx >= 0 ? CONNECT_CATALOG[idx].baseURL : "";
    let id = idx >= 0 ? CONNECT_CATALOG[idx].id : "custom";
    if (idx < 0) {
      const url = await app.askQuestions([{ header: "Base URL", question: "URL base del proveedor (https://…/v1):", options: [] }]);
      if (!url || !/^https?:\/\/\S+$/.test(url[0] ?? "")) { app.error("/connect cancelado o URL inválida"); return; }
      baseURL = url[0].replace(/\/$/, "");
      const name = await app.askQuestions([{ header: "ID", question: "Nombre corto para este proveedor (ej. «ollama»):", options: [] }]);
      id = (name?.[0] ?? "custom").trim().replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase() || "custom";
    }
    const key = await app.askQuestions([{
      header: `API key «${id}»`,
      question: "Pega la clave (oculta con «*»; se guarda solo en auth.json con permisos 0600):",
      options: [],
      mask: true,
    }]);
    const apiKey = key?.[0]?.trim();
    if (!apiKey) { app.info("/connect cancelado (sin clave)"); return; }
    try {
      const { path, replaced } = writeAuthEntry(id, { baseURL, apiKey });
      app.info(`proveedor «${id}» ${replaced ? "actualizado" : "guardado"} en ${path} (0600). Las nuevas sesiones lo usan cuando config/env no dan clave para esa baseURL.`);
    } catch (err) {
      app.error(`/connect falló: ${(err as Error).message}`);
    }
  };

  // ————— comandos slash / paleta —————
  const commands: SlashCommand[] = [
    { name: "help", hint: "atajos y comandos", run: () => app.openHelp() },
    { name: "new", hint: "nueva sesión", run: () => app.startNewSession() },
    { name: "sessions", hint: "listar sesiones", run: () => app.openSessions() },
    { name: "models", hint: "seleccionar modelo (esta sesión)", run: () => void app.openModels() },
    { name: "connect", hint: "añadir un proveedor con API key (auth.json 0600)", run: (_app) => { void runConnect(); } },
    { name: "export", hint: "exportar la sesión a Markdown (abre $EDITOR si está definido)", run: (_app) => { void (async () => {
        try {
          const r = exportSessionMarkdown(rt);
          if (process.env.VISUAL || process.env.EDITOR) {
            const opened = await openInExternalEditor(r.path, suspendUI);
            _app.info(opened.ok ? `exportado (${r.messages} mensajes) → ${r.path} (abierto en $EDITOR)` : `exportado a ${r.path}; ${opened.detail}`);
          } else {
            _app.info(`exportado (${r.messages} mensajes) → ${r.path}`);
          }
        } catch (err) { _app.error(`/export falló: ${(err as Error).message}`); }
      })(); } },
    { name: "editor", hint: "abrir el buffer del prompt en $EDITOR", run: (_app) => { void (async () => {
        const before = app.getEditorText();
        const res = await editInExternalEditor(before, suspendUI, "nicotine");
        if ("error" in res) { _app.error(res.error); return; }
        app.setEditorText(res.text.replace(/\n$/, "")); // EOF final informativo del editor
        _app.info("buffer actualizado desde el editor externo");
      })(); } },
    { name: "themes", hint: "cambiar tema", run: () => app.openThemes() },
    { name: "agent", hint: "alternar build/plan", run: () => { const id = cycleAgent(); app.info(`agente: ${id}`); } },
    { name: "thinking", hint: "razonamiento del modelo", run: () => app.info("razonamiento visible: se mostrará cuando el proveedor emita `reasoning_content` (la mayoría no lo hace); placeholder en fase 3") },
    { name: "compact", hint: "compactar contexto ahora", run: () => void runCompact() },
    { name: "undo", hint: "deshacer cambios de archivos del último turno", run: () => runUndo() },
    { name: "redo", hint: "rehacer el último undo", run: () => runRedo() },
    { name: "fork", hint: "bifurcar la sesión actual", run: () => runFork() },
    { name: "init", hint: "generar/actualizar AGENTS.md", run: () => submitTurn(INIT_PROMPT) },
    { name: "doctor", hint: "informe de carga", run: () => app.info("doctor: ejecuta `nicotine doctor` en otra terminal (informe legible en stdout)") },
    { name: "exit", hint: "salir", run: () => engine.stop() },
  ];
  commands.push(...mcpPromptCommands);
  // ————— comandos de config `commands: {}` (spec JSON verificado 2026-11) —————
  for (const cc of rt.configCommands) {
    if (commands.some((c) => c.name === cc.name)) { app.info(`/${cc.name} (config) ignorado: nombre en uso`); continue; }
    commands.push({
      name: cc.name,
      hint: cc.hint,
      run: (_app, rawArgs) => {
        if (cc.model) { rt.provider.model = stripModel(cc.model); _app.info(`modelo: ${stripModel(cc.model)} (este comando)`); }
        if (cc.agent) {
          const ok = rt.agent.set(cc.agent);
          _app.info(ok ? `agente: ${cc.agent} (este comando)` : `agente «${cc.agent}» no seleccionable aquí (subagent o desconocido); se mantiene el actual`);
        }
        submitTurn(renderCommandBody(cc, rawArgs ?? ""));
      },
    });
  }
  // ————— comandos de archivo (fase 7): .claude/commands, .opencode/commands, .pi/prompts, plugins (plugin:name) —————
  for (const fc of rt.plugins.commands) {
    if (commands.some((c) => c.name === fc.name)) { app.info(`/${fc.name} (${fc.source}) ignorado: nombre en uso por un builtin, comando de config o MCP`); continue; }
    commands.push({ name: fc.name, hint: fc.hint, run: (_app, rawArgs) => submitTurn(renderCommandBody(fc, rawArgs ?? "")) });
  }
  for (const w of foreignThemeWarnings) app.info(w);
  app.deps.commands = commands;

  // ————— extensiones (después de comandos builtin, antes del motor) —————
  const extBridge: UiBridge = {
    app: app as unknown as ExtAppLike,
    registerCommand: (cmd) => {
      if (commands.some((c) => c.name === cmd.name)) { app.info(`extensión: /${cmd.name} ignorado (nombre en uso)`); return; }
      commands.push(cmd as SlashCommand);
    },
    registerShortcut: (spec, handler) => app.registerShortcut(spec, handler),
    setSlot: (slot, component) => app.setSlot(slot, component),
    addWidget: (component) => app.addWidget(component),
    registerTheme: (theme) => { themes.set(theme.name, theme); app.deps.themes = [...themes.keys()].sort(); return true; },
    applyTheme: (name) => { const t = themes.get(name); if (!t) return false; theme = t; app.deps.theme = t; app.requestRender(); return true; },
    refresh: () => app.requestRender(),
  };
  await prepareExtensions(rt, { bridge: extBridge, ui: tuiUi });

  // ————— bus de eventos → widgets —————
  rt.bus.on((ev) => {
    switch (ev.type) {
      // Texto del modelo y salida de tools: dato no confiable, se limpia al entrar.
      case "text_delta": app.appendAssistantDelta(sanitizeForTUI(ev.text)); break;
      case "tool_start": app.toolStart(ev.id, ev.name, ev.args); break;
      case "tool_end": app.toolEnd(ev.id, ev.name, sanitizeForTUI(ev.output), ev.isError, ev.durationMs); break;
      case "turn_end": {
        if (ev.usage?.totalTokens) rt.usageTotals.totalTokens = (rt.usageTotals.totalTokens ?? 0) + ev.usage.totalTokens;
        app.turnEnd(ev.reason, rt.usageTotals.totalTokens);
        break;
      }
      case "error": app.error(ev.message); break;
      case "todos_updated": app.todosUpdated(ev.todos); break;
      case "session_saved": break;
      case "provider_retry": app.info(ev.nextModel && ev.nextModel !== ev.model ? `HTTP ${ev.status} — saltando a modelo ${ev.nextModel}` : `HTTP ${ev.status} — reintentando (${ev.attempt}/${ev.total})${ev.model ? ` modelo ${ev.model}` : ""}`); break;
    }
  });

  // ————— arranque de la UI —————
  if (opts.sessionId || opts.continueLatest) app.setHistory(displayHistory(rt.messages.slice(1)));
  app.info(`nicotine ${VERSION} — sesión ${rt.session.id} · ${rt.provider.model} · esc aborta · ctrl+p comandos`);

  const engineName = (opts.engine ?? envAlias("UI_ENGINE") ?? "opentui").toLowerCase();
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
          process.stderr.write(`[nicotine] OpenTUI falló (${(err as Error)?.message ?? err}); usando motor ANSI\n`);
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
    if (m.role === "user") out.push({ role: "user", text: sanitizeForTUI(String(m.content ?? "")) });
    else if (m.role === "assistant") out.push({ role: "assistant", text: sanitizeForTUI(String(m.content ?? "")) });
    else if (m.role === "tool") out.push({ role: "tool", text: "resultado de herramienta", toolName: "tool", output: sanitizeForTUI(String(m.content ?? "")) });
    // system y otros: no se muestran
  }
  return out;
}

const INIT_PROMPT =
  "Analiza este repositorio para crear o actualizar AGENTS.md en la raíz. " +
  "Primero explora: README, package.json/pyproject.toml/Cargo.toml, configs de build/test, y la estructura de src/. " +
  "El AGENTS.md debe incluir: propósito del proyecto; comandos exactos de build, test y run; convenciones de código y de commits; y una guía rápida de estructura. " +
  "Si AGENTS.md ya existe, ACTUALÍZALO fusionando con lo que hay (no borres nada). Usa las herramientas (read/glob/grep/write/edit); no inventes comandos. " +
"Si encuentras decisiones o convenciones persistentes que no quepan bien en AGENTS.md, crea o actualiza también .nicotine/memory.md (memoria del proyecto) con ellas.";
