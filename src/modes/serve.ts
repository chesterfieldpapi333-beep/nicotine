// nicotine serve — servidor HTTP OPCIONAL (apagado por defecto; solo arranca con
// `nicotine serve`). Expone DOS capas:
//   1. API propia mínima (documentada en docs/parity.md) — para scripting.
//   2. Subconjunto HONESTO de la API REST clásica de opencode (fase 10e,
//      src/modes/serve-opencode.ts) — para clientes opencode. NO es paridad:
//      lo no implementado responde 404 con { error } (ver /doc).
//
// Reglas duras de seguridad (lucen la revisión):
//   - REQUIERE NICOTINE_SERVER_PASSWORD u OPENCODE_SERVER_PASSWORD (cualquier bind,
//     loopback incluido; la segunda es solo para clientes opencode).
//     Sin ninguna, se niega a arrancar.
//   - Sin TLS propio: HTTP en claro. Para exponer fuera de la máquina, pon un
//     proxy con TLS delante. Bind por defecto 127.0.0.1.
//   - SIN CORS: ninguna cabecera Access-Control-*; no es una API de navegador.
//   - Auth básica (cualquier usuario, la contraseña debe coincidir) en TODOS
//     los endpoints, comparación en tiempo constante.
//   - Permisos fail-closed: los diálogos «ask» se RECHAZAN (paso automático
//     solo con --auto; deny gana siempre). Un turno a la vez (409 si ocupado).
//   - Sin ejecución de nada externo; 1 MiB máx. de body. mDNS/DNS-SD OPCIONAL
//     (--mdns / --mdns-domain): best-effort, el servicio se anuncia como
//     _nicotine._tcp (nicotine.local); si 5353 falla, serve arranca igual.
//
//   API propia:  GET  /health · GET /sessions · GET /session/current ·
//   GET  /session/export · POST /session/prompt (SSE) · POST /session/abort
//   Subconjunto opencode (ver /doc): GET|POST /session · GET /session/status ·
//   /session/{id} (GET/PATCH/DELETE) · /session/{id}/message (GET/POST) …

import { envAlias } from "../core/env.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { runAgentLoop } from "../core/loop.js";
import type { TokenUsage } from "../core/events.js";
import type { AgentTool, ChatMessage } from "../core/types.js";
import type { ProviderConfig } from "../core/provider.js";
import { buildRuntime, persistNewMessages, prepareContext, prepareMcp, prepareHooks, prepareUrlContext, type RuntimeOptions, type Runtime } from "./common.js";
import { prepareExtensions } from "../ext/loader.js";
import { Session } from "../core/session.js";
import { closeMcpClients } from "../compat/mcp/manager.js";
import { MdnsAnnouncer } from "../compat/mdns.js";
import { passOk, send, readBody } from "./serve-http.js";
import { handleOpenCodeRequest, type OpenCodeContext, type ExecuteTurnArgs, type ExecuteTurnResult } from "./serve-opencode.js";
import { ocTodos, type OcEvent } from "../compat/opencode-rest.js";

export interface ServeOptions extends RuntimeOptions {
  port?: number;
  hostname?: string;
  /** Anuncia el servicio por mDNS/DNS-SD tras arrancar (best-effort; nunca rompe serve). */
  mdns?: boolean;
  /** Dominio mDNS (defecto nicotine.local). Implica mdns=true. */
  mdnsDomain?: string;
  /** Señal del proceso (SIGINT) para apagado limpio. */
  onListening?: (addr: string) => void;
}

const VERSION = "0.1.0";
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

/** Exporta la sesión actual como Markdown (mismo formato que /export, sin archivo). */
function sessionMarkdown(rt: Runtime): string {
  const lines = [`# Sesión nicotine ${rt.session.id}`, ""];
  for (const m of rt.session.messages()) {
    if (m.role === "user") lines.push("## Usuario", "", String(m.content ?? ""), "");
    else if (m.role === "assistant") lines.push("## Asistente", "", String(m.content ?? ""), "");
    else if (m.role === "tool") lines.push("## Resultado de tool", "", "```text", String(m.content ?? "").slice(0, 8000), "```", "");
  }
  return lines.join("\n");
}

/**
 * Ejecuta un turno y devuelve el motivo; persiste los mensajes nuevos.
 * Compartido por POST /session/prompt (SSE crudo) y el subconjunto opencode
 * (/session/{id}/message…). Estampa `turnTs` en los mensajes del turno antes de
 * persistir → ids de mensaje estables entre el evento en vivo y la recarga.
 */
async function executeTurn(rt: Runtime, fetchImpl: RuntimeOptions["fetchImpl"], args: ExecuteTurnArgs): Promise<ExecuteTurnResult> {
  rt.ctx.signal = args.signal;
  const turnTs = args.turnTs;
  const startIndex = rt.messages.length;
  let usage: TokenUsage | undefined;
  const offUsage = rt.bus.on((ev) => { if (ev.type === "turn_end" && ev.usage) usage = { ...ev.usage }; });
  const off = rt.bus.on((ev) => args.onCoreEvent?.(ev));
  rt.messages.push({ role: "user", content: args.prompt, ts: turnTs });
  if (rt.messages.filter((m) => m.role === "user").length === 1) rt.session.setTitle(args.prompt.replace(/\s+/g, " ").slice(0, 80));
  rt.ctx.undo?.beginTurn(args.prompt.replace(/\s+/g, " ").slice(0, 80));
  const savedSystem = args.systemOverride ? rt.messages[0] : null;
  if (savedSystem && args.systemOverride) rt.messages[0] = { role: "system", content: args.systemOverride };
  try {
    const reason = await runAgentLoop({ provider: args.provider ?? rt.provider, permissions: rt.permissions, messages: rt.messages, tools: args.tools ?? rt.tools, ctx: rt.ctx, fetchImpl });
    for (let i = startIndex; i < rt.messages.length; i++) {
      const m = rt.messages[i] as ChatMessage & { ts?: number };
      if (!m.ts) m.ts = turnTs;
    }
    return { reason, usage };
  } finally {
    if (savedSystem) rt.messages[0] = savedSystem;
    offUsage();
    off();
    persistNewMessages(rt, startIndex);
    rt.bus.emit({ type: "session_saved", sessionId: rt.session.id });
  }
}

export async function runServe(opts: ServeOptions): Promise<number> {
  // Auth: NICOTINE_SERVER_PASSWORD (propia) u OPENCODE_SERVER_PASSWORD (compat con clientes opencode)
  const password = envAlias("SERVER_PASSWORD") ?? process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) {
    process.stderr.write("nicotine serve: falta NICOTINE_SERVER_PASSWORD (o OPENCODE_SERVER_PASSWORD para clientes opencode). Por seguridad, serve nunca arranca sin contraseña (auth básica en todos los endpoints).\n");
    return 2;
  }
  const hostname = opts.hostname ?? "127.0.0.1";
  const port = opts.port ?? 4096;
  // 0 = puerto efímero (tests/embedding); la CLI exige 1..65535
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`nicotine serve: puerto inválido: ${port}\n`);
    return 2;
  }
  const loopback = /^(127\.|::1$|localhost$|::ffff:127\.)/.test(hostname);

  // Runtime único para el proceso (una sesión activa; cambiar = reiniciar con -s)
  const rt = buildRuntime({ ...opts, attachUi: false });
  // Fail-closed ANTES de cualquier confirm (hooks/MCP leen stdin si no): ask → reject
  rt.ctx.ui.confirm = opts.auto ? async () => "once" as const : async () => "reject" as const;
  await prepareMcp(rt);
  await prepareHooks(rt);
  await prepareExtensions(rt, { ui: rt.ctx.ui });
  try { await prepareUrlContext(rt); } catch (err) { process.stderr.write(`serve: instrucciones-URL fallaron: ${(err as Error).message}\n`); }
  try { await prepareContext(rt); } catch (err) { process.stderr.write(`serve: compactación falló: ${(err as Error).message}\n`); }

  let currentAbort: AbortController | null = null;
  let busy = false;
  let lastOcTodos: ReturnType<typeof ocTodos> = [];
  const log = (line: string) => process.stderr.write(`[serve] ${line}\n`);
  // Todos: la última lista emitida por la tool `todowrite` (memoria del proceso)
  rt.bus.on((ev) => { if (ev.type === "todos_updated") lastOcTodos = ocTodos(ev.todos); });
  // Clientes SSE del subconjunto opencode (/event y /global/event)
  const ocClients = new Set<(ev: OcEvent) => void>();
  const ocCtx: OpenCodeContext = {
    rt, cwd: opts.cwd, version: VERSION,
    busy: () => busy,
    setBusy: (v, abort) => { busy = v; if (abort !== undefined) currentAbort = abort; if (!v) currentAbort = null; },
    abortCurrent: () => { const had = currentAbort !== null; currentAbort?.abort(); return had; },
    ocClients,
    todos: () => lastOcTodos,
    executeTurn: (args) => executeTurn(rt, opts.fetchImpl, args),
    turnTimeoutMs: TURN_TIMEOUT_MS,
  };

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const finish = (status: number) => log(`${req.method} ${req.url} → ${status} (${Date.now() - started}ms)`);
    try {
      if (!passOk(req.headers.authorization, password)) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="nicotine"', "cache-control": "no-store" });
        res.end("Unauthorized");
        finish(401);
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      // ——— API propia (nicotine) ———
      if (req.method === "GET" && path === "/health") { send(res, 200, { ok: true, version: VERSION }); finish(200); return; }
      if (req.method === "GET" && path === "/session/current") {
        const list = Session.list();
        const cur = list.find((s) => s.id === rt.session.id);
        send(res, 200, { id: rt.session.id, title: cur?.title ?? "" });
        finish(200);
        return;
      }
      if (req.method === "GET" && path === "/sessions") { send(res, 200, Session.list()); finish(200); return; }
      if (req.method === "GET" && path === "/session/export") {
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" });
        res.end(sessionMarkdown(rt));
        finish(200);
        return;
      }
      if (req.method === "POST" && path === "/session/abort") { currentAbort?.abort(); send(res, 200, { ok: true }); finish(200); return; }
      if (req.method === "POST" && path === "/session/prompt") {
        if (busy) { send(res, 409, { error: "turno en curso; inténtalo al terminar o aborta con POST /session/abort" }); finish(409); return; }
        busy = true; // marca SINCRÓNICA antes de cualquier await (evita dos turnos a la vez)
        let raw: string;
        try { raw = await readBody(req); } catch (err) { busy = false; send(res, 413, { error: (err as Error).message }); finish(413); return; }
        let parsed: { prompt?: unknown };
        try { parsed = JSON.parse(raw || "{}"); } catch { busy = false; send(res, 400, { error: "JSON inválido" }); finish(400); return; }
        const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
        if (!prompt) { busy = false; send(res, 400, { error: "falta `prompt` (string no vacío)" }); finish(400); return; }
        const turn = new AbortController();
        currentAbort = turn;
        const turnTimer = setTimeout(() => turn.abort(), TURN_TIMEOUT_MS);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const writeEvent = (ev: unknown) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* cliente desconectado */ } };
        req.on("close", () => turn.abort()); // cliente se fue → abortar el turno
        log(`prompt recibido (${prompt.length} chars)`);
        let reason: "stop" | "max_steps" | "aborted" = "aborted";
        try {
          const out = await executeTurn(rt, opts.fetchImpl, { prompt, signal: turn.signal, turnTs: Date.now(), onCoreEvent: writeEvent });
          reason = out.reason;
        } catch (err) {
          writeEvent({ type: "error", message: String((err as Error)?.message ?? err) });
        } finally {
          clearTimeout(turnTimer);
          currentAbort = null;
          busy = false;
          writeEvent({ type: "stream_end", reason });
          res.end();
          finish(200);
        }
        return;
      }

      // ——— Subconjunto opencode (honesto, ver /doc) ———
      if (await handleOpenCodeRequest(ocCtx, req, res, url, finish)) return;

      send(res, 404, { error: "ruta desconocida o no implementada en el subconjunto opencode REST de nicotine", method: req.method, path, doc: "/doc" });
      finish(404);
    } catch (err) {
      try { send(res, 500, { error: String((err as Error)?.message ?? err) }); } catch { /* socket muerto */ }
      finish(500);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => resolve());
  });
  const addrInfo = server.address();
  const effectivePort = typeof addrInfo === "object" && addrInfo ? addrInfo.port : port;
  const addr = `http://${hostname}:${effectivePort}`;
  stderr_banner(addr, loopback, log);
  let mdns: MdnsAnnouncer | null = null;
  if (opts.mdns || opts.mdnsDomain) {
    try {
      mdns = new MdnsAnnouncer({ httpPort: effectivePort, domain: opts.mdnsDomain ?? "nicotine.local", path: "/", logger: (m) => log(m) });
      const ok = await mdns.start();
      if (!ok) mdns = null;
    } catch (err) {
      log(`mDNS no disponible: ${(err as Error).message}; serve sigue sin anuncio`);
      mdns = null;
    }
  }
  opts.onListening?.(addr);
  // Apagado limpio: SIGINT/SIGTERM → cerrar servidor y clientes MCP
  const shutdown = () => {
    log("apagando…");
    void mdns?.stop(); // goodbye TTL 0 (best-effort)
    server.close(() => { void closeMcpClients(rt.mcpClients).finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<void>(() => { /* corre hasta la señal */ });
  return 0;
}

function stderr_banner(addr: string, loopback: boolean, log: (l: string) => void): void {
  log(`escuchando en ${addr} (auth básica; HTTP en claro)`);
  if (!loopback) log("ADVERTENCIA: bind no-loopback sin TLS. Pon un proxy con TLS delante o vuelve a 127.0.0.1.");
  log("API propia: GET /health · GET /sessions · GET /session/current · GET /session/export · POST /session/prompt (SSE) · POST /session/abort");
  log("Subconjunto opencode (sin paridad; ver /doc): GET|POST /session · /session/{id} (GET/PATCH/DELETE) · /session/{id}/message (GET/POST) · /event (SSE) · /find · /file — resto → 404");
}
