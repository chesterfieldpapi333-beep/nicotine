// Construye el system prompt. Identidad + entorno + agente + (fase 4):
// archivos de contexto del proyecto (AGENTS.md/CLAUDE.md/GEMINI.md/instructions)
// y la lista de skills (solo nombre+descripción; el body se carga bajo demanda
// con la tool `skill`).

import { platform, release } from "node:os";
import type { AgentDef } from "./agents.js";

export function buildSystemPrompt(opts: { cwd: string; agent: AgentDef; contextBlock?: string; skillBlock?: string }): string {
  // Base sustituible por agents.<id>.system (spec: `system` reemplaza el system
  // prompt base); el entorno se conserva siempre, al igual que el contexto de
  // proyecto y las skills.
  const lines = [
    ...(opts.agent.systemPrompt
      ? [opts.agent.systemPrompt.trimEnd()]
      : [
          "Eres Nicotine, un agente de ingeniería de software que trabaja en la terminal del usuario.",
          "Respondes en el idioma del usuario. Eres conciso: nada de preámbulos ni resúmenes innecesarios.",
        ]),
    "",
    "Entorno:",
    `- directorio de trabajo: ${opts.cwd}`,
    `- fecha: ${new Date().toISOString().slice(0, 10)}`,
    `- sistema: ${platform()} ${release()}`,
    "",
    ...(opts.agent.systemPrompt
      ? []
      : [
          "Forma de trabajo:",
          "- Usa las tools en vez de adivinar: lee antes de editar, busca antes de asumir.",
          "- Prefiere `edit` para cambios puntuales y `write` solo para archivos nuevos o reescrituras completas.",
          "- Ante ambigüedad real (no estilística), pregunta con la tool `question` antes de actuar.",
          "- Las salidas grandes se truncan; pide offset/limit si necesitas más.",
        ]),
  ];
  if (opts.agent.systemAppend) lines.push("", opts.agent.systemAppend);
  if (opts.contextBlock) lines.push("", opts.contextBlock.trimEnd());
  if (opts.skillBlock) lines.push("", opts.skillBlock.trimEnd());
  return lines.join("\n");
}
