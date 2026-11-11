// Undo/redo por turno: pre/post imagen en disco, respaldo de estado actual.
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ToolContext, UiHooks } from "../src/core/types.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nicotine-undo-"));
  process.env.XDG_DATA_HOME = join(tmp, "data");
});

const ui: UiHooks = { confirm: async () => "once", question: async () => null, info: () => {} };

function makeCtx(cwd: string, undo: import("../src/core/undo.js").UndoManager): ToolContext {
  return { cwd, sessionId: "test", signal: new AbortController().signal, ui, readFiles: new Set(), emit: () => {}, undo };
}

describe("UndoManager", () => {
  test("write crea archivo → undo lo borra → redo lo recrea", async () => {
    const { UndoManager } = await import("../src/core/undo.js");
    const { executeTool } = await import("../src/core/loop.js");
    const { writeTool } = await import("../src/tools/write.js");
    const { PermissionEngine, baseRules } = await import("../src/core/permissions.js");
    const undo = new UndoManager(`s-${Date.now()}`);
    const ctx = makeCtx(tmp, undo);
    const permissions = new PermissionEngine(baseRules());
    const target = join(tmp, "nuevo.txt");
    undo.beginTurn("probar write");
    await executeTool(writeTool, { path: target, content: "contenido-v1\n" }, { provider: { baseURL: "http://x/v1", apiKey: "k", model: "m", headers: {}, engine: "fetch" as const }, permissions, messages: [], tools: [writeTool], ctx });
    expect(readFileSync(target, "utf8")).toBe("contenido-v1\n");
    const undone = undo.undo();
    expect(undone.ok).toBe(true);
    expect(existsSync(target)).toBe(false);
    const redone = undo.redo();
    expect(redone.ok).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("contenido-v1\n");
    rmSync(tmp, { recursive: true, force: true });
  });

  test("write sobre archivo existente → undo restaura el viejo contenido", async () => {
    const { UndoManager } = await import("../src/core/undo.js");
    const { executeTool } = await import("../src/core/loop.js");
    const { writeTool } = await import("../src/tools/write.js");
    const { PermissionEngine, baseRules } = await import("../src/core/permissions.js");
    const undo = new UndoManager(`s-${Date.now()}b`);
    const ctx = makeCtx(tmp, undo);
    const permissions = new PermissionEngine(baseRules());
    const target = join(tmp, "existente.txt");
    writeFileSync(target, "original\n");
    undo.beginTurn("sobrescribir");
    await executeTool(writeTool, { path: target, content: "modificado\n" }, { provider: { baseURL: "http://x/v1", apiKey: "k", model: "m", headers: {}, engine: "fetch" as const }, permissions, messages: [], tools: [writeTool], ctx });
    undo.undo();
    expect(readFileSync(target, "utf8")).toBe("original\n");
    undo.redo();
    expect(readFileSync(target, "utf8")).toBe("modificado\n");
    rmSync(tmp, { recursive: true, force: true });
  });

  test("bash queda registrado como no deshacible pero se consume", async () => {
    const { UndoManager } = await import("../src/core/undo.js");
    const { executeTool } = await import("../src/core/loop.js");
    const { bashTool } = await import("../src/tools/bash.js");
    const { PermissionEngine, baseRules } = await import("../src/core/permissions.js");
    const undo = new UndoManager(`s-${Date.now()}c`);
    const ctx = makeCtx(tmp, undo);
    const permissions = new PermissionEngine(baseRules());
    undo.beginTurn("bash turn");
    await executeTool(bashTool, { command: "echo hola" }, { provider: { baseURL: "http://x/v1", apiKey: "k", model: "m", headers: {}, engine: "fetch" as const }, permissions, messages: [], tools: [bashTool], ctx });
    const res = undo.undo();
    expect(res.ok).toBe(true);
    expect(res.skipped.some((s) => s.includes("bash"))).toBe(true);
    expect(undo.canUndo()).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("unbeginTurn posterior invalida el redo", async () => {
    const { UndoManager } = await import("../src/core/undo.js");
    const undo = new UndoManager(`s-${Date.now()}d`);
    undo.beginTurn("t1");
    undo.snapshotPre("write", [join(tmp, "x.txt")]);
    writeFileSync(join(tmp, "x.txt"), "v1\n");
    undo.snapshotPost();
    undo.undo();
    expect(undo.canRedo()).toBe(true);
    undo.beginTurn("t2"); // invalida
    expect(undo.canRedo()).toBe(false);
    expect(undo.redo().ok).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("si el usuario editó después del turno, el archivo no se borra y queda respaldo", async () => {
    const { UndoManager } = await import("../src/core/undo.js");
    const undo = new UndoManager(`s-${Date.now()}e`);
    const target = join(tmp, "mio.txt");
    undo.beginTurn("crear");
    undo.snapshotPre("write", [target]);
    writeFileSync(target, "del agente\n");
    undo.snapshotPost();
    writeFileSync(target, "editado por mí después\n"); // edición posterior del usuario
    const res = undo.undo();
    expect(res.deleted).toEqual([]);
    expect(res.skipped.length).toBe(1);
    expect(readFileSync(target, "utf8")).toBe("editado por mí después\n");
    expect(res.backupDir).toBeDefined();
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("Session fork/remove", () => {
  test("forkFrom copia el historial con id nuevo y título fork:", async () => {
    const { Session } = await import("../src/core/session.js");
    const s = Session.create("/proyecto");
    s.setTitle("original");
    s.appendMessage({ role: "user", content: "hola" });
    s.appendMessage({ role: "assistant", content: "buenas" });
    const fork = Session.forkFrom(s, "/proyecto");
    expect(fork.id).not.toBe(s.id);
    expect(fork.messages().map((m) => m.content)).toEqual(["hola", "buenas"]);
    expect(Session.list().find((x) => x.id === fork.id)?.title).toStartWith("fork:");
    // la original sigue intacta
    expect(Session.load(s.id)?.messages().length).toBe(2);
    expect(Session.remove(fork.id)).toBe(true);
    expect(Session.list().find((x) => x.id === fork.id)).toBeUndefined();
    expect(Session.remove("no-existe")).toBe(false);
  });
});
