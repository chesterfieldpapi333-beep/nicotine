// Registro de tools built-in. Una tool por archivo; aquí solo se cablea.

import type { AgentTool } from "../core/types.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { applyPatchTool } from "./apply_patch.js";
import { bashTool } from "./bash.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { listTool } from "./list.js";
import { webfetchTool } from "./webfetch.js";
import { websearchTool } from "./websearch.js";
import { todowriteTool } from "./todowrite.js";
import { questionTool } from "./question.js";
import { taskTool } from "./task.js";
import { planEnterTool, planExitTool } from "./plan.js";
import { skillTool } from "./skill.js";

export const ALL_TOOLS: AgentTool[] = [
  readTool, writeTool, editTool, applyPatchTool, bashTool,
  globTool, grepTool, listTool, webfetchTool, websearchTool,
  todowriteTool, questionTool,
  taskTool, planEnterTool, planExitTool, skillTool,
];

// Perfil «minimal» (--solo-bash): solo bash + solo-lectura. Deny-wins intacto:
// el usuario puede seguir denegando/forzando ask sobre bash; aquí solo se
// recorta la superficie, nunca se amplía.
export const SOLO_BASH_TOOL_NAMES: readonly string[] = [
  "bash", "read", "glob", "grep", "webfetch",
];

export function filterSoloBash(tools: AgentTool[]): AgentTool[] {
  return tools.filter((t) => SOLO_BASH_TOOL_NAMES.includes(t.name));
}
