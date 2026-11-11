// SBOM simple desde bun.lock (solo lectura; sin red). Salida JSON a stdout.
import { readFileSync } from "node:fs";
import { parseJsonc } from "../src/util/jsonc.js";

const lock = parseJsonc<{ lockfileVersion?: number; packages?: Record<string, unknown[]> }>(readFileSync("bun.lock", "utf8"), "bun.lock");
const packages: { name: string; version: string; integrity: string | null }[] = [];
for (const [name, entry] of Object.entries(lock.packages ?? {})) {
  if (!Array.isArray(entry)) continue;
  const spec = entry[0] as string; // "name@version"
  const integrity = typeof entry[entry.length - 1] === "string" ? (entry[entry.length - 1] as string) : null;
  const at = spec.lastIndexOf("@");
  packages.push({ name, version: at > 0 ? spec.slice(at + 1) : spec, integrity });
}
packages.sort((a, b) => a.name.localeCompare(b.name));
process.stdout.write(JSON.stringify({ name: "nicotine", lockfileVersion: lock.lockfileVersion ?? null, packageManager: "bun", packages }, null, 2) + "\n");
