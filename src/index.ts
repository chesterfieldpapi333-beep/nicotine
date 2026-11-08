// vireo — entry point y parser de argumentos (sin dependencias).

import { stdin, stdout, stderr } from "node:process";
import { runPrint } from "./modes/print.js";
import { runJson } from "./modes/json.js";
import { runRepl } from "./modes/repl.js";
import { runTui } from "./modes/tui.js";
import { runDoctor } from "./modes/doctor.js";

const VERSION = "0.1.0";

const HELP = `vireo — agente de código CLI ligero (lite)

Uso:
  vireo [opciones] [prompt...]     TUI en terminal (ANSI/OpenTUI); REPL plano sin TTY
  vireo --print [opciones] [prompt]  un turno; respuesta a stdout
  vireo --json  [opciones] [prompt]  eventos JSONL a stdout
  vireo doctor [opciones]            diagnóstico

Opciones:
  -p, --print        modo no interactivo (un turno)
      --json         eventos como JSONL
  -m, --model <id>   modelo (p. ej. openai/gpt-4o-mini); [proveedor/]modelo
      --agent <id>   agente built-in: build | plan
      --auto         auto-aprueba lo que pregunte (deny sigue denegado)
  -c, --continue     reanuda la última sesión
  -s, --session <id> reanuda una sesión concreta
      --config-dir <dir>  capa extra de configuración (menor precedencia que el proyecto)
  -h, --help         ayuda
      --version      versión

Entorno:
  VIREO_UI_ENGINE    motor de TUI: opentui (defecto) | ansi (fallback propio)
  VIREO_TUI_CONFIG   ruta alternativa a tui.json(c)
  VIREO_MODEL        modelo por defecto

Si stdin no es un TTY, su contenido se añade al prompt entre <stdin>…</stdin>.
Config: opencode.json(c) — capas: /etc/opencode < ~/.config/opencode < proyecto
(raíz→cwd) < .opencode/ < --config-dir. Permisos: allow/ask/deny por acción y
patrón (objeto "permission" v1 o array "permissions" v2).
`;

interface Args {
  command?: string;
  print: boolean;
  json: boolean;
  auto: boolean;
  model?: string;
  agent?: string;
  sessionId?: string;
  continueLatest: boolean;
  configDir?: string;
  help: boolean;
  version: boolean;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { print: false, json: false, auto: false, continueLatest: false, help: false, version: false, positional: [] };
  const next = (i: number, flag: string) => {
    if (i + 1 >= argv.length) throw new Error(`falta valor para ${flag}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--print": case "-p": args.print = true; break;
      case "--json": args.json = true; break;
      case "--auto": args.auto = true; break;
      case "--model": case "-m": args.model = next(i, a); i++; break;
      case "--agent": args.agent = next(i, a); i++; break;
      case "--session": case "-s": args.sessionId = next(i, a); i++; break;
      case "--continue": case "-c": args.continueLatest = true; break;
      case "--config-dir": args.configDir = next(i, a); i++; break;
      case "--help": case "-h": args.help = true; break;
      case "--version": args.version = true; break;
      case "doctor": case "serve":
        if (!args.command) { args.command = a; break; }
        args.positional.push(a); break;
      case "--": args.positional.push(...argv.slice(i + 1)); i = argv.length; break;
      default:
        if (a.startsWith("-") && a !== "-") throw new Error(`flag desconocido: ${a} (usa --help)`);
        args.positional.push(a);
    }
  }
  return args;
}

async function readStdinIfPiped(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stdin as AsyncIterable<Buffer>) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    stderr.write(`vireo: ${(err as Error).message}\n`);
    return 2;
  }
  if (args.version) { stdout.write(`vireo ${VERSION}\n`); return 0; }
  if (args.help) { stdout.write(HELP); return 0; }

  const cwd = process.cwd();

  if (args.command === "doctor") {
    return runDoctor({ cwd, configDir: args.configDir, agentId: args.agent, modelFlag: args.model });
  }
  if (args.command === "serve") {
    stderr.write("vireo serve llega en una fase posterior (HTTP opcional, apagado por defecto).\n");
    return 2;
  }

  const stdinText = await readStdinIfPiped();
  const promptBase = args.positional.join(" ").trim();
  const prompt = stdinText ? (promptBase ? `${promptBase}\n\n<stdin>\n${stdinText}\n</stdin>` : stdinText) : promptBase;

  // Ctrl+C: aborta el turno en curso (el loop y bash escuchan esta señal)
  const abort = new AbortController();
  process.on("SIGINT", () => abort.abort());

  const base = { cwd, configDir: args.configDir, auto: args.auto, agentId: args.agent, modelFlag: args.model, sessionId: args.sessionId, continueLatest: args.continueLatest, signal: abort.signal };

  try {
    if (args.json) {
      if (!prompt) { stderr.write("vireo --json requiere un prompt (argumento o stdin).\n"); return 2; }
      return await runJson({ ...base, prompt });
    }
    if (args.print) {
      if (!prompt) { stderr.write("vireo --print requiere un prompt (argumento o stdin).\n"); return 2; }
      return await runPrint({ ...base, prompt });
    }
    if (prompt) return await runPrint({ ...base, prompt }); // prompt directo = un turno
    if (stdout.isTTY && stdin.isTTY) return await runTui({ ...base }); // TUI interactiva
    return await runRepl(base);
  } catch (err) {
    stderr.write(`vireo: ${(err as Error).message}\n`);
    return 1;
  }
}

main().then((code) => process.exit(code));
