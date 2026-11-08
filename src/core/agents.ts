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
}

export const BUILTIN_AGENTS: AgentDef[] = [
  {
    id: "build",
    mode: "primary",
    description: "Agente de código por defecto: lectura y edición con permisos.",
    permissionRules: [], // hereda defaults (allow; .env ask)
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

export function findAgent(id: string | undefined): AgentDef {
  if (!id) return BUILTIN_AGENTS[0];
  const found = BUILTIN_AGENTS.find((a) => a.id === id);
  if (!found) throw new Error(`Agente desconocido: ${id}. Disponibles: ${BUILTIN_AGENTS.map((a) => a.id).join(", ")}`);
  return found;
}
