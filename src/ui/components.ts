// Modelo de mensajes para la vista y renderizado de tarjetas de tool.
// (Componentes puros: reciben ancho + tema; no tocan estado global.)

import { fgHex, token, reset, bold, dimmed, type Theme } from "./theme.js";
import { wrapAnsi } from "./ansi-wrap.js";
import { applyDiffStyle, type DiffStyle } from "./diff-style.js";

export type DisplayRole = "user" | "assistant" | "tool" | "system" | "error";

export interface DisplayMessage {
  role: DisplayRole;
  /** texto del mensaje; en tools: preview de argumentos (one-line) */
  text: string;
  /** salida completa de la tool (se rellena en tool_end) */
  output?: string;
  toolName?: string;
  isError?: boolean;
  durationMs?: number;
}

export function userLine(theme: Theme, text: string): string {
  return fgHex(token(theme, "user")) + bold + "❯ " + reset + fgHex(token(theme, "user")) + text + reset;
}

export function assistantLines(text: string): string[] {
  return text.split("\n");
}

export function toolStartLine(theme: Theme, name: string, argsOneLine: string): string {
  return fgHex(token(theme, "tool")) + "● " + reset + fgHex(token(theme, "tool")) + name + reset + dimmed + " " + argsOneLine + reset;
}

export function toolEndLine(theme: Theme, name: string, isError: boolean, durationMs: number): string {
  const mark = isError ? `${fgHex(token(theme, "error"))}✗${reset}` : `${fgHex(token(theme, "success"))}✓${reset}`;
  return `  ${mark} ${dimmed}${name} · ${durationMs}ms${reset}`;
}

export function toolOutputLine(theme: Theme, line: string): string {
  // Diffs con color cuando el contenido trae marcas unificadas
  if (line.startsWith("+") && !line.startsWith("+++")) return fgHex(token(theme, "diffAdd")) + "  " + line + reset;
  if (line.startsWith("-") && !line.startsWith("---")) return fgHex(token(theme, "diffDel")) + "  " + line + reset;
  if (line.startsWith("@@")) return fgHex(token(theme, "diffHunk")) + "  " + line + reset;
  return dimmed + "  " + line + reset;
}

export function wrapMessage(msg: DisplayMessage, theme: Theme, width: number, diffStyle?: DiffStyle): string[] {
  const out: string[] = [];
  const pushWrapped = (raw: string) => { for (const chunk of wrapAnsi(raw, Math.max(1, width))) out.push(chunk.text); };
  switch (msg.role) {
    case "user": pushWrapped(userLine(theme, msg.text)); break;
    case "assistant": for (const raw of assistantLines(msg.text)) pushWrapped(raw); break;
    case "tool": {
      pushWrapped(toolStartLine(theme, msg.toolName ?? "tool", oneLine(msg.text, 160)));
      if (msg.output !== undefined) {
        const styled = applyDiffStyle(msg.output, diffStyle);
        const lines = styled.split("\n").slice(0, 30);
        for (const raw of lines) for (const chunk of wrapAnsi(toolOutputLine(theme, raw), Math.max(1, width))) out.push(chunk.text);
        if (styled.split("\n").length > 30) out.push(dimmed + "  …(salida truncada)" + reset);
        if (msg.durationMs !== undefined) out.push(toolEndLine(theme, msg.toolName ?? "tool", !!msg.isError, msg.durationMs));
      }
      break;
    }
    case "system": pushWrapped(dimmed + "· " + msg.text + reset); break;
    case "error": pushWrapped(fgHex(token(theme, "error")) + "error: " + msg.text + reset); break;
  }
  return out;
}

export const oneLine = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s).replace(/\s+/g, " ");


