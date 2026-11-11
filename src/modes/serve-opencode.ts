// Subconjunto HONESTO de la API REST clásica de opencode para `nicotine serve`.
// Ver la cabecera de src/compat/opencode-rest.ts (fuente de verdad: SDK clásico
// v1.18.0) y docs/parity.md (fase 10e). Lo NO implementado devuelve 404 con
// { error }: handleOpenCodeRequest devuelve false y serve.ts emite el 404.
//
// Diferencias deliberadas vs opencode (documentadas):
//   - una sesión por proceso: prompt/command/abort/summarize SOLO aceptan la
//     sesión activa (id ≠ sesión actual → 404);
//   - ?directory= se acepta y se ignora;
//   - cost/tokens por mensaje = 0; error de tool no persistido;
//   - /lsp y /formatter devuelven [] SIEMPRE (sin servidores persistentes);
//   - /session/{id}/summarize compacta con el provider CONFIGURADO (los
//     providerID/modelID del body se aceptan pero no se honran);
//   - ids «live» durante el streaming son provisionales; el id final llega en
//     message.updated tras persistir el turno.

import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Runtime } from "./common.js";
import { compactNow } from "./common.js";
import { Session, dataHome, sessionsDir } from "../core/session.js";
import type { AgentEvent, TokenUsage } from "../core/events.js";
import type { AgentTool, ChatMessage } from "../core/types.js";
import type { ProviderConfig } from "../core/provider.js";
import { stripModel } from "../core/provider.js";
import { allAgents } from "../core/agents.js";
import { renderCommandBody } from "../compat/file-commands.js";
import { ALL_TOOLS } from "../tools/index.js";
import {
  buildOpenApiDoc, detectProviderId, findFiles, findText, gitBranch, gitFileStatus,
  listDir, listOcSessions, mapAgentToOc, mapChatMessages, mapCommandToOc, mapMcpStatusToOc,
  mapOcSession, ocConfigProviders, ocProviderList, ocTodos, projectId, readFileContent,
  sanitizeConfig, TurnEventAdapter,
  type OcMessagePair, type OcEvent,
} from "../compat/opencode-rest.js";
import { readBody, send } from "./serve-http.js";

export interface ExecuteTurnArgs {
  prompt: string;
  signal: AbortSignal;
  /** ts único del turno: se estampa en los mensajes nuevos antes de persistir (ids estables). */
  turnTs: number;
  tools?: AgentTool[];
  provider?: ProviderConfig;
  systemOverride?: string;
  onCoreEvent?: (ev: AgentEvent) => void;
  onUserMessage?: (pair: OcMessagePair) => void;
}
export interface ExecuteTurnResult { reason: "stop" | "max_steps" | "aborted"; usage?: TokenUsage }
export type ExecuteTurn = (args: ExecuteTurnArgs) => Promise<ExecuteTurnResult>;

export interface OpenCodeContext {
  rt: Runtime;
  cwd: string;
  version: string;
  busy(): boolean;
  /** Marca/desmarca busy; con `abort` guarda el AbortController para /abort. */
  setBusy(busy: boolean, abort?: AbortController | null): void;
  /** Aborta el turno en curso (si hay). Devuelve true si había uno. */
  abortCurrent(): boolean;
  /** Clientes SSE registrados (para fan-out de eventos opencode). */
  ocClients: Set<(ev: OcEvent) => void>;
  todos(): ReturnType<typeof ocTodos>;
  executeTurn: ExecuteTurn;
  /** ms máximos antes de abortar un turno vía REST. */
  turnTimeoutMs: number;
}

/** Emite un evento a todos los clientes SSE registrados (/event, /global/event). Nunca lanza. */
export function emitOcEvent(ctx: OpenCodeContext, ev: OcEvent): void {
  for (const fn of [...ctx.ocClients]) {
    try { fn(ev); } catch { /* cliente roto: se desregistra al cerrar */ }
  }
}

const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
const jsonError = (res: ServerResponse, status: number, error: string): void => { send(res, status, { error }); };
const sessionMissing = (res: ServerResponse, id: string): void => jsonError(res, 404, `sesión «${id}» no existe`);
const notActive = (res: ServerResponse, id: string): void =>
  jsonError(res, 404, `sesión «${id}» no está activa en este proceso (nicotine: una sesión por proceso; arranca con -s ${id})`);

/**
 * Marca busy SINCRÓNICAMENTE (antes de cualquier await) y parsea el body.
 * Ante cualquier error responde y desmarca; el caller solo continúa si devuelve ParsedPromptBody.
 */
async function guardBusyAndParse(
  ctx: OpenCodeContext,
  req: IncomingMessage,
  res: ServerResponse,
  finish: (status: number) => void,
  parse: (raw: string) => Promise<PromptParts | { error: string }> | (PromptParts | { error: string }),
): Promise<PromptParts | null> {
  if (ctx.busy()) { jsonError(res, 409, "turno en curso; espera o aborta con POST /session/{id}/abort"); finish(409); return null; }
  ctx.setBusy(true, null);
  let raw: string;
  try { raw = await readBody(req); } catch (err) { ctx.setBusy(false, null); jsonError(res, 413, (err as Error).message); finish(413); return null; }
  const parsed = await parse(raw);
  if (parsed && "error" in parsed) { ctx.setBusy(false, null); jsonError(res, 400, parsed.error); finish(400); return null; }
  return parsed as PromptParts;
}

function sessionExists(id: string): boolean {
  return existsSync(join(sessionsDir(), `${id}.jsonl`));
}

function cwdCreatedMs(cwd: string): number {
  try { const t = statSync(cwd).birthtimeMs; return Math.floor(t > 0 ? t : statSync(cwd).mtimeMs); } catch { return 0; }
}

function ocProject(cwd: string): Record<string, unknown> {
  return { id: projectId(cwd), worktree: cwd, time: { created: cwdCreatedMs(cwd) } };
}

function currentAgentId(rt: Runtime): string {
  return rt.agent.current();
}

function ocModelOf(ctx: OpenCodeContext, provider: ProviderConfig): { providerID: string; modelID: string } {
  return { providerID: detectProviderId(provider.baseURL), modelID: provider.model };
}

/** Mensajes persistidos de una sesión JSONL en forma opencode (info+parts). */
function mapPersisted(ctx: OpenCodeContext, sessionID: string): OcMessagePair[] {
  const s = Session.load(sessionID);
  const msgs = s?.messagesWithTs() ?? [];
  return mapChatMessages(sessionID, ctx.cwd, ocModelOf(ctx, ctx.rt.provider), currentAgentId(ctx.rt), msgs);
}

// ───────────────── validación del body de prompt (message/prompt_async/command) ─────────────────

interface PromptParts {
  prompt: string;
  providerOverride?: ProviderConfig;
  systemOverride?: string;
  toolsFilter?: AgentTool[];
  /** nombre de agente solicitado (ya aplicado). */
  agentApplied?: string;
}

const MAX_FILE_PART_BYTES = 32 * 1024;
const MAX_FILE_PARTS = 8;

function filePartText(part: Record<string, unknown>): { name: string; content: string } | { error: string } {
  const url = typeof part.url === "string" ? part.url : "";
  let path: string | null = null;
  if (url.startsWith("file://")) {
    try { path = decodeURIComponent(url.slice(7)); } catch { return { error: `url file:// inválida: ${url}` }; }
  } else if (url && !url.includes("://") && isAbsolute(url)) {
    path = url; // ruta absoluta en el campo url (clientes que no anteponen file://)
  }
  if (!path) return { error: `FilePart con url «${url.slice(0, 60)}» no soportado (solo file:// o ruta absoluta)` };
  try {
    const buf = readFileSync(path);
    if (buf.length > MAX_FILE_PART_BYTES) return { error: `archivo demasiado grande (>32 KiB): ${path}` };
    const name = typeof part.filename === "string" && part.filename.trim() ? part.filename : path;
    return { name: String(name), content: buf.toString("utf8") };
  } catch {
    return { error: `archivo no legible: ${path}` };
  }
}

type ParsedPromptBody = PromptParts;

async function parsePromptBody(ctx: OpenCodeContext, raw: string): Promise<ParsedPromptBody | { error: string }> {
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw || "{}") as Record<string, unknown>; } catch { return { error: "JSON inválido" }; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body debe ser un objeto" };
  if (body.messageID !== undefined) return { error: "messageID no soportado (nicotine deriva los ids del JSONL persistido)" };
  if (body.noReply) return { error: "noReply no soportado (nicotine siempre ejecuta el turno)" };
  const parts = body.parts;
  if (!Array.isArray(parts) || parts.length === 0) return { error: "falta `parts` (array no vacío de partes de texto)" };
  const texts: string[] = [];
  const fileBlocks: string[] = [];
  let fileCount = 0;
  for (const p of parts as Array<Record<string, unknown>>) {
    if (!p || typeof p !== "object") return { error: "parte inválida (no es objeto)" };
    if (p.type === "text") {
      if (typeof p.text !== "string" || !p.text.trim()) return { error: "parte «text» sin texto" };
      texts.push(p.text);
      continue;
    }
    if (p.type === "file") {
      fileCount += 1;
      if (fileCount > MAX_FILE_PARTS) return { error: `demasiadas partes «file» (máx ${MAX_FILE_PARTS})` };
      const fp = filePartText(p);
      if ("error" in fp) return { error: fp.error };
      fileBlocks.push(`## ${fp.name}\n\n${fp.content}`);
      continue;
    }
    if (p.type === "agent" || p.type === "subtask") {
      return { error: `partes «${String(p.type)}» no soportadas; usa el campo \`agent\` del body para cambiar de agente` };
    }
    return { error: `tipo de parte no soportado: ${String(p.type)} (soportados: text, file file://)` };
  }
  let prompt = texts.join("\n");
  if (fileBlocks.length) prompt += `\n\n${fileBlocks.join("\n\n")}`;
  prompt = prompt.trim();
  if (!prompt) return { error: "el prompt resultante está vacío" };

  // agent: cambia el agente de la sesión (como /agent en la TUI); persiste para el resto de la sesión
  let agentApplied: string | undefined;
  if (typeof body.agent === "string" && body.agent.trim()) {
    const ok = ctx.rt.agent.set(body.agent.trim());
    if (!ok) return { error: `agente desconocido o no seleccionable: ${body.agent}` };
    agentApplied = body.agent.trim();
  }

  // model: { providerID, modelID } — se honra modelID; providerID se ACEPTA pero se ignora
  // (nicotine habla con UN endpoint OpenAI-compatible; el failover de claves/modelos se mantiene)
  let providerOverride: ProviderConfig | undefined;
  if (body.model !== undefined) {
    const m = body.model as Record<string, unknown>;
    const modelID = typeof m?.modelID === "string" ? m.modelID.trim() : "";
    if (!modelID) return { error: "model.modelID requerido si se pasa `model`" };
    providerOverride = { ...ctx.rt.provider, model: stripModel(modelID) };
  }

  // tools: { glob: false } — filtra las tools del turno por nombre exacto
  let toolsFilter: AgentTool[] | undefined;
  if (body.tools !== undefined) {
    if (!body.tools || typeof body.tools !== "object" || Array.isArray(body.tools)) return { error: "`tools` debe ser un objeto { nombre: boolean }" };
    const flags = body.tools as Record<string, unknown>;
    toolsFilter = ctx.rt.tools.filter((t) => flags[t.name] !== false);
  }

  // system: sobreescribe el system prompt SOLO durante este turno (se restaura al terminar)
  let systemOverride: string | undefined;
  if (typeof body.system === "string" && body.system.trim()) systemOverride = body.system;

  return { prompt, providerOverride, systemOverride, toolsFilter, agentApplied };
}

// ─────────────────────────── ciclo de vida del turno ───────────────────────────

interface StartedTurn {
  turnTs: number;
  adapter: TurnEventAdapter;
  abort: AbortController;
  exec: Promise<ExecuteTurnResult>;
  provider: ProviderConfig;
}

function beginTurn(ctx: OpenCodeContext, o: { sessionID: string; prompt: string; tools?: AgentTool[]; provider?: ProviderConfig; systemOverride?: string }): StartedTurn {
  const abort = new AbortController();
  ctx.setBusy(true, abort);
  const turnTs = Date.now();
  const adapter = new TurnEventAdapter({ sessionID: o.sessionID, turnTs, emit: (ev) => emitOcEvent(ctx, ev) });
  const exec = ctx.executeTurn({
    prompt: o.prompt, signal: abort.signal, turnTs, tools: o.tools, provider: o.provider, systemOverride: o.systemOverride,
    onCoreEvent: (ev) => adapter.handle(ev),
    onUserMessage: (pair) => adapter.begin(pair),
  });
  return { turnTs, adapter, abort, exec, provider: o.provider ?? ctx.rt.provider };
}

/** Cierra el turno tras `exec`: persiste (executeTurn ya lo hace), recarga y emite message.updated final + idle. */
async function settleTurn(ctx: OpenCodeContext, started: StartedTurn, sessionID: string): Promise<OcMessagePair | null> {
  try { await started.exec; } catch (err) { started.adapter.fail(String((err as Error)?.message ?? err)); }
  const pairs = mapPersisted(ctx, sessionID);
  const assistantPair = [...pairs].reverse().find((p) => p.info.role === "assistant") ?? null;
  if (assistantPair) emitOcEvent(ctx, { type: "message.updated", properties: { info: assistantPair.info } });
  else started.adapter.fail("el turno no produjo ningún mensaje del asistente");
  started.adapter.finish();
  ctx.setBusy(false, null);
  return assistantPair;
}

/** Turno síncrono compartido por POST …/message y POST …/command. */
async function runTurnSync(ctx: OpenCodeContext, res: ServerResponse, finish: (s: number) => void, o: { sessionID: string; prompt: string; tools?: AgentTool[]; provider?: ProviderConfig; systemOverride?: string; onSettled?: (pair: OcMessagePair) => void }): Promise<void> {
  const started = beginTurn(ctx, o);
  const timer = setTimeout(() => started.abort.abort(), ctx.turnTimeoutMs);
  const pair = await settleTurn(ctx, started, o.sessionID);
  clearTimeout(timer);
  if (!pair) { jsonError(res, 500, "el turno no produjo ningún mensaje del asistente"); finish(500); return; }
  o.onSettled?.(pair);
  send(res, 200, { info: pair.info, parts: pair.parts });
  finish(200);
}

// ─────────────────────────── el handler principal ───────────────────────────

/**
 * Intenta atender la petición como ruta del subconjunto opencode.
 * Devuelve true si respondió (o puso la respuesta en camino, SSE); false si no
 * es una ruta abierta por el subconjunto (serve.ts emite el 404).
 */
export async function handleOpenCodeRequest(ctx: OpenCodeContext, req: IncomingMessage, res: ServerResponse, url: URL, finish: (status: number) => void): Promise<boolean> {
  const rt = ctx.rt;
  const path = url.pathname;
  const method = req.method ?? "GET";
  const cwd = ctx.cwd;
  const version = ctx.version;
  const providerId = detectProviderId(rt.provider.baseURL);

  // /global/health
  if (method === "GET" && path === "/global/health") { send(res, 200, { healthy: true, version }); finish(200); return true; }
  // /doc — este documento describe EXACTAMENTE este subconjunto
  if (method === "GET" && path === "/doc") { send(res, 200, buildOpenApiDoc(version)); finish(200); return true; }
  // /path — Path clásico (state/config/worktree/directory); «config» = dir del layer más específico (o ~/.config/opencode)
  if (method === "GET" && path === "/path") {
    const config = rt.layers.length ? dirname(rt.layers[rt.layers.length - 1]) : join(homedir(), ".config", "opencode");
    send(res, 200, { state: dataHome(), config, worktree: cwd, directory: cwd });
    finish(200); return true;
  }
  // /vcs — { branch } vía git; 404 honesto fuera de repo
  if (method === "GET" && path === "/vcs") {
    const branch = gitBranch(cwd);
    if (!branch) { jsonError(res, 404, "no es un repo git (o git no disponible)"); finish(404); return true; }
    send(res, 200, { branch }); finish(200); return true;
  }
  if (method === "GET" && path === "/project") { send(res, 200, [ocProject(cwd)]); finish(200); return true; }
  if (method === "GET" && path === "/project/current") { send(res, 200, ocProject(cwd)); finish(200); return true; }

  // /config — fusionada y SANITIZADA (claves sensibles → ***)
  if (method === "GET" && path === "/config") { send(res, 200, sanitizeConfig(rt.config)); finish(200); return true; }
  if (method === "PATCH" && path === "/config") {
    jsonError(res, 404, "PATCH /config no implementado en el subconjunto nicotine (sin capa de escritura de config); edita opencode.json(c) a mano");
    finish(404); return true;
  }
  if (method === "GET" && path === "/config/providers") { send(res, 200, ocConfigProviders(rt.config, rt.provider)); finish(200); return true; }
  if (method === "GET" && path === "/provider") { send(res, 200, ocProviderList(rt.config, rt.provider)); finish(200); return true; }
  if (method === "GET" && path === "/provider/auth") {
    send(res, 200, { [providerId]: [{ type: "api", label: "API key" }] });
    finish(200); return true;
  }

  // listados estáticos
  if (method === "GET" && path === "/command") {
    const seen = new Set(rt.configCommands.map((c) => c.name));
    const merged = [...rt.configCommands, ...rt.plugins.commands.filter((c) => !seen.has(c.name))];
    send(res, 200, merged.map(mapCommandToOc));
    finish(200); return true;
  }
  if (method === "GET" && path === "/agent") {
    send(res, 200, allAgents().filter((a) => !a.hidden).map((a) => mapAgentToOc(a, providerId)));
    finish(200); return true;
  }
  if (method === "GET" && path === "/mcp") {
    const map: Record<string, unknown> = {};
    for (const st of rt.mcp.servers) map[st.name] = mapMcpStatusToOc(st);
    send(res, 200, map);
    finish(200); return true;
  }
  // /lsp y /formatter: nicotine NO mantiene servidores LSP persistentes ni formatters → [] siempre
  if (method === "GET" && path === "/lsp") { send(res, 200, []); finish(200); return true; }
  if (method === "GET" && path === "/formatter") { send(res, 200, []); finish(200); return true; }

  // /log — log del cliente a stderr; devuelve true
  if (method === "POST" && path === "/log") {
    let raw: string;
    try { raw = await readBody(req); } catch (err) { jsonError(res, 413, (err as Error).message); finish(413); return true; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw || "{}") as Record<string, unknown>; } catch { jsonError(res, 400, "JSON inválido"); finish(400); return true; }
    const service = typeof body.service === "string" ? body.service : "";
    const message = typeof body.message === "string" ? body.message : "";
    const level = typeof body.level === "string" ? body.level : "info";
    if (!service || !message) { jsonError(res, 400, "faltan `service` y/o `message` (strings no vacíos)"); finish(400); return true; }
    if (!["debug", "info", "warn", "error"].includes(level)) { jsonError(res, 400, "level debe ser debug|info|warn|error"); finish(400); return true; }
    const extra = body.extra !== undefined ? ` ${JSON.stringify(body.extra).slice(0, 2000)}` : "";
    process.stderr.write(`[client] ${service} (${level}): ${message}${extra}\n`);
    send(res, 200, true); finish(200); return true;
  }

  // /find — regex del árbol del proyecto (rg --json o buscador propio con offsets en bytes)
  if (method === "GET" && path === "/find") {
    const pattern = url.searchParams.get("pattern") ?? "";
    const r = findText(pattern, cwd);
    if (r.error) { jsonError(res, 400, r.error); finish(400); return true; }
    send(res, 200, r.matches ?? []); finish(200); return true;
  }
  // /find/file — fuzzy sobre el árbol (mismo motor que «@» en la TUI)
  if (method === "GET" && path === "/find/file") {
    const query = url.searchParams.get("query");
    if (query == null || !query.trim()) { jsonError(res, 400, "falta `query`"); finish(400); return true; }
    const dirs = url.searchParams.get("dirs") === "true";
    send(res, 200, findFiles(query, cwd, dirs));
    finish(200); return true;
  }
  // /find/symbol — sin endpoint de símbolos LSP en nicotine
  if (method === "GET" && path === "/find/symbol") {
    jsonError(res, 404, "no implementado: nicotine no tiene endpoint de símbolos LSP (ver /doc)");
    finish(404); return true;
  }
  // /file — contenido de un DIRECTORIO como FileNode[]
  if (method === "GET" && path === "/file") {
    const p = url.searchParams.get("path");
    if (!p) { jsonError(res, 400, "falta `path`"); finish(400); return true; }
    const r = listDir(p, cwd);
    if (r.error) { jsonError(res, 400, r.error); finish(400); return true; }
    send(res, 200, r.nodes); finish(200); return true;
  }
  if (method === "GET" && path === "/file/content") {
    const p = url.searchParams.get("path");
    if (!p) { jsonError(res, 400, "falta `path`"); finish(400); return true; }
    const r = readFileContent(p, cwd);
    if (r.tooBig) { jsonError(res, 413, r.error ?? "archivo demasiado grande"); finish(413); return true; }
    if (r.error) { jsonError(res, 400, r.error); finish(400); return true; }
    send(res, 200, r.content); finish(200); return true;
  }
  if (method === "GET" && path === "/file/status") { send(res, 200, gitFileStatus(cwd)); finish(200); return true; }
  // /experimental/tool — catálogo de tools del proceso
  if (method === "GET" && path === "/experimental/tool/ids") { send(res, 200, ALL_TOOLS.map((t) => t.name)); finish(200); return true; }
  if (method === "GET" && path === "/experimental/tool") { send(res, 200, ALL_TOOLS.map((t) => ({ id: t.name, description: t.description, parameters: t.parameters }))); finish(200); return true; }

  // /event y /global/event — SSE: server.connected primero, luego eventos en vivo
  if (method === "GET" && (path === "/event" || path === "/global/event")) {
    const isGlobal = path === "/global/event";
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const writeOne = (ev: OcEvent): void => {
      const payload = isGlobal ? { directory: cwd, payload: ev } : ev;
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* cliente desconectado */ }
    };
    writeOne({ type: "server.connected", properties: {} });
    ctx.ocClients.add(writeOne);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* socket muerto */ } }, 25_000);
    req.on("close", () => { clearInterval(ping); ctx.ocClients.delete(writeOne); });
    finish(200);
    return true;
  }

  // ───────────────────────── sesiones (forma opencode) ─────────────────────────

  // GET /session → Array<Session> (TODAS las JSONL) — CAMBIO incompatible leve vs fase 9:
  // la forma {id,title} de la sesión activa pasa a GET /session/current (ver docs/parity.md)
  if (method === "GET" && path === "/session") { send(res, 200, listOcSessions(cwd, version)); finish(200); return true; }
  if (method === "POST" && path === "/session") {
    let raw: string;
    try { raw = await readBody(req); } catch (err) { jsonError(res, 413, (err as Error).message); finish(413); return true; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw || "{}") as Record<string, unknown>; } catch { jsonError(res, 400, "JSON inválido"); finish(400); return true; }
    if (body.parentID !== undefined) { jsonError(res, 400, "parentID no soportado (nicotine no persiste relaciones padre→hijo entre sesiones)"); finish(400); return true; }
    let title: string | undefined;
    if (body.title !== undefined) {
      if (typeof body.title !== "string" || !body.title.trim()) { jsonError(res, 400, "`title` debe ser un string no vacío"); finish(400); return true; }
      title = body.title.trim().slice(0, 200);
    }
    const s = Session.create(cwd);
    if (title) s.setTitle(title);
    const mapped = mapOcSession(s.id, cwd, version);
    if (mapped) emitOcEvent(ctx, { type: "session.created", properties: { info: mapped } });
    send(res, 200, mapped ?? { id: s.id, projectID: projectId(cwd), directory: cwd, title: title ?? "(nueva)", version, time: { created: Date.now(), updated: Date.now() } });
    finish(200); return true;
  }
  // GET /session/status → { [id]: { type } } (busy solo para la sesión de este proceso)
  if (method === "GET" && path === "/session/status") {
    const map: Record<string, { type: "idle" | "busy" }> = {};
    for (const s of listOcSessions(cwd, version)) map[s.id] = { type: s.id === rt.session.id && ctx.busy() ? "busy" : "idle" };
    if (!map[rt.session.id]) map[rt.session.id] = { type: ctx.busy() ? "busy" : "idle" };
    send(res, 200, map); finish(200); return true;
  }

  const mOne = path.match(/^\/session\/([^/]+)$/);
  if (mOne) {
    const id = decode(mOne[1]);
    if (method === "GET") {
      const s = mapOcSession(id, cwd, version);
      if (!s) { sessionMissing(res, id); finish(404); return true; }
      send(res, 200, s); finish(200); return true;
    }
    if (method === "PATCH") {
      let raw: string;
      try { raw = await readBody(req); } catch (err) { jsonError(res, 413, (err as Error).message); finish(413); return true; }
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw || "{}") as Record<string, unknown>; } catch { jsonError(res, 400, "JSON inválido"); finish(400); return true; }
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) { jsonError(res, 400, "falta `title` (string no vacío)"); finish(400); return true; }
      if (!sessionExists(id)) { sessionMissing(res, id); finish(404); return true; }
      Session.load(id)?.setTitle(title.slice(0, 200));
      const mapped = mapOcSession(id, cwd, version);
      if (mapped) emitOcEvent(ctx, { type: "session.updated", properties: { info: mapped } });
      send(res, 200, mapped); finish(200); return true;
    }
    if (method === "DELETE") {
      if (id === rt.session.id) { jsonError(res, 409, "no se puede borrar la sesión ACTIVA del proceso (nicotine la tiene abierta)"); finish(409); return true; }
      const mapped = mapOcSession(id, cwd, version);
      const ok = Session.remove(id);
      if (ok && mapped) emitOcEvent(ctx, { type: "session.deleted", properties: { info: mapped } });
      send(res, 200, ok); finish(200); return true;
    }
    return false;
  }

  const mMsg = path.match(/^\/session\/([^/]+)\/message$/);
  if (mMsg) {
    const id = decode(mMsg[1]);
    if (method === "GET") {
      if (!sessionExists(id)) { sessionMissing(res, id); finish(404); return true; }
      const pairs = mapPersisted(ctx, id);
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? Number(limitRaw) : NaN;
      send(res, 200, Number.isFinite(limit) && limit > 0 ? pairs.slice(-Math.floor(limit)) : pairs);
      finish(200); return true;
    }
    if (method === "POST") {
      if (id !== rt.session.id) { notActive(res, id); finish(404); return true; }
      const parsed = await guardBusyAndParse(ctx, req, res, finish, (raw) => parsePromptBody(ctx, raw));
      if (!parsed) return true;
      await runTurnSync(ctx, res, finish, { sessionID: id, prompt: parsed.prompt, tools: parsed.toolsFilter, provider: parsed.providerOverride, systemOverride: parsed.systemOverride });
      return true;
    }
    return false;
  }

  const mMid = path.match(/^\/session\/([^/]+)\/message\/([^/]+)$/);
  if (mMid) {
    if (method !== "GET") return false;
    const id = decode(mMid[1]);
    const mid = decode(mMid[2]);
    if (!sessionExists(id)) { sessionMissing(res, id); finish(404); return true; }
    const pair = mapPersisted(ctx, id).find((p) => p.info.id === mid);
    if (!pair) { jsonError(res, 404, `mensaje no encontrado: ${mid}`); finish(404); return true; }
    send(res, 200, pair); finish(200); return true;
  }

  const mAsync = path.match(/^\/session\/([^/]+)\/prompt_async$/);
  if (mAsync) {
    if (method !== "POST") return false;
    const id = decode(mAsync[1]);
    if (id !== rt.session.id) { notActive(res, id); finish(404); return true; }
    const parsed = await guardBusyAndParse(ctx, req, res, finish, (raw) => parsePromptBody(ctx, raw));
    if (!parsed) return true;
    const started = beginTurn(ctx, { sessionID: id, prompt: parsed.prompt, tools: parsed.toolsFilter, provider: parsed.providerOverride, systemOverride: parsed.systemOverride });
    const timer = setTimeout(() => started.abort.abort(), ctx.turnTimeoutMs);
    void settleTurn(ctx, started, id).finally(() => clearTimeout(timer));
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
    finish(204); return true;
  }

  const mCmd = path.match(/^\/session\/([^/]+)\/command$/);
  if (mCmd) {
    if (method !== "POST") return false;
    const id = decode(mCmd[1]);
    if (id !== rt.session.id) { notActive(res, id); finish(404); return true; }
    if (ctx.busy()) { jsonError(res, 409, "turno en curso; espera o aborta con POST /session/{id}/abort"); finish(409); return true; }
    ctx.setBusy(true, null);
    let body: Record<string, unknown> = {};
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw || "{}") as Record<string, unknown>;
      if (body.messageID !== undefined) { const e = "messageID no soportado (nicotine deriva los ids del JSONL persistido)"; ctx.setBusy(false, null); jsonError(res, 400, e); finish(400); return true; }
      const command = typeof body.command === "string" ? body.command.trim().replace(/^\/+/, "") : "";
      if (!command) { ctx.setBusy(false, null); jsonError(res, 400, "falta `command` (nombre del comando, sin «/»)"); finish(400); return true; }
      body = { ...body, command };
    } catch (err) {
      ctx.setBusy(false, null);
      const msg = err instanceof SyntaxError ? "JSON inválido" : (err as Error).message;
      jsonError(res, err instanceof SyntaxError ? 400 : 413, msg); finish(err instanceof SyntaxError ? 400 : 413); return true;
    }
    const command = String(body.command);
    const cfg = rt.configCommands.find((c) => c.name === command);
    const plug = cfg ? undefined : rt.plugins.commands.find((c) => c.name === command);
    const found = cfg ?? plug;
    if (!found) {
      const available = [...rt.configCommands.map((c) => c.name), ...rt.plugins.commands.map((c) => c.name)];
      ctx.setBusy(false, null);
      jsonError(res, 400, `comando «${command}» desconocido o no ejecutable vía REST (los builtins son acciones de UI). Disponibles: ${available.join(", ") || "(ninguno)"}`);
      finish(400); return true;
    }
    const argsText = typeof body.arguments === "string" ? body.arguments : "";
    // agent/model del body pisan los del comando (como en opencode); los comandos
    // de plugin (FileCommand) no llevan agent/model — solo los de config (ConfigCommand)
    const foundAgent = "agent" in found && typeof found.agent === "string" ? found.agent : undefined;
    const foundModel = "model" in found && typeof found.model === "string" ? found.model : undefined;
    let providerOverride: ProviderConfig | undefined;
    if (typeof body.agent === "string" && body.agent.trim()) {
      if (!rt.agent.set(body.agent.trim())) { ctx.setBusy(false, null); jsonError(res, 400, `agente desconocido o no seleccionable: ${body.agent}`); finish(400); return true; }
    } else if (foundAgent) {
      rt.agent.set(foundAgent); // si falla, se mantiene el actual (como en la TUI)
    }
    const modelField = typeof body.model === "string" && body.model.trim() ? body.model.trim() : foundModel;
    if (modelField) providerOverride = { ...rt.provider, model: stripModel(modelField) };
    const prompt = renderCommandBody(found, argsText);
    await runTurnSync(ctx, res, finish, {
      sessionID: id, prompt, provider: providerOverride,
      onSettled: (pair) => emitOcEvent(ctx, { type: "command.executed", properties: { name: command, sessionID: id, arguments: argsText, messageID: pair.info.id } }),
    });
    return true;
  }

  const mAbort = path.match(/^\/session\/([^/]+)\/abort$/);
  if (mAbort) {
    if (method !== "POST") return false;
    const id = decode(mAbort[1]);
    if (id !== rt.session.id) { notActive(res, id); finish(404); return true; }
    ctx.abortCurrent(); // true si había turno; en cualquier caso 200 true (abort es idempotente)
    send(res, 200, true); finish(200); return true;
  }

  const mTodo = path.match(/^\/session\/([^/]+)\/todo$/);
  if (mTodo) {
    if (method !== "GET") return false;
    const id = decode(mTodo[1]);
    if (!sessionExists(id)) { sessionMissing(res, id); finish(404); return true; }
    // nicotine solo conoce los todos del proceso en curso; para otras sesiones: []
    send(res, 200, id === rt.session.id ? ctx.todos() : []);
    finish(200); return true;
  }

  const mSummarize = path.match(/^\/session\/([^/]+)\/summarize$/);
  if (mSummarize) {
    if (method !== "POST") return false;
    const id = decode(mSummarize[1]);
    if (id !== rt.session.id) { notActive(res, id); finish(404); return true; }
    if (ctx.busy()) { jsonError(res, 409, "turno en curso; aborta con POST /session/{id}/abort"); finish(409); return true; }
    ctx.setBusy(true, null);
    let raw: string;
    try { raw = await readBody(req); } catch (err) { ctx.setBusy(false, null); jsonError(res, 413, (err as Error).message); finish(413); return true; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw || "{}") as Record<string, unknown>; } catch { jsonError(res, 400, "JSON inválido"); finish(400); return true; }
    if (typeof body.providerID !== "string" || typeof body.modelID !== "string") {
      ctx.setBusy(false, null);
      jsonError(res, 400, "summarize requiere { providerID, modelID } (strings). Se aceptan pero NO se honran: nicotine compacta con su provider CONFIGURADO");
      finish(400); return true;
    }
    try {
      const r = await compactNow(rt);
      if (r.compacted) emitOcEvent(ctx, { type: "session.compacted", properties: { sessionID: id } });
      send(res, 200, r.compacted); finish(200); return true;
    } catch (err) {
      jsonError(res, 500, `compactación falló: ${(err as Error)?.message ?? err}`); finish(500); return true;
    } finally {
      ctx.setBusy(false, null);
    }
  }

  return false;
}
