// Descubrimiento de CLIs (C5): PATH falsa en tmpdir, sin tocar el PATH real.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KNOWN_CLIS,
  VERSION_MAX_CHARS,
  VERSION_UNAVAILABLE,
  cleanVersionLine,
  discoverClis,
  isExecutableFile,
  probeCliVersion,
} from "../src/compat/discovery.js";

let root: string;
let binA: string;
let binB: string;

const script = (dir: string, name: string, body: string, mode = 0o755) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, mode);
  return p;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nicotine-discovery-"));
  binA = join(root, "a");
  binB = join(root, "b");
  mkdirSync(binA);
  mkdirSync(binB);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("discoverClis — solo disco", () => {
  test("encuentra ejecutables en varias entradas de PATH y respeta el orden", () => {
    const git = script(binA, "git", "#!/bin/sh\necho git version 2.43.0\n");
    const claude = script(binB, "claude", "#!/bin/sh\necho claude 1.0.0\n");
    const res = discoverClis({ pathEnv: `${binA}:${binB}` });
    expect(res.searchedDirs).toBe(2);
    expect(res.found).toEqual([
      { name: "git", path: git },
      { name: "claude", path: claude },
    ]);
    expect(res.missing).toContain("gh");
    expect(res.missing).toContain("ollama");
    expect(res.found.length + res.missing.length).toBe(KNOWN_CLIS.length);
  });

  test("ignora archivos sin bit de ejecución y directorios con el mismo nombre", () => {
    script(binA, "jq", "#!/bin/sh\necho jq-1.7\n", 0o644);
    mkdirSync(join(binA, "rg"));
    const res = discoverClis({ pathEnv: binA, names: ["jq", "rg", "curl"] });
    expect(res.found).toEqual([]);
    expect(res.missing).toEqual(["jq", "rg", "curl"]);
  });

  test("PATH vacío: nada encontrado y ninguna excepción", () => {
    const res = discoverClis({ pathEnv: "", names: ["git", "bun"] });
    expect(res.searchedDirs).toBe(0);
    expect(res.found).toEqual([]);
    expect(res.missing).toEqual(["git", "bun"]);
  });

  test("no ejecuta nada al escanear (script trampa que deja marca)", () => {
    const marker = join(root, "ejecutado");
    script(binA, "git", `#!/bin/sh\ntouch "${marker}"\necho git version 9.9.9\n`);
    discoverClis({ pathEnv: binA });
    expect(existsSync(marker)).toBe(false);
  });

  test("isExecutableFile: distingue archivo ejecutable, no ejecutable e inexistente", () => {
    const exe = script(binA, "git", "#!/bin/sh\nexit 0\n");
    const plain = script(binA, "plano", "x", 0o644);
    expect(isExecutableFile(exe)).toBe(true);
    expect(isExecutableFile(plain)).toBe(false);
    expect(isExecutableFile(join(binA, "no-existe"))).toBe(false);
  });
});

describe("probeCliVersion — opt-in, acotado y sin colgarse", () => {
  test("captura solo la primera línea de --version", () => {
    const p = script(binA, "git", "#!/bin/sh\necho 'git version 2.43.0'\necho 'segunda línea que no debe verse'\n");
    expect(probeCliVersion(p)).toBe("git version 2.43.0");
  });

  test("acota a 120 caracteres y quita caracteres de control", () => {
    const p = script(binA, "ruidoso", `#!/bin/sh\nprintf 'v1.0\\033[31m\\033[2K%s\\n' "$(head -c 300 /dev/zero | tr '\\0' 'x')"\n`);
    const out = probeCliVersion(p);
    expect(out.length).toBeLessThanOrEqual(VERSION_MAX_CHARS);
    expect(out.startsWith("v1.0")).toBe(true);
    expect(out).not.toContain("\u001b");
  });

  test("exit ≠ 0 → versión no disponible", () => {
    const p = script(binA, "roto", "#!/bin/sh\necho algo\n exit 3\n");
    expect(probeCliVersion(p)).toBe(VERSION_UNAVAILABLE);
  });

  test("sin salida → versión no disponible", () => {
    const p = script(binA, "mudo", "#!/bin/sh\nexit 0\n");
    expect(probeCliVersion(p)).toBe(VERSION_UNAVAILABLE);
  });

  test("binario inexistente → versión no disponible (sin lanzar)", () => {
    expect(probeCliVersion(join(binA, "fantasma"))).toBe(VERSION_UNAVAILABLE);
  });

  test("script que duerme 5 s → no disponible y el timeout corta antes", () => {
    const p = script(binA, "lento", "#!/bin/sh\nsleep 5\necho nunca\n");
    const t0 = Date.now();
    expect(probeCliVersion(p)).toBe(VERSION_UNAVAILABLE);
    expect(Date.now() - t0).toBeLessThan(4500); // timeout de 2 s + margen
  });

  test("cleanVersionLine: redacta credenciales y normaliza nulos", () => {
    expect(cleanVersionLine("cli 1.0 sk-abcdefghijklmnop\nresto")).toBe("cli 1.0 sk-***");
    expect(cleanVersionLine("\n")).toBe(VERSION_UNAVAILABLE);
    expect(cleanVersionLine(undefined)).toBe(VERSION_UNAVAILABLE);
  });
});
