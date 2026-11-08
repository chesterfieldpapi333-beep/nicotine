// skill: carga el cuerpo de una SKILL.md por id (el system prompt solo lleva
// nombre+descripción). Sigue el estándar agentskills.io / Claude Code skills.

import type { AgentTool } from "../core/types.js";
import { skillBodyForModel } from "../compat/skills.js";

export const skillTool: AgentTool = {
  name: "skill",
  description:
    "Carga el contenido completo de una skill listada en «Skills disponibles». " +
    "Úsala ANTES de trabajar en la tarea para la que existe la skill; sigue sus instrucciones al pie de la letra.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "id de la skill (el nombre del directorio, tal como aparece en el listado)" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  permission: { action: "skill", resource: (a) => String(a.id ?? "*") },
  async run(args, ctx) {
    const index = ctx.skills;
    const id = String(args.id ?? "").trim();
    if (!index) return { output: "Error: las skills no están inicializadas en este runtime." };
    const ids = [...index.byId.keys()];
    if (!id) return { output: `Error: falta "id". Disponibles: ${ids.join(", ") || "(ninguna)"}` };
    const rec = index.byId.get(id);
    if (!rec) {
      return { output: `Error: skill desconocida «${id}». Disponibles: ${ids.join(", ") || "(ninguna)"}` };
    }
    return { output: skillBodyForModel(rec) };
  },
};
