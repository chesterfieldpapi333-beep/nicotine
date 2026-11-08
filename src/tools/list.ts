// list: lista NO recursiva de un directorio (name/ para carpetas).
// read ya lista directorios; `list` existe por paridad con CLIs que la separan.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "../core/types.js";
import { resolvePath } from "./fs-util.js";

export const listTool: AgentTool = {
  name: "list",
  description: "Lista el contenido directo de un directorio (no recursivo). Entradas de carpeta terminan en /.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directorio a listar. Por defecto el cwd." },
    },
  },
  permission: { action: "list", resource: (a) => String(a.path ?? ".") },
  async run(args, ctx) {
    const path = args.path ? resolvePath(ctx.cwd, String(args.path)) : ctx.cwd;
    if (!existsSync(path)) throw new Error(`no existe: ${path}`);
    const st = statSync(path);
    if (!st.isDirectory()) throw new Error(`no es un directorio: ${path}`);
    const entries = readdirSync(path, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
      .sort();
    const slice = entries.slice(0, 500);
    const more = entries.length > slice.length ? `\n… y ${entries.length - slice.length} más` : "";
    return { output: (slice.join("\n") || "(vacío)") + more };
  },
};
