// Agentes built-in, paridad OpenCode: build (primary), plan (primary, deniega
// edit), architect (primary, deniega edit, sesgo a diseño) y editor (primary,
// aplica cambios mínimos y verificados). Los agentes de archivo llegan en la
// fase 1+; aquí solo lo mínimo para que `--agent plan|architect|editor` funcione.

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
  {
    id: "architect",
    mode: "primary",
    description: "Arquitecto: explora y diseña — alternativas, tradeoffs, riesgos. No edita.",
    systemAppend:
      "Estás en modo ARCHITECT. NO edites archivos. Analiza el diseño: requisitos, restricciones, " +
      "alternativas y tradeoffs explícitos. Propón UN diseño concreto con riesgos conocidos y un plan " +
      "de aplicación por pasos; señala qué decisión tomaría un senior y por qué. " +
      "Cuando el diseño esté acordado, indica que puede aplicarse con el agente «editor».",
    permissionRules: [{ action: "edit", resource: "*", effect: "deny" }],
  },
  {
    id: "editor",
    mode: "primary",
    description: "Editor: aplica cambios mínimos y verificados sobre un plan o instrucción concreta.",
    systemAppend:
      "Eres el EDITOR. Aplica cambios mínimos y dirigidos: lee antes de editar, toca lo justo para " +
      "cumplir la instrucción, y verifica (tests/lints si existen) antes de terminar. " +
      "Si la instrucción es ambigua, pregunta antes de adivinar — no expandas el alcance.",
    permissionRules: [], // hereda defaults (allow; .env ask)
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
