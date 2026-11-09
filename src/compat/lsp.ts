// Cliente LSP mínimo, CERO dependencias (JSON-RPC 2.0 con encuadre
// «Content-Length» sobre stdio del servidor indicado por el usuario).
//
// Alcance honesto (v1 experimental): SOLO «diagnostics» para UN archivo.
// Sin completion/hover/rename/executeCommand. Los servidores LSP los pone el
// usuario en la config (`lsp:`); vireo no empaqueta ninguno.
//
//   "lsp": {
//     "typescript": {
//       "command": "typescript-language-server",
//       "args": ["--stdio"],
//       "extensions": [".ts", ".tsx", ".js", ".jsx"],
//       "rootMarkers": ["tsconfig.json", "package.json"]
//     }
//   }
//
// Terceros: vireo no ejecuta código embebido en configs ajenas — `command`
// ES el servidor, lanzado con stdio heredado y sin login. El contenido de los
// archivos abiertos viaja por el pipe (como en editores normales).

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { extname, join } from "node:path";
import { existsSync } from "node:fs";

export interface LspServerDef {
  name: string;
  command: string[];
  extensions: string[];
  rootMarkers: string[];
}

export interface LspDiagnostic {
  line: number;      // 1-based
  character: number; // 1-based
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
  code?: string;
}

const SEVERITY: Record<number, LspDiagnostic["severity"]> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };
const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact",
  ".mjs": "javascript", ".cjs": "javascript", ".mts": "typescript", ".cts": "typescript",
  ".py": "python", ".rs": "rust", ".go": "go", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp",
  ".json": "json", ".md": "markdown", ".yaml": "yaml", ".yml": "yaml", ".html": "html", ".css": "css",
};

/** Lee `lsp:` de la config → defs + avisos. Nunca lanza. */
export function lspServersFromConfig(config: Record<string, unknown>): { defs: LspServerDef[]; warnings: string[] } {
  const raw = config["lsp"];
  const warnings: string[] = [];
  if (raw === undefined || raw === null) return { defs: [], warnings };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { defs: [], warnings: ["lsp: se espera un objeto «nombre → servidor»; ignorado"] };
  }
  const defs: LspServerDef[] = [];
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) { warnings.push(`lsp.${name}: definición no-objeto; ignorada`); continue; }
    const obj = v as Record<string, unknown>;
    const commandRaw = obj["command"];
    const argsRaw = obj["args"];
    let command: string[] = [];
    if (Array.isArray(commandRaw)) command = commandRaw.map(String).filter((x) => x.trim());
    else if (typeof commandRaw === "string" && commandRaw.trim()) {
      command = [commandRaw, ...(Array.isArray(argsRaw) ? argsRaw.map(String) : [])];
    }
    if (command.length === 0) { warnings.push(`lsp.${name}: falta «command» (string o array); ignorado`); continue; }
    const extRaw = obj["extensions"];
    const extensions = (Array.isArray(extRaw) ? extRaw.map(String) : []).map((e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`));
    if (!extensions.length) { warnings.push(`lsp.${name}: falta «extensions» (ej. [".ts"]); ignorado`); continue; }
    const markersRaw = obj["rootMarkers"];
    const rootMarkers = (Array.isArray(markersRaw) ? markersRaw.map(String) : []).filter(Boolean);
    defs.push({ name, command, extensions, rootMarkers });
  }
  return { defs, warnings };
}

/** Ruta del proyecto (root): donde existe un rootMarker, buscando hacia arriba desde cwd. */
export function findRoot(def: LspServerDef, cwd: string): string {
  if (!def.rootMarkers.length) return cwd;
  let dir = cwd;
  for (let i = 0; i < 12; i++) {
    if (def.rootMarkers.some((m) => existsSync(join(dir, m)))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

export function languageIdFor(filePath: string): string {
  return LANGUAGE_BY_EXT[extname(filePath).toLowerCase()] ?? "plaintext";
}

interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

class LspSession {
  private child: ChildProcess | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private diagnosticsHandler: ((uri: string, diags: LspDiagnostic[]) => void) | null = null;

  constructor(private def: LspServerDef, private cwd: string) {}

  onDiagnostics(fn: (uri: string, diags: LspDiagnostic[]) => void): void { this.diagnosticsHandler = fn; }

  async start(): Promise<void> {
    const def = this.def;
    this.child = spawn(def.command[0], def.command.slice(1), { cwd: this.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout!.on("data", (c: Buffer) => this.onData(c));
    this.child.stderr?.on("data", () => { /* diagnósticos del propio servidor: no tocar */ });
    await new Promise<void>((resolve, reject) => {
      this.child!.once("error", (err) => reject(new Error(`no se pudo lanzar LSP «${def.name}» (${def.command[0]}): ${(err as Error).message}`)));
      this.child!.once("spawn", () => resolve());
    });
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buf.subarray(0, headerEnd).toString("latin1");
      const m = /content-length:\s*(\d+)/i.exec(header);
      const len = m ? Number(m[1]) : 0;
      if (this.buf.length < headerEnd + 4 + len) return;
      const body = this.buf.subarray(headerEnd + 4, headerEnd + 4 + len).toString("utf8");
      this.buf = this.buf.subarray(headerEnd + 4 + len);
      let msg: JsonRpcMessage;
      try { msg = JSON.parse(body) as JsonRpcMessage; } catch { continue; }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (typeof msg.id === "number" && (msg.result !== undefined || msg.error)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message ?? "error LSP"} (code ${msg.error.code ?? "?"})`));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics" && this.diagnosticsHandler) {
      const params = msg.params as { uri?: string; diagnostics?: { range?: { start?: { line?: number; character?: number } }; severity?: number; message?: string; source?: string; code?: string | number }[] } | undefined;
      if (!params?.uri) return;
      const diags: LspDiagnostic[] = (params.diagnostics ?? []).map((d) => ({
        line: (d.range?.start?.line ?? 0) + 1,
        character: (d.range?.start?.character ?? 0) + 1,
        severity: SEVERITY[d.severity ?? 3] ?? "info",
        message: d.message ?? "",
        source: d.source,
        code: d.code !== undefined ? String(d.code) : undefined,
      }));
      this.diagnosticsHandler(params.uri, diags);
    }
  }

  send(method: string, params: unknown): void {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.writeFrame(body);
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout (${timeoutMs}ms) en ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.writeFrame(body);
    });
  }

  private writeFrame(body: string): void {
    this.child?.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, () => { /* cerrado: los pending resolverán por exit/timeout */ });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await this.request("shutdown", null, 1500).catch(() => {});
    this.send("exit", null);
    this.child = null;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1000);
      child.once("exit", () => { clearTimeout(t); resolve(); });
    });
  }
}

export interface DiagnosticsResult {
  server: string;
  diagnostics: LspDiagnostic[];
  /** Nota informativa («sin diagnósticos publicados en 10s», etc.). */
  note?: string;
}

/**
 * Diagnósticos de UN archivo vía el servidor LSP cuyo «extensions» casa.
 * Nunca lanza: errores → thrown Error, los envuelve el llamador.
 */
export async function diagnosticsFor(def: LspServerDef, absPath: string, cwd: string, timeoutMs = 10000): Promise<DiagnosticsResult> {
  const session = new LspSession(def, findRoot(def, cwd));
  const uri = pathToFileURL(absPath).href;
  let latest: LspDiagnostic[] | null = null;
  session.onDiagnostics((gotUri, diags) => { if (gotUri === uri) latest = diags; });
  try {
    await session.start();
    await session.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(findRoot(def, cwd)).href,
      capabilities: { textDocument: { publishDiagnostics: {} } },
      clientInfo: { name: "vireo", version: "0.1.0" },
    }, Math.min(timeoutMs, 8000));
    session.send("initialized", {});
    const text = readFileSync(absPath, "utf8");
    session.send("textDocument/didOpen", { textDocument: { uri, languageId: languageIdFor(absPath), version: 1, text } });
    // Espera: primer publishDiagnostics, o silencio hasta timeoutMs
    const deadline = Date.now() + timeoutMs;
    while (latest === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (latest === null) return { server: def.name, diagnostics: [], note: `el servidor no publicó diagnósticos en ${timeoutMs}ms (¿archivo vacío o sin errores detectables?)` };
    // pequeño reposo para que un segundo publish (LSP lento) actualice el resultado
    await new Promise((r) => setTimeout(r, 250));
    return { server: def.name, diagnostics: latest };
  } finally {
    await session.close();
  }
}

/** Nombre de archivo sugerido para tests/documentación. */
export function lspSummary(def: LspServerDef): string {
  return `${def.name} (${def.command[0]}; ext: ${def.extensions.join(",")})`;
}
