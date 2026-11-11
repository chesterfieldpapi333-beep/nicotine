// Análisis estático CONSERVADOR de comandos bash (no ejecuta nada).
// Marca lo destructivo para FORZAR un ask (nunca conceder allow implícito).
// Heurística deliberadamente simple sobre shell-scan; en duda → isDangerous.

import { shellSegments } from "../core/shell-scan.js";
import { basename } from "node:path";

export interface BashAnalysis { isDangerous: boolean; reason?: string }

const DESTRUCTIVE = new Set([
  "rm", "dd", "mkfs", "shred", "wipe", "fdisk", "parted", "mkswap", "chmod", "chown",
  "mkfs.ext4", "mkfs.xfs", "mkfs.btrfs", "sfdisk",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const DOWNLOADERS = new Set(["curl", "wget"]);
const WRAPPERS = new Set(["sudo", "doas", "command", "builtin", "env", "xargs", "nice", "ionice", "nohup", "time"]);
const REDIRECT_SENSITIVE = /(^|\s)(>>|>|&>|\|\s*(sudo\s+)?tee)\s*["']?(~?\/|\$HOME\/)?(\.ssh\b|\.aws\b|\.gnupg\b|etc\b|dev\/(sd|nvme|hd|mmcblk)|boot\b)/i;

/** Quita wrappers iniciales (sudo, env A=B, nice, …) y devuelve el comando real. */
function unwrap(tokens: string[]): { cmd: string; rest: string[] } {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "env") {
      i++;
      while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++; // assignments
      continue;
    }
    if (WRAPPERS.has(t)) { i++; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; } // VAR=valor suelto
    if (i > 0 && t.startsWith("-")) {
      i++;
      // flags con valor: nice -n 5, ionice -c 3, sudo -u root …
      if ((t === "-n" || t === "-s" || t === "-c" || t === "-t" || t === "-u" || t === "-g" || t === "--priority" || t === "--class" || t === "--user" || t === "--group") && i < tokens.length) i++;
      continue;
    }
    break;
  }
  return { cmd: i < tokens.length ? basename(tokens[i]) : "", rest: tokens.slice(i + 1) };
}

export function analyzeBashCommand(command: string): BashAnalysis {
  const t = String(command ?? "").trim();
  if (!t) return { isDangerous: false };

  // 1) Redirecciones a rutas sensibles (texto crudo; se evalúa antes de partir)
  const m = REDIRECT_SENSITIVE.exec(t);
  if (m) return { isDangerous: true, reason: `redirección a ruta sensible («${m[0].trim().slice(0, 60)}»)` };

  // 2) Segmentos de primer nivel (&&/||/;/|/salto de línea, respetando comillas)
  const segments = shellSegments(t);
  const cmds = segments.map((seg) => unwrap(seg.trim().split(/\s+/)).cmd);

  // 2a) Descargar + ejecutar shell: «curl … | sh», «wget … | sudo bash»
  for (let i = 0; i < segments.length - 1; i++) {
    if (DOWNLOADERS.has(cmds[i]) && SHELLS.has(cmds[i + 1])) {
      return { isDangerous: true, reason: `descarga directa a shell «${cmds[i]} | ${cmds[i + 1]}»` };
    }
  }
  // 2b) Shell interpretando sustitución de red: «bash -c "$(curl …)"», backticks
  for (const seg of segments) {
    const { cmd } = unwrap(seg.trim().split(/\s+/));
    if (SHELLS.has(cmd) && /(\$\(.*(curl|wget)|`[^`]*(curl|wget))/.test(seg)) {
      return { isDangerous: true, reason: "shell ejecutando sustitución de red ($(curl…) o backticks)" };
    }
  }
  // 2c) Comando directamente destructivo (tras quitar wrappers)
  for (let i = 0; i < segments.length; i++) {
    const { cmd } = unwrap(segments[i].trim().split(/\s+/));
    if (!cmd) continue;
    if (DESTRUCTIVE.has(cmd)) {
      if (cmd === "dd" && /of=\/dev\//i.test(segments[i])) return { isDangerous: true, reason: "«dd» escribiendo a dispositivo" };
      return { isDangerous: true, reason: `comando destructivo «${cmd}»` };
    }
  }
  return { isDangerous: false };
}
