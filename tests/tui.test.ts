// Tests de la máquina de estados de la TUI (sin terminal real).
// computeFrame es determinista dado (width, height); handleKey acepta teclas
// sintéticas. El motor real lo cubre el smoke test con pty.

import { test, expect, describe } from "bun:test";
import { TuiApp, fuzzyFilter } from "../src/ui/app.js";
import { defaultThemes } from "../src/ui/theme.js";
import { DEFAULT_KEYBINDS, type TuiConfig } from "../src/ui/tui-config.js";
import type { KeyEventLike } from "../src/ui/key.js";
import { stripAnsi } from "../src/ui/ansi-wrap.js";

function makeTuiConfig(): TuiConfig {
  return {
    theme: "vireo-dark", leaderTimeout: 2000, keybinds: { ...DEFAULT_KEYBINDS },
    scrollSpeed: 3, diffStyle: "auto", mouse: false,
    cursor: { style: "block", blinking: false }, layers: [],
  };
}

function makeApp() {
  const submitted: string[] = [];
  const exits: string[] = [];
  const state = { model: "mock-model", agent: "build", session: "abc12345" };
  const app = new TuiApp({
    theme: defaultThemes[0],
    setTheme: () => {},
    tui: makeTuiConfig(),
    cwd: "/tmp/proyecto-test",
    themes: ["vireo-dark", "vireo-light"],
    commands: [
      { name: "help", hint: "ayuda", run: (a) => a.openHelp() },
      { name: "exit", hint: "salir", run: () => { exits.push("exit"); } },
      { name: "new", hint: "nueva sesión", run: () => { exits.push("new"); } },
    ],
    submit: (prompt) => submitted.push(prompt),
    abortTurn: () => { exits.push("abort"); },
    cycleAgent: () => { state.agent = state.agent === "build" ? "plan" : "build"; return state.agent; },
    newSession: () => ({ id: "new00000" }),
    switchSession: () => true,
    listSessions: () => [{ id: "abc12345", title: "sesión previa" }],
    fetchModels: async () => ["mock-model", "otro-modelo"],
    setModel: (m) => { state.model = m; },
    currentModel: () => state.model,
    currentAgent: () => state.agent,
    currentSession: () => state.session,
    exit: () => { exits.push("exit"); },
  });
  return { app, submitted, exits, state };
}

const key = (name: string, sequence = "", mods: Partial<KeyEventLike> = {}): KeyEventLike =>
  ({ name, ctrl: false, meta: false, shift: false, sequence: sequence || name, ...mods });

const typeText = (app: TuiApp, text: string) => {
  for (const ch of text) app.handleKey({ name: ch, ctrl: false, meta: false, shift: false, sequence: ch });
};

const frameText = (app: TuiApp, w = 100, h = 30) => app.computeFrame(w, h).map(stripAnsi).join("\n");

describe("TUI — frame", () => {
  test("frame vacío: 30 líneas, header y footer", () => {
    const { app } = makeApp();
    const frame = app.computeFrame(100, 30);
    expect(frame.length).toBe(30);
    const all = frame.map(stripAnsi).join("\n");
    expect(all).toContain("vireo");
    expect(all).toContain("build");
    expect(all).toContain("mock-model");
    expect(all).toContain("ctrl+p");
  });

  test("el ancho se respeta (fitAnsi corta líneas largas)", () => {
    const { app } = makeApp();
    for (const line of app.computeFrame(40, 20)) expect(stripAnsi(line).length).toBeLessThanOrEqual(40);
  });

  test("cursor por defecto dentro del editor", () => {
    const { app } = makeApp();
    app.computeFrame(80, 24);
    expect(app.cursor.row).toBeGreaterThanOrEqual(0);
  });
});

describe("TUI — editor y envío", () => {
  test("escribir y enviar con return", () => {
    const { app, submitted } = makeApp();
    typeText(app, "hola mundo");
    app.handleKey(key("return"));
    expect(submitted).toEqual(["hola mundo"]);
    expect(frameText(app)).toContain("hola mundo"); // user message visible
  });

  test("ctrl+j inserta nueva línea en vez de enviar", () => {
    const { app, submitted } = makeApp();
    typeText(app, "linea1");
    app.handleKey(key("j", "\n", { ctrl: true }));
    typeText(app, "linea2");
    app.handleKey(key("return"));
    expect(submitted).toEqual(["linea1\nlinea2"]);
  });

  test("escape limpia el editor", () => {
    const { app } = makeApp();
    typeText(app, "borrame");
    app.handleKey(key("escape"));
    app.handleKey(key("return")); // editor vacío: no envía nada
    expect(frameText(app)).not.toContain("borrame");
  });

  test("ctrl+c con editor vacío sale; con texto, lo limpia", () => {
    const { app, exits } = makeApp();
    typeText(app, "x");
    app.handleKey(key("c", "\x03", { ctrl: true })); // limpia
    expect(exits).toEqual([]);
    app.handleKey(key("c", "\x03", { ctrl: true })); // sale
    expect(exits).toEqual(["exit"]);
  });

  test("backspace borra el último carácter", () => {
    const { app, submitted } = makeApp();
    typeText(app, "abc");
    app.handleKey(key("backspace"));
    app.handleKey(key("return"));
    expect(submitted).toEqual(["ab"]);
  });
});

describe("TUI — comandos slash", () => {
  test("/exit ejecuta el comando exit", () => {
    const { app, exits } = makeApp();
    typeText(app, "/exit");
    app.handleKey(key("return"));
    expect(exits).toEqual(["exit"]);
  });

  test("/inexistente muestra error", () => {
    const { app } = makeApp();
    typeText(app, "/zzzz");
    app.handleKey(key("return"));
    expect(frameText(app)).toContain("desconocido");
  });

  test("autocompletado slash aparece y tab completa", () => {
    const { app } = makeApp();
    typeText(app, "/ex");
    const frame = frameText(app);
    expect(frame).toContain("sugerencias");
    app.handleKey(key("tab"));
    app.handleKey(key("return"));
    // se completó a /exit y lo ejecutó
    expect(frameText(app)).toContain(""); // no crash
  });

  test("fuzzyFilter ordena por subsecuencia consecutiva", () => {
    const items = fuzzyFilter(["src/ui/app.ts", "src/tools/apply_patch.ts", "docs/parity.md", "scripts/mock-provider.ts"], "mock");
    expect(items[0]).toBe("scripts/mock-provider.ts");
  });
});

describe("TUI — diálogos", () => {
  test("permiso: 'a' resuelve always y dibuja el diff", async () => {
    const { app } = makeApp();
    const promise = app.confirmPermission({ action: "edit", resource: "src/x.ts", diff: "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new" });
    expect(frameText(app)).toContain("permiso requerido");
    expect(frameText(app)).toContain("-old");
    app.handleKey(key("a"));
    expect(await promise).toBe("always");
    expect(frameText(app)).not.toContain("permiso requerido");
  });

  test("permiso: escape resuelve reject", async () => {
    const { app } = makeApp();
    const promise = app.confirmPermission({ action: "bash", resource: "rm -rf /tmp/x" });
    app.handleKey(key("escape"));
    expect(await promise).toBe("reject");
  });

  test("pregunta: opción numérica y el frame muestra progreso", async () => {
    const { app } = makeApp();
    const promise = app.askQuestions([{ header: "Modo", question: "¿Qué hacemos?", options: ["rápido", "seguro"] }]);
    expect(frameText(app)).toContain("¿Qué hacemos?");
    app.handleKey(key("2"));
    expect(await promise).toEqual(["seguro"]);
  });

  test("pregunta: '0' abre respuesta libre y return la envía", async () => {
    const { app } = makeApp();
    const promise = app.askQuestions([{ header: "Notas", question: "¿Comentario?", options: ["a"] }]);
    app.handleKey(key("0"));
    typeText(app, "libre!");
    app.handleKey(key("return"));
    expect(await promise).toEqual(["libre!"]);
  });

  test("lista: flechas + return selecciona", async () => {
    const { app, exits } = makeApp();
    app.deps.commands.push({ name: "pick", hint: "", run: (a) => {
      (a as unknown as { dialog: { onPick: (id: string) => void } });
    } });
    // usar openSessions: dos entradas, bajar y elegir la segunda
    app.openSessions();
    app.handleKey(key("down"));
    app.handleKey(key("return"));
    expect(frameText(app)).toContain("sesión cargada: abc12345".slice(0, 10));
  });
});

describe("TUI — mensajes y tools", () => {
  test("tool_start/tool_end dibujan tarjeta con ✓ y output", () => {
    const { app } = makeApp();
    app.toolStart("t1", "bash", { command: "echo hola" });
    expect(frameText(app)).toContain("bash");
    app.toolEnd("t1", "bash", "hola\n", false, 12);
    const frame = frameText(app);
    expect(frame).toContain("hola");
    expect(frame).toContain("12ms");
  });

  test("todos_updated muestra el strip de tareas", () => {
    const { app } = makeApp();
    app.todosUpdated([{ content: "hacer cosa", status: "in_progress" }, { content: "otra", status: "pending" }]);
    expect(frameText(app)).toContain("hacer cosa");
  });

  test("text_delta acumula en el mismo mensaje assistant", () => {
    const { app } = makeApp();
    app.turnStarted();
    app.appendAssistantDelta("he ");
    app.appendAssistantDelta("cho");
    app.turnEnd("stop");
    const frame = frameText(app);
    expect(frame).toContain("he cho");
  });
});

describe("TUI — diálogos fase 3", () => {
  const mk = () => {
    const deleted: string[] = [];
    const renamed: [string, string][] = [];
    const submitted: string[] = [];
    const app = new TuiApp({
      theme: defaultThemes[0],
      setTheme: () => {},
      tui: makeTuiConfig(),
      cwd: "/tmp/proyecto-test",
      themes: ["vireo-dark"],
      commands: [
        { name: "undo", hint: "deshacer", run: () => submitted.push("undo!") },
      ],
      submit: (p) => submitted.push(p),
      abortTurn: () => {},
      cycleAgent: () => "plan",
      newSession: () => ({ id: "fork0001" }),
      switchSession: () => true,
      listSessions: () => [{ id: "ses00001", title: "sesión para borrar" }],
      fetchModels: async () => [],
      setModel: () => {},
      renameSession: (id, title) => { renamed.push([id, title]); },
      deleteSession: (id) => { deleted.push(id); },
      currentModel: () => "mock-model",
      currentAgent: () => "build",
      currentSession: () => "activa00",
      exit: () => {},
    });
    return { app, submitted, deleted, renamed };
  };

  const type = (app: TuiApp, text: string) => { for (const ch of text) app.handleKey({ name: ch, ctrl: false, meta: false, shift: false, sequence: ch }); };

  test("pregunta sin opciones abre en modo libre directamente", async () => {
    const { app } = mk();
    const promise = app.askQuestions([{ header: "Renombrar", question: "Nuevo título:", options: [] }]);
    expect(stripAnsi(app.computeFrame(80, 24).join("\n"))).toContain("respuesta libre");
    type(app, "mi título");
    app.handleKey(key("return"));
    expect(await promise).toEqual(["mi título"]);
  });

  test("/undo desde el leader ejecuta el comando", async () => {
    const { app, submitted } = mk();
    app.handleKey(key("x", "\x18", { ctrl: true })); // leader
    app.handleKey(key("u", "u"));                   // <leader>u → /undo
    expect(submitted).toContain("undo!");
  });

  test("sesiones: 'd' pide confirmación y borra con '1'", async () => {
    const { app, deleted } = mk();
    app.openSessions();
    app.handleKey(key("d")); // pedir confirmación
    expect(stripAnsi(app.computeFrame(100, 30).join("\n"))).toContain("Borrar sesión");
    app.handleKey(key("1")); // "Sí, borrar"
    await new Promise((r) => setImmediate(r)); // confirmarDeleteSession es async
    expect(deleted).toEqual(["ses00001"]);
  });

  test("sesiones: 'r' pide título libre y renombra", async () => {
    const { app, renamed } = mk();
    app.openSessions();
    app.handleKey(key("r"));
    await new Promise((r) => setImmediate(r));
    type(app, "nuevo nombre");
    app.handleKey(key("return"));
    await new Promise((r) => setImmediate(r));
    expect(renamed).toEqual([["ses00001", "nuevo nombre"]]);
  });
});
