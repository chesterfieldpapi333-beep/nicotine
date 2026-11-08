// grep: busca texto en archivos con ripgrep (respeta .gitignore por defecto);
// si `rg` no está en PATH, cae a un buscador JS propio (.gitignore parcial).
// La primera línea del resultado indica qué motor se usó cuando no es rg puro.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { isAbsolute, join, relative, sep, resolve } from "node:path";
import type { AgentTool } from "../core/types.js";
import { resolvePath } from "./fs-util.js";
import { loadGitignore, isIgnored } from "./glob.js";

const DEFAULT_LIMIT = 100;
const MAX_LINE = 240;

export const grepTool: AgentTool = {
  name: "grep",
  description:
    "Busca un patrón (regex) en el contenido de archivos. literal=true para texto plano. " +
    "Filtra con path, include (p. ej. '*.ts') y caseSensitive. Devuelve ruta:línea:contenido. Límite por defecto 100 líneas.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "Directorio o archivo. Por defecto el cwd." },
      include: { type: "string", description: "Glob de nombres, p. ej. '*.ts'." },
      literal: { type: "boolean" },
      caseSensitive: { type: "boolean" },
      limit: { type: "number" },
    },
    required: ["pattern"],
  },
  permission: { action: "grep", resource: (a) => String(a.pattern) },
  async run(args, ctx) {
    const base = args.path ? resolvePath(ctx.cwd, String(args.path)) : ctx.cwd;
    if (!existsSync(base)) throw new Error(`no existe: ${base}`);
    const limit = Math.max(1, Math.min(1000, Number(args.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
    const pattern = String(args.pattern);
    if (spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0) {
      return ripgrep(pattern, base, args, limit, ctx.cwd);
    }
    return jsSearch(pattern, base, args, limit, ctx.cwd);
  },
};

async function ripgrep(pattern: string, base: string, args: Record<string, unknown>, limit: number, cwd: string) {
  const absBase = isAbsolute(base) ? base : resolve(cwd, base);
  // --no-require-git: honrar .gitignore aunque el meta proyecto no sea un repo git (fixtures, árboles sueltos)
  const rgArgs = ["--no-heading", "--line-number", "--color", "never", "--no-require-git", "--max-count", String(limit)];
  if (args.literal) rgArgs.push("--fixed-strings");
  if (!args.caseSensitive) rgArgs.push("--ignore-case");
  if (args.include) rgArgs.push("-g", String(args.include));
  rgArgs.push("--", pattern, absBase);
  const { code, out } = await new Promise<{ code: number | null; out: string }>((resolvePromise) => {
    const child = spawn("rg", rgArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { if (out.length < 1_000_000) out += d; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
    child.on("exit", (code) => { clearTimeout(timer); resolvePromise({ code, out }); });
    child.on("error", () => { clearTimeout(timer); resolvePromise({ code: -1, out }); });
  });
  if (code !== 0 && code !== 1) throw new Error(`rg terminó con código ${code} (patrón inválido o error de lectura)`);
  const lines = out.split("\n").filter(Boolean).slice(0, limit).map((l) => {
    // rg emite "<absBase>/ruta:línea:contenido" → lo pasamos a relativo del cwd
    const idx = l.indexOf(":");
    if (idx > 0 && l.slice(0, idx).startsWith(absBase)) {
      const absFile = l.slice(0, idx);
      return relative(cwd, absFile).split(sep).join("/") + l.slice(idx);
    }
    return l;
  });
  return { output: lines.length ? lines.join("\n") : "(sin coincidencias)" };
}

async function jsSearch(pattern: string, base: string, args: Record<string, unknown>, limit: number, cwd: string) {
  const ignores = loadGitignore(cwd);
  let re: RegExp;
  try {
    re = new RegExp(args.literal ? escapeRe(pattern) : pattern, args.caseSensitive ? "" : "i");
  } catch (err) {
    throw new Error(`regex inválida: ${(err as Error).message}`);
  }
  const include = args.include
    ? new RegExp("^" + String(args.include).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, ".") + "$")
    : null;
  const out: string[] = [];
  const deadline = Date.now() + 30_000;
  const pushFile = (abs: string) => {
    const rel = relative(cwd, abs).split(sep).join("/");
    let text: string;
    try { text = readFileSync(abs, "utf8"); } catch { return; }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && out.length < limit; i++) {
      if (re.test(lines[i])) out.push(`${rel}:${i + 1}:${truncate(lines[i])}`);
    }
  };
  const walk = (dir: string) => {
    if (out.length >= limit || Date.now() > deadline) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= limit || Date.now() > deadline) return;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const abs = join(dir, e.name);
      const rel = relative(cwd, abs).split(sep).join("/");
      if (isIgnored(rel, ignores)) continue;
      if (e.isDirectory()) { walk(abs); continue; }
      if (include && !include.test(e.name)) continue;
      pushFile(abs);
    }
  };
  const st = statSync(base);
  if (st.isFile()) pushFile(base); else walk(base);
  const header = "[buscador JS: rg no disponible en PATH; .gitignore soportado parcialmente]\n";
  return { output: (out.length ? header : "") + (out.join("\n") || "(sin coincidencias)") };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const truncate = (s: string) => (s.length > MAX_LINE ? s.slice(0, MAX_LINE) + "…" : s);
