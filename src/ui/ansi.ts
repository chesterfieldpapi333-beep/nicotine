// Motor ANSI propio: mínimo, sin dependencias. El fallback cuando OpenTUI falla
// (terminales raras, tmux antiguo, CI). Pasa los escapes SGR de los componentes
// tal cual; el frame entero se repinta por línea con erase-to-EOL (sin parpadeo).

import type { TuiApp } from "./app.js";
import type { KeyEventLike } from "./key.js";

export interface UiEngine {
  /** Arranca y resuelve al terminar (app.deps.exit()). */
  start(): Promise<void>;
  /** Termina el engine y restaura la terminal. */
  stop(): void;
  /**
   * Suspende la UI, cede la terminal al editor externo ($EDITOR/$VISUAL) y
   * restaura la TUI al salir. v1: usado por /editor y /export.
   */
  withSuspendedUI?<T>(fn: () => Promise<T>): Promise<T>;
}

export function createAnsiEngine(app: TuiApp): UiEngine {
  const stdin = process.stdin;
  const stdout = process.stdout;
  let stopped = false;
  let frameQueued = false;
  let resolveDone: () => void = () => {};

  const cols = () => stdout.columns || 80;
  const rows = () => stdout.rows || 24;

  const flush = () => {
    if (stopped) return;
    const w = cols(), h = rows();
    const frame = app.computeFrame(w, h);
    let out = "\x1b[H"; // cursor home
    for (let i = 0; i < frame.length; i++) {
      out += frame[i] + "\x1b[K"; // pintar + borrar resto de línea
      if (i < frame.length - 1) out += "\n";
    }
    out += "\x1b[0J"; // borrar de aquí al final (si la ventana creció)
    const c = app.cursor;
    out += c.row >= 0 ? `\x1b[${c.row + 1};${c.col + 1}H\x1b[?25h` : "\x1b[?25l";
    stdout.write(out);
  };

  const scheduleFlush = () => {
    if (frameQueued || stopped) return;
    frameQueued = true;
    setImmediate(() => { frameQueued = false; flush(); });
  };

  const onData = (buf: Buffer) => {
    for (const key of decodeAnsiKeys(buf)) app.handleKey(key); // handleKey → app.requestRender
  };
  const onResize = () => scheduleFlush();

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    stdout.write("\x1b[?25h\x1b[?1049l"); // cursor visible + salir de alt screen
    try { stdin.setRawMode?.(false); } catch { /* no TTY */ }
    stdin.removeListener("data", onData);
    stdout.removeListener("resize", onResize);
    stdin.pause();
    resolveDone();
  };

  const withSuspendedUI = async <T>(fn: () => Promise<T>): Promise<T> => {
    // salir de alt screen, cursor visible, raw off, sin listeners de stdin
    stdout.write("\x1b[?25h\x1b[?1049l");
    try { stdin.setRawMode?.(false); } catch { /* no TTY */ }
    stdin.pause();
    stdin.removeListener("data", onData);
    try {
      return await fn();
    } finally {
      stdin.on("data", onData);
      try { stdin.setRawMode?.(true); } catch { /* no TTY */ }
      stdin.resume();
      stdout.write("\x1b[?1049h\x1b[?25l"); // alt screen + cursor oculto
      flush();
    }
  };

  return {
    start(): Promise<void> {
      return new Promise<void>((resolve) => {
        resolveDone = resolve;
        app.requestRender = scheduleFlush;
        stdout.write("\x1b[?1049h\x1b[?25l"); // alt screen + cursor oculto
        try { stdin.setRawMode?.(true); } catch { /* stdin no es TTY (pipe): los keys no llegarán */ }
        stdin.resume();
        stdin.on("data", onData);
        stdout.on("resize", onResize);
        flush();
      });
    },
    stop(): void { cleanup(); },
    withSuspendedUI,
  };
}

/** Decodifica un chunk de stdin a teclas normalizadas. Exportado para tests. */
export function decodeAnsiKeys(buf: Buffer): KeyEventLike[] {
  const s = buf.toString("utf8");
  const keys: KeyEventLike[] = [];
  const key = (name: string, ctrl = false, shift = false, meta = false, sequence = ""): KeyEventLike =>
    ({ name, ctrl, shift, meta, sequence });
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    // Alt+Enter llega como ESC CR (sin protocolo kitty): meta+return
    if (s.startsWith("\x1b\r", i) || s.startsWith("\x1b\n", i)) { keys.push(key("return", false, false, true, "\x1b\r")); i += 2; continue; }
    if (ch === "\x1b") {
      if (s.startsWith("\x1b[", i)) {
        let j = i + 2;
        while (j < s.length && !/[@-~]/.test(s[j])) j++;
        keys.push(decodeCsi(s.slice(i + 2, j + 1)));
        i = j + 1;
        continue;
      }
      if (s.startsWith("\x1bO", i)) {
        const code = s[i + 2] ?? "";
        keys.push(key({ A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" }[code] ?? "unknown"));
        i += 3;
        continue;
      }
      keys.push(key("escape", false, false, false, "\x1b"));
      i += 1;
      continue;
    }
    const code = ch.codePointAt(0)!;
    if (code < 32 || ch === "\x7f") {
      if (ch === "\r") keys.push(key("return", false, false, false, "\r"));
      else if (ch === "\n") keys.push(key("j", true, false, false, "\n")); // Ctrl+J
      else if (ch === "\t") keys.push(key("tab", false, false, false, "\t"));
      else if (ch === "\x7f") keys.push(key("backspace", false, false, false, "\x7f"));
      else { const letter = String.fromCharCode(code + 96); if (letter >= "a" && letter <= "z") keys.push(key(letter, true, false, false, ch)); }
      i += 1;
      continue;
    }
    // run imprimible (UTF-8 multibyte incluido, ya decodificado)
    let j = i, text = "";
    while (j < s.length) {
      const c = s[j];
      if (c === "\x1b" || (c.codePointAt(0) ?? 32) < 32 || c === "\x7f") break;
      text += c;
      j++;
    }
    if (text) {
      const single = [...text].length === 1;
      keys.push(key(text, false, single && text >= "A" && text <= "Z", false, text));
      i = j;
    }
  }
  return keys;
}

function decodeCsi(seq: string): KeyEventLike {
  const key = (name: string, ctrl = false, shift = false, meta = false): KeyEventLike => ({ name, ctrl, shift, meta, sequence: "\x1b[" + seq });
  const plain: Record<string, string> = {
    A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "tab",
  };
  if (seq === "Z") return key("tab", false, true);
  if (seq === "3~") return key("delete");
  if (seq === "5~") return key("pageup");
  if (seq === "6~") return key("pagedown");
  if (seq === "1~" || seq === "7~" || seq === "H") return key("home");
  if (seq === "4~" || seq === "8~" || seq === "F") return key("end");
  if (plain[seq]) return key(plain[seq]);
  // con modificadores: 1;<mod><letra> — mod bits: 2 shift, 3 alt, 5 ctrl, combos sum+1
  const mm = /^1;(\d+)([A-Za-z])$/.exec(seq);
  if (mm) {
    const mod = Number(mm[1]);
    const shift = ((mod - 1) & 1) !== 0;
    const meta = ((mod - 1) & 2) !== 0;
    const ctrl = ((mod - 1) & 4) !== 0;
    return key(plain[mm[2]] ?? "unknown", ctrl, shift, meta);
  }
  return key("unknown");
}
