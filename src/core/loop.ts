// Loop agéntico: stream → tool calls → resultados → repetir hasta que el modelo
// pare (o maxSteps / abort). El núcleo no imprime: todo sale por ctx.emit.

import type { AgentTool, ChatMessage, ToolContext, ToolSchema } from "./types.js";
import { PermissionDenied, expandHome, type PermissionEngine, type CheckResult } from "./permissions.js";
import { streamChat, type ProviderConfig } from "./provider.js";
import type { TokenUsage } from "./events.js";
import { resolve } from "node:path";

export interface LoopOptions {
  provider: ProviderConfig;
  permissions: PermissionEngine;
  messages: ChatMessage[];
  tools: AgentTool[];
  ctx: ToolContext;
  maxSteps?: number;
  fetchImpl?: typeof fetch;
}

export async function runAgentLoop(opts: LoopOptions): Promise<"stop" | "max_steps" | "aborted"> {
  const maxSteps = opts.maxSteps ?? 50;
  const emit = opts.ctx.emit;
  let usage: TokenUsage | undefined;

  for (let step = 0; step < maxSteps; step++) {
    if (opts.ctx.signal.aborted) {
      emit({ type: "turn_end", reason: "aborted", usage });
      return "aborted";
    }
    const toolsSchema: ToolSchema[] | undefined = opts.tools.length
      ? opts.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }))
      : undefined;

    const { message, usage: stepUsage } = await streamChat({
      provider: opts.provider,
      messages: opts.messages,
      tools: toolsSchema,
      signal: opts.ctx.signal,
      onText: (text) => emit({ type: "text_delta", text }),
      fetchImpl: opts.fetchImpl,
    });
    usage = stepUsage ?? usage;
    opts.messages.push(message);

    if (!message.tool_calls?.length) {
      emit({ type: "turn_end", reason: "stop", usage });
      return "stop";
    }

    for (const call of message.tool_calls) {
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        opts.messages.push(toolMessage(call.id, `Error: argumentos JSON inválidos: ${call.function.arguments.slice(0, 200)}`));
        continue;
      }
      const tool = opts.tools.find((t) => t.name === name);
      emit({ type: "tool_start", id: call.id, name, args });
      const started = Date.now();
      let output: string;
      let isError = false;
      try {
        output = await executeTool(tool, args, opts, name);
      } catch (err) {
        isError = true;
        output = err instanceof PermissionDenied
          ? `Error: ${err.message}. El usuario no aprobó esta operación; prueba otra vía o pregunta.`
          : `Error: ${(err as Error).message}`;
      }
      emit({ type: "tool_end", id: call.id, name, output, isError, durationMs: Date.now() - started });
      opts.messages.push(toolMessage(call.id, output));
    }
  }

  emit({ type: "error", message: `Se alcanzó el máximo de ${maxSteps} pasos sin que el modelo terminara.` });
  emit({ type: "turn_end", reason: "max_steps", usage });
  return "max_steps";
}

// Propuesta de patrón para "allow always": para rutas (read/edit/write/list), la carpeta con /*; para el resto (p. ej. bash), el recurso exacto.
export function proposeAlwaysPattern(action: string, resource: string): string {
  if (action === "edit" || action === "read" || action === "write" || action === "list") {
    const i = Math.max(resource.lastIndexOf("/"), resource.lastIndexOf("\\"));
    return i > 0 ? resource.slice(0, i + 1) + "*" : resource;
  }
  return resource;
}

function toolMessage(callId: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: callId, content };
}

// executeTool aplica el flujo de permisos ANTES de tocar nada:
//   deny → error sin ejecutar · ask → diff/preview + confirmación de la UI ·
//   allow → ejecuta. Las tools con `preview` exponen un diff para el diálogo.
export async function executeTool(tool: AgentTool | undefined, args: Record<string, unknown>, opts: LoopOptions, name = "?"): Promise<string> {
  if (!tool) throw new Error(`tool desconocida: "${name}"`);
  // Hooks PreToolUse (fase 7): bloquean ANTES del diálogo de permisos.
  const preReason = await opts.ctx.hooks?.preTool?.(tool.name, args).catch((err) => `hook PreToolUse falló: ${(err as Error).message}`);
  if (typeof preReason === "string" && preReason) return preReason;
  const action = tool.permission.action;
  const resources = tool.permissionResources?.(args) ?? [tool.permission.resource(args)];
  const resource = resources[0];
  const isPathAction = ["read", "edit", "list", "write"].includes(action);
  const checkOne = (r: string): CheckResult =>
    isPathAction ? opts.permissions.checkPath(opts.ctx.cwd, action, r) : opts.permissions.check(action, r);
  // deny > ask > allow para operaciones compuestas
  const results = resources.map(checkOne);
  let decision = results.find((r) => r.effect === "deny") ?? results.find((r) => r.effect === "ask") ?? results.find((r) => r.effect === "allow") ?? { effect: "ask" as const };
  if (decision.effect === "ask") {
    // diff antes de pedir permiso (spec para write/edit/apply_patch)
    let diff: string | undefined;
    try { diff = (await tool.preview?.(args, opts.ctx))?.diff; } catch { /* preview falló: se pide sin diff */ }
    const patterns = resources.map((r) => proposeAlwaysPattern(action, r));
    const verdict = await opts.ctx.ui.confirm({ action, resource: resources.join(", "), diff, alwaysPattern: patterns.join(", ") });
    if (verdict === "reject") throw new PermissionDenied(action, resource);
    if (verdict === "always") {
      for (const [i, r] of resources.entries()) {
        opts.permissions.addSavedAllow({ action, resource: patterns[i], effect: "allow" });
        opts.ctx.approvals?.save(action, patterns[i]); // proyecto-scoped (XDG), nunca pisa deny (el motor re-evalúa deny)
      }
    }
    decision = { effect: "allow" };
  }
  if (decision.effect === "deny") throw new PermissionDenied(action, resource);

  // Snapshots pre-imagen DESPUÉS del permiso (si se rechaza, no se toca nada).
  const undo = opts.ctx.undo;
  let preTaken = false;
  if (undo && UNDOABLE_TOOLS.has(tool.name)) {
    try { undo.snapshotPre(tool.name, undoablePaths(tool.name, args, opts.ctx.cwd, resources)); preTaken = true; } catch { /* snapshot falló: se ejecuta sin undo */ }
  }
  let result: Awaited<ReturnType<typeof tool.run>>;
  try {
    result = await tool.run(args, opts.ctx);
    // Hooks PostToolUse: informativos, nunca bloquean.
    await opts.ctx.hooks?.postTool?.(tool.name, args).catch(() => {});
    if (preTaken) try { undo!.snapshotPost(); } catch { opts.ctx.ui.info("undo: no se pudo guardar el snapshot"); }
    return result.output;
  } catch (err) {
    if (preTaken) try { undo!.snapshotPost(); } catch { /* sin snapshot; el error original manda */ }
    throw err;
  }
}

const UNDOABLE_TOOLS = new Set(["write", "edit", "apply_patch", "bash"]);

// Rutas afectadas por la tool (misma fuente que los permisos: permissionResources).
function undoablePaths(name: string, args: Record<string, unknown>, cwd: string, resources: string[]): string[] {
  if (name === "bash") return []; // marcamos el paso como NO deshacible
  return resources
    .filter((r) => r && !r.includes("\n"))
    .map((r) => {
      const expanded = expandHome(r.trim());
      const resolved = resolve(cwd, expanded);
      return resolved;
    });
}
