// Subconjunto HONESTO de la API REST "clásica" de opencode en vireo serve.
// No es paridad: solo las rutas implementadas en src/modes/serve.ts responden;
// todo lo demás devuelve 404 con cuerpo { error } (ver docs/parity.md, fase 10e).
//
// Fuente de verdad de las formas de datos: SDK clásico de opencode v1.18.0
// (packages/sdk/js/src/gen/types.gen.ts, etiqueta v1.18.0), NO el nuevo
// contrato experimental /api/* de packages/protocol del repo actual.
// Diferencias deliberadas frente a opencode documentadas en cada función.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ChatMessage, ToolCall } from "../core/types.js";
import { Session, sessionsDir } from "../core/session.js";
import { CONNECT_CATALOG } from "../core/auth.js";
import { fuzzyFilter } from "../ui/fuzzy.js";
import { walkProject } from "./project-walk.js";
import { isIgnored, loadGitignore } from "../tools/glob.js";
import { ALL_TOOLS } from "../tools/index.js";
import { BUILTIN_AGENTS, type AgentDef } from "../core/agents.js";
import { stripModel } from "../core/provider.js";

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

export const DEFAULT_PROJECT_ID_SALT = "vireo";

/** projectID sintético y estable para el directorio actual (vireo gestiona UNA raíz por proceso). */
export function projectId(cwd: string): string {
  return `proj_${sha1(`${DEFAULT_PROJECT_ID_SALT}:${cwd}`).slice(0, 16)}`;
}

/**
 * providerID efectivo: vireo habla con UN endpoint OpenAI-compatible.
 * Se deduce de la baseURL por el catálogo CONNECT; si no encaja, se reporta «custom».
 */
export function detectProviderId(baseURL: string): string {
  const norm = baseURL.replace(/\/+$/, "");
  for (const c of CONNECT_CATALOG) if (c.baseURL.replace(/\/+$/, "") === norm) return c.id;
  return "custom";
}

const PROVIDER_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  together: "TOGETHER_API_KEY",
};

/** Nombre legible para un providerId detectado (catálogo o «custom»). Nunca incluye claves. */
export function providerLabel(id: string): string {
  return CONNECT_CATALOG.find((c: { id: string; label: string }) => c.id === id)?.label ?? "OpenAI-compatible (personalizado)";
}

export function providerEnv(id: string): string | undefined {
  return PROVIDER_ENV[id];
}

function birthtimeMs(path: string): number | null {
  try { const st = statSync(path); return st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs; } catch { return null; }
}
export function sessionUpdatedMs(path: string): number | null {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

export interface OcSession {
  id: string; projectID: string; directory: string; title: string; version: string;
  time: { created: number; updated: number };
}

/** Mapa JSONL → Session clásico de opencode. Devuelve null si la sesión no existe. */
export function mapOcSession(id: string, cwdHint: string, version: string): OcSession | null {
  const path = join(sessionsDir(), `${id}.jsonl`);
  if (!existsSync(path)) return null;
  const meta = Session.meta(id);
  const created = meta?.created ? (Date.parse(meta.created) || birthtimeMs(path) || Date.now()) : (birthtimeMs(path) ?? Date.now());
  const updated = sessionUpdatedMs(path) ?? Date.now();
  const directory = meta?.cwd ?? cwdHint;
  return {
    id,
    projectID: projectId(directory),
    directory,
    title: (meta?.title ?? "").trim() || "(sin título)",
    version,
    time: { created: Math.floor(created), updated: Math.floor(updated) },
  };
}

/** Todas las sesiones JSONL en forma opencode (updated desc, como Session.list()). */
export function listOcSessions(cwdHint: string, version: string): OcSession[] {
  const out: OcSession[] = [];
  for (const s of Session.list()) {
    const mapped = mapOcSession(s.id, cwdHint, version);
    if (mapped) out.push(mapped);
  }
  return out;
}

// ───────────────────────────── mensajes ─────────────────────────────

export interface OcMessagePair {
  info: Record<string, unknown> & { id: string; sessionID: string; role: "user" | "assistant" };
  parts: Array<Record<string, unknown> & { id: string; sessionID: string; messageID: string; type: string }>;
}

const msgId = (sessionID: string, m: ChatMessage & { ts?: number }, ts: number): string =>
  `msg_${ts.toString(36)}_${sha1(`${sessionID}:${ts}:${m.role}:${String(m.content ?? "")}:${m.tool_calls?.length ?? 0}`).slice(0, 12)}`;

const partId = (messageID: string, suffix: string): string => `prt_${sha1(`${messageID}:${suffix}`).slice(0, 12)}`;

function textPart(messageID: string, sessionID: string, text: string, ts: number): OcMessagePair["parts"][number] {
  return { id: partId(messageID, "text"), sessionID, messageID, type: "text", text, time: { start: ts, end: ts } };
}

const safeJson = (raw: string | undefined): Record<string, unknown> => {
  try { const v = raw ? JSON.parse(raw) : {}; return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : { value: v }; } catch { return {}; }
};

/**
 * ChatMessage[] de vireo → Array<{ info, parts }> (el sobre clásico de opencode).
 * Mapeo honesto y aproximado:
 *   - los mensajes «tool» (resultado) se pliegan en ToolPart.state.output del
 *     tool_call correspondiente; no aparecen como mensaje propio;
 *   - los mensajes «system» no se exponen (vireo no los persiste);
 *   - cost/tokens no se persisten por mensaje: se emiten ceros;
 *   - el estado de error de un tool NO se persiste: siempre «completed»;
 *   - parentID del assistant = id del último user previo (u «unknown»);
 *   - time.created = ts de la línea JSONL (o 0 si falta).
 */
export function mapChatMessages(
  sessionID: string,
  cwd: string,
  model: { providerID: string; modelID: string },
  agentId: string,
  msgs: (ChatMessage & { ts?: number })[],
): OcMessagePair[] {
  const pairs: OcMessagePair[] = [];
  const toolOut = new Map<string, { content: string; ts?: number }>();
  for (const m of msgs) if (m.role === "tool") toolOut.set(String(m.tool_call_id ?? ""), { content: String(m.content ?? ""), ts: m.ts });
  let lastUserId = "";
  for (const m of msgs) {
    if (m.role === "system" || m.role === "tool") continue;
    const ts = m.ts ?? 0;
    const mid = msgId(sessionID, m, ts);
    if (m.role === "user") {
      lastUserId = mid;
      const parts = m.content ? [textPart(mid, sessionID, String(m.content), ts)] : [];
      pairs.push({ info: { id: mid, sessionID, role: "user", time: { created: ts }, agent: agentId, model: { ...model } }, parts });
      continue;
    }
    // assistant
    const parts: OcMessagePair["parts"] = [];
    if (m.content) parts.push(textPart(mid, sessionID, String(m.content), ts));
    for (const tc of (m.tool_calls ?? []) as ToolCall[]) {
      const out = toolOut.get(tc.id);
      parts.push({
        id: partId(mid, `tool:${tc.id}`), sessionID, messageID: mid, type: "tool",
        callID: tc.id, tool: tc.function.name,
        state: {
          status: "completed",
          input: safeJson(tc.function.arguments),
          output: out?.content ?? "(sin resultado registrado)",
          title: tc.function.name,
          metadata: {},
          time: { start: ts, end: out?.ts ?? ts },
        },
      });
    }
    pairs.push({
      info: {
        id: mid, sessionID, role: "assistant", parentID: lastUserId || "unknown",
        modelID: model.modelID, providerID: model.providerID, mode: agentId,
        path: { cwd, root: cwd }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: ts, completed: ts }, finish: "stop",
      },
      parts,
    });
  }
  return pairs;
}

// ──────────────────────── eventos SSE (/event, /global/event) ────────────────────────

export interface OcEvent { type: string; properties: Record<string, unknown> }

/** TodoItem de vireo → Todo de opencode (id/priority sintéticos, documentados). */
export function ocTodos(todos: { content: string; status: string }[]): Array<{ id: string; content: string; status: string; priority: string }> {
  return todos.map((t, i) => ({ id: `todo_${i + 1}`, content: String(t.content), status: ["pending", "in_progress", "completed"].includes(t.status) ? t.status : "pending", priority: "medium" }));
}

/**
 * Adaptador de eventos del núcleo → eventos opencode de UN turno.
 * Los ids «live» (msg_<ts>_live) son PROVISIONALES: tras el turno, serve emite
 * message.updated con el id final derivado del JSONL persistido (ver serve.ts).
 */
export class TurnEventAdapter {
  private textBuf = "";
  private lastUsage: { input: number; output: number } | undefined;
  private errored: string | null = null;
  private turnTs: number;
  private liveAssistantId: string;
  private running = new Map<string, { tool: string; input: Record<string, unknown>; start: number }>();

  constructor(private opts: { sessionID: string; turnTs: number; emit: (ev: OcEvent) => void }) {
    this.turnTs = opts.turnTs;
    this.liveAssistantId = `msg_${opts.turnTs.toString(36)}_live`;
  }

  get assistantId(): string { return this.liveAssistantId; }

  /** Al crear el mensaje de usuario: session.status busy + message.updated(user). */
  begin(userPair: OcMessagePair): void {
    const { emit } = this.opts;
    emit({ type: "session.status", properties: { sessionID: this.opts.sessionID, status: { type: "busy" } } });
    emit({ type: "message.updated", properties: { info: userPair.info } });
  }

  /** Mensaje de error del turno (p. ej. excepción en el loop): session.error. */
  fail(message: string): void {
    this.errored = message;
    this.opts.emit({ type: "session.error", properties: { sessionID: this.opts.sessionID, error: { name: "UnknownError", data: { message } } } });
  }

  /** Consume un AgentEvent del núcleo. */
  handle(ev: import("../core/events.js").AgentEvent): void {
    const { emit } = this.opts;
    const sessionID = this.opts.sessionID;
    const partBase = { sessionID, messageID: this.liveAssistantId };
    switch (ev.type) {
      case "text_delta":
        this.textBuf += ev.text;
        emit({ type: "message.part.updated", properties: { part: { id: partId(this.liveAssistantId, "text"), ...partBase, type: "text", text: this.textBuf, time: { start: this.turnTs } }, delta: ev.text } });
        return;
      case "tool_start": {
        const args = ev.args && typeof ev.args === "object" ? ev.args : {};
        this.running.set(ev.id, { tool: ev.name, input: args, start: Date.now() });
        emit({ type: "message.part.updated", properties: { part: { id: `prt_live_${ev.id}`, ...partBase, type: "tool", callID: ev.id, tool: ev.name, state: { status: "running", input: args, time: { start: Date.now() } } } } });
        return;
      }
      case "tool_end": {
        const started = this.running.get(ev.id);
        const input = started?.input ?? {};
        const state = ev.isError
          ? { status: "error", input, error: String(ev.output).slice(0, 4000), time: { start: started?.start ?? Date.now(), end: Date.now() } }
          : { status: "completed", input, output: String(ev.output), title: ev.name, metadata: {}, time: { start: started?.start ?? Date.now(), end: Date.now() } };
        this.running.delete(ev.id);
        emit({ type: "message.part.updated", properties: { part: { id: `prt_live_${ev.id}`, ...partBase, type: "tool", callID: ev.id, tool: ev.name, state } } });
        return;
      }
      case "todos_updated":
        emit({ type: "todo.updated", properties: { sessionID, todos: ocTodos(ev.todos) } });
        return;
      case "compaction":
        emit({ type: "session.compacted", properties: { sessionID } });
        return;
      case "error":
        this.errored = ev.message;
        emit({ type: "session.error", properties: { sessionID, error: { name: "UnknownError", data: { message: ev.message } } } });
        return;
      case "turn_end":
        this.lastUsage = { input: ev.usage?.promptTokens ?? 0, output: ev.usage?.completionTokens ?? 0 };
        return;
      default:
        return; // session_saved / provider_retry / error de núcleo: sin equivalente directo
    }
  }

  /** Cierre del turno: session.status idle + session.idle. Devuelve los tokens acumulados. */
  finish(): { tokens: { input: number; output: number } | null; failed: boolean } {
    const sessionID = this.opts.sessionID;
    this.opts.emit({ type: "session.status", properties: { sessionID, status: { type: "idle" } } });
    this.opts.emit({ type: "session.idle", properties: { sessionID } });
    return { tokens: this.lastUsage ?? null, failed: this.errored !== null };
  }
}

// ─────────────────────── /find y /find/file ───────────────────────

export interface OcFindMatch {
  path: { text: string }; lines: { text: string }; line_number: number; absolute_offset: number;
  submatches: Array<{ match: { text: string }; start: number; end: number }>;
}

/**
 * /find?pattern=… — regex sobre archivos de texto del árbol del proyecto.
 * Con ripgrep en PATH usa `rg --json` (offsets en bytes exactos); si no, cae a
 * un buscador propio con offsets calculados en bytes (limitado a 200 resultados).
 */
export function findText(pattern: string, cwd: string, limit = 200): { matches?: OcFindMatch[]; error?: string } {
  if (!pattern.trim()) return { error: "falta `pattern` (string no vacío)" };
  const rel = (p: string) => (isAbsolute(p) ? relative(cwd, p) : p).split(sep).join("/");
  const rg = spawnSync("rg", ["--json", "--ignore-case", "--no-require-git", "--max-count", String(limit), "--", pattern, cwd], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (rg.error) {
    if ((rg.error as NodeJS.ErrnoException).code !== "ENOENT") return { error: `ripgrep falló: ${String(rg.error)}` };
    return jsFindText(pattern, cwd, limit);
  }
  if (rg.status !== 0 && rg.status !== 1) return { error: `patrón inválido o error de rg (código ${rg.status})` };
  const matches: OcFindMatch[] = [];
  for (const line of rg.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; absolute_offset?: number; submatches?: Array<{ match?: { text?: string }; start?: number; end?: number }> } };
      if (ev.type !== "match" || !ev.data) continue;
      matches.push({
        path: { text: rel(String(ev.data.path?.text ?? "")) },
        lines: { text: String(ev.data.lines?.text ?? "").replace(/\n$/, "") },
        line_number: Number(ev.data.line_number ?? 0),
        absolute_offset: Number(ev.data.absolute_offset ?? 0),
        submatches: (ev.data.submatches ?? []).map((s) => ({ match: { text: String(s.match?.text ?? "") }, start: Number(s.start ?? 0), end: Number(s.end ?? 0) })),
      });
      if (matches.length >= limit) break;
    } catch { /* línea de rg no parseable: ignorar */ }
  }
  return { matches };
}

function jsFindText(pattern: string, cwd: string, limit: number): { matches?: OcFindMatch[]; error?: string } {
  let re: RegExp;
  try { re = new RegExp(pattern, "gi"); } catch (err) { return { error: `regex inválida: ${(err as Error).message}` }; }
  const matches: OcFindMatch[] = [];
  for (const rel of walkProject(cwd)) {
    if (matches.length >= limit) break;
    const abs = join(cwd, rel);
    let buf: Buffer;
    try { buf = readFileSync(abs); } catch { continue; }
    if (buf.includes(0)) continue; // binario
    const text = buf.toString("utf8");
    let offset = 0;
    let lineNo = 0;
    for (const line of text.split("\n")) {
      lineNo += 1;
      re.lastIndex = 0;
      const subs: OcFindMatch["submatches"] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        subs.push({ match: { text: m[0] }, start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0) re.lastIndex += 1; // patrón vacío: avanzar a mano
      }
      if (subs.length) {
        matches.push({ path: { text: rel }, lines: { text: line }, line_number: lineNo, absolute_offset: offset + subs[0].start, submatches: subs });
        if (matches.length >= limit) break;
      }
      offset += Buffer.byteLength(line) + 1;
    }
  }
  return { matches };
}

/** /find/file?query=… — fuzzy sobre el árbol del proyecto (mismo motor que la TUI). */
export function findFiles(query: string, cwd: string, dirs: boolean, limit = 100): string[] {
  const files = walkProject(cwd);
  if (!dirs) return fuzzyFilter(files, query, limit);
  const dirSet = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/"));
  }
  return fuzzyFilter([...dirSet, ...files], query, limit);
}

// ─────────────────────────── /file y /file/content ───────────────────────────

export interface OcFileNode { name: string; path: string; absolute: string; type: "file" | "directory"; ignored: boolean }

export function listDir(pathParam: string, cwd: string): { nodes?: OcFileNode[]; error?: string } {
  const abs = isAbsolute(pathParam) ? pathParam : join(cwd, pathParam);
  let entries;
  try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return { error: `no es un directorio legible: ${pathParam}` }; }
  const ignores = loadGitignore(cwd);
  const nodes: OcFileNode[] = [];
  for (const e of entries.slice(0, 2000)) {
    const child = join(abs, e.name);
    const rel = relative(cwd, child).split(sep).join("/");
    const inside = rel && !rel.startsWith("..");
    nodes.push({
      name: e.name,
      path: inside ? rel : child,
      absolute: child,
      type: e.isDirectory() ? "directory" : "file",
      ignored: inside ? isIgnored(rel, ignores) : false,
    });
  }
  return { nodes };
}

const MIME: Record<string, string> = {
  ".ts": "text/plain", ".tsx": "text/plain", ".js": "text/plain", ".jsx": "text/plain", ".mjs": "text/plain", ".cjs": "text/plain",
  ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain", ".html": "text/html", ".css": "text/css",
  ".yml": "text/yaml", ".yaml": "text/yaml", ".toml": "text/plain", ".sh": "text/plain", ".py": "text/plain", ".go": "text/plain", ".rs": "text/plain",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
};

/** /file/content — texto utf8 o base64 si binario. Tope 2 MiB. */
export function readFileContent(pathParam: string, cwd: string): { content?: Record<string, unknown>; error?: string; tooBig?: boolean } {
  const abs = isAbsolute(pathParam) ? pathParam : join(cwd, pathParam);
  let buf: Buffer;
  try { buf = readFileSync(abs); } catch { return { error: `no existe o no legible: ${pathParam}` }; }
  const MAX = 2 * 1024 * 1024;
  if (buf.length > MAX) return { error: `archivo demasiado grande (máx 2 MiB)`, tooBig: true };
  const ext = (abs.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
  const isBinary = buf.subarray(0, 8192).includes(0);
  if (isBinary) {
    return { content: { type: "binary", content: buf.toString("base64"), encoding: "base64", mimeType: MIME[ext] ?? "application/octet-stream" } };
  }
  return { content: { type: "text", content: buf.toString("utf8"), mimeType: MIME[ext] ?? "text/plain" } };
}

// ─────────────────────────── git: /vcs y /file/status ───────────────────────────

/** Rama actual (git). null si el directorio no es un repo o git falla. */
export function gitBranch(cwd: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  const branch = r.stdout.trim();
  return branch || null;
}

export interface OcGitFile { path: string; added: number; removed: number; status: "added" | "deleted" | "modified" }

/**
 * /file/status — `git status --porcelain` + numstat vs HEAD.
 * Fuera de un repo git devuelve [] (documentado en /doc y docs/parity.md).
 */
export function gitFileStatus(cwd: string): OcGitFile[] {
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8" });
  if (inside.error || inside.status !== 0 || inside.stdout.trim() !== "true") return [];
  const st = spawnSync("git", ["-c", "core.quotePath=false", "status", "--porcelain=v1"], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (st.status !== 0) return [];
  const numstat = spawnSync("git", ["diff", "--numstat", "HEAD"], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const counts = new Map<string, { added: number; removed: number }>();
  if (numstat.status === 0) {
    for (const line of numstat.stdout.split("\n")) {
      const [a, d, ...rest] = line.split("\t");
      const p = rest.join("\t");
      if (!p) continue;
      counts.set(p, { added: Number(a) || 0, removed: Number(d) || 0 });
    }
  }
  const out: OcGitFile[] = [];
  for (const line of st.stdout.split("\n")) {
    if (!line.trim()) continue;
    const x = line[0], y = line[1];
    let p = line.slice(3).trim();
    const arrow = p.lastIndexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4);
    const xy = `${x}${y}`;
    let status: OcGitFile["status"] = "modified";
    if (xy === "??" || (x === "A" && y === " ")) status = "added";
    else if (x === "D" || y === "D") status = "deleted";
    else if (x === "A" || y === "A") status = "added";
    let { added, removed } = counts.get(p) ?? { added: 0, removed: 0 };
    if (xy === "??") {
      try { added = readFileSync(join(cwd, p), "utf8").split("\n").length; } catch { /* binario/ilegible: 0 */ }
      removed = 0;
    }
    out.push({ path: p.split(sep).join("/"), added, removed, status });
  }
  return out;
}

// ─────────────────────── config / providers / agentes ───────────────────────

const SENSITIVE = /(api[-_]?key|apikey|token|secret|password|authorization|credential|refresh|client[-_]?id)/i;

/** Config fusionada con claves sensibles redactadas (recursivo, no muta el original). */
export function sanitizeConfig(input: unknown): unknown {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = SENSITIVE.test(k) ? "***" : walk(val);
      return out;
    }
    return v;
  };
  return walk(input);
}

export interface OcProvider {
  id: string; name: string; source: "env" | "config" | "custom" | "api"; env: string[];
  options: Record<string, unknown>; models: Record<string, unknown>;
}

/** Provider sintético (vireo = UN endpoint OpenAI-compatible). NUNCA incluye claves. */
export function ocProvider(cfg: Record<string, unknown>, provider: { baseURL: string; model: string; apiKey?: string }): OcProvider {
  const id = detectProviderId(provider.baseURL);
  const providerCfg = (cfg["provider"] ?? {}) as Record<string, unknown>;
  const configKey = typeof providerCfg["apiKey"] === "string" || Array.isArray(providerCfg["apiKeys"]);
  const source: OcProvider["source"] = id === "custom" ? "custom" : configKey ? "config" : "env";
  const env = PROVIDER_ENV[id] ? [PROVIDER_ENV[id]] : [];
  return { id, name: providerLabel(id), source, env, options: { baseURL: provider.baseURL }, models: {} };
}

/** Respuesta de /provider (lista): catálogo CONNECT + proveedor activo. models:{} honesto (sin catálogo remoto). */
export function ocProviderList(cfg: Record<string, unknown>, provider: { baseURL: string; model: string }): Record<string, unknown> {
  const active = ocProvider(cfg, provider);
  const catalog = CONNECT_CATALOG.map((c: { id: string; label: string; baseURL: string }) => ({ id: c.id, name: c.label, env: PROVIDER_ENV[c.id] ? [PROVIDER_ENV[c.id]] : [], api: c.baseURL, models: {} as Record<string, unknown> }));
  const all = catalog.some((c) => c.id === active.id) ? catalog : [...catalog, { id: active.id, name: active.name, env: [], api: provider.baseURL, models: {} }];
  return { all, default: { [active.id]: provider.model }, connected: [active.id] };
}

/** Respuesta de /config/providers. */
export function ocConfigProviders(cfg: Record<string, unknown>, provider: { baseURL: string; model: string }): Record<string, unknown> {
  const active = ocProvider(cfg, provider);
  return { providers: [active], default: { [active.id]: provider.model } };
}

/** AgentDef → Agent clásico de opencode. permission es una APROXIMACIÓN documentada. */
export function mapAgentToOc(a: AgentDef, providerID: string): Record<string, unknown> {
  const effect = (action: string): "ask" | "allow" | "deny" => {
    let eff: "ask" | "allow" | "deny" = "allow";
    for (const r of a.permissionRules ?? []) if (r.action === action) eff = r.effect as typeof eff;
    return eff;
  };
  const names = a.toolAllow ?? ALL_TOOLS.map((t) => t.name);
  const tools: Record<string, boolean> = {};
  for (const n of names) tools[n] = true;
  const permission: Record<string, unknown> = { edit: effect("edit"), bash: { "*": effect("bash") }, webfetch: effect("webfetch") };
  const ext = (a.permissionRules ?? []).find((r) => r.action === "external_directory");
  if (ext) permission["external_directory"] = ext.effect;
  const out: Record<string, unknown> = {
    name: a.id, description: a.description, mode: a.mode ?? "primary",
    builtIn: BUILTIN_AGENTS.some((b) => b.id === a.id),
    permission, tools, options: {},
  };
  if (a.model) out["model"] = { providerID, modelID: stripModel(a.model) };
  return out;
}

/** Comandos custom (config + plugins) → Command clásico. */
export function mapCommandToOc(c: { name: string; description?: string; hint?: string; agent?: string; model?: string; body: string }): Record<string, unknown> {
  return { name: c.name, description: (c.description ?? c.hint ?? "").slice(0, 512) || undefined, agent: c.agent, model: c.model, template: c.body };
}

/** Estado MCP vireo → McpStatus clásico. «untrusted» se mapea a failed con motivo (no hay equivalente). */
export function mapMcpStatusToOc(st: { state: string; error?: string }): Record<string, unknown> {
  switch (st.state) {
    case "connected": return { status: "connected" };
    case "disabled": return { status: "disabled" };
    case "untrusted": return { status: "failed", error: "omitido: servidor no confiable (sin aprobar por el usuario)" };
    default: {
      const error = st.error ?? "desconocido";
      if (/oauth|401|authori[sz]/i.test(error)) return { status: "needs_auth" };
      return { status: "failed", error };
    }
  }
}

// ─────────────────────────── /doc (OpenAPI 3.1 del subconjunto) ───────────────────────────

/**
 * Describe EXACTAMENTE las rutas que serve implementa (ni una más).
 * No es paridad con opencode; ver docs/parity.md. Respuestas tipadas como "any"
 * salvo /global/health y /find (formas documentadas).
 */
export function buildOpenApiDoc(version: string): Record<string, unknown> {
  const ok = (description: string) => ({ description, content: { "application/json": { schema: { type: "object" } } } });
  const okArr = (description: string) => ({ description, content: { "application/json": { schema: { type: "array" } } } });
  const sse = (description: string) => ({ description: `${description} (text/event-stream)` });
  const notImpl = { description: "No implementado en el subconjunto vireo (body { error })" };
  const paths: Record<string, Record<string, unknown>> = {
    "/global/health": { get: { summary: "Salud del servidor", responses: { "200": ok("{ healthy: true, version }") } } },
    "/global/event": { get: { summary: "SSE de eventos globales (GlobalEvent { directory, payload }); primer evento: server.connected", responses: { "200": sse("stream SSE") } } },
    "/doc": { get: { summary: "Este documento OpenAPI 3.1", responses: { "200": ok("OpenAPI 3.1") } } },
    "/path": { get: { summary: "{ state, config, worktree, directory }", responses: { "200": ok("Path") } } },
    "/vcs": { get: { summary: "{ branch } (git rev-parse --abbrev-ref HEAD); 404 si no es repo", responses: { "200": ok("VcsInfo"), "404": { description: "no es un repo git (body { error })" } } } },
    "/project": { get: { summary: "Array con el proyecto ÚNICO actual (vireo: una raíz por proceso)", responses: { "200": okArr("Array<Project>") } } },
    "/project/current": { get: { summary: "Proyecto único actual", responses: { "200": ok("Project") } } },
    "/config": { get: { summary: "Config fusionada SANITIZADA (claves sensibles → ***)", responses: { "200": ok("objeto config") } }, patch: { summary: "NO implementado", responses: { "404": notImpl } } },
    "/config/providers": { get: { summary: "{ providers: [provider sintético sin claves], default: { id: model } }", responses: { "200": ok("ConfigProviders") } } },
    "/provider": { get: { summary: "{ all: [catálogo sin claves], default, connected }", responses: { "200": ok("ProviderList") } } },
    "/provider/auth": { get: { summary: "{ [providerId]: [{ type: 'api', label: 'API key' }] }", responses: { "200": ok("ProviderAuth") } } },
    "/command": { get: { summary: "Comandos custom (config + plugins) como Command clásico; template = cuerpo crudo", responses: { "200": okArr("Array<Command>") } } },
    "/agent": { get: { summary: "Agentes (builtins + archivo + config) como Agent clásico; permission APROXIMADO (documentado)", responses: { "200": okArr("Array<Agent>") } } },
    "/mcp": { get: { summary: "{ [name]: McpStatus } (connected|disabled|failed|needs_auth); «untrusted»→failed documentado", responses: { "200": ok("McpStatus map") } } },
    "/lsp": { get: { summary: "Array LSP clásico — SIEMPRE [] (vireo no mantiene servidores LSP persistentes)", responses: { "200": okArr("Array<LspStatus>") } } },
    "/formatter": { get: { summary: "Array formatter clásico — SIEMPRE [] (vireo no gestiona formatters)", responses: { "200": okArr("Array<FormatterStatus>") } } },
    "/log": { post: { summary: "Escribe una línea de log del cliente a stderr; devuelve true", responses: { "200": ok("boolean"), "400": { description: "body inválido" } } } },
    "/event": { get: { summary: "SSE de eventos del proyecto; primer evento: server.connected", responses: { "200": sse("stream SSE") } } },
    "/find": { get: { summary: "?pattern=regex — coincidencias en bytes (rg --json o buscador propio)", responses: { "200": okArr("Array<FindMatch>"), "400": { description: "pattern inválido" } } } },
    "/find/file": { get: { summary: "?query=fuzzy — rutas relativas (dirs=true incluye directorios)", responses: { "200": okArr("Array<string>"), "400": { description: "falta query" } } } },
    "/find/symbol": { get: { summary: "NO implementado (sin endpoint de símbolos LSP en vireo)", responses: { "404": notImpl } } },
    "/file": { get: { summary: "?path= — contenido de DIRECTORIO como FileNode[]", responses: { "200": okArr("Array<FileNode>"), "400": { description: "path no es directorio legible" } } } },
    "/file/content": { get: { summary: "?path= — texto utf8 o base64 (binario, tope 2 MiB)", responses: { "200": ok("FileContent"), "400": { description: "no legible" }, "413": { description: "demasiado grande" } } } },
    "/file/status": { get: { summary: "Array<File> desde git status --porcelain + numstat; [] fuera de repo git", responses: { "200": okArr("Array<File>") } } },
    "/session": { get: { summary: "Array con TODAS las sesiones JSONL (forma opencode)", responses: { "200": okArr("Array<Session>") } }, post: { summary: "Crea sesión (body { parentID?, title? }); devuelve Session", responses: { "200": ok("Session") } } },
    "/session/status": { get: { summary: "{ [sessionID]: { type: 'idle'|'busy' } } (busy solo en este proceso)", responses: { "200": ok("SessionStatus map") } } },
    "/session/current": { get: { summary: "EXTENSIÓN vireo: { id, title } de la sesión activa del proceso (no es ruta opencode)", responses: { "200": ok("{ id, title }") } } },
    "/session/{id}": { get: { summary: "Session (404 si no existe)", responses: { "200": ok("Session"), "404": { description: "no encontrada" } } }, patch: { summary: "Renombra (body { title? })", responses: { "200": ok("Session"), "404": { description: "no encontrada" } } }, delete: { summary: "Borra JSONL (false si no existe); 409 para la sesión activa", responses: { "200": ok("boolean"), "409": { description: "sesión activa del proceso" } } } },
    "/session/{id}/message": { get: { summary: "Array<{ info, parts }> (mensajes NO-system persistidos)", responses: { "200": okArr("Array<{info, parts}>"), "404": { description: "no encontrada" } } }, post: { summary: "Ejecuta un turno (body clásico SessionPrompt: parts[] de texto; FilePart con url file:// soportado; noReply/agent/system/model/tools honrados con límites documentados en /doc y parity.md)", responses: { "200": ok("AssistantMessage pair"), "400": { description: "body inválido/no soportado" }, "404": { description: "sesión no activa en este proceso" }, "409": { description: "turno en curso" } } } },
    "/session/{id}/message/{messageID}": { get: { summary: "{ info, parts } por id", responses: { "200": ok("{info, parts}"), "404": { description: "mensaje no encontrado" } } } },
    "/session/{id}/prompt_async": { get: { summary: "NO (POST)", responses: { "404": notImpl } }, post: { summary: "204 inmediato; el turno corre en segundo plano (mismo body que …/message)", responses: { "204": { description: "aceptado" }, "400": { description: "body inválido" }, "404": { description: "sesión no activa" }, "409": { description: "turno en curso" } } } },
    "/session/{id}/command": { post: { summary: "Ejecuta un comando custom (body { command, arguments }) — devuelve AssistantMessage pair", responses: { "200": ok("AssistantMessage pair"), "400": { description: "comando desconocido o builtin no ejecutable vía REST" }, "404": { description: "sesión no activa" }, "409": { description: "turno en curso" } } } },
    "/session/{id}/abort": { post: { summary: "Aborta el turno en curso del proceso; devuelve true", responses: { "200": ok("boolean"), "404": { description: "sesión no activa" } } } },
    "/session/{id}/todo": { get: { summary: "Últimos todos vistos por este proceso (todowrite); [] si ninguno — priority/id sintéticos", responses: { "200": okArr("Array<Todo>"), "404": { description: "no encontrada" } } } },
    "/session/{id}/summarize": { post: { summary: "Compacta con el modelo CONFIGURADO (providerID/modelID del body se aceptan pero NO se honran); devuelve boolean compacted", responses: { "200": ok("boolean"), "400": { description: "body inválido" }, "404": { description: "sesión no activa" } } } },
    "/experimental/tool/ids": { get: { summary: "Array<string> de nombres de tool (ALL_TOOLS del proceso)", responses: { "200": okArr("ToolIds") } } },
    "/experimental/tool": { get: { summary: "Array<{ id, description, parameters }> (parameters = JSON Schema propio de vireo)", responses: { "200": okArr("ToolList") } } },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "vireo serve — subconjunto compatible con la API REST clásica de opencode",
      version,
      description: "Subconjunto HONESTO: solo las rutas de este documento existen; el resto responde 404 con { error }. " +
        "Las formas siguen el SDK clásico de opencode v1.18.0; campos sin equivalente en vireo (p. ej. cost/tokens por mensaje, error de tool, needs_auth real para OAuth MCP) se emiten con valores neutros y están documentados en docs/parity.md. " +
        "Auth: HTTP Basic (cualquier usuario; VIREO_SERVER_PASSWORD u OPENCODE_SERVER_PASSWORD). " +
        "query ?directory= se ACEPTA pero se ignora (vireo sirve una raíz por proceso). no es paridad.",
    },
    servers: [{ url: "/" }],
    paths,
  };
}
