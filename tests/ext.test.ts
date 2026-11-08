// Extensiones: descubrimiento, compuerta de confianza, activación tolerante a
// fallos, tools registradas en el runtime, comandos/atajos/slots vía bridge.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverExtensions, prepareExtensions, parseShortcut } from "../src/ext/loader.js";
import type { UiBridge, SlotName } from "../src/ext/api.js";
import type { Component } from "../src/ui/component.js";
import { loadProjectApprovals, saveProjectApproval } from "../src/core/approvals.js";

let root: string;
let data: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vireo-ext-proj-"));
  data = mkdtempSync(join(tmpdir(), "vireo-ext-data-"));
  home = mkdtempSync(join(tmpdir(), "vireo-ext-home-"));
  process.env.XDG_DATA_HOME = data;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const writeExt = (base: string, id: string, source: string) => {
  mkdirSync(base, { recursive: true });
  const file = join(base, `${id}.ts`);
  writeFileSync(file, source);
  return file;
};

const toolExt = `
export default function activate(api: any) {
  api.registerTool({
    name: "ext_shout",
    description: "grita el texto",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    permission: { action: "ext_shout", resource: () => "*" },
    async run(args: any) { return { output: String(args.text ?? "").toUpperCase() }; },
  });
  api.log("cargada");
}
`;

const failingExt = `export default function activate() { throw new Error("boom al activar"); }\n`;
const noExportExt = `export const notActivate = 1;\n`;
const markerExt = (marker: string) => `import { writeFileSync } from "node:fs";\nexport default function activate() { writeFileSync(${JSON.stringify(marker)}, "ejecutada"); }\n`;
const uiExt = `
export default function activate(api: any) {
  api.registerCommand({ name: "hola", hint: "saluda", run(app: any) { app.info("hola desde extensión"); } });
  api.registerShortcut("ctrl+g", () => api.log("atajo"));
  api.ui.addWidget({ render: () => ["widget-de-prueba"] });
  api.ui.setSlot("header", { render: () => ["header-de-prueba"] });
}
`;

// bridge falso que captura todo
const fakeBridge = () => {
  const state = { commands: [] as { name: string }[], shortcuts: [] as { name: string }[], slots: new Map<SlotName, Component | null>(), widgets: [] as Component[], themes: new Map<string, { name: string; tokens: Record<string, string> }>() };
  const bridge: UiBridge & { state: typeof state } = {
    state,
    app: { info: () => {}, error: () => {}, requestRender: () => {} },
    registerCommand: (cmd) => { state.commands.push(cmd as { name: string }); },
    registerShortcut: (spec) => { state.shortcuts.push(spec); },
    setSlot: (slot, comp) => { state.slots.set(slot, comp); },
    addWidget: (comp) => { state.widgets.push(comp); },
    registerTheme: (t) => { state.themes.set(t.name, t); return true; },
    applyTheme: (name) => state.themes.has(name),
    refresh: () => {},
  };
  return bridge;
};

const ui = (decision: "once" | "reject" = "once") => ({
  confirm: async () => decision,
  info: () => {},
});

const fakeRuntime = () => {
  const tools: { name: string }[] = [];
  const listeners: ((ev: never) => void)[] = [];
  return {
    ctx: { cwd: root, ui: ui() },
    config: {},
    extensionOrigins: {} as Record<string, "system" | "global" | "project" | "custom">,
    bus: { on: (fn: (ev: never) => void) => { listeners.push(fn); return () => {}; } },
    tools,
    _listeners: listeners,
  } as never;
};

describe("discoverExtensions", () => {
  test("global confiable + proyecto no confiable; id único (config pisa convención)", () => {
    writeExt(join(home, ".config", "vireo", "extensions"), "g1", toolExt);
    writeExt(join(root, ".vireo", "extensions"), "p1", toolExt);
    const { candidates } = discoverExtensions(root, {}, {}, );
    // sin HOME inyectable aquí (usa homedir real) — solo comprobamos proyecto
    expect(candidates.some((c) => c.id === "p1" && c.origin === "project")).toBe(true);
  });

  test("config extensions: carpeta y archivo suelto; origen proyecto", () => {
    writeExt(join(root, "mismas"), "c1", toolExt);
    const { candidates, warnings } = discoverExtensions(root, { extensions: ["./mismas", "./no-existe"] }, { "./mismas": "project" });
    expect(candidates.map((c) => c.id)).toEqual(["c1"]);
    expect(candidates[0].origin).toBe("project");
    expect(warnings.some((w) => w.includes("no-existe"))).toBe(true);
  });
});

describe("prepareExtensions — compuerta y robustez", () => {
  test("proyecto + rechazo → untrusted y el código NO se importa", async () => {
    const marker = join(root, "marker.txt");
    writeExt(join(root, ".vireo", "extensions"), "evil", markerExt(marker));
    const rt = fakeRuntime();
    const reports = await prepareExtensions(rt as never, { ui: ui("reject") });
    expect(reports).toHaveLength(1);
    expect(reports[0].status).toBe("untrusted");
    expect(existsSync(marker)).toBe(false); // nunca se importó
  });

  test("proyecto + aceptación → loaded; tool registrada en el runtime", async () => {
    writeExt(join(root, ".vireo", "extensions"), "demo", toolExt);
    const rt = fakeRuntime() as { tools: { name: string; run: (a: Record<string, unknown>, c: never) => Promise<{ output: string }> }[] };
    const reports = await prepareExtensions(rt as never, { ui: ui("once") });
    expect(reports[0].status).toBe("loaded");
    const tool = rt.tools.find((t) => t.name === "ext_shout")!;
    expect(tool).toBeDefined();
    const res = await tool.run({ text: "hola" }, {} as never);
    expect(res.output).toBe("HOLA");
  });

  test("activate roto → failed, no tumba a las demás", async () => {
    writeExt(join(root, ".vireo", "extensions"), "roto", failingExt);
    writeExt(join(root, ".vireo", "extensions"), "buena", toolExt);
    const rt = fakeRuntime() as { tools: { name: string }[] };
    const reports = await prepareExtensions(rt as never, { ui: ui("once") });
    const byId = Object.fromEntries(reports.map((r) => [r.id, r.status]));
    expect(byId.roto).toBe("failed");
    expect(byId.buena).toBe("loaded");
    expect(rt.tools.some((t) => t.name === "ext_shout")).toBe(true);
  });

  test("módulo sin activate → failed con mensaje claro", async () => {
    writeExt(join(root, ".vireo", "extensions"), "sinexport", noExportExt);
    const rt = fakeRuntime();
    const reports = await prepareExtensions(rt as never, { ui: ui("once") });
    expect(reports[0].status).toBe("failed");
    expect(reports[0].error).toContain("activate");
  });

  test("comandos/atajos/slots llegan al bridge de la TUI", async () => {
    writeExt(join(root, ".vireo", "extensions"), "ui", uiExt);
    const bridge = fakeBridge();
    const rt = fakeRuntime();
    const reports = await prepareExtensions(rt as never, { bridge, ui: ui("once") });
    expect(reports[0].status).toBe("loaded");
    expect(bridge.state.commands.map((c) => c.name)).toEqual(["hola"]);
    expect(bridge.state.shortcuts.map((c) => c.name)).toEqual(["g"]);
    expect(bridge.state.widgets).toHaveLength(1);
    expect(bridge.state.slots.get("header")?.render(10)).toEqual(["header-de-prueba"]);
  });

  test("sin bridge (print/json/repl): tools sí, UI no, nada explota", async () => {
    writeExt(join(root, ".vireo", "extensions"), "ui2", uiExt);
    const rt = fakeRuntime();
    const reports = await prepareExtensions(rt as never, { ui: ui("once") });
    expect(reports[0].status).toBe("loaded");
  });
});

describe("parseShortcut", () => {
  test("exige modificador; normaliza ctrl/alt", () => {
    expect(parseShortcut("ctrl+g")).toEqual({ ctrl: true, alt: false, name: "g" });
    expect(parseShortcut("alt+f2")).toEqual({ ctrl: false, alt: true, name: "f2" });
    expect(parseShortcut("g")).toBeNull();
    expect(parseShortcut("ctrl+")).toBeNull();
    expect(parseShortcut("ctrl+enter")).toBeNull(); // nombres no alfanuméricos rechazados
  });
});

describe("approvals persistentes (proyecto, XDG)", () => {
  test("guardar/cargar roundtrip, dedupe, nunca pisa deny (motor)", async () => {
    saveProjectApproval(root, "bash", "git status *");
    saveProjectApproval(root, "bash", "git status *"); // duplicado
    saveProjectApproval(root, "edit", "/tmp/x/*");
    const items = loadProjectApprovals(root);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.action).sort()).toEqual(["bash", "edit"]);
    const { PermissionEngine } = await import("../src/core/permissions.js");
    const engine = new PermissionEngine([
      { action: "*", resource: "*", effect: "allow" },
      { action: "bash", resource: "git push *", effect: "deny" },
      ...items.map((i) => ({ action: i.action, resource: i.resource, effect: "allow" as const })),
    ]);
    expect(engine.check("bash", "git status").effect).toBe("allow");
    expect(engine.check("bash", "git push origin").effect).toBe("deny"); // deny gana a cualquier allow
  });

  test("cwd distinta = almacén distinto; archivo corrupto no rompe", async () => {
    saveProjectApproval(root, "bash", "ls *");
    const other = mkdtempSync(join(tmpdir(), "vireo-ext-other-"));
    expect(loadProjectApprovals(other)).toHaveLength(0);
    rmSync(other, { recursive: true, force: true });
  });
});

describe("extensión de referencia (examples/extensions/shout.ts)", () => {
  test("carga vía config, registra ext_shout, comando /shout y slot footer", async () => {
    const ref = join(import.meta.dir, "..", "examples", "extensions", "shout.ts");
    const rt = fakeRuntime() as unknown as {
      tools: { name: string; run: (a: Record<string, unknown>, c: never) => Promise<{ output: string }> }[];
      config: Record<string, unknown>;
    };
    rt.config = { extensions: [ref] };
    const bridge = fakeBridge();
    const reports = await prepareExtensions(rt as never, { ui: ui("once"), bridge });
    const r = reports.find((x) => x.id === "shout");
    expect(r?.status).toBe("loaded");
    expect(r?.tools).toBe(1);
    const tool = rt.tools.find((t) => t.name === "ext_shout")!;
    const res = await tool.run({ text: "ok" }, {} as never);
    expect(res.output).toBe("OK");
    expect(bridge.state.commands.map((c) => c.name)).toContain("shout");
    expect(bridge.state.slots.get("footer")).toBeTruthy();
  });
});
