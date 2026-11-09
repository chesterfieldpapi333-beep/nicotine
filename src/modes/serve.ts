// vireo serve — servidor HTTP OPCIONAL (apagado por defecto; solo arranca con
// `vireo serve`). Diseño PROPIO mínimo (documentado en docs/parity.md); NO es
// la API REST de OpenCode. Pensado para scripting local y pruebas de humo.
//
// Reglas duras de seguridad (lucen la revisión):
//   - REQUIERE VIREO_SERVER_PASSWORD (cualquier bind, loopback incluido).
//     Sin ella se niega a arrancar.
//   - Sin TLS propio: HTTP en claro. Para exponer fuera de la máquina, pon un
//     proxy con TLS delante. Bind por defecto 127.0.0.1.
//   - SIN CORS: ninguna cabecera Access-Control-*; no es una API de navegador.
//   - Auth básica (cualquier usuario, la contraseña debe coincidir) en TODOS
//     los endpoints, comparación en tiempo constante.
//   - Permisos fail-closed: los diálogos «ask» se RECHAZAN (paso automático
//     solo con --auto; deny gana siempre). Un turno a la vez (409 si ocupado).
//   - Sin ejecución de nada externo; 1 MiB máx. de body. mDNS/DNS-SD OPCIONAL
//     (--mdns / --mdns-domain): best-effort, el servicio se anuncia como
//     _vireo._tcp (vireo.local); si 5353 falla, serve arranca igual.
//
//   GET  /health           → { ok: true, version }
//   GET  /session          → { id, title } de la sesión activa del proceso
//   GET  /sessions         → [{ id, title, mtime }] (todas las sesiones JSONL)
//   GET  /session/export   → text/markdown de la sesión actual (no escribe archivo)
//   POST /session/prompt   { prompt: string } → text/event-stream (SSE) con los
//                            eventos del núcleo + {"type":"stream_end"...}
//   POST /session/abort    → { ok: true } (aborta el turno en curso)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { runAgentLoop } from "../core/loop.js";
import { buildRuntime, persistNewMessages, prepareContext, prepareMcp, prepareHooks, prepareUrlContext, type RuntimeOptions, type Runtime } from "./common.js";
import { prepareExtensions } from "../ext/loader.js";
import { Session } from "../core/session.js";
import { closeMcpClients } from "../compat/mcp/manager.js";
import { MdnsAnnouncer } from "../compat/mdns.js";

export interface ServeOptions extends RuntimeOptions {
  port?: number;
  hostname?: string;
  /** Anuncia el servicio por mDNS/DNS-SD tras arrancar (best-effort; nunca rompe serve). */
  mdns?: boolean;
  /** Dominio mDNS (defecto vireo.local). Implica mdns=true. */
  mdnsDomain?: string;
  /** Señal del proceso (SIGINT) para apagado limpio. */
  onListening?: (addr: string) => void;
}

const VERSION = "0.1.0";
const MAX_BODY = 1 << 20;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

function passOk(header: string | undefined, password: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    const pass = i >= 0 ? decoded.slice(i + 1) : ""; // cualquier usuario vale; la clave manda
    const a = Buffer.from(pass), b = Buffer.from(password);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body demasiado grande (máx 1 MiB)")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Exporta la sesión actual como Markdown (mismo formato que /export, sin archivo). */
function sessionMarkdown(rt: Runtime): string {
  const lines = [`# Sesión vireo ${rt.session.id}`, ""];
  for (const m of rt.session.messages()) {
    if (m.role === "user") lines.push("## Usuario", "", String(m.content ?? ""), "");
    else if (m.role === "assistant") lines.push("## Asistente", "", String(m.content ?? ""), "");
    else if (m.role === "tool") lines.push("## Resultado de tool", "", "```text", String(m.content ?? "").slice(0, 8000), "```", "");
  }
  return lines.join("\n");
}

async function runPromptTurn(rt: Runtime, prompt: string, fetchImpl: RuntimeOptions["fetchImpl"], write: (ev: unknown) => void, signal: AbortSignal): Promise<"stop" | "max_steps" | "aborted"> {
  rt.ctx.signal = signal;
  const off = rt.bus.on((ev) => write(ev));
  const startIndex = rt.messages.length;
  rt.messages.push({ role: "user", content: prompt });
  if (rt.messages.filter((m) => m.role === "user").length === 1) rt.session.setTitle(prompt.replace(/\s+/g, " ").slice(0, 80));
  rt.ctx.undo?.beginTurn(prompt.replace(/\s+/g, " ").slice(0, 80));
  try {
    return await runAgentLoop({ provider: rt.provider, permissions: rt.permissions, messages: rt.messages, tools: rt.tools, ctx: rt.ctx, fetchImpl });
  } finally {
    off();
    persistNewMessages(rt, startIndex);
    rt.bus.emit({ type: "session_saved", sessionId: rt.session.id });
  }
}

export async function runServe(opts: ServeOptions): Promise<number> {
  const password = process.env.VIREO_SERVER_PASSWORD;
  if (!password) {
    process.stderr.write("vireo serve: falta VIREO_SERVER_PASSWORD. Por seguridad, serve nunca arranca sin contraseña (auth básica en todos los endpoints).\n");
    return 2;
  }
  const hostname = opts.hostname ?? "127.0.0.1";
  const port = opts.port ?? 4096;
  // 0 = puerto efímero (tests/embedding); la CLI exige 1..65535
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`vireo serve: puerto inválido: ${port}\n`);
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
  const log = (line: string) => process.stderr.write(`[serve] ${line}\n`);

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const finish = (status: number) => log(`${req.method} ${req.url} → ${status} (${Date.now() - started}ms)`);
    try {
      if (!passOk(req.headers.authorization, password)) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="vireo"', "cache-control": "no-store" });
        res.end("Unauthorized");
        finish(401);
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") { send(res, 200, { ok: true, version: VERSION }); finish(200); return; }
      if (req.method === "GET" && path === "/session") {
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
        let raw: string;
        try { raw = await readBody(req); } catch (err) { send(res, 413, { error: (err as Error).message }); finish(413); return; }
        let parsed: { prompt?: unknown };
        try { parsed = JSON.parse(raw || "{}"); } catch { send(res, 400, { error: "JSON inválido" }); finish(400); return; }
        const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
        if (!prompt) { send(res, 400, { error: "falta `prompt` (string no vacío)" }); finish(400); return; }
        busy = true;
        const turn = new AbortController();
        currentAbort = turn;
        const turnTimer = setTimeout(() => turn.abort(), TURN_TIMEOUT_MS);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        const writeEvent = (ev: unknown) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* cliente desconectado */ } };
        req.on("close", () => turn.abort()); // cliente se fue → abortar el turno
        log(`prompt recibido (${prompt.length} chars)`);
        let reason: "stop" | "max_steps" | "aborted" = "aborted";
        try {
          reason = await runPromptTurn(rt, prompt, opts.fetchImpl, writeEvent, turn.signal);
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
      send(res, 404, { error: "ruta desconocida" });
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
      mdns = new MdnsAnnouncer({ httpPort: effectivePort, domain: opts.mdnsDomain ?? "vireo.local", path: "/", logger: (m) => log(m) });
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
  log("endpoints: GET /health · GET /session · GET /sessions · GET /session/export · POST /session/prompt (SSE) · POST /session/abort");
}
