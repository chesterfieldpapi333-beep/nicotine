// task: delega un trabajo a un subagente y espera el resultado.
// El subagente corre en una sesión JSONL hija, con las MISMAS tools menos
// las de orquestación (task/plan-*) — profundidad máxima 1 (spec).

import type { AgentTool } from "../core/types.js";

const oneLine = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s).replace(/\s+/g, " ");

export const taskTool: AgentTool = {
  name: "task",
  description:
    "Delega una tarea autocontenida a un subagente y devuelve su respuesta final. " +
    "Úsala para investigaciones y subtareas multi-paso que no necesiten tu contexto completo. " +
    "Tipos: «general» (todas las tools) y «explore» (solo lectura). " +
    "El subagente no ve el historial previo salvo en el prompt: inclúyelo TODO.",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Instrucción completa y autocontenida para el subagente." },
      description: { type: "string", description: "Resumen corto (3-6 palabras) para el log/título." },
      subagent_type: { type: "string", description: "general | explore (default: general).", enum: ["general", "explore"] },
    },
    required: ["prompt"],
  },
  permission: { action: "task", resource: (a) => oneLine(String(a.description ?? a.prompt ?? "task"), 80) },
  async run(args, ctx) {
    if (ctx.isSubagent) return { output: "Error: los subagentes no pueden lanzar subagentes (profundidad máxima 1)." };
    if (!ctx.runSubagent) return { output: "task no soportada en este modo (usa la TUI o --print en un proyecto)." };
    const subagentType = String(args.subagent_type ?? "general");
    const description = String(args.description ?? "");
    return { output: await ctx.runSubagent({ agentId: subagentType, prompt: String(args.prompt ?? ""), description }) };
  },
};
