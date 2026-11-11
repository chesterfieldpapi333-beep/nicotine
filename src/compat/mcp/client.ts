// Cliente MCP mínimo, CERO dependencias (desviación documentada en parity.md:
// @modelcontextprotocol/client@2.4.0 existe pero su API exacta no está
// verificada y "lite" no paga por ello; el handshake/probe está implementado
// a mano según el spec 2026-07-28 y el legacy initialize ≤ 2025-11-25).
//
// Transportes:
//   - stdio: spawn del comando; JSON-RPC 2.0 delimitado por \n ( spec MCP stdio ).
//   - streamable HTTP: POST con Accept: application/json, text/event-stream;
//     respuesta application/json directa o stream SSE (se lee hasta el id pedido).
//     Captura y reenvía `mcp-session-id` (servidores legacy con sesión).
// Protocolo:
//   - "legacy"     → initialize (ladder 2025-11-25 → 2024-11-05) + notifications/initialized.
//   - "2026-07-28" → stateless: _meta con io.modelcontextprotocol/protocolVersion
//                    y headers Mcp-Method/Mcp-Name; server/discover obligatorio.
//   - "auto"       → probe server/discover; en cualquier fallo/versión no soportada
//                    → reintenta con initialize legacy.
//
// Timeouts por petición (startup/catalog/execution los fija el llamador).
// Errores: cualquier fallo → rechaza la promesa con mensaje accionable; nunca lanza
// excepciones fuera del flujo async.

import { spawn, type ChildProcess } from "node:child_process";
import type { McpServerDef } from "./types.js";
import { getValidAccessToken } from "./oauth.js";
import type { ToolParameters } from "../../core/types.js";

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: ToolParameters;
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

const CLIENT_INFO = { name: "nicotine", version: "0.2.0" };
const PROTOCOL_2026 = "2026-07-28";
const LEGACY_LADDER = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class McpClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private child: ChildProcess | null = null;
  private stdoutBuf = "";
  private stderrTail: string[] = [];
  private sessionId: string | null = null;
  private httpStateless = false;
  /** Protocolo efectivo tras el handshake. */
  negotiatedProtocol: "legacy" | "2026-07-28" | null = null;
  readonly stderrLog: string[] = [];

  constructor(private def: McpServerDef) {}

  // ---------- transporte ----------

  private async send(method: string, params: unknown, timeoutMs: number, forceStateless = false): Promise<unknown> {
    if (this.def.transport.kind === "stdio") return this.sendStdio(method, params, timeoutMs);
    return this.sendHttp(method, params, timeoutMs, forceStateless || this.httpStateless);
  }

  private async sendStdio(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = await this.ensureStdio();
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params: withMeta(params, this.negotiatedProtocol === PROTOCOL_2026) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout (${timeoutMs}ms) en ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(JSON.stringify(payload) + "\n", (err) => {
        if (err) { clearTimeout(timer); this.pending.delete(id); reject(new Error(`no se pudo escribir a ${this.def.name}: ${err.message}`)); }
      });
    });
  }

  private async sendHttp(method: string, params: unknown, timeoutMs: number, stateless: boolean): Promise<unknown> {
    const t = this.def.transport;
    if (t.kind !== "http") throw new Error("internal: sendHttp en transporte stdio");
    const id = this.nextId++;
    // OAuth: bearer guardado cuando el usuario NO puso Authorization explícita
    const hasExplicitAuth = Object.keys(t.headers).some((h) => h.toLowerCase() === "authorization");
    let oauthToken: string | null = null;
    if (!hasExplicitAuth) {
      try { oauthToken = await getValidAccessToken(this.def); } catch { oauthToken = null; }
    }
    let bodyParams = params as Record<string, unknown> | undefined;
    if (stateless) {
      bodyParams = { ...(bodyParams ?? {}), _meta: { ...(((bodyParams ?? {})["_meta"] as Record<string, unknown>) ?? {}), "io.modelcontextprotocol/protocolVersion": PROTOCOL_2026, clientInfo: CLIENT_INFO, clientCapabilities: {} } };
    }
    const attempt = async (token: string | null): Promise<Response> => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...t.headers,
      };
      if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
      if (stateless) {
        headers["mcp-method"] = method;
        const toolName = (bodyParams as { name?: string })?.name;
        if (toolName) headers["mcp-name"] = toolName;
      }
      if (token) headers["authorization"] = `Bearer ${token}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        return await fetch(t.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params: bodyParams }), signal: ctrl.signal });
      } catch (err) {
        const e = err as Error;
        throw new Error(e.name === "AbortError" ? `timeout (${timeoutMs}ms) en ${method} contra ${t.url}` : `no se pudo contactar ${t.url}: ${e.message}`);
      } finally {
        clearTimeout(timer);
      }
    };
    let res = await attempt(oauthToken);
    // 401 → intenta refresh UNA vez y reintenta UNA vez (nunca bucle infinito)
    if (res.status === 401 && !hasExplicitAuth) {
      const refreshed = await getValidAccessToken(this.def, fetch, { forceRefresh: true }).catch(() => null);
      if (refreshed) {
        res = await attempt(refreshed);
      } else if (oauthToken) {
        throw new Error(`HTTP 401 en ${method}: el token de «${this.def.name}» no se pudo renovar; ejecuta «nicotine mcp auth ${this.def.name}»`);
      }
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const ct = res.headers.get("content-type") ?? "";
    if (!res.ok && res.status !== 202) {
      const tail = (await res.text().catch(() => "")).slice(0, 300);
      const hint = res.status === 401 && !hasExplicitAuth ? ` — ejecuta «nicotine mcp auth ${this.def.name}»` : "";
      throw new Error(`HTTP ${res.status} en ${method}${hint}: ${tail || res.statusText}`);
    }
    if (ct.includes("text/event-stream")) return readSseForId(res, id, timeoutMs);
    // application/json (o cuerpo vacío para 202)
    const text = await res.text();
    if (!text.trim()) return undefined;
    const msg = JSON.parse(text) as JsonRpcMessage;
    if (msg.id !== id || msg.result === undefined) {
      if (msg.error) throw new Error(`${method}: ${msg.error.message ?? "error JSON-RPC"} (code ${msg.error.code ?? "?"})`);
      throw new Error(`${method}: respuesta JSON-RPC inesperada`);
    }
    return msg.result;
  }

  private ensureStdio(): Promise<ChildProcess> {
    if (this.child && !this.child.killed) return Promise.resolve(this.child);
    const t = this.def.transport;
    if (t.kind !== "stdio") return Promise.reject(new Error("internal: ensureStdio en HTTP"));
    return new Promise((resolveP, rejectP) => {
      let child: ChildProcess;
      try {
        child = spawn(t.command[0], t.command.slice(1), {
          env: { ...process.env, ...t.env },
          cwd: t.cwd,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        return rejectP(new Error(`no se pudo lanzar "${t.command[0]}": ${(err as Error).message}`));
      }
      child.on("error", (err) => rejectP(new Error(`no se pudo lanzar "${t.command.join(" ")}": ${err.message}`)));
      child.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk.toString("utf8")));
      child.stderr!.on("data", (chunk: Buffer) => { this.stderrLog.push(chunk.toString("utf8")); if (this.stderrLog.length > 40) this.stderrLog.shift(); });
      child.on("exit", (code, signal) => {
        const tail = this.stderrLog.slice(-5).join("").trim().slice(-400);
        const err = new Error(`el servidor MCP «${this.def.name}» terminó (code ${code ?? "?"}${signal ? `, señal ${signal}` : ""})${tail ? `: ${tail}` : ""}`);
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
        this.pending.clear();
        this.child = null;
      });
      this.child = child;
      child.on("spawn", () => resolveP(child));
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try { msg = JSON.parse(line) as JsonRpcMessage; } catch { continue; } // no-JSON en stdout: ignorar
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (typeof msg.id !== "number" && typeof msg.id !== "string") return; // notificación: la ignoramos (logs/progreso)
    const pending = this.pending.get(Number(msg.id));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(Number(msg.id));
    if (msg.error) pending.reject(new Error(`${msg.error.message ?? "error JSON-RPC"} (code ${msg.error.code ?? "?"})`));
    else pending.resolve(msg.result);
  }

  // ---------- protocolo ----------

  /** Conecta y negocia. Devuelve el protocolo efectivo. */
  async connect(): Promise<"legacy" | "2026-07-28"> {
    const want = this.def.protocol;
    if (want === "2026-07-28") {
      await this.discover(this.def.startupTimeoutMs);
      this.negotiatedProtocol = PROTOCOL_2026;
      if (this.def.transport.kind === "http") this.httpStateless = true;
      return PROTOCOL_2026;
    }
    if (want === "auto") {
      try {
        await this.discover(Math.min(this.def.startupTimeoutMs, 5000));
        this.negotiatedProtocol = PROTOCOL_2026;
        if (this.def.transport.kind === "http") this.httpStateless = true;
        return PROTOCOL_2026;
      } catch {
        // cualquier fallo → handshake legacy (spec y docs: fallback)
        this.negotiatedProtocol = null;
        this.httpStateless = false;
        await this.legacyInitialize(this.def.startupTimeoutMs);
        return "legacy";
      }
    }
    await this.legacyInitialize(this.def.startupTimeoutMs);
    return "legacy";
  }

  private async discover(timeoutMs: number): Promise<{ supportedVersions?: string[] }> {
    const result = (await this.send("server/discover", {}, timeoutMs, true)) as { supportedVersions?: string[] } | undefined;
    if (!result || !Array.isArray(result.supportedVersions) || !result.supportedVersions.includes(PROTOCOL_2026)) {
      throw new Error(`server/discover no anuncia ${PROTOCOL_2026}`);
    }
    return result;
  }

  private async legacyInitialize(timeoutMs: number): Promise<void> {
    let lastErr: Error | null = null;
    for (const version of LEGACY_LADDER) {
      try {
        await this.send("initialize", { protocolVersion: version, capabilities: {}, clientInfo: CLIENT_INFO }, timeoutMs);
        this.negotiatedProtocol = "legacy";
        await this.notify("notifications/initialized", {});
        return;
      } catch (err) {
        lastErr = err as Error;
        const msg = lastErr.message.toLowerCase();
        // solo seguimos bajando por la escalera si el servidor rechaza la VERSIÓN
        if (!/protocol|version/.test(msg)) throw lastErr;
      }
    }
    throw lastErr ?? new Error("no se pudo inicializar el servidor MCP");
  }

  private async notify(method: string, params: unknown): Promise<void> {
    if (this.def.transport.kind === "stdio") {
      const child = await this.ensureStdio();
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
      return;
    }
    const t = this.def.transport;
    if (t.kind !== "http") return;
    try {
      await fetch(t.url, { method: "POST", headers: { "content-type": "application/json", ...t.headers }, body: JSON.stringify({ jsonrpc: "2.0", method, params }) });
    } catch { /* la notificación initialized es best-effort */ }
  }

  /** Lista las tools del servidor. */
  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.send("tools/list", {}, this.def.catalogTimeoutMs)) as { tools?: { name?: string; description?: string; inputSchema?: ToolParameters }[] } | undefined;
    const tools = Array.isArray(result?.tools) ? result!.tools! : [];
    return tools.filter((t): t is { name: string; description?: string; inputSchema?: ToolParameters } => typeof t?.name === "string" && !!t.name)
      .map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? { type: "object", properties: {} } }));
  }

  async listResources(): Promise<{ uri: string; name?: string; description?: string }[]> {
    const result = (await this.send("resources/list", {}, this.def.catalogTimeoutMs)) as { resources?: { uri?: string; name?: string; description?: string }[] } | undefined;
    return (result?.resources ?? []).filter((r): r is { uri: string; name?: string; description?: string } => typeof r?.uri === "string");
  }

  async readResource(uri: string): Promise<string> {
    const result = (await this.send("resources/read", { uri }, this.def.executionTimeoutMs)) as { contents?: { text?: string; blob?: string; uri?: string }[] } | undefined;
    const parts = result?.contents ?? [];
    return parts.map((c) => c.text ?? (c.blob ? `[blob ${c.blob.length} chars base64 — no soportado; pide texto]` : `[${c.uri ?? uri}]`)).join("\n") || "(recurso vacío)";
  }

  /** null = el servidor no anuncia prompts/list (o falló). */
  async listPrompts(): Promise<McpPromptInfo[] | null> {
    try {
      const result = (await this.send("prompts/list", {}, this.def.catalogTimeoutMs)) as { prompts?: { name?: string; description?: string; arguments?: { name: string; description?: string; required?: boolean }[] }[] } | undefined;
      return (result?.prompts ?? []).filter((t): t is Required<Pick<typeof t, "name">> & typeof t => typeof t?.name === "string" && !!t.name);
    } catch { return null; }
  }

  /** Renderiza un prompt MCP a texto (roles preservados). */
  async getPrompt(name: string, args: Record<string, string>): Promise<string> {
    const result = (await this.send("prompts/get", { name, arguments: args }, this.def.executionTimeoutMs)) as {
      messages?: { role?: string; content?: { type?: string; text?: string } | string }[];
    } | undefined;
    const msgs = result?.messages ?? [];
    return msgs.map((m) => {
      const c = m.content;
      const text = typeof c === "string" ? c : (c?.text ?? `[${c?.type ?? "contenido"} no textual]`);
      return `${m.role ?? "user"}: ${text}`;
    }).join("\n\n") || "(prompt vacío)";
  }

  async callTool(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    const result = (await this.send("tools/call", { name, arguments: args ?? {} }, this.def.executionTimeoutMs)) as {
      content?: { type: string; text?: string; data?: string; mimeType?: string }[];
      isError?: boolean;
    } | undefined;
    const blocks = result?.content ?? [];
    const text = blocks.map((b) => {
      if (b.type === "text") return b.text ?? "";
      if (b.type === "image") return `[imagen ${b.mimeType ?? "png"}, ${(b.data ?? "").length} chars base64]`;
      if (b.type === "resource") return `[recurso embebido]`;
      return `[${b.type}]`;
    }).join("\n");
    return { text: text || "(sin contenido)", isError: !!result?.isError };
  }

  /** Cierra hijos y rechaza lo pendiente (llamado al salir del proceso). */
  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      await new Promise<void>((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r(); }, 2000); child.on("exit", () => { clearTimeout(t); r(); }); });
    }
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("cliente MCP cerrado")); }
    this.pending.clear();
  }
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function withMeta(params: unknown, stateless: boolean): unknown {
  if (!stateless) return params;
  const p = (params ?? {}) as Record<string, unknown>;
  return { ...p, _meta: { ...((p["_meta"] as Record<string, unknown>) ?? {}), "io.modelcontextprotocol/protocolVersion": PROTOCOL_2026, clientInfo: CLIENT_INFO, clientCapabilities: {} } };
}

/** Lee un stream SSE hasta encontrar el mensaje con `id`. */
async function readSseForId(res: Response, id: number, timeoutMs: number): Promise<unknown> {
  if (!res.body) throw new Error("respuesta SSE sin cuerpo");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) { await reader.cancel().catch(() => {}); throw new Error(`timeout (${timeoutMs}ms) leyendo SSE`); }
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (;;) {
      const sep = buf.indexOf("\n\n");
      if (sep === -1) break;
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLines = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart());
      if (!dataLines.length) continue;
      let msg: JsonRpcMessage;
      try { msg = JSON.parse(dataLines.join("\n")); } catch { continue; }
      if (msg.id === undefined) continue; // notificación embebida
      if (msg.error) throw new Error(msg.error.message ?? "error JSON-RPC en SSE");
      if (msg.id === id) return msg.result;
    }
  }
  throw new Error("stream SSE terminó sin respuesta para la petición");
}
