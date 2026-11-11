// bash: ejecuta un comando en el shell del usuario (config `shell`, $SHELL o
// /bin/sh) con timeout por defecto de 2 minutos y abort con SIGTERM→SIGKILL.
// La salida se trunca a las últimas líneas; el total queda en un archivo
// temporal cuya ruta se incluye en el resultado.

import { envAlias } from "../core/env.js";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AgentTool } from "../core/types.js";
import { loadConfig } from "../core/config.js";
import { isAbsolute, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;
const ABSOLUTE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// Siempre presentes en el entorno hijo para que PATH/HOME/locale funcionen.
const BASIC_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "USER", "LOGNAME"];

function bashLimits(cwd: string): { maxOutputBytes: number; envAllow: string[] | null } {
  let maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES;
  let envAllow: string[] | null = null;
  const envBytes = Number(process.env.NICOTINE_MAX_TOOL_OUTPUT_BYTES);
  if (Number.isFinite(envBytes) && envBytes >= 1024) maxOutputBytes = Math.min(ABSOLUTE_MAX_OUTPUT_BYTES, Math.floor(envBytes));
  try {
    const tools = loadConfig(cwd).config["tools"];
    const bash = tools && typeof tools === "object" ? (tools as Record<string, unknown>)["bash"] : undefined;
    if (bash && typeof bash === "object") {
      const b = bash as Record<string, unknown>;
      if (typeof b["maxOutputBytes"] === "number" && Number.isFinite(b["maxOutputBytes"]) && (b["maxOutputBytes"] as number) >= 1024) {
        maxOutputBytes = Math.min(ABSOLUTE_MAX_OUTPUT_BYTES, Math.floor(b["maxOutputBytes"] as number));
      }
      const allow = b["envAllow"];
      if (Array.isArray(allow)) envAllow = allow.filter((x): x is string => typeof x === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(x));
    }
  } catch { /* config ilegible: límites por defecto */ }
  if (envAllow === null) {
    const raw = process.env.NICOTINE_BASH_ENV_ALLOW;
    if (raw) envAllow = raw.split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
  }
  return { maxOutputBytes, envAllow };
}

function childEnv(envAllow: string[] | null): NodeJS.ProcessEnv {
  if (!envAllow) return process.env;
  const allow = new Set([...BASIC_ENV, ...envAllow]);
  const out: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export const bashTool: AgentTool = {
  name: "bash",
  description:
    "Ejecuta un comando de shell en el directorio de trabajo (o `workdir`). Devuelve stdout+stderr combinados " +
    "(truncado a 50 KiB por defecto; NICOTINE_MAX_TOOL_OUTPUT_BYTES o tools.bash.maxOutputBytes lo ajustan, máx. 4 MiB; el completo queda en un archivo temporal 0600). Timeout por defecto 120000 ms. " +
    "background=true lanza el proceso en segundo plano y devuelve de inmediato la ruta del log (sin notificación aún). " +
    "tools.bash.envAllow o NICOTINE_BASH_ENV_ALLOW (lista separada por comas) limpian el entorno del hijo: solo esas variables + PATH/HOME/LANG/LC_ALL/TERM/TMPDIR/USER/LOGNAME.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Comando completo a ejecutar." },
      workdir: { type: "string", description: "Directorio de trabajo. Por defecto el del proyecto." },
      timeout: { type: "number", description: "Timeout en ms (por defecto 120000)." },
      background: { type: "boolean", description: "true = lanzar en segundo plano." },
    },
    required: ["command"],
  },
  permission: { action: "bash", resource: (a) => String(a.command) },
  async run(args, ctx) {
    const command = String(args.command);
    const workdir = args.workdir ? (isAbsolute(String(args.workdir)) ? String(args.workdir) : resolve(ctx.cwd, String(args.workdir))) : ctx.cwd;
    const timeout = Math.max(1, Number(args.timeout ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
    const shell = envAlias("SHELL") || process.env.SHELL || "/bin/sh";
    const { maxOutputBytes, envAllow } = bashLimits(ctx.cwd);
    const env = childEnv(envAllow);
    const fullLog = join(tmpdir(), `nicotine-bash-${randomUUID().slice(0, 8)}.log`);

    if (args.background) {
      const child = spawn(shell, ["-c", command], { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (d) => chunks.push(d));
      child.stderr.on("data", (d) => chunks.push(d));
      child.on("exit", () => writeFileSync(fullLog, Buffer.concat(chunks), { mode: 0o600 }));
      child.unref();
      return { output: `background: proceso lanzado (pid ${child.pid}), log al terminar en ${fullLog}` };
    }

    const { code, output, timedOut } = await runWithAbort(shell, command, workdir, timeout, ctx.signal, env);
    const buf = Buffer.from(output, "utf8");
    const logPath = buf.length > maxOutputBytes ? (writeFileSync(fullLog, output, { mode: 0o600 }), fullLog) : null;
    const tail = buf.length > maxOutputBytes ? buf.subarray(buf.length - maxOutputBytes).toString("utf8") : output;
    const header = [
      timedOut ? `[timeout ${timeout} ms — proceso terminado]` : `[exit ${code}]`,
      logPath ? `[salida completa: ${logPath}]` : "",
    ].filter(Boolean).join("\n");
    return { output: `${header}\n${tail}`.trimEnd() };
  },
};

function runWithAbort(shell: string, command: string, cwd: string, timeoutMs: number, signal: AbortSignal, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; output: string; timedOut: boolean }>((resolvePromise, reject) => {
    const child = spawn(shell, ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (d: Buffer) => { if (output.length < 4_000_000) output += d.toString("utf8"); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    const kill = () => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 2000).unref(); };
    const timer = setTimeout(kill, timeoutMs);
    const onAbort = () => { kill(); };
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(err); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolvePromise({ code, output, timedOut });
    });
  });
}
