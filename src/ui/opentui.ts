// Motor OpenTUI (primer engine). Un TextRenderable precargado por fila de la
// pantalla; el frame ANSI de los componentes se parsea a StyledText por línea.
// El motor ANSI propio (ansi.ts) hace exactamente lo mismo si este falla.

import type { TuiApp } from "./app.js";
import { parseAnsiLine } from "./ansi-parse.js";
import type { UiEngine } from "./ansi.js";

// TextAttributes (verificado en @opentui/core 0.8.3, TextAttributes bits)
const ATTR = { BOLD: 1 << 0, DIM: 1 << 1, INVERSE: 1 << 5 } as const;

interface MountResult {
  flush(): Promise<void>;
  detach(): void;
}

/** Monta el frame ANSI de `app` sobre un renderer OpenTUI ya creado.
 *  Exportado para el smoke test headless (createTestRenderer). */
export async function mountOpenTui(app: TuiApp, renderer: import("@opentui/core").CliRenderer): Promise<MountResult> {
  const core = await import("@opentui/core");
  const { RGBA, StyledText, TextRenderable } = core;
  let rows: import("@opentui/core").TextRenderable[] = [];
  let flushing = false;
  let pendingAgain = false;
  let detached = false;

  const flush = async () => {
    if (detached) return;
    if (flushing) { pendingAgain = true; return; }
    flushing = true;
    try {
      const w = renderer.width, h = renderer.height;
      while (rows.length < h) {
        const t = new TextRenderable(renderer, {
          content: "", height: 1, width: "100%",
          onMouseScroll: (event) => {
            const sc = event.scroll;
            if (!sc) return;
            const lines = Math.max(1, Math.min(4, Math.round(Math.abs(sc.delta) || 1))) * app.deps.tui.scrollSpeed;
            if (sc.direction === "up") app.scrollLines(lines);
            else if (sc.direction === "down") app.scrollLines(-lines);
          },
        });
        renderer.root.add(t);
        rows.push(t);
      }
      rows.forEach((r, i) => { r.visible = i < h; });
      const frame = app.computeFrame(w, h);
      for (let i = 0; i < h; i++) {
        const row = rows[i];
        const line = frame[i] ?? "";
        const spans = parseAnsiLine(line);
        if (spans.length === 0) { row.content = ""; continue; }
        const chunks = spans.map((s) => {
          const chunk: { __isChunk: true; text: string; fg?: InstanceType<typeof RGBA>; attributes?: number } = { __isChunk: true, text: s.text };
          if (s.fg) chunk.fg = RGBA.fromHex(s.fg);
          let attrs = 0;
          if (s.bold) attrs |= ATTR.BOLD;
          if (s.dim) attrs |= ATTR.DIM;
          if (s.inverse) attrs |= ATTR.INVERSE;
          if (attrs) chunk.attributes = attrs;
          return chunk;
        });
        row.content = new StyledText(chunks as never[]);
      }
      const c = app.cursor;
      renderer.setCursorPosition(c.col, c.row, c.row >= 0);
      renderer.requestRender();
    } finally {
      flushing = false;
      if (pendingAgain && !detached) { pendingAgain = false; void flush(); }
    }
  };

  renderer.keyInput.on("keypress", (key) => {
    if (key.eventType === "release") return;
    app.handleKey({
      name: key.name,
      ctrl: key.ctrl,
      meta: key.meta || key.option,
      shift: key.shift,
      sequence: key.sequence ?? "",
    });
  });
  renderer.on("resize", () => { void flush(); });
  app.requestRender = () => { void flush(); };
  await flush();

  return {
    flush,
    detach: () => { detached = true; },
  };
}

export function createOpenTuiEngine(app: TuiApp): UiEngine {
  let renderer: import("@opentui/core").CliRenderer | null = null;
  let stopped = false;
  let resolveDone: () => void = () => {};

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    const r = renderer;
    renderer = null;
    r?.destroy(); // restaura la terminal (alt screen, cursor)
    resolveDone();
  };

  return {
    async start(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        void (async () => {
          const core = await import("@opentui/core");
          const bg = app.deps.theme.tokens["bg"];
          renderer = await core.createCliRenderer({
            screenMode: "alternate-screen",
            exitOnCtrlC: false,
            useMouse: app.deps.tui.mouse,
            targetFps: 30,
            backgroundColor: bg ?? "#1a1a1a",
          });
          await mountOpenTui(app, renderer);
        })().catch(reject);
      });
    },
    stop(): void { cleanup(); },
    async withSuspendedUI<T>(fn: () => Promise<T>): Promise<T> {
      const r = renderer;
      if (!r) throw new Error("motor OpenTUI no iniciado");
      try {
        await r.suspend(); // sale de alt screen / raw mode y restaura la terminal
        return await fn();
      } finally {
        await r.resume().catch(() => {}); // el contenido del buffer se re-renderiza solo
      }
    },
  };
}
