// /editor y /export — editor externo con UI suspendida (con suspend inyectado).
import { describe, test, expect } from "bun:test";
import { editInExternalEditor, editorCommand, openInExternalEditor } from "../src/ui/external-editor.js";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("editorCommand", () => {
  test("$VISUAL gana sobre $EDITOR; se dividen flags; default vi", () => {
    const bak = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR };
    process.env.VISUAL = "code --wait"; process.env.EDITOR = "emacs";
    expect(editorCommand()).toEqual({ cmd: "code", args: ["--wait"] });
    delete process.env.VISUAL;
    expect(editorCommand()).toEqual({ cmd: "emacs", args: [] });
    delete process.env.EDITOR;
    expect(editorCommand().cmd).toBe("vi");
    if (bak.VISUAL === undefined) delete process.env.VISUAL; else process.env.VISUAL = bak.VISUAL;
    if (bak.EDITOR === undefined) delete process.env.EDITOR; else process.env.EDITOR = bak.EDITOR;
  });
});

describe("editInExternalEditor", () => {
  test("roundtrip: el contenido editado vuelve al llamador; suspend se ejecuta", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vireo-edtest-"));
    const probe = join(dir, "probe");
    // editor falso: antepone «EDITADO» al archivo usando la shell
    const fake = join(dir, "fake-editor.sh");
    writeFileSync(fake, '#!/bin/sh\nprintf "EDITADO:%s" "$(cat "$1")" > "$1"\n', { mode: 0o755 });
    const bak = process.env.VISUAL; process.env.VISUAL = fake;
    let suspended = 0;
    const suspend = async (fn: () => Promise<void>) => { suspended++; await fn(); };
    const res = await editInExternalEditor("original", suspend, "test");
    expect(suspended).toBe(1);
    expect("text" in res && res.text).toBe("EDITADO:original");
    if (bak === undefined) delete process.env.VISUAL; else process.env.VISUAL = bak;
  });

  test("editor que sale con código ≠ 0 → error sin tocar el buffer", async () => {
    const bak = process.env.VISUAL; process.env.VISUAL = "false"; // exit 1
    const res = await editInExternalEditor("intacto", async (fn) => { await fn(); }, "test2");
    expect("error" in res && res.error.includes("intacto") === false ? true : "error" in res).toBe(true);
    expect("error" in res).toBe(true);
    if (bak === undefined) delete process.env.VISUAL; else process.env.VISUAL = bak;
  });
});

describe("openInExternalEditor", () => {
  test("archivo existente se abre (fake editor ok) y se informa", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vireo-opentest-"));
    const file = join(dir, "out.md");
    writeFileSync(file, "contenido", "utf8");
    const bak = process.env.VISUAL; process.env.VISUAL = "true";
    const res = await openInExternalEditor(file, async (fn) => { await fn(); });
    expect(res.ok).toBe(true);
    expect(res.detail).toBe(file);
    expect(readFileSync(file, "utf8")).toBe("contenido");
    if (bak === undefined) delete process.env.VISUAL; else process.env.VISUAL = bak;
  });
});
