// Migración única vireo → nicotine (fase 10f, 2026-11).
// Si el directorio de datos legacy ($XDG_DATA_HOME/vireo) o la caché legacy
// ($XDG_CACHE_HOME/vireo) existen y los nuevos aún no, se copian y el legacy
// se renombra a «vireo.bak» (nunca se borra nada). Best-effort: cualquier
// error se avisa por stderr y el arranque continúa con el directorio nuevo.
// Las extensiones/temas/memoria de proyecto se leen en nicotine y,
// como compat, también en las rutas .vireo (no se tocan: son del proyecto).

import { cpSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function migrateOne(kind: "datos" | "caché", base: string): void {
  const legacy = join(base, "vireo");
  const target = join(base, "nicotine");
  if (!existsSync(legacy)) return;
  if (existsSync(target)) {
    try { process.stderr.write(`aviso: existe el directorio de ${kind} legacy «${legacy}» (se ignora; usa «${target}»)\n`); } catch { /* sin stderr */ }
    return;
  }
  try {
    cpSync(legacy, target, { recursive: true });
    renameSync(legacy, `${legacy}.bak`);
    process.stderr.write(`nicotine: migrados ${kind} de «${legacy}» a «${target}» (backup: «${legacy}.bak»)\n`);
  } catch (err) {
    try { process.stderr.write(`aviso: no se pudo migrar ${kind} «${legacy}»: ${(err as Error).message}; se usará «${target}» igualmente\n`); } catch { /* sin stderr */ }
  }
}

/** Migra datos y caché de vireo a nicotine una sola vez. Nunca lanza. */
export function migrateLegacyDataDir(): void {
  try {
    migrateOne("datos", process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"));
    migrateOne("caché", process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
  } catch { /* best effort total */ }
}
