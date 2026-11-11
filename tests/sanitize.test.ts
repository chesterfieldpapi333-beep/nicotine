// sanitizeForTUI: la salida del modelo y de las tools es dato no confiable.
import { describe, test, expect } from "bun:test";
import { sanitizeForTUI, isAllowedSgr } from "../src/security/sanitize.js";

const ESC = "\u001b";
const CSI = (seq: string) => `${ESC}[${seq}`;

describe("sanitizeForTUI — texto plano", () => {
  test("texto plano queda idéntico (incluye unicode, tabs y saltos)", () => {
    for (const text of [
      "",
      "hola mundo",
      "línea 1\nlínea 2\n",
      "con\ttabulador\ty ñandú 🦜",
      "<div>sin secuencias</div> & símbolos €",
    ]) {
      expect(sanitizeForTUI(text)).toBe(text);
    }
  });

  test("es idempotente", () => {
    const samples = [
      `a${CSI("2J")}b${CSI("31m")}rojo${CSI("0m")}`,
      `${ESC}]52;c;Zm9v${"\u0007"}texto`,
      "a\r\nb\u0007c",
    ];
    for (const s of samples) {
      const once = sanitizeForTUI(s);
      expect(sanitizeForTUI(once)).toBe(once);
    }
  });
});

describe("sanitizeForTUI — destruye lo peligroso", () => {
  test("movimiento de cursor (absoluto, relativo, home, guardar/restaurar)", () => {
    for (const seq of ["H", "2J", "10;20H", "A", "3B", "5C", "2D", "6G", "1;1f", "s", "u"]) {
      const out = sanitizeForTUI(`antes${CSI(seq)}después`);
      expect(out).toBe("antesdespués");
      expect(out).not.toContain(ESC);
    }
  });

  test("borrado de línea y de pantalla", () => {
    for (const seq of ["K", "2K", "1K", "J", "3J", "0J"]) {
      expect(sanitizeForTUI(`x${CSI(seq)}y`)).toBe("xy");
    }
  });

  test("OSC 52 (portapapeles), título de ventana y OSC sin terminador", () => {
    expect(sanitizeForTUI(`a${ESC}]52;c;cHJ1ZWJh${"\u0007"}b`)).toBe("ab");
    expect(sanitizeForTUI(`a${ESC}]0;título malicioso${ESC}\\b`)).toBe("ab");
    expect(sanitizeForTUI(`a${ESC}]2;notice${"\u0007"}b`)).toBe("ab");
    // sin BEL ni ST: se descarta el resto (fail-closed)
    expect(sanitizeForTUI(`a${ESC}]52;c;cHJ1ZWJh`)).toBe("a");
  });

  test("DCS, SOS, PM y APC se descartan completos", () => {
    expect(sanitizeForTUI(`a${ESC}P1;2|datos${ESC}\\b`)).toBe("ab");
    expect(sanitizeForTUI(`a${ESC}Xdatos${ESC}\\b`)).toBe("ab");
    expect(sanitizeForTUI(`a${ESC}^datos${ESC}\\b`)).toBe("ab");
    expect(sanitizeForTUI(`a${ESC}_datos${ESC}\\b`)).toBe("ab");
    expect(sanitizeForTUI(`a${ESC}Pdatos sin fin`)).toBe("a");
  });

  test("CSI no-SGR, consultas de estado y escapes simples", () => {
    for (const seq of ["?25l", "?25h", "6n", "2 q", ">c", "!p"]) {
      expect(sanitizeForTUI(`a${CSI(seq)}b`)).toBe("ab");
    }
    expect(sanitizeForTUI(`a${ESC}c`)).toBe("a"); // RIS
    expect(sanitizeForTUI(`a${ESC}7b`)).toBe("ab");
    expect(sanitizeForTUI(`a${ESC}(Bb`)).toBe("ab");
    expect(sanitizeForTUI(`a${ESC}`)).toBe("a"); // ESC colgando
  });

  test("CSI incompleta al final se descarta sin colgarse", () => {
    expect(sanitizeForTUI(`texto${ESC}[`)).toBe("texto");
    expect(sanitizeForTUI(`texto${ESC}[31`)).toBe("texto");
  });

  test("controles C0 y C1 (incluido CSI de 8 bits) se eliminan", () => {
    expect(sanitizeForTUI("a\u0007b\u0008c\u000bd\u000ce")).toBe("abcde");
    expect(sanitizeForTUI("a\u009b2Jb")).toBe("ab");
    expect(sanitizeForTUI("a\u009d0;titulo\u0007b")).toBe("ab");
    expect(sanitizeForTUI("a\u009d0;sin-fin")).toBe("a");
    expect(sanitizeForTUI("\u0000\u001f")).toBe("");
  });

  test("\\r y \\r\\n se normalizan a salto de línea (no sobrescriben la línea)", () => {
    expect(sanitizeForTUI("a\rb")).toBe("a\nb");
    expect(sanitizeForTUI("a\r\nb")).toBe("a\nb");
    expect(sanitizeForTUI("\r")).toBe("\n");
  });

  test("SGR fuera de la lista blanca se descarta", () => {
    for (const params of ["38;5;196", "48;5;0", "7", "5", "8", "9", "41", "44", "38;2;1;2;3", "?25"]) {
      expect(sanitizeForTUI(`a${CSI(`${params}m`)}b`)).toBe("ab");
    }
  });
});

describe("sanitizeForTUI — conserva SGR básico", () => {
  test("reset, negrita, dim, subrayado, off y colores de texto", () => {
    for (const params of ["0", "1", "2", "4", "22", "24", "30", "31", "32", "33", "34", "35", "36", "37", "39", "90", "91", "92", "93", "94", "95", "96", "97", "1;4;31", "", "1;4;38"]) {
      if (params === "1;4;38") continue; // variante no permitida, cubierta abajo
      expect(sanitizeForTUI(`a${CSI(`${params}m`)}b`)).toBe(`a${CSI(`${params}m`)}b`);
    }
    expect(isAllowedSgr("")).toBe(true);
    expect(isAllowedSgr("1;4;31")).toBe(true);
    expect(isAllowedSgr("1;38")).toBe(false);
  });

  test("mezcla: se limpia el movimiento y sobrevive el color", () => {
    const input = `hola${CSI("2K")} mundo${CSI("32m")}verde${CSI("0m")}${CSI("10;1H")}fin`;
    expect(sanitizeForTUI(input)).toBe(`hola mundo${CSI("32m")}verde${CSI("0m")}fin`);
  });
});

describe("sanitizeForTUI — límites", () => {
  test("1 MB de entrada no cuelga y la salida no crece", () => {
    const big = `${"x".repeat(1_000_000)}${CSI("2J")}${ESC}]52;c;Zm9v${"\u0007"}`;
    const t0 = Date.now();
    const out = sanitizeForTUI(big);
    const elapsed = Date.now() - t0;
    expect(out.length).toBeLessThanOrEqual(big.length);
    expect(out.length).toBe(1_000_000);
    expect(elapsed).toBeLessThan(1000);
  });

  test("basura aleatoria: nunca lanza y siempre acota la longitud", () => {
    let seed = 123456789;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let i = 0; i < 200; i++) {
      let s = "";
      const len = rnd() % 64;
      for (let k = 0; k < len; k++) s += String.fromCharCode(rnd() % 0x120);
      const out = sanitizeForTUI(s);
      expect(out.length).toBeLessThanOrEqual(s.length);
      expect(out.includes("\u001b[2J")).toBe(false);
    }
  });
});

describe("cableado en los puntos de impresión", () => {
  const capture = async (fn: () => void): Promise<string> => {
    const chunks: string[] = [];
    const out = process.stdout.write, err = process.stderr.write;
    process.stdout.write = ((c: unknown) => { chunks.push(String(c)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown) => { chunks.push(String(c)); return true; }) as typeof process.stderr.write;
    try { fn(); } finally { process.stdout.write = out; process.stderr.write = err; }
    return chunks.join("");
  };

  test("FlatUi: texto del modelo y salida de tool se imprimen saneados", async () => {
    const { FlatUi } = await import("../src/ui/flat.js");
    const { EventBus } = await import("../src/core/events.js");
    const bus = new EventBus();
    new FlatUi({ auto: true }).attach(bus);
    const all = await capture(() => {
      bus.emit({ type: "text_delta", text: `hola${ESC}[2J mundo${CSI("31m")}rojo${CSI("0m")}` });
      bus.emit({ type: "tool_start", id: "t1", name: "bash", args: { command: `echo${ESC}]52;c;Zm9v${"\u0007"}` } });
      bus.emit({ type: "tool_end", id: "t1", name: "bash", output: `salida${ESC}[1;1Hfinal`, isError: false, durationMs: 3 });
    });
    expect(all).toContain(`hola mundo${CSI("31m")}rojo${CSI("0m")}`);
    expect(all).toContain("salidafinal");
    expect(all).not.toContain(CSI("2J"));
    expect(all).not.toContain(CSI("1;1H"));
    // en los argumentos, JSON.stringify ya escapa ESC; nunca debe quedar el byte real
    expect(all).not.toContain(`${ESC}]52`);
  });

  test("TuiApp: argumentos de tool_start y salida de tool quedan limpios en el frame", async () => {
    const { TuiApp } = await import("../src/ui/app.js");
    const { defaultThemes } = await import("../src/ui/theme.js");
    const { DEFAULT_KEYBINDS } = await import("../src/ui/tui-config.js");
    const app = new TuiApp({
      theme: defaultThemes[0],
      setTheme: () => {},
      tui: {
        theme: "nicotine-dark", leaderTimeout: 2000, keybinds: { ...DEFAULT_KEYBINDS },
        scrollSpeed: 3, diffStyle: "auto", mouse: false,
        cursor: { style: "block", blinking: false }, ui: { actionStream: true }, layers: [],
      },
      cwd: "/tmp/sanitize-test",
      themes: ["nicotine-dark"],
      commands: [],
      submit: () => {},
      abortTurn: () => {},
      cycleAgent: () => "build",
      newSession: () => ({ id: "s" }),
      switchSession: () => true,
      listSessions: () => [],
      fetchModels: async () => [],
      setModel: () => {},
      currentModel: () => "m",
      currentAgent: () => "build",
      currentSession: () => "s",
      exit: () => {},
    });
    app.toolStart("t1", "bash", { command: `echo${ESC}[2J` });
    app.toolEnd("t1", "bash", `linea${ESC}]52;c;Zm9v${"\u0007"}fin${CSI("31m")}ok`, false, 1);
    const frame = app.computeFrame(100, 30).join("\n");
    expect(frame).not.toContain(CSI("2J"));
    expect(frame).not.toContain("]52;");
    expect(frame).toContain("lineafin");
  });
});
