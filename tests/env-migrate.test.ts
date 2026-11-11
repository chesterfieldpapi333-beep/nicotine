// Fase 10f: alias de entorno VIREO_* → NICOTINE_* y migración vireo → nicotine.
import { test, expect, afterEach, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const uniq = () => Math.random().toString(36).slice(2, 10).toUpperCase();
const temps: string[] = [];
const envBackup = { ...process.env };

function captureStderr(fn: () => void): string {
  const orig = process.stderr.write.bind(process.stderr);
  let out = "";
  (process.stderr as { write: typeof process.stderr.write }).write = ((chunk: unknown) => { out += String(chunk); return true; }) as typeof process.stderr.write;
  try { fn(); } finally { (process.stderr as { write: typeof process.stderr.write }).write = orig; }
  return out;
}

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in envBackup)) delete process.env[k];
  for (const k of Object.keys(envBackup)) process.env[k] = envBackup[k];
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("envAlias (fase 10f)", () => {
  test("NICOTINE_gana a VIREO_", async () => {
    const { envAlias } = await import(`../src/core/env.ts?case=${uniq()}`);
    const name = `TEST_${uniq()}`;
    process.env[`NICOTINE_${name}`] = "new";
    process.env[`VIREO_${name}`] = "old";
    expect(envAlias(name)).toBe("new");
  });
  test("VIREO_ funciona como alias deprecado con aviso único", async () => {
    const { envAlias } = await import(`../src/core/env.ts?case=${uniq()}`);
    const name = `TEST_${uniq()}`;
    process.env[`VIREO_${name}`] = "old";
    const warn = captureStderr(() => { expect(envAlias(name)).toBe("old"); });
    expect(warn).toContain(`VIREO_${name}`);
    expect(warn).toContain(`NICOTINE_${name}`);
    const warn2 = captureStderr(() => { expect(envAlias(name)).toBe("old"); });
    expect(warn2).toBe("");
  });
  test("sin ninguna de las dos devuelve undefined", async () => {
    const { envAlias } = await import(`../src/core/env.ts?case=${uniq()}`);
    const name = `TEST_${uniq()}`;
    delete process.env[`NICOTINE_${name}`];
    delete process.env[`VIREO_${name}`];
    expect(envAlias(name)).toBeUndefined();
  });
});

describe("migrateLegacyDataDir (fase 10f)", () => {
  test("migra datos y caché con backup, sin destruir el legacy", async () => {
    const root = mkdtempSync(join(tmpdir(), "nicotine-migrate-"));
    temps.push(root);
    process.env.XDG_DATA_HOME = join(root, "data-root");
    const legacyDataRoot = join(process.env.XDG_DATA_HOME, "vireo");
    mkdirSync(legacyDataRoot, { recursive: true });
    writeFileSync(join(legacyDataRoot, "auth.json"), "secret\n");
    process.env.XDG_CACHE_HOME = join(root, "cache-root");
    const legacyCacheRoot = join(process.env.XDG_CACHE_HOME, "vireo");
    mkdirSync(legacyCacheRoot, { recursive: true });
    writeFileSync(join(legacyCacheRoot, "cache.bin"), "bytes\n");

    const { migrateLegacyDataDir } = await import(`../src/core/migrate.ts?case=${uniq()}`);
    migrateLegacyDataDir();

    expect(existsSync(join(process.env.XDG_DATA_HOME, "nicotine", "auth.json"))).toBe(true);
    expect(readFileSync(join(process.env.XDG_DATA_HOME, "nicotine", "auth.json"), "utf8")).toBe("secret\n");
    expect(existsSync(join(process.env.XDG_DATA_HOME, "vireo.bak", "auth.json"))).toBe(true);
    expect(existsSync(join(process.env.XDG_DATA_HOME, "vireo"))).toBe(false);
    expect(existsSync(join(process.env.XDG_CACHE_HOME, "nicotine", "cache.bin"))).toBe(true);
    expect(existsSync(join(process.env.XDG_CACHE_HOME, "vireo.bak", "cache.bin"))).toBe(true);
  });
  test("no pisa un directorio destino ya existente (aviso y continúa)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nicotine-migrate-"));
    temps.push(root);
    process.env.XDG_DATA_HOME = root;
    process.env.XDG_CACHE_HOME = join(root, "cache");
    mkdirSync(join(root, "vireo"));
    mkdirSync(join(root, "nicotine"));
    writeFileSync(join(root, "vireo", "auth.json"), "legacy\n");
    writeFileSync(join(root, "nicotine", "auth.json"), "fresh\n");

    const { migrateLegacyDataDir } = await import(`../src/core/migrate.ts?case=${uniq()}`);
    captureStderr(() => migrateLegacyDataDir());

    expect(readFileSync(join(root, "nicotine", "auth.json"), "utf8")).toBe("fresh\n");
    expect(existsSync(join(root, "vireo", "auth.json"))).toBe(true);
  });
});
