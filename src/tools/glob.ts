// glob: busca rutas por patrón (**/*.ts). Usa Bun.Glob (sin dependencias) y
// respeta .gitignore con un subconjunto pragmático (líneas literales, *, **,
// prefijo /, trailing /, ! para negar). Hidden solo con dot:true o patrón con punto.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AgentTool } from "../core/types.js";
import { resolvePath } from "./fs-util.js";

export const globTool: AgentTool = {
  name: "glob",
  description:
    "Encuentra archivos por patrón glob (p. ej. **/*.ts). Busca desde `path` (por defecto el cwd). " +
    "hidden=true incluye ocultos; limit acota resultados (por defecto 100). Respeta .gitignore.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Patrón glob, p. ej. src/**/*.test.ts" },
      path: { type: "string", description: "Directorio base. Por defecto el cwd." },
      hidden: { type: "boolean" },
      limit: { type: "number" },
    },
    required: ["pattern"],
  },
  permission: { action: "glob", resource: (a) => String(a.pattern) },
  async run(args, ctx) {
    const base = args.path ? resolvePath(ctx.cwd, String(args.path)) : ctx.cwd;
    if (!existsSync(base)) throw new Error(`no existe el directorio: ${base}`);
    const limit = Math.max(1, Math.min(1000, Number(args.limit ?? 100) || 100));
    const pattern = String(args.pattern);
    const ignores = loadGitignore(ctx.cwd);
    const glob = new Bun.Glob(pattern);
    const dot = !!args.hidden || pattern.split("/").some((s) => s.startsWith("."));
    const matches: string[] = [];
    const started = Date.now();
    for await (const entry of glob.scan({ cwd: base, dot, onlyFiles: true })) {
      if (matches.length >= limit * 4) break; // escaneo acotado aunque el límite acote la salida
      if (isIgnored(entry, ignores)) continue;
      matches.push(entry);
      if (Date.now() - started > 30_000) break; // timeout de seguridad 30 s
    }
    // Ordenar por mtime descendente (lo más reciente primero) y acotar.
    const withMtime = matches.map((m) => {
      try { return { m, t: statSync(join(base, m)).mtimeMs }; } catch { return { m, t: 0 }; }
    }).sort((x, y) => y.t - x.t).slice(0, limit);
    const out = withMtime.map((x) => relative(ctx.cwd, join(base, x.m)).split(sep).join("/"));
    return { output: out.length ? out.join("\n") : "(sin coincidencias)" };
  },
};

export interface IgnoreRule { negated: boolean; regex: RegExp }

export function loadGitignore(root: string): IgnoreRule[] {
  const path = join(root, ".gitignore");
  if (!existsSync(path)) return [];
  const rules: IgnoreRule[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) { negated = true; line = line.slice(1); }
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    // glob → regex (subconjunto: **, *, ?)
    let re = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "*") {
        if (line[i + 1] === "*") { re += ".*"; i++; if (line[i + 1] === "/") i++; }
        else re += "[^/]*";
      } else if (ch === "?") re += "[^/]";
      else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    rules.push({ negated, regex: new RegExp(anchored ? `^${re}(/|$)` : `(^|/)${re}(/|$)`) });
  }
  return rules;
}

export function isIgnored(path: string, rules: IgnoreRule[]): boolean {
  const norm = path.split(sep).join("/");
  let ignored = false;
  for (const rule of rules) {
    if (rule.regex.test(norm)) ignored = !rule.negated;
  }
  return ignored;
}
