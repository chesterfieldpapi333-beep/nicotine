/** Versión del paquete, leída de package.json en runtime (única fuente de verdad). */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown"; // nunca lanzar por no poder leer la propia versión
  }
}

export const VERSION = readVersion();
