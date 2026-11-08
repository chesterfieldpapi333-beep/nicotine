// --print: un turno completo, respuesta a stdout, herramientas/ruido a stderr.

import { runAgentLoop } from "../core/loop.js";
import { buildRuntime, persistNewMessages, prepareContext, type RuntimeOptions } from "./common.js";

export async function runPrint(opts: RuntimeOptions & { prompt: string }): Promise<number> {
  const rt = buildRuntime(opts);
  await prepareContext(rt); // compactar antes de empezar, si toca
  rt.ctx.undo?.beginTurn(opts.prompt.replace(/\s+/g, " ").slice(0, 80));
  const startIndex = rt.messages.length;
  rt.messages.push({ role: "user", content: opts.prompt });
  if (rt.messages.filter((m) => m.role === "user").length === 1) {
    rt.session.setTitle(opts.prompt.replace(/\s+/g, " ").slice(0, 80));
  }
  rt.bus.on((ev) => {
    if (ev.type === "turn_end" && ev.usage) {
      rt.usageTotals.promptTokens = (rt.usageTotals.promptTokens ?? 0) + (ev.usage.promptTokens ?? 0);
      rt.usageTotals.completionTokens = (rt.usageTotals.completionTokens ?? 0) + (ev.usage.completionTokens ?? 0);
      rt.usageTotals.totalTokens = (rt.usageTotals.totalTokens ?? 0) + (ev.usage.totalTokens ?? 0);
    }
  });
  const reason = await runAgentLoop({
    provider: rt.provider,
    permissions: rt.permissions,
    messages: rt.messages,
    tools: rt.tools,
    ctx: rt.ctx,
  });
  persistNewMessages(rt, startIndex);
  rt.bus.emit({ type: "session_saved", sessionId: rt.session.id });
  return reason === "aborted" ? 130 : 0;
}
