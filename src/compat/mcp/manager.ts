// Gestor MCP: lee `mcp` de la config (v2 `mcp.servers` o clásico `mcp.<nombre>`),
// decide confianza por capa de origen, conecta los servidores en paralelo y
// expone sus tools como AgentTool (`<server>_<tool>`).
//
// Compuerta de confianza (parity: la confianza NO se honra en silencio):
//   - system/global/custom (en tu propia máquina, tu flag) → se lanzan.
//   - proyecto (raíz→cwd, .opencode/) → se PIDE una vez por servidor
//     (ctx.ui.confirm, action "mcp"; --auto aprueba y avisa; sin TTY rechaza).
//     El resumen muestra comando/URL y NOMBRES de env vars, nunca sus valores.
// Nunca se conectan durante `doctor` (doctor solo lista).
//
// Los subagentes (task) NO reciben tools MCP en fase 5.
// Prompts MCP → comandos dinámicos `<server>:<prompt>`: fase 6 (necesita TUI dinámica).

import type { AgentTool, ToolContext, UiHooks } from "../../core/types.js";
import type { McpLayerKind, McpServerDef, McpServerStatus, McpProtocol } from "./types.js";
import { McpClient, type McpPromptInfo } from "./client.js";

export interface McpRuntime {
  servers: McpServerStatus[];
  tools: AgentTool[];
  /** Prompts anunciados por servidores conectados (para comandos <server>:<prompt>). */
  prompts: { server: string; prompt: McpPromptInfo }[];
  /** Cliente vivo por nombre (para close() al salir). */
  clients: Map<string, McpClient>;
}

const CLIENT_KILL = { registered: false };

export interface ConnectMcpOptions {
  config: Record<string, unknown>;
  mcpOrigins: Record<string, McpLayerKind>;
  ui: UiHooks;
  /** cwd para logs/mensajes. */
  cwd: string;
  /** "mcp:<nombre>" ya aprobados en esta sesión (para no repetir la pregunta). */
  approved?: Set<string>;
  /** Servidores leídos de otras CLIs (.mcp.json, gemini/codex, extensiones gemini). */
  extraDefs?: { name: string; raw: Record<string, unknown>; origin: McpLayerKind; excludeTools?: string[]; source: string }[];
}

/** Extrae TODAS las definiciones mcp de la config (ambas formas, merged). */
export function mcpServersFromConfig(config: Record<string, unknown>): { name: string; raw: Record<string, unknown> }[] {
  const mcp = config["mcp"];
  if (!mcp || typeof mcp !== "object") return [];
  const obj = mcp as Record<string, unknown>;
  const out = new Map<string, Record<string, unknown>>();
  // forma clásica: claves directas (excepto "servers")
  for (const [k, v] of Object.entries(obj)) {
    if (k === "servers") continue;
    if (v && typeof v === "object") out.set(k, v as Record<string, unknown>);
  }
  // forma v2: mcp.servers.<nombre> pisa a la clásica
  const servers = obj["servers"];
  if (servers && typeof servers === "object") {
    for (const [k, v] of Object.entries(servers as Record<string, unknown>)) {
      if (v && typeof v === "object") out.set(k, v as Record<string, unknown>);
    }
  }
  return [...out.entries()].map(([name, raw]) => ({ name, raw }));
}

/** Nombres de servidores mcp declarados en UNA capa (para detectar orígenes). */
export function mcpServerNamesInLayer(data: Record<string, unknown>): string[] {
  return mcpServersFromConfig(data).map((s) => s.name);
}

function num(v: unknown, dflt: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function strMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = String(val);
  return out;
}

function asDef(name: string, raw: Record<string, unknown>, origins: Record<string, McpLayerKind>, cwd: string): McpServerDef {
  const origin: McpLayerKind = origins[name] ?? "project"; // sin capa conocida → tratar como no confiado
  const timeouts = (raw["timeouts"] ?? {}) as Record<string, unknown>;
  const protocolRaw = String(raw["protocol"] ?? "").toLowerCase();
  const commandRaw = raw["command"];
  const argsRaw = raw["args"];
  const envRaw = raw["env"] ?? raw["environment"]; // v1 usaba `environment`
  const url = typeof raw["url"] === "string" ? raw["url"] : raw["httpUrl"] as string | undefined;
  const isRemote = !!url && !commandRaw;
  const resolvedCommand: string[] | null = (() => {
    if (Array.isArray(commandRaw)) return commandRaw.map(String);
    if (typeof commandRaw === "string" && commandRaw.trim()) {
      const args = Array.isArray(argsRaw) ? argsRaw.map(String) : [];
      return [commandRaw, ...args];
    }
    return null;
  })();

  const defaultProtocol: McpProtocol = isRemote ? "auto" : "legacy";
  const protocol: McpProtocol = protocolRaw === "legacy" || protocolRaw === "auto" || protocolRaw === "2026-07-28" ? protocolRaw : defaultProtocol;

  return {
    name,
    origin,
    transport: isRemote
      ? { kind: "http", url: String(url), headers: strMap(raw["headers"]) }
      : { kind: "stdio", command: resolvedCommand ?? ["false"], env: strMap(envRaw), cwd: typeof raw["cwd"] === "string" ? raw["cwd"] : undefined },
    protocol,
    enabled: raw["enabled"] !== false,
    startupTimeoutMs: num(timeouts["startup"] ?? raw["startup_timeout_ms"], 5000),
    catalogTimeoutMs: num(timeouts["catalog"] ?? raw["catalog_timeout_ms"], 10000),
    executionTimeoutMs: num(timeouts["execution"] ?? raw["tool_timeout_ms"] ?? raw["timeout"], 60000),
  };
}

function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_") || "x";
}

function describeDef(def: McpServerDef): string {
  const lines = [`servidor MCP «${def.name}» (${def.origin === "project" ? "de ESTE proyecto — no confiado por defecto" : "de tu config " + def.origin})`];
  if (def.transport.kind === "stdio") {
    lines.push(`lanzará: ${def.transport.command.join(" ")}`);
    const keys = Object.keys(def.transport.env);
    if (keys.length) lines.push(`env: ${keys.join(", ")} (valores no mostrados)`);
    if (def.transport.cwd) lines.push(`cwd: ${def.transport.cwd}`);
  } else {
    lines.push(`url: ${def.transport.url}`);
    const keys = Object.keys(def.transport.headers);
    if (keys.length) lines.push(`headers: ${keys.join(", ")} (valores no mostrados)`);
  }
  lines.push("¿Lanzarlo?");
  return lines.join("\n");
}

export async function connectMcpServers(opts: ConnectMcpOptions): Promise<McpRuntime> {
  const nativeDefs = mcpServersFromConfig(opts.config).map(({ name, raw }) => ({ name, raw, source: "opencode.json" as string }));
  const extraDefs = opts.extraDefs ?? [];
  const mergedRaw: { name: string; raw: Record<string, unknown>; origin: McpLayerKind; excludeTools?: string[] }[] = [];
  const seenNames = new Set<string>();
  for (const d of nativeDefs) { seenNames.add(d.name); mergedRaw.push({ name: d.name, raw: d.raw, origin: opts.mcpOrigins[d.name] ?? "project" }); }
  for (const d of extraDefs) {
    if (seenNames.has(d.name)) { opts.ui.info(`mcp «${d.name}»: ${d.source} ignorado (ya definido en la config nativa o antes)`); continue; }
    seenNames.add(d.name);
    mergedRaw.push({ name: d.name, raw: d.raw, origin: d.origin, excludeTools: d.excludeTools });
  }
  const excludesByServer = new Map<string, Set<string>>();
  for (const d of mergedRaw) if (d.excludeTools?.length) excludesByServer.set(d.name, new Set(d.excludeTools.map((t) => t.toLowerCase())));
  const originsForAsDef = Object.fromEntries(mergedRaw.map((d) => [d.name, d.origin]));
  const defs = mergedRaw.map(({ name, raw }) => asDef(name, raw, originsForAsDef, opts.cwd));
  const approved = opts.approved ?? new Set<string>();
  const statuses = new Map<string, McpServerStatus>();
  const clients = new Map<string, McpClient>();
  const tools: AgentTool[] = [];
  const resourceCapable: string[] = [];
  const promptEntries: { server: string; prompt: McpPromptInfo }[] = [];

  const results = await Promise.allSettled(defs.map(async (def) => {
    if (!def.enabled) { statuses.set(def.name, { name: def.name, origin: def.origin, state: "disabled", toolCount: 0 }); return; }
    // compuerta de confianza: solo el proyecto necesita permiso
    if (def.origin === "project" && !approved.has(def.name)) {
      const decision = await opts.ui.confirm({ action: "mcp", resource: def.name, diff: describeDef(def) });
      if (decision === "reject") {
        statuses.set(def.name, { name: def.name, origin: def.origin, state: "untrusted", toolCount: 0, error: "rechazado por el usuario" });
        opts.ui.info(`mcp «${def.name}»: omitido (no confiado)`);
        return;
      }
      approved.add(def.name);
    }
    const client = new McpClient(def);
    try {
      const negotiated = await client.connect();
      const toolInfos = await client.listTools();
      const resources = await client.listResources().then((r) => r, () => null); // null = sin capability
      const prompts = await client.listPrompts();
      if (prompts?.length) promptEntries.push(...prompts.map((prompt) => ({ server: def.name, prompt })));
      clients.set(def.name, client);
      resourceCapable.push(...(resources !== null ? [def.name] : []));
      let excluded = 0;
      for (const info of toolInfos) {
        const ex = excludesByServer.get(def.name);
        if (ex?.has(info.name.toLowerCase())) { excluded++; continue; }
        tools.push(makeMcpTool(def.name, info.name, info, client));
      }
      if (excluded) opts.ui.info(`mcp «${def.name}»: ${excluded} tool(s) ocultas por excludeTools`);
      statuses.set(def.name, { name: def.name, origin: def.origin, state: "connected", protocol: negotiated, toolCount: toolInfos.length });
    } catch (err) {
      await client.close().catch(() => {});
      statuses.set(def.name, { name: def.name, origin: def.origin, state: "failed", toolCount: 0, error: (err as Error).message });
      opts.ui.info(`mcp «${def.name}»: ${(err as Error).message}`);
    }
  }));
  for (const r of results) if (r.status === "rejected") opts.ui.info(`mcp: error inesperado: ${r.reason}`);

  // tools compartidas de resources (nombre fijo, `server` como enum)
  if (resourceCapable.length) {
    tools.push(makeListResourcesTool(resourceCapable, clients));
    tools.push(makeReadResourceTool(resourceCapable, clients));
  }

  // matar hijos al salir del proceso
  if (!CLIENT_KILL.registered) {
    process.on("exit", () => { for (const c of clients.values()) void c.close(); });
    CLIENT_KILL.registered = true;
  }

  return { servers: defs.map((d) => statuses.get(d.name)!).filter(Boolean), tools: dedupeTools(tools, opts.ui), prompts: promptEntries, clients };
}

function makeMcpTool(server: string, toolName: string, info: { name: string; description: string; inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean } }, client: McpClient): AgentTool {
  const full = `${sanitizeName(server)}_${sanitizeName(toolName)}`;
  return {
    name: full,
    description: `[MCP ${server}] ${info.description || toolName}`.slice(0, 1024),
    parameters: info.inputSchema,
    permission: { action: "mcp", resource: () => `${server}:${toolName}` },
    async run(args: Record<string, unknown>, _ctx: ToolContext) {
      const { text, isError } = await client.callTool(toolName, args);
      return { output: isError ? `Error MCP (${server}): ${text}` : text, metadata: { server, tool: toolName, isError } };
    },
  };
}

function makeListResourcesTool(servers: string[], clients: Map<string, McpClient>): AgentTool {
  return {
    name: "opencode_list_mcp_resources",
    description: "Lista los resources que expone un servidor MCP (uri, nombre). Descubrimiento; lee con opencode_read_mcp_resource.",
    parameters: { type: "object", properties: { server: { type: "string", enum: servers } }, required: ["server"], additionalProperties: false },
    permission: { action: "mcp", resource: (a) => `${String(a.server ?? "?")}:resources/list` },
    async run(args: Record<string, unknown>) {
      const client = clients.get(String(args.server ?? ""));
      if (!client) return { output: `Error: servidor desconocido o no conectado: ${String(args.server)} (conectados: ${servers.join(", ")})` };
      const resources = await client.listResources();
      if (!resources.length) return { output: "(sin resources)" };
      return { output: resources.map((r) => `- ${r.uri}${r.name ? ` — ${r.name}` : ""}`).join("\n") };
    },
  };
}

function makeReadResourceTool(servers: string[], clients: Map<string, McpClient>): AgentTool {
  return {
    name: "opencode_read_mcp_resource",
    description: "Lee el contenido de un resource MCP por uri (primero descúbrelo con opencode_list_mcp_resources).",
    parameters: { type: "object", properties: { server: { type: "string", enum: servers }, uri: { type: "string", description: "uri del resource" } }, required: ["server", "uri"], additionalProperties: false },
    permission: { action: "mcp", resource: (a) => `${String(a.server ?? "?")}:resources/read ${String(a.uri ?? "?")}` },
    async run(args: Record<string, unknown>) {
      const client = clients.get(String(args.server ?? ""));
      const uri = String(args.uri ?? "");
      if (!client) return { output: `Error: servidor desconocido o no conectado: ${String(args.server)}` };
      if (!uri) return { output: "Error: falta `uri`" };
      return { output: await client.readResource(uri) };
    },
  };
}

function dedupeTools(tools: AgentTool[], ui: UiHooks): AgentTool[] {
  const seen = new Set<string>();
  const out: AgentTool[] = [];
  for (const t of tools) {
    if (seen.has(t.name)) { ui.info(`mcp: tool duplicada «${t.name}» — se conserva la primera`); continue; }
    seen.add(t.name);
    out.push(t);
  }
  return out;
}

/** Mata todos los clientes (tests / serve); en el proceso se usa el hook exit. */
export async function closeMcpClients(rt: McpRuntime | undefined): Promise<void> {
  if (!rt) return;
  await Promise.allSettled([...rt.clients.values()].map((c) => c.close()));
}
