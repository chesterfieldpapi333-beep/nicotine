// Tool `lsp` (experimental, gated): diagnósticos de UN archivo vía el servidor
// LSP configurado por el usuario en `lsp:` (cero dependencias empaquetadas).
// Solo existe cuando la config declara al menos un servidor.

import { resolve } from "node:path";
import { statSync } from "node:fs";
import type { AgentTool } from "../core/types.js";
import { diagnosticsFor, type LspServerDef, lspSummary } from "../compat/lsp.js";

export function makeLspTool(defs: LspServerDef[]): AgentTool {
  return {
    name: "lsp",
    description:
      `Diagnósticos del servidor LSP para UN archivo (experimental). ` +
      `Servidores configurados: ${defs.map(lspSummary).join(" · ")}. ` +
      `action «diagnostics» devuelve errores/avisos con línea y columna.`,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["diagnostics"], description: "Acción a ejecutar (v1: solo diagnostics)" },
        path: { type: "string", description: "Ruta del archivo (relativa al cwd o absoluta)" },
        timeoutMs: { type: "number", description: "Máx. tiempo de espera de diagnósticos (defecto 10000)" },
      },
      required: ["action", "path"],
      additionalProperties: false,
    },
    permission: { action: "lsp", resource: (a) => String(a.path ?? "?") },
    async run(args, ctx) {
      const action = String(args.action ?? "");
      if (action !== "diagnostics") return { output: `Error: acción desconocida «${action}» (v1 soporta: diagnostics)` };
      const rel = String(args.path ?? "");
      if (!rel) return { output: "Error: falta `path`" };
      const abs = resolve(ctx.cwd, rel);
      let st;
      try { st = statSync(abs); } catch { return { output: `Error: no existe el archivo: ${abs}` }; }
      if (!st.isFile()) return { output: `Error: no es un archivo: ${abs}` };
      const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
      const def = defs.find((d) => d.extensions.includes(ext));
      if (!def) {
        return { output: `Error: ningún servidor LSP configurado cubre «${ext}» (configurados: ${defs.flatMap((d) => d.extensions).join(", ")})` };
      }
      const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? Math.min(args.timeoutMs, 60000) : 10000;
      try {
        const res = await diagnosticsFor(def, abs, ctx.cwd, timeoutMs);
        if (!res.diagnostics.length) {
          return { output: res.note ? `lsp «${def.name}»: sin diagnósticos (${res.note})` : `lsp «${def.name}»: sin diagnósticos en ${abs}` };
        }
        const lines = res.diagnostics.slice(0, 50).map((d) =>
          `${abs}:${d.line}:${d.character} [${d.severity}]${d.code ? ` ${d.code}` : ""} ${d.message}${d.source ? ` (${d.source})` : ""}`);
        if (res.diagnostics.length > 50) lines.push(`…(+${res.diagnostics.length - 50} diagnósticos más)`);
        return { output: lines.join("\n") };
      } catch (err) {
        return { output: `Error LSP «${def.name}»: ${(err as Error).message}` };
      }
    },
  };
}
