// write: crea o REEMPLAZA un archivo completo. Crea directorios padres.
// Para cambios parciales usa `edit` (menos tokens y diffs revisables).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentTool } from "../core/types.js";
import { resolvePath, unifiedDiff } from "./fs-util.js";

export const writeTool: AgentTool = {
  name: "write",
  description:
    "Crea un archivo nuevo o reemplaza COMPLETO su contenido (crea directorios padre). " +
    "Para modificar parte de un archivo existente, usa edit en su lugar.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Ruta del archivo." },
      content: { type: "string", description: "Contenido completo del archivo." },
    },
    required: ["path", "content"],
  },
  permission: { action: "edit", resource: (a) => String(a.path) },
  async preview(args, ctx) {
    const path = resolvePath(ctx.cwd, String(args.path));
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    return { diff: unifiedDiff(String(args.path), before, String(args.content ?? "")) };
  },
  async run(args, ctx) {
    const path = resolvePath(ctx.cwd, String(args.path));
    const content = String(args.content ?? "");
    const before = existsSync(path) ? readFileSync(path, "utf8") : null;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    ctx.readFiles.add(path);
    const verb = before === null ? "Creado" : "Reescrito";
    return { output: `${verb} ${path} (${content.length} bytes, ${content.split("\n").length} líneas)` };
  },
};
