// Undo/redo por turno: pre/post imagen en disco, respaldo de estado actual.
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

describe("UndoManager — bordes (Q3)", () => {
  const newId = () => `q3-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const snapshotsDir = (id: string) => join(process.env.XDG_DATA_HOME!, "nicotine", "snapshots", id);
  const manifestPath = (id: string) => join(snapshotsDir(id), "manifest.json");
  const filesPath = (id: string) => join(snapshotsDir(id), "files");

  test("sin turnos: undo y redo informan y no lanzan", async () => {
    const { UndoManager } = await import("../src/core/undo.js");
    const undo = new UndoManager(newId());
    expect(undo.canUndo()).toBe(false);
    expect(undo.canRedo()).toBe(false);
    const u = undo.undo();
    expect(u.ok).toBe(false);
    expect(u.message).toContain("no hay cambios que deshacer");
    const r = undo.redo();
    expect(r.ok).toBe(false);
    expect(r.message).toContain("no hay nada que rehacer");
  });

  test("abortPending descarta la pre-imagen y no deja registro", async () => {
    const { UndoManager } = await import("../src/core/undo.js");
    const id = newId();
    const undo = new UndoManager(id);
    const target = join(tmp, "abortado.txt");
    undo.beginTurn("no llegó a correr");
    undo.snapshotPre("write", [target]);
    undo.abortPending();
    expect(undo.canUndo()).toBe(false);
    expect(readdirSync(filesPath(id))).toEqual([]);
    expect(() => undo.snapshotPost()).not.toThrow();
  });

  test("dos tools en el mismo turno: undo revierte ambos", async () => {
    const { UndoManager } = await import("../src/core/undo.js");
    const undo = new UndoManager(newId());
    const a = join(tmp, "turno-a.txt");
    const b = join(tmp, "turno-b.txt");
    undo.beginTurn("dos escrituras");
    undo.snapshotPre("write", [a]);
    writeFileSync(a, "a\n");
    undo.snapshotPost();
    undo.snapshotPre("edit", [b]);
    writeFileSync(b, "b\n");
    undo.snapshotPost();
    const res = undo.undo();
    expect(res.ok).toBe(true);
    expect(res.deleted).toHaveLength(2);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(undo.canUndo()).toBe(false);
  });

  test("poda: libera las imágenes de los turnos viejos al pasar de 30", async () => {
    const { UndoManager } = await import("../src/core/undo.js");
    const id = newId();
    const undo = new UndoManager(id);
    for (let i = 1; i <= 31; i++) {
      undo.beginTurn(`turno ${i}`);
      undo.snapshotPre("write", [join(tmp, `poda-${i}.txt`)]);
      writeFileSync(join(tmp, `poda-${i}.txt`), `v${i}\n`);
      undo.snapshotPost();
    }
    const manifest = JSON.parse(readFileSync(manifestPath(id), "utf8")) as { seq: number; records: { turn: number; dir?: string }[] };
    expect(manifest.seq).toBe(31);
    // El turno 1 ya perdió sus imágenes en disco (la poda corre en memoria)…
    const oldest = manifest.records.find((r) => r.turn === 1);
    expect(oldest?.dir).toBeDefined();
    expect(existsSync(join(filesPath(id), oldest!.dir!))).toBe(false);
    // …y los turnos conservados siguen completos.
    const kept = manifest.records.filter((r) => r.turn > 1);
    expect(kept.every((r) => existsSync(join(filesPath(id), r.dir!)))).toBe(true);
  });

  test("deuda: el manifest en disco puede citar imágenes ya podadas", async () => {
    // save() persiste ANTES de prune(): una instancia nueva carga el manifest sin podar.
    const { UndoManager } = await import("../src/core/undo.js");
    const id = newId();
    const undo = new UndoManager(id);
    for (let i = 1; i <= 31; i++) {
      undo.beginTurn(`turno ${i}`);
      undo.snapshotPre("write", [join(tmp, `deuda-${i}.txt`)]);
      writeFileSync(join(tmp, `deuda-${i}.txt`), `v${i}\n`);
      undo.snapshotPost();
    }
    const reloaded = new UndoManager(id);
    expect(reloaded.canUndo()).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath(id), "utf8")) as { records: { turn: number; dir?: string }[] };
    expect(manifest.records.some((r) => r.turn === 1)).toBe(true);
  });

  test("archivo > 2 MB: no se respalda y undo lo omite con nota", async () => {
    const { UndoManager } = await import("../src/core/undo.js");
    const undo = new UndoManager(newId());
    const big = join(tmp, "grande.bin");
    undo.beginTurn("archivo enorme");
    undo.snapshotPre("write", [big]);
    writeFileSync(big, "x".repeat(2 * 1024 * 1024 + 10));
    undo.snapshotPost();
    const res = undo.undo();
    expect(res.restored).toEqual([]);
    expect(res.skipped.some((s) => s.includes("demasiado grande"))).toBe(true);
    expect(existsSync(big)).toBe(true);
  });

  test("manifest corrupto: arranca limpio en vez de lanzar", async () => {
    const { UndoManager } = await import("../src/core/undo.js");
    const id = newId();
    mkdirSync(filesPath(id), { recursive: true });
    writeFileSync(manifestPath(id), "{{{ no es json");
    const undo = new UndoManager(id);
    expect(undo.canUndo()).toBe(false);
    expect(undo.beginTurn("tras corrupto")).toBe(1);
  });

  test("el estado sobrevive a una instancia nueva (manifest en disco)", async () => {
    const { UndoManager } = await import("../src/core/undo.js");
    const id = newId();
    const first = new UndoManager(id);
    const target = join(tmp, "persistente.txt");
    first.beginTurn("persistir");
    first.snapshotPre("write", [target]);
    writeFileSync(target, "v\n");
    first.snapshotPost();
    const second = new UndoManager(id);
    expect(second.canUndo()).toBe(true);
    const res = second.undo();
    expect(res.deleted).toHaveLength(1);
    expect(existsSync(target)).toBe(false);
  });

  test("redo recrea directorios intermedios borrados", async () => {
    const { UndoManager } = await import("../src/core/undo.js");
    const undo = new UndoManager(newId());
    const nested = join(tmp, "cap1", "cap2", "nota.txt");
    mkdirSync(join(tmp, "cap1", "cap2"), { recursive: true });
    undo.beginTurn("anidado");
    undo.snapshotPre("write", [nested]);
    writeFileSync(nested, "anidado\n");
    undo.snapshotPost();
    undo.undo();
    rmSync(join(tmp, "cap1"), { recursive: true, force: true });
    const res = undo.redo();
    expect(res.ok).toBe(true);
    expect(readFileSync(nested, "utf8")).toBe("anidado\n");
  });

  test("relTo: dentro del cwd relativo, fuera absoluto", async () => {
    const { relTo } = await import("../src/core/undo.js");
    expect(relTo(join(process.cwd(), "src", "index.ts"))).toBe(join("src", "index.ts"));
    const outside = join(tmp, "fuera.txt");
    expect(relTo(outside)).toBe(outside);
  });
});
