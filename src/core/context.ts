// Construye el system prompt. Hoy: identidad + entorno + agente.
// Fase 4 añadirá AGENTS.md/CLAUDE.md/GEMINI.md y la lista de skills
// (solo nombre+descripción; el body se carga bajo demanda con la tool `skill`).

import { platform, release } from "node:os";
import type { AgentDef } from "./agents.js";

export function buildSystemPrompt(opts: { cwd: string; agent: AgentDef }): string {
  const lines = [
    "Eres Vireo, un agente de ingeniería de software que trabaja en la terminal del usuario.",
    "Respondes en el idioma del usuario. Eres conciso: nada de preámbulos ni resúmenes innecesarios.",
    "",
    "Entorno:",
    `- directorio de trabajo: ${opts.cwd}`,
    `- fecha: ${new Date().toISOString().slice(0, 10)}`,
    `- sistema: ${platform()} ${release()}`,
    "",
    "Forma de trabajo:",
    "- Usa las tools en vez de adivinar: lee antes de editar, busca antes de asumir.",
    "- Prefiere `edit` para cambios puntuales y `write` solo para archivos nuevos o reescrituras completas.",
    "- Ante ambigüedad real (no estilística), pregunta con la tool `question` antes de actuar.",
    "- Las salidas grandes se truncan; pide offset/limit si necesitas más.",
  ];
  if (opts.agent.systemAppend) lines.push("", opts.agent.systemAppend);
  return lines.join("\n");
}
