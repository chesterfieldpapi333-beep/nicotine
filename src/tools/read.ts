// read: lee un archivo (texto con líneas numeradas, páginas de offset/limit)
// o lista un directorio NO recursivo. Imágenes/PDF ≤ 20 MiB: aún no se envían
// como adjuntos (Fase 8); se informa al modelo.

import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import type { AgentTool } from "../core/types.js";
import { resolvePath, looksBinary } from "./fs-util.js";

const MAX_LINE = 2000;       // caracteres por línea antes de truncar
const MAX_BYTES = 50 * 1024; // 50 KiB por página (paridad OpenCode)
const MAX_LINES = 2000;

export const readTool: AgentTool = {
  name: "read",
  description:
    "Lee un archivo de texto (líneas numeradas) o lista un directorio de forma no recursiva. " +
    "Usa offset (1-based) y limit para paginar. Devuelve hasta 2000 líneas / 50 KiB por página.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Ruta del archivo o directorio (absoluta o relativa al cwd)." },
      offset: { type: "number", description: "Línea inicial (1-based). Por defecto 1." },
      limit: { type: "number", description: "Máximo de líneas. Por defecto 2000." },
    },
    required: ["path"],
  },
  permission: { action: "read", resource: (a) => String(a.path) },
  async run(args, ctx) {
    const path = resolvePath(ctx.cwd, String(args.path));
    if (!existsSync(path)) throw new Error(`no existe: ${path}`);
    const st = statSync(path);

    if (st.isDirectory()) {
      const entries = readdirSync(path, { withFileTypes: true })
        .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
        .sort();
      const slice = entries.slice(0, 500);
      const more = entries.length > slice.length ? `\n… y ${entries.length - slice.length} entradas más` : "";
      return { output: slice.join("\n") + more || "(directorio vacío)" };
    }

    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "webp", "pdf"].includes(ext)) {
      return { output: `[archivo ${ext.toUpperCase()} de ${st.size} bytes — los adjuntos multimedia aún no se envían al modelo (pendiente fase 8); usa tools de shell si necesitas procesarlo]` };
    }

    const buf = readFileSync(path);
    if (looksBinary(buf)) throw new Error(`archivo binario no soportado: ${path}`);
    ctx.readFiles.add(path); // la edición exige lectura previa: la registramos aquí

    const offset = Math.max(1, Number(args.offset ?? 1) || 1);
    const limit = Math.min(MAX_LINES, Math.max(1, Number(args.limit ?? MAX_LINES) || MAX_LINES));
    const lines = buf.toString("utf8").split("\n");
    const out: string[] = [];
    let bytes = 0;
    for (let i = offset - 1; i < lines.length && out.length < limit; i++) {
      let line = lines[i];
      if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE) + "…";
      const numbered = `${i + 1}: ${line}`;
      bytes += numbered.length + 1;
      if (bytes > MAX_BYTES) { out.push(`… (truncado en 50 KiB; usa offset=${i + 1} para continuar)`); break; }
      out.push(numbered);
    }
    if (!out.length) out.push(`(sin líneas desde ${offset}; el archivo tiene ${lines.length} líneas)`);
    else if (offset - 1 + out.length < lines.length) out.push(`… (${lines.length - (offset - 1 + out.length)} líneas más; usa offset=${offset + out.length})`);
    return { output: out.join("\n") };
  },
};
