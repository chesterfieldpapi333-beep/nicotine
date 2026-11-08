// Smoke test headless del motor OpenTUI con el renderer de pruebas de
// @opentui/core/testing. Verifica que el frame llega al buffer nativo.

import { test, expect, describe } from "bun:test";
import { TuiApp } from "../src/ui/app.js";
import { defaultThemes } from "../src/ui/theme.js";
import { DEFAULT_KEYBINDS, type TuiConfig } from "../src/ui/tui-config.js";
import type { KeyEventLike } from "../src/ui/key.js";

const tui: TuiConfig = {
  theme: "vireo-dark", leaderTimeout: 2000, keybinds: { ...DEFAULT_KEYBINDS },
  scrollSpeed: 3, diffStyle: "auto", mouse: false,
  cursor: { style: "block", blinking: false }, layers: [],
};

function makeApp() {
  const submitted: string[] = [];
  const app = new TuiApp({
    theme: defaultThemes[0],
    setTheme: () => {},
    tui,
    cwd: "/tmp/proyecto-test",
    themes: ["vireo-dark"],
    commands: [{ name: "exit", hint: "salir", run: () => {} }],
    submit: (p) => submitted.push(p),
    abortTurn: () => {},
    cycleAgent: () => "build",
    newSession: () => ({ id: "x" }),
    switchSession: () => true,
    listSessions: () => [],
    fetchModels: async () => [],
    setModel: () => {},
    currentModel: () => "mock-model",
    currentAgent: () => "build",
    currentSession: () => "abc12345",
    exit: () => {},
  });
  return { app, submitted };
}

const key = (name: string, sequence = "", mods: Partial<KeyEventLike> = {}): KeyEventLike =>
  ({ name, ctrl: false, meta: false, shift: false, sequence: sequence || name, ...mods });

describe("OpenTUI — smoke headless", () => {
  test("el frame aterriza en el buffer nativo; las teclas llegan al app", async () => {
    const { createTestRenderer } = await import("@opentui/core/testing");
    const { mountOpenTui } = await import("../src/ui/opentui.js");
    const { app, submitted } = makeApp();
    const { renderer, captureCharFrame, flush, dispose } = await createTestRenderer({ width: 80, height: 24, screenMode: "alternate-screen" });
    try {
      const mount = await mountOpenTui(app, renderer);
      await flush();
      let frame = captureCharFrame();
      expect(frame).toContain("vireo");
      expect(frame).toContain("mock-model");
      expect(frame).toContain("abc12345");
      expect(frame).toContain("listo");
      // escribir "hola" y enviar: debe aparecer el mensaje del usuario y el envío
      for (const ch of "hola") app.handleKey(key(ch, ch));
      await mount.flush();
      await flush();
      app.handleKey(key("return"));
      await mount.flush();
      await flush();
      frame = captureCharFrame();
      expect(submitted).toEqual(["hola"]);
      expect(frame).toContain("hola");
    } finally {
      await dispose();
    }
  });
});
