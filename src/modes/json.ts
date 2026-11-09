// --json: el mismo flujo, pero cada evento sale como una línea JSONL en stdout.
// Ideal para pipes, CI y para probar el núcleo sin UI.

import { runAgentLoop } from "../core/loop.js";
import { buildRuntime, persistNewMessages, prepareContext, prepareMcp, prepareHooks, prepareUrlContext, type RuntimeOptions } from "./common.js";
import { prepareExtensions } from "../ext/loader.js";

export async function runJson(opts: RuntimeOptions & { prompt: string }): Promise<number> {
  const rt = buildRuntime({ ...opts, attachUi: false });
  await prepareMcp(rt);
  await prepareHooks(rt);
  await prepareExtensions(rt, { ui: rt.ctx.ui });
  await prepareUrlContext(rt);
  await prepareContext(rt);
  rt.ctx.undo?.beginTurn(opts.prompt.replace(/\s+/g, " ").slice(0, 80));
  // Solo JSONL en stdout; los diálogos de permiso siguen yendo por stderr (FlatUi hooks).
  rt.bus.on((ev) => process.stdout.write(JSON.stringify(ev) + "\n"));
  const startIndex = rt.messages.length;
  rt.messages.push({ role: "user", content: opts.prompt });
  const reason = await runAgentLoop({
    provider: rt.provider,
    permissions: rt.permissions,
    messages: rt.messages,
    tools: rt.tools,
    ctx: rt.ctx,
  });
  persistNewMessages(rt, startIndex);
  return reason === "aborted" ? 130 : 0;
}
