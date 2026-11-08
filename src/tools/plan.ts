// plan-enter / plan-exit: el modelo PIDE cambiar entre agente plan (explora,
// sin edición) y build (edita). plan-exit pide confirmación explícita del
// usuario, porque habilitar escritura merece un consentimiento informado.
// Spec: paridad v1 ("plan_enter"/"plan_exit"); en v2 no son tools built-in,
// pero el spec lite del producto las mantiene (ver docs/parity.md).

import type { AgentTool } from "../core/types.js";

export const planEnterTool: AgentTool = {
  name: "plan-enter",
  description:
    "Cambia al agente plan: explora el código y produce un plan sin editar archivos. " +
    "Úsala cuando la tarea requiera análisis antes de tocar nada.",
  parameters: { type: "object", properties: {} },
  permission: { action: "plan", resource: () => "plan-enter" },
  async run(_args, ctx) {
    if (!ctx.switchAgent) return { output: "Cambio de agente no soportado en este modo (usa el atajo tab en la TUI)." };
    return { output: ctx.switchAgent("plan") ? "Agente: plan (solo exploración; sin edición de archivos)." : "No se pudo cambiar a plan." };
  },
};

export const planExitTool: AgentTool = {
  name: "plan-exit",
  description:
    "Pide confirmación para volver al agente build (habilita edición de archivos). " +
    "Úsala cuando el plan esté aprobado y toque implementar.",
  parameters: { type: "object", properties: {} },
  permission: { action: "plan", resource: () => "plan-exit" },
  async run(_args, ctx) {
    if (!ctx.switchAgent) return { output: "Cambio de agente no soportado en este modo (usa el atajo tab en la TUI)." };
    const verdict = await ctx.ui.confirm({ action: "plan_exit", resource: "volver a agente build (habilita edición de archivos)" });
    if (verdict === "reject") return { output: "El usuario prefirió seguir en modo plan. No edites archivos." };
    return { output: ctx.switchAgent("build") ? "Agente: build (edición habilitada)." : "No se pudo cambiar a build." };
  },
};
