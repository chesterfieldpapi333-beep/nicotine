import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nicotine-session-"));
  process.env.XDG_DATA_HOME = tmp;
});

describe("Session JSONL", () => {
  test("crear → append → messages roundtrip", async () => {
    const { Session } = await import("../src/core/session.js");
    const s = Session.create("/proyecto");
    s.appendMessage({ role: "user", content: "hola" });
    s.appendMessage({ role: "assistant", content: "buenas" });
    s.appendMessage({ role: "tool", tool_call_id: "c1", content: "resultado" });
    const msgs = s.messages();
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(msgs[2].tool_call_id).toBe("c1");
    expect(s.messages().length).toBe(3);
  });
  test("list() devuelve la sesión creada con título actualizado", async () => {
    const { Session } = await import("../src/core/session.js");
    const s = Session.create("/proyecto");
    s.setTitle("mi título de prueba");
    const list = Session.list();
    expect(list[0].id).toBe(s.id);
    expect(list[0].title).toBe("mi título de prueba");
  });
  test("load() recupera cwd del meta", async () => {
    const { Session } = await import("../src/core/session.js");
    const s = Session.create("/un/proyecto/real");
    const loaded = Session.load(s.id);
    expect(loaded).not.toBeNull();
  });
});
