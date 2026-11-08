// Tipos normalizados para MCP. Los loaders de config (OpenCode hoy; fase 7:
// claude/codex/gemini/pi) producen estas defs; el gestor (manager.ts) las ejecuta.

export type McpProtocol = "legacy" | "auto" | "2026-07-28";
export type McpLayerKind = "system" | "global" | "project" | "custom";

export type McpTransport =
  | { kind: "stdio"; command: string[]; env: Record<string, string>; cwd?: string }
  | { kind: "http"; url: string; headers: Record<string, string> };

export interface McpServerDef {
  name: string;
  /** Capa de config que lo introdujo (para la compuerta de confianza). */
  origin: McpLayerKind;
  transport: McpTransport;
  /** Protocolo solicitado; ver client.ts. Por defecto: stdio→legacy, http→auto. */
  protocol: McpProtocol;
  startupTimeoutMs: number;
  catalogTimeoutMs: number;
  executionTimeoutMs: number;
  enabled: boolean;
}

export type McpServerState = "connected" | "failed" | "disabled" | "untrusted";

export interface McpServerStatus {
  name: string;
  origin: McpLayerKind;
  state: McpServerState;
  /** Protocolo realmente usado tras el probe/fallback. */
  protocol?: "legacy" | "2026-07-28";
  toolCount: number;
  error?: string;
}
