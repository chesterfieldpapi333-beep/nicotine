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
import { isAbsolute, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 50 * 1024;

export const bashTool: AgentTool = {
  name: "bash",
  description:
    "Ejecuta un comando de shell en el directorio de trabajo (o `workdir`). Devuelve stdout+stderr combinados " +
    "(truncado a 50 KiB; el completo queda en un archivo temporal). Timeout por defecto 120000 ms. " +
    "background=true lanza el proceso en segundo plano y devuelve de inmediato la ruta del log (sin notificación aún).",
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
    const fullLog = join(tmpdir(), `nicotine-bash-${randomUUID().slice(0, 8)}.log`);

    if (args.background) {
      const child = spawn(shell, ["-c", command], { cwd: workdir, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (d) => chunks.push(d));
      child.stderr.on("data", (d) => chunks.push(d));
      child.on("exit", () => writeFileSync(fullLog, Buffer.concat(chunks)));
      child.unref();
      return { output: `background: proceso lanzado (pid ${child.pid}), log al terminar en ${fullLog}` };
    }

    const { code, output, timedOut } = await runWithAbort(shell, command, workdir, timeout, ctx.signal);
    const buf = Buffer.from(output, "utf8");
    const logPath = buf.length > MAX_OUTPUT_BYTES ? (writeFileSync(fullLog, output), fullLog) : null;
    const tail = buf.length > MAX_OUTPUT_BYTES ? buf.subarray(buf.length - MAX_OUTPUT_BYTES).toString("utf8") : output;
    const header = [
      timedOut ? `[timeout ${timeout} ms — proceso terminado]` : `[exit ${code}]`,
      logPath ? `[salida completa: ${logPath}]` : "",
    ].filter(Boolean).join("\n");
    return { output: `${header}\n${tail}`.trimEnd() };
  },
};

function runWithAbort(shell: string, command: string, cwd: string, timeoutMs: number, signal: AbortSignal) {
  return new Promise<{ code: number | null; output: string; timedOut: boolean }>((resolvePromise, reject) => {
    const child = spawn(shell, ["-c", command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
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
