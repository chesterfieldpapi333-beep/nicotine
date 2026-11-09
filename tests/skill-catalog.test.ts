// Catálogos HTTP de skills (discovery /.well-known/agent-skills): actualización
// verificada por digest + caché síncrona para el arranque.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogCacheDir, cachedCatalogSources, catalogStatus, updateCatalogs } from "../src/compat/skill-catalog.js";
import { loadSkillIndex } from "../src/compat/skills.js";

const sha256hex = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");
const CATALOG = "https://skills.example.com/.well-known/agent-skills/index.json";

const skillMd = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\ninstrucciones de la skill\n`;

function mockCatalogFetch(map: Record<string, { body: string | Buffer; status?: number }>): typeof fetch {
  return (async (url: unknown) => {
    const key = String(url);
    const hit = map[key];
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(hit.body, { status: hit.status ?? 200 });
  }) as unknown as typeof fetch;
}

let home: string, root: string, cacheRoot: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vireo-cat-home-"));
  root = mkdtempSync(join(tmpdir(), "vireo-cat-cwd-"));
  cacheRoot = mkdtempSync(join(tmpdir(), "vireo-cat-cache-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(cacheRoot, { recursive: true, force: true });
});

describe("vireo skills update — descarga verificada por digest", () => {
  const buildCatalog = (entries: { name: string; body: string; type?: string; digestOk?: boolean }[]) => {
    const skills = entries.map((e) => ({
      name: e.name,
      type: e.type ?? "skill-md",
      description: `${e.name} desc`,
      url: `https://skills.example.com/.well-known/agent-skills/${e.name}/SKILL.md`,
      digest: "sha256:" + (e.digestOk === false ? "0".repeat(64) : sha256hex(e.body)),
    }));
    const map: Record<string, { body: string }> = { [CATALOG]: { body: JSON.stringify({ $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json", skills }) } };
    for (const e of entries) map[`https://skills.example.com/.well-known/agent-skills/${e.name}/SKILL.md`] = { body: e.body };
    return map;
  };

  test("catálogo válido: instala skills en caché y el cargador las descubre", async () => {
    const map = buildCatalog([{ name: "revisor", body: skillMd("revisor", "revisa diffs con rigor") }]);
    const res = await updateCatalogs([CATALOG], { fetchImpl: mockCatalogFetch(map), cacheRoot });
    expect(res[0].errors).toEqual([]);
    expect(res[0].ok).toBe(1);
    // caché: <cacheRoot>/<hash>/revisor/SKILL.md + catalog.json
    const dir = catalogCacheDir(CATALOG, cacheRoot);
    expect(existsSync(join(dir, "revisor", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "catalog.json"))).toBe(true);
    // descubrimiento SÍNCRONO vía config skills:[url]
    const { byId, warnings } = loadSkillIndex(root, { skills: [CATALOG] }, { home, catalogCacheRoot: cacheRoot });
    expect(warnings).toEqual([]);
    expect(byId.get("revisor")?.description).toBe("revisa diffs con rigor");
  });

  test("digest que NO coincide → no instala esa skill y reporta error", async () => {
    const map = buildCatalog([{ name: "mala", body: skillMd("mala", "x"), digestOk: false }]);
    const res = await updateCatalogs([CATALOG], { fetchImpl: mockCatalogFetch(map), cacheRoot });
    expect(res[0].ok).toBe(0);
    expect(res[0].errors.some((e) => e.includes("DIGEST NO COINCIDE"))).toBe(true);
  });

  test("entradas tipo != skill-md se omiten; nombre inválido se omite", async () => {
    const map = buildCatalog([
      { name: "arch", body: "PK\x03\x04", type: "archive" },
      { name: "NO_VALIDO", body: skillMd("x", "y") },
      { name: "buena", body: skillMd("buena", "ok") },
    ]);
    const res = await updateCatalogs([CATALOG], { fetchImpl: mockCatalogFetch(map), cacheRoot });
    expect(res[0].ok).toBe(1);
    expect(res[0].skipped.length).toBeGreaterThanOrEqual(2);
  });

  test("URL relativa de artefacto se resuelve contra el índice; caché vieja se reemplaza", async () => {
    const body = skillMd("relativa", "relativa ok");
    const dir = catalogCacheDir(CATALOG, cacheRoot);
    mkdirSync(join(dir, "stale"), { recursive: true }); // basura de una descarga anterior
    const map: Record<string, { body: string }> = {
      [CATALOG]: { body: JSON.stringify({ skills: [{ name: "relativa", type: "skill-md", description: "d", url: "./skills/relativa/SKILL.md", digest: "sha256:" + sha256hex(body) }] }) },
      "https://skills.example.com/.well-known/agent-skills/skills/relativa/SKILL.md": { body },
    };
    const res = await updateCatalogs([CATALOG], { fetchImpl: mockCatalogFetch(map), cacheRoot });
    expect(res[0].errors).toEqual([]);
    expect(existsSync(join(dir, "stale"))).toBe(false); // reemplazo limpio
    expect(existsSync(join(dir, "relativa", "SKILL.md"))).toBe(true);
  });

  test("índice caído → error claro, sin caché que confundir", async () => {
    const res = await updateCatalogs([CATALOG], { fetchImpl: mockCatalogFetch({}), cacheRoot });
    expect(res[0].errors.length).toBe(1);
    expect(cachedCatalogSources([CATALOG], cacheRoot)).toEqual([]);
    expect(catalogStatus([CATALOG], cacheRoot)[0].downloaded).toBe(false);
  });
});

describe("catalogStatus / cachedCatalogSources", () => {
  test("sin caché → no descargado; con caché → cuenta skills y fecha", async () => {
    expect(catalogStatus([CATALOG], cacheRoot)[0]).toMatchObject({ downloaded: false, skills: [] });
    const body = skillMd("zeta", "z");
    const map: Record<string, { body: string }> = {
      [CATALOG]: { body: JSON.stringify({ skills: [{ name: "zeta", type: "skill-md", url: "./zeta/SKILL.md", digest: "sha256:" + sha256hex(body) }] }) },
      "https://skills.example.com/.well-known/agent-skills/zeta/SKILL.md": { body },
    };
    await updateCatalogs([CATALOG], { fetchImpl: mockCatalogFetch(map), cacheRoot });
    const st = catalogStatus([CATALOG], cacheRoot)[0];
    expect(st.downloaded).toBe(true);
    expect(st.skills).toEqual(["zeta"]);
    expect(cachedCatalogSources([CATALOG], cacheRoot)).toHaveLength(1);
  });
});
