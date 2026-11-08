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
