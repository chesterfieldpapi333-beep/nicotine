// Fase 11: memoria Obsidian (vault), descarga robusta, análisis estático, modelos.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

import { resolveVault, vaultDigest, listMarkdown } from "../src/compat/obsidian-vault.ts";
import { makeVaultTools } from "../src/tools/vault.ts";
import { runDownload } from "../src/modes/download.ts";
import { runAnalyze, detectMagic } from "../src/modes/analyze.ts";
import { classify, fetchModelIds, loadOverrides, saveOverrides } from "../src/core/model-catalog.ts";

const temps: string[] = [];
const envBackup = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in envBackup)) delete process.env[k];
  for (const k of Object.keys(envBackup)) process.env[k] = envBackup[k];
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

function makeVault(): string {
  const root = tmp("nicotine-vault-");
  for (const z of ["00-Inbox", "01-Decisiones", "02-Sesiones", "03-Contexto"]) mkdirSync(join(root, z), { recursive: true });
  writeFileSync(join(root, "01-Decisiones", "2026-11-06 - lit.md"), "---\ntitulo: lit\nfecha: 2026-11-06\n---\n\nDecisión de usar extensiones integradas.\n");
  writeFileSync(join(root, "03-Contexto", "estado.md"), "Máquina de trabajo.\n");
  writeFileSync(join(root, "00-Inbox", "ideas.md"), "Idea: usar vault para decisión previa antes de re-discutir.\n");
  return root;
}

const run = (t: { name: string; run: (args: Record<string, unknown>, ctx: never) => Promise<{ output: string }> }, args: Record<string, unknown>) =>
  t.run(args, { cwd: "/tmp", sessionId: "t", signal: new AbortController().signal, ui: { confirm: async () => "once", question: async () => null, info: () => {} }, readFiles: new Set(), emit: () => {} } as never);

describe("vault Obsidian (fase 11a)", () => {
  test("desactivado sin config ni env; activo con memory.vaultPath", () => {
    delete process.env.NICOTINE_VAULT; delete process.env.NICOTINE_MEMORY_OFF;
    expect(resolveVault({}).enabled).toBe(false);
    const root = makeVault();
    const v = resolveVault({ memory: { vaultPath: root } });
    expect(v.enabled).toBe(true);
    expect(v.writeZones).toEqual(["00-Inbox", "01-Decisiones", "03-Contexto"]);
  });

  test("02-Sesiones nunca es zona de escritura, ni con override", () => {
    const root = makeVault();
    const v = resolveVault({ memory: { vaultPath: root, vaultWriteZones: ["02-Sesiones", "00-Inbox"] } });
    expect(v.writeZones).toEqual(["00-Inbox"]);
  });

  test("vault_search encuentra notas; vault_read bloquea escapes", async () => {
    const root = makeVault();
    const state = resolveVault({ memory: { vaultPath: root } });
    const [search, read] = makeVaultTools(state);
    const hits = await run(search as never, { query: "extensiones" });
    expect(hits.output).toContain("2026-11-06 - lit.md");
    await expect(run(read as never, { path: "../outside.md" })).rejects.toThrow(/sale del vault/);
    const ok = await run(read as never, { path: "00-Inbox/ideas.md" });
    expect(ok.output).toContain("Idea");
  });

  const SECRET = "sk-" + "spa" + "x".repeat(60);

  test("vault_read bloquea notas con credenciales (fail-closed) sin filtrar el secreto", async () => {
    const root = makeVault();
    writeFileSync(join(root, "02-Sesiones", "ia local.md"), `Nota de prueba.\nclave: ${SECRET}\nmás texto\n`);
    const state = resolveVault({ memory: { vaultPath: root } });
    const [, read] = makeVaultTools(state);
    const res = await run(read as never, { path: "02-Sesiones/ia local.md" });
    expect(res.output).toContain("credenciales");
    expect(res.output).not.toContain(SECRET);
  });

  test("vault_search omite líneas con credenciales y sí encuentra el resto", async () => {
    const root = makeVault();
    writeFileSync(join(root, "02-Sesiones", "ia local.md"), `modelo favorito: mixtra\notra clave: ${SECRET}\nmodelo listo\n`);
    const state = resolveVault({ memory: { vaultPath: root } });
    const [search] = makeVaultTools(state);
    const res = await run(search as never, { query: "modelo" });
    expect(res.output).toContain("ia local.md");
    expect(res.output).not.toContain(SECRET);
  });

  test("el digest nunca incluye líneas con credenciales del excerpt", () => {
    const root = makeVault();
    writeFileSync(join(root, "01-Decisiones", "2026-11-06 - lit.md"), `---\ntitulo: lit\nfecha: 2026-11-06\n---\n\nDecisión pública.\nclave interna: ${SECRET}\n`);
    const state = resolveVault({ memory: { vaultPath: root } });
    const d = vaultDigest(state);
    expect(d).toContain("lit");
    expect(d).not.toContain(SECRET);
  });

  test("vault_write crea con frontmatter en zona permitida; rechaza 02-Sesiones y credenciales", async () => {
    const root = makeVault();
    const state = resolveVault({ memory: { vaultPath: root } });
    const [, , write] = makeVaultTools(state);
    const created = await run(write as never, { path: "00-Inbox/notas/nueva.md", content: "Contenido sin frontmatter" });
    expect(created.output).toContain("escrito 00-Inbox/notas/nueva.md");
    const body = readFileSync(join(root, "00-Inbox", "notas", "nueva.md"), "utf8");
    expect(body).toMatch(/^---\ntitulo: nueva\n/);
    await expect(run(write as never, { path: "02-Sesiones/x.md", content: "no" })).rejects.toThrow(/zona no permitida/);
    await expect(run(write as never, { path: "00-Inbox/sec.md", content: "token=ghp____________________________________".replace(/_+/g, "x".repeat(36)) })).rejects.toThrow(/credenciales/);
    expect(existsSync(join(root, "00-Inbox", "sec.md"))).toBe(false);
  });

  test("digest menciona decisiones y respeta el límite", () => {
    const root = makeVault();
    const state = resolveVault({ memory: { vaultPath: root } });
    const d = vaultDigest(state, 8192);
    expect(d).toContain("2026-11-06 - lit");
    expect(d).toContain("02-Sesiones");
    const small = vaultDigest(state, 64);
    expect(small.length).toBeLessThanOrEqual(64 + "\n…(digest truncado)".length);
    expect(small).toContain("digest");
  });
});

describe("nic download (fase 11d)", () => {
  const okFetch = (() => Promise.resolve(new Response(new TextEncoder().encode("hola").buffer, { status: 200, headers: { "content-length": "4" } }) as unknown as Response)) as unknown as typeof fetch;

  test("descarga con sha256 correcto", async () => {
    const dir = tmp("nicotine-dl-");
    const out = join(dir, "f.bin");
    const code = await runDownload({ url: "https://ejemplo.test/x.bin", out, fetchImpl: okFetch, retries: 1 });
    expect(code).toBe(0);
    expect(createHash("sha256").update(readFileSync(out)).digest("hex")).toBe(createHash("sha256").update("hola").digest("hex"));
  });

  test("reintenta 500 y acaba bien", async () => {
    let calls = 0;
    const flaky = (() => { calls++; return Promise.resolve(new Response(new TextEncoder().encode(calls < 3 ? "err" : "ok").buffer, { status: calls < 3 ? 500 : 200 }) as unknown as Response); }) as unknown as typeof fetch;
    const dir = tmp("nicotine-dl-");
    const out = join(dir, "f2.bin");
    const code = await runDownload({ url: "https://ejemplo.test/y.bin", out, fetchImpl: flaky, retries: 3 });
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("ok");
  });

  test("content-length por encima del límite → error y archivo ausente", async () => {
    const tooBig = (() => Promise.resolve(new Response(new Uint8Array([1]).buffer, { status: 200, headers: { "content-length": String(200 * 1024 * 1024) } }) as unknown as Response)) as unknown as typeof fetch;
    const dir = tmp("nicotine-dl-");
    const out = join(dir, "big.bin");
    const code = await runDownload({ url: "https://ejemplo.test/big.bin", out, fetchImpl: tooBig, retries: 1, maxBytes: 1024 });
    expect(code).toBe(1);
    expect(existsSync(out)).toBe(false);
  });
});

describe("nic analyze (fase 11d)", () => {
  test("magic bytes y sha256 de un PNG mínimo", async () => {
    const dir = tmp("nicotine-an-");
    const f = join(dir, "tiny.png");
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from("resto")]);
    writeFileSync(f, sig);
    expect(detectMagic(sig.subarray(0, 512))).toBe("png");
    expect(detectMagic(Buffer.from("%PDF-1.7\n"))).toBe("pdf");
    const code = await runAnalyze({ file: f });
    expect(code).toBe(0);
  });
});

describe("nic models (fase 11c)", () => {
  test("heurística conservadora: solo afirma lo que sabe", () => {
    expect(classify("openai/gpt-4o-mini", {}).tools).toBe(true);
    expect(classify("mi-modelo-raro", {}).tools).toBeNull();
    expect(classify("uncensored-foo", {}).censored).toBe(false);
    expect(classify("uncensored-foo", {}).censored).not.toBe(true);
    expect(classify("gpt-4o", { "gpt-4o": { tools: false, censored: true } })).toEqual({ id: "gpt-4o", tools: false, censored: true, source: "override" });
  });

  test("fetchModelIds deduplica y ordena; overrides roundtrip", async () => {
    const mockFetch = (() => Promise.resolve(new Response(JSON.stringify({ data: [{ id: "b" }, { id: "a" }, { id: "b" }] }), { status: 200 }) as unknown as Response)) as unknown as typeof fetch;
    const ids = await fetchModelIds("http://127.0.0.1:9/v1", "", mockFetch);
    expect(ids).toEqual(["a", "b"]);
    const dir = tmp("nicotine-ov-");
    const path = join(dir, "ov.json");
    saveOverrides({ "x": { tools: true } }, path);
    expect(loadOverrides(path)).toEqual({ "x": { tools: true } });
  });
});
