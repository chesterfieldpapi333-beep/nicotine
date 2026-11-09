// REPL interino para `vireo` sin argumentos en terminal (la TUI real llega en la fase 2).
// Bucle readline: cada línea es un turno; Ctrl+C aborta el turno en curso.

import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { runAgentLoop } from "../core/loop.js";
import { buildRuntime, persistNewMessages, prepareContext, prepareMcp, prepareHooks, type RuntimeOptions } from "./common.js";
import { prepareExtensions } from "../ext/loader.js";
import { Session } from "../core/session.js";

export async function runRepl(opts: RuntimeOptions): Promise<number> {
  const rt = buildRuntime(opts);
  await prepareMcp(rt);
  await prepareHooks(rt);
  await prepareExtensions(rt, { ui: rt.ctx.ui });
  stderr.write(`vireo — sesión ${rt.session.id} (cwd: ${opts.cwd}). /help para ayuda, /exit para salir.\n`);
  const rl = createInterface({ input: stdin, output: stdout });
  for (;;) {
    let line: string;
    try { line = (await rl.question("vireo> ")).trim(); } catch { break; }
    if (!line) continue;
    if (["/exit", "/quit", "/q"].includes(line)) break;
    if (line === "/help") { stderr.write("/new  nueva sesión · /sessions  listar · /exit  salir\n"); continue; }
    if (line === "/sessions") {
      for (const s of Session.list().slice(0, 20)) stderr.write(`${s.id}  ${s.title}\n`);
      continue;
    }
    await prepareContext(rt);
    rt.ctx.undo?.beginTurn(line.slice(0, 80));
    const startIndex = rt.messages.length;
    rt.messages.push({ role: "user", content: line });
    rl.pause(); // no leer stdin mientras el modelo piensa (evita mezclar input con streams)
    await runAgentLoop({
      provider: rt.provider, permissions: rt.permissions, messages: rt.messages,
      tools: rt.tools, ctx: rt.ctx,
    });
    persistNewMessages(rt, startIndex);
    rl.resume();
  }
  rl.close();
  return 0;
}
