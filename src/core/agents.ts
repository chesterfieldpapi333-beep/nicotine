// Agentes built-in, paridad OpenCode: build (primary) y plan (primary,
// deniega edit). Los agentes de archivo (.opencode/agents/*.md) llegan en la fase 1+;
// aquí solo lo mínimo para que `--agent plan` funcione ya.

import type { Rule } from "./permissions.js";

export interface AgentDef {
  id: string;
  mode: "primary" | "subagent" | "all";
  description: string;
  /** Se añade al system prompt base. */
  systemAppend?: string;
  /** Reglas EXTRA que se ANEXAN tras las globales (spec: rules append). */
  permissionRules: Rule[];
  /** Allowlist de tools (vireo) — agentes de archivo con `tools:` en frontmatter. Ausente = todas. */
  toolAllow?: string[];
}

export const BUILTIN_AGENTS: AgentDef[] = [
  {
    id: "build",
    mode: "primary",
    description: "Agente de código por defecto: lectura y edición con permisos.",
    permissionRules: [], // hereda defaults (allow; .env ask)
  },
  // Subagentes (los usan `task`; no aparecen en el ciclo de tab)
  {
    id: "general",
    mode: "subagent",
    description: "Subagente multi-paso de propósito general (todas las tools).",
    permissionRules: [],
  },
  {
    id: "explore",
    mode: "subagent",
    description: "Subagente de exploración rápida, de solo lectura.",
    permissionRules: [{ action: "edit", resource: "*", effect: "deny" }],
  },
  {
    id: "plan",
    mode: "primary",
    description: "Explora y planifica sin editar archivos del proyecto.",
    systemAppend:
      "Estás en modo PLAN. NO edites archivos del proyecto. Explora, responde preguntas y " +
      "produce un plan. Puedes proponer diffs en texto, pero no aplicarlos.",
    permissionRules: [{ action: "edit", resource: "*", effect: "deny" }],
  },
];

/** Agentes de archivo registrados en runtime (plugins/otros CLI). */
const EXTRA_AGENTS: AgentDef[] = [];

/** Registra agentes de archivo (idempotente por id). Lo llama el descubrimiento de plugins. */
export function registerExtraAgents(defs: AgentDef[]): void {
  for (const d of defs) if (!EXTRA_AGENTS.some((e) => e.id === d.id)) EXTRA_AGENTS.push(d);
}

/** Limpia los agentes extra (tests). */
export function clearExtraAgents(): void { EXTRA_AGENTS.length = 0; }

export function allAgents(): AgentDef[] { return [...BUILTIN_AGENTS, ...EXTRA_AGENTS]; }

export function findAgent(id: string | undefined): AgentDef {
  if (!id) return BUILTIN_AGENTS[0];
  const found = allAgents().find((a) => a.id === id);
  if (!found) throw new Error(`Agente desconocido: ${id}. Disponibles: ${allAgents().map((a) => a.id).join(", ")}`);
  return found;
}
