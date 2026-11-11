// /editor y /export — editor externo ($VISUAL/$EDITOR) con la TUI suspendida.
// Nunca ejecuta el contenido del archivo; solo lanza el editor del usuario.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface EditResult { ok: boolean; detail: string; }

/** Comando del editor: $VISUAL > $EDITOR > vi. Se divide por espacios
 *  (admite «code --wait»; los GUI deben llevar --wait o nicotine no reanudará). */
export function editorCommand(): { cmd: string; args: string[] } {
  const raw = (process.env.VISUAL ?? process.env.EDITOR ?? "vi").trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  return { cmd: parts[0] ?? "vi", args: parts.slice(1) };
}

/** Abre un archivo existente en el editor externo (para /export). Informa el código de salida. */
export async function openInExternalEditor(file: string, suspend: (fn: () => Promise<void>) => Promise<void>): Promise<{ ok: boolean; detail: string }> {
  const { cmd, args } = editorCommand();
  let code = -1;
  await suspend(async () => {
    code = await new Promise<number>((resolve) => {
      let child;
      try { child = spawn(cmd, [...args, file], { stdio: "inherit" }); } catch { resolve(-1); return; }
      child.on("error", () => resolve(-1));
      child.on("close", (c) => resolve(c ?? -1));
    });
  });
  if (code !== 0) return { ok: false, detail: `el editor «${cmd}» salió con código ${code === -1 ? "?" : code} (el archivo quedó en ${file})` };
  return { ok: true, detail: file };
}

/** Abre `content` en el editor externo; devuelve el texto resultante. */
export async function editInExternalEditor(initial: string, suspend: (fn: () => Promise<void>) => Promise<void>, hint: string): Promise<{ text: string } | { error: string }> {
  const { cmd, args } = editorCommand();
  let dir: string | null = null;
  let file = "";
  try {
    dir = mkdtempSync(join(tmpdir(), "nicotine-editor-"));
    file = join(dir, `${hint}.md`);
    writeFileSync(file, initial, "utf8");
    let code = -1;
    await suspend(async () => {
      code = await new Promise<number>((resolve) => {
        let child;
        try { child = spawn(cmd, [...args, file], { stdio: "inherit" }); } catch (err) {
          resolve(-1); // 127-ish
          return;
        }
        child.on("error", () => resolve(-1));
        child.on("close", (c) => resolve(c ?? -1));
      });
    });
    if (code !== 0) return { error: `el editor «${cmd}» salió con código ${code === -1 ? "? (¿no existe? instala vim o exporta $EDITOR)" : code}; el buffer NO se modificó` };
    const text = existsSync(file) ? readFileSync(file, "utf8") : initial;
    return { text };
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp */ } }
  }
}
