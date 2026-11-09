// UI plana: consumidor mínimo de eventos para --print/--json/REPL interino.
// - texto del modelo → stdout (crudo, para pipes)
// - tool chatter, permisos, errores → stderr
// - permisos: y/n/a en TTY; sin TTY → reject; --auto → allow

import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
const isTTY = !!stdin.isTTY && !!stderr.isTTY;
import type { EventBus } from "../core/events.js";
import type { PermissionDecision, PermissionRequest, QuestionPrompt, UiHooks } from "../core/types.js";

const useColor = !process.env.NO_COLOR && isTTY;
const c = (code: string) => (s: string) => (useColor ? `[${code}m${s}[0m` : s);
const dim = c("2"), red = c("31"), green = c("32"), yellow = c("33"), cyan = c("36");

export class FlatUi implements UiHooks {
  constructor(private opts: { auto: boolean }) {}

  attach(bus: EventBus): void {
    bus.on((ev) => {
      switch (ev.type) {
        case "text_delta":
          stdout.write(ev.text);
          break;
        case "tool_start":
          stderr.write(dim(`\n→ ${ev.name}(${oneLine(JSON.stringify(ev.args), 200)})\n`));
          break;
        case "tool_end": {
          const status = ev.isError ? red("error") : green("ok");
          stderr.write(dim(`← ${ev.name} ${status} ${ev.durationMs}ms\n`) + truncateLines(ev.output, 10).map((l) => dim("  " + l) + "\n").join(""));
          break;
        }
        case "provider_retry":
          stderr.write(dim(`  · HTTP ${ev.status} — ${ev.nextModel && ev.nextModel !== ev.model ? `saltando a modelo ${ev.nextModel}` : `reintentando (${ev.attempt}/${ev.total})`}\n`));
          break;
        case "compaction":
          stderr.write(`  · contexto compactado (${ev.pass === 1 ? "poda sin LLM" : "resumen"}): ${ev.beforeTokens} → ${ev.afterTokens} tokens\n`);
          break;
        case "turn_end": {
          stdout.write("\n");
          if (ev.usage?.totalTokens) stderr.write(dim(`[tokens: ${ev.usage.totalTokens}]\n`));
          break;
        }
        case "error":
          stderr.write(red(`error: ${ev.message}\n`));
          break;
        case "todos_updated": {
          const icon = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;
          stderr.write(cyan("tareas:\n") + ev.todos.map((t) => `  ${icon[t.status]} ${t.content}`).join("\n") + "\n");
          break;
        }
        case "session_saved":
          stderr.write(dim(`[sesión ${ev.sessionId}]\n`));
          break;
      }
    });
  }

  info(text: string): void { stderr.write(dim(text + "\n")); }

  async confirm(req: PermissionRequest): Promise<PermissionDecision> {
    if (this.opts.auto) { this.info(`[--auto] permitido: ${req.action} → ${req.resource}`); return "once"; }
    if (!isTTY) { stderr.write(red(`permiso denegado (no interactivo): ${req.action} → ${req.resource}\n`)); return "reject"; }
    if (req.diff) stderr.write(colorDiff(req.diff) + "\n");
    const rl = createInterface({ input: stdin, output: stderr });
    try {
      for (;;) {
        const alwaysHint = req.alwaysPattern ? ` / a=siempre (guarda «${req.alwaysPattern}»)` : " / a=siempre";
        const answer = (await rl.question(yellow(`¿Permitir ${req.action} → ${req.resource}? [y=sí / n=no${alwaysHint}] `))).trim().toLowerCase();
        if (["y", "yes", "si", "sí", "s"].includes(answer)) return "once";
        if (["a", "always", "siempre", "s2"].includes(answer)) return "always";
        if (["n", "no", ""].includes(answer)) return "reject";
      }
    } finally { rl.close(); }
  }

  async question(questions: QuestionPrompt[]): Promise<string[] | null> {
    if (!isTTY) return null;
    const rl = createInterface({ input: stdin, output: stderr });
    const answers: string[] = [];
    try {
      for (const q of questions) {
        stderr.write(cyan(`\n${q.header} — ${q.question}\n`));
        q.options.forEach((opt, i) => stderr.write(`  ${i + 1}) ${opt}\n`));
        stderr.write(`  0) respuesta libre\n`);
        const answer = (await rl.question("> ")).trim();
        const idx = Number(answer);
        if (!answer) answers.push("(sin respuesta)");
        else if (Number.isInteger(idx) && idx >= 1 && idx <= q.options.length) answers.push(q.options[idx - 1]);
        else answers.push(answer);
      }
    } finally { rl.close(); }
    return answers;
  }
}

const oneLine = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s).replace(/\n/g, " ");

function truncateLines(text: string, max: number): string[] {
  const lines = text.split("\n");
  const shown = lines.slice(0, max);
  if (lines.length > max) shown.push(`… (${lines.length - max} líneas más)`);
  return shown;
}

function colorDiff(diff: string): string {
  return diff.split("\n").map((l) => {
    if (l.startsWith("+") && !l.startsWith("+++")) return green(l);
    if (l.startsWith("-") && !l.startsWith("---")) return red(l);
    if (l.startsWith("@@")) return cyan(l);
    return l;
  }).join("\n");
}
