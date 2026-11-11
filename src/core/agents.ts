// Agentes built-in, paridad OpenCode: build (primary), plan (primary, deniega
// edit), architect (primary, deniega edit, sesgo a diseño) y editor (primary,
// aplica cambios mínimos y verificados). Los agentes de archivo llegan en la
// fase 1+; aquí solo lo mínimo para que `--agent plan|architect|editor` funcione.
//
// Tres capas, aplicadas EN ORDEN en allAgents():
//   1. BUILTIN_AGENTS — pueden marcarse `hidden`/`disabled` desde la config
//      (escalares reemplazan, permissions se añaden, /no del campo = conservar).
//   2. EXTRA_AGENTS — archivos (.opencode/agents, plugins…): añaden IDs
//      NUEVOS; NUNCA pisan un built-in (el built-in gana).
//   3. CONFIG_AGENTS — `agents: {}` en opencode.json(c): pisan cualquier mismo
//      ID según las reglas de merge (scalars sustituyen; permissions de reglas
//      se ANEXAN; description/mode/hidden/model/toolAllow/systemAppend toman el
//      del portable si está; `disabled: true` elimina el agente; `hidden: true`
//      lo oculta del listado y del catálogo de subagentes, sin afectar a
//      --agent explícito).

import type { Rule } from "./permissions.js";

export interface AgentDef {
  id: string;
  mode?: "primary" | "subagent" | "all";
  description: string;
  /** Se añade al system prompt base. */
  systemAppend?: string;
  /** Reemplaza el system prompt base (config `agents.<id>.system`, spec). */
  systemPrompt?: string;
  /** Reglas EXTRA que se ANEXAN tras las globales (spec: rules append). */
  permissionRules: Rule[];
  /** Allowlist de tools (nicotine) — agentes de archivo con `tools:` en frontmatter. Ausente = todas. */
  toolAllow?: string[];
  /** Modelo propio (subagentes lo usan; la sesión de un primario NO cambia al seleccionarlo). */
  model?: string;
  /** Oculto del listado y del catálogo de subagentes. --agent explícito sigue resolviendo. */
  hidden?: boolean;
  /** Config `agents.x.disabled: true` — el agente desaparece del registro. */
  disabled?: boolean;
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

/** Agentes definidos en `agents: {}` de la config (spec JSONC). Se RE-SETEA en cada carga. */
let CONFIG_AGENTS: AgentDef[] = [];

/** Registra agentes de archivo (idempotente por id). Lo llama el descubrimiento de plugins. */
export function registerExtraAgents(defs: AgentDef[]): void {
  for (const d of defs) if (!EXTRA_AGENTS.some((e) => e.id === d.id)) EXTRA_AGENTS.push(d);
}

/** Sustituye los agentes de la config (parseo ya mergeado entre capas). */
export function registerConfigAgents(defs: AgentDef[]): void {
  CONFIG_AGENTS = [...defs];
}

/** Limpia los agentes extra y de config (tests). */
export function clearExtraAgents(): void {
  EXTRA_AGENTS.length = 0;
  CONFIG_AGENTS = [];
}

/** Merge canónico de agentes según la spec (ver agents#merging): escalares reemplazan;
 *  reglas de permisos se ANEXAN; los campos ausentes conservan el valor previo. */
function mergeAgent(base: AgentDef, over: AgentDef): AgentDef {
  return {
    ...base, ...over,
    mode: over.mode ?? base.mode,
    description: over.description ? over.description : base.description,
    systemAppend: over.systemAppend ?? base.systemAppend,
    systemPrompt: over.systemPrompt ?? base.systemPrompt,
    permissionRules: [...base.permissionRules, ...over.permissionRules],
    toolAllow: over.toolAllow ?? base.toolAllow,
    model: over.model ?? base.model,
    hidden: over.hidden ?? base.hidden,
    disabled: over.disabled,
  };
}

export function allAgents(): AgentDef[] {
  const byId = new Map<string, AgentDef>();
  for (const a of BUILTIN_AGENTS) byId.set(a.id, a);
  // archivos: añaden ids nuevos; nunca pisan un built-in
  for (const a of EXTRA_AGENTS) if (!byId.has(a.id)) byId.set(a.id, a);
  // config: pisa cualquier mismo id con las reglas de merge
  for (const a of CONFIG_AGENTS) {
    if (a.disabled) { byId.delete(a.id); continue; }
    const prev = byId.get(a.id);
    const def: AgentDef = { ...a, mode: a.mode ?? prev?.mode ?? "primary" };
    byId.set(a.id, prev ? mergeAgent(prev, def) : def);
  }
  // post-condición de tipo: todo agente registrado tiene modo resuelto
  return [...byId.values()].map((a) => ({ ...a, mode: a.mode ?? "primary" }));
}

export function findAgent(id: string | undefined): AgentDef {
  if (!id) return allAgents().find((a) => a.id === "build") ?? { ...BUILTIN_AGENTS[0], mode: "primary" };
  const found = allAgents().find((a) => a.id === id);
  if (!found) throw new Error(`Agente desconocido: ${id}. Disponibles: ${allAgents().map((a) => a.id).join(", ")}`);
  return found;
}
