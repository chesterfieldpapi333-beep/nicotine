// /export — exporta la sesión actual a Markdown en
// $XDG_DATA_HOME/vireo/exports/<id>-<timestamp>.md (spec tui#export).
// Lite: no abre $EDITOR todavía (la TUI no suspende su engine para editores
// externos en v1); imprime la ruta. Nunca ejecuta nada.

import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { dataHome } from "../core/session.js";
import type { Session } from "../core/session.js";
import { Session as SessionList } from "../core/session.js";
import type { ChatMessage } from "../core/types.js";

export function exportSessionMarkdown(rt: { session: Session; provider: { model: string }; ctx: { cwd: string } }): { path: string; messages: number } {
  const msgs = rt.session.messages() as ChatMessage[];
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const path = join(dataHome(), "exports", `${rt.session.id}-${stamp}.md`);
  mkdirSync(dirname(path), { recursive: true });
  let title = "(sin título)";
  try { title = SessionList.list().find((x) => x.id === rt.session.id)?.title ?? title; } catch { /* informativo */ }
  const lines: string[] = [
    `# Sesión vireo ${rt.session.id}`,
    "",
    `**Título:** ${title}`,
    `**Fecha:** ${new Date().toISOString().slice(0, 19).replace("T", " ")} · **Modelo:** ${rt.provider.model} · **CWD:** ${rt.ctx.cwd}`,
    "",
  ];
  let n = 0;
  for (const m of msgs as ChatMessage[]) {
    if (m.role === "system") continue; // el system prompt no se exporta (es del motor)
    n++;
    if (m.role === "user") lines.push("## Usuario", "", m.content ?? "", "");
    else if (m.role === "assistant") {
      lines.push("## Asistente", "", m.content ?? "");
      if (m.tool_calls?.length) {
        lines.push("", "```text", ...m.tool_calls.map((tc) => `tool_call: ${tc.function?.name}(${(tc.function?.arguments ?? "").slice(0, 200)})`), "```");
      }
      lines.push("");
    } else if (m.role === "tool") {
      lines.push(`## Resultado de tool`, "", "```text", (m.content ?? "").slice(0, 8000), "```", "");
    }
  }
  const body = lines.join("\n");
  writeFileSync(path, body, "utf8");
  try { chmodSync(path, 0o600); } catch { /* fs que no soporte chmod */ }
  return { path, messages: n };
}
