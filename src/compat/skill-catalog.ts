// Catálogos HTTP de skills (agentskills.io discovery / .well-known/agent-skills).
//
// El arranque de nicotine es SÍNCRONO: no se descarga nada al arrancar. En su
// lugar, `nicotine skills update` (este módulo, con fetch) descarga los catálogos
// configurados en `skills: ["https://…"]`, verifica el digest sha256 de cada
// SKILL.md contra el índice (integridad estilo registry) y los deja en caché
// ($XDG_CACHE_HOME o ~/.cache/nicotine/skills-http/<hash-url>/<nombre>/SKILL.md).
// El cargador síncrono escanea la CACHÉ como una fuente más (sin red).
//
// Formato esperado (discovery 0.2.0, tolerante): {"$schema"?, skills: [{name,
// type: "skill-md", description?, url, digest: "sha256:<hex>"}]}. Entradas con
// tipo distinto de skill-md se omiten; entradas sin digest sha256 válido se
// rechazan (la integridad no es opcional).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAX_CATALOG_SKILLS = 100;
export const MAX_SKILL_BYTES = 1024 * 1024; // 1 MiB por SKILL.md

export interface CatalogEntry {
  name: string;
  type: string;
  description?: string;
  url: string;
  digest: string;
}

const sha256hex = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

/** Carpeta de caché de un catálogo. `cacheRoot` inyectable para tests. */
export function catalogCacheDir(catalogUrl: string, cacheRoot?: string): string {
  const base = cacheRoot ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "nicotine", "skills-http");
  return join(base, sha256hex(catalogUrl).slice(0, 16));
}

/** Fuentes síncronas para el escáner: solo directorios de caché que ya existen. */
export function cachedCatalogSources(catalogUrls: string[], cacheRoot?: string): { dir: string; source: string }[] {
  const out: { dir: string; source: string }[] = [];
  for (const url of catalogUrls) {
    const dir = catalogCacheDir(url, cacheRoot);
    if (existsSync(dir)) {
      let host = url;
      try { host = new URL(url).host; } catch { /* url rara: se usa tal cual */ }
      out.push({ dir, source: `config · catálogo HTTP (caché de ${host})` });
    }
  }
  return out;
}

export interface CatalogUpdateResult {
  url: string;
  ok: number;
  /** Entradas omitidas (tipo no soportado, nombre inválido, etc.) */
  skipped: { name: string; reason: string }[];
  errors: string[];
}

const NAME_RE = /^[a-z0-9](-?[a-z0-9]){0,63}$/;

/** Estado síncrono del caché (para doctor). */
export function catalogStatus(catalogUrls: string[], cacheRoot?: string): { url: string; downloaded: boolean; skills: string[]; updatedAt?: string }[] {
  const out: { url: string; downloaded: boolean; skills: string[]; updatedAt?: string }[] = [];
  for (const url of catalogUrls) {
    const dir = catalogCacheDir(url, cacheRoot);
    if (!existsSync(dir)) { out.push({ url, downloaded: false, skills: [] }); continue; }
    let skills: string[] = [];
    try {
      skills = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "SKILL.md")))
        .map((e) => e.name)
        .sort();
    } catch { /* caché ilegible: se reporta como vacía */ }
    let updatedAt: string | undefined;
    try {
      const meta = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8")) as { updatedAt?: string };
      updatedAt = typeof meta.updatedAt === "string" ? meta.updatedAt : undefined;
    } catch { /* sin meta: ok */ }
    out.push({ url, downloaded: true, skills, updatedAt });
  }
  return out;
}

/** Descarga y verifica un catálogo completo. Escribe en caché (reemplaza el contenido previo). */
export async function updateCatalog(url: string, opts: { fetchImpl?: typeof fetch; cacheRoot?: string } = {}): Promise<CatalogUpdateResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const result: CatalogUpdateResult = { url, ok: 0, skipped: [], errors: [] };

  // 1) índice
  let indexJson: unknown;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    indexJson = JSON.parse(await res.text());
  } catch (err) {
    result.errors.push(`índice no descargable: ${(err as Error).message}`);
    return result;
  }
  const list = (indexJson as { skills?: unknown })?.skills;
  if (!Array.isArray(list)) {
    result.errors.push("el índice no tiene «skills» (array) — ¿no es un catálogo agentskills discovery?");
    return result;
  }
  const schema = (indexJson as { $schema?: unknown })?.$schema;
  if (schema !== undefined && typeof schema === "string" && !/agentskills|agent-skills/.test(schema)) {
    result.skipped.push({ name: "($schema)", reason: `$schema desconocido (${schema}); se continúa por los digests` });
  }

  // 2) verificar + escribir en una caché limpia
  const cacheDir = catalogCacheDir(url, opts.cacheRoot);
  const responses: { entry: CatalogEntry; body: Buffer }[] = [];
  let count = 0;
  for (const raw of list) {
    if (count >= MAX_CATALOG_SKILLS) { result.skipped.push({ name: "…", reason: `tope ${MAX_CATALOG_SKILLS} skills por catálogo; el resto se omite` }); break; }
    const e = raw as Partial<CatalogEntry>;
    if (!e || typeof e !== "object") { result.skipped.push({ name: "(?)", reason: "entrada no-objeto" }); continue; }
    const name = String(e.name ?? "").trim();
    const type = String(e.type ?? "");
    if (type !== "skill-md") { result.skipped.push({ name: name || "(?)", reason: `tipo «${type || "?"}» no soportado (solo skill-md)` }); continue; }
    if (!NAME_RE.test(name)) { result.skipped.push({ name: name || "(?)", reason: "nombre inválido (slug en minúsculas con guiones)" }); continue; }
    if (typeof e.url !== "string" || !e.url.trim()) { result.skipped.push({ name, reason: "falta url" }); continue; }
    const digest = String(e.digest ?? "");
    if (!/^sha256:[0-9a-f]{64}$/i.test(digest)) { result.errors.push(`${name}: digest ausente o inválido (se exige sha256:<hex>)`); continue; }
    let artifactUrl: URL;
    try { artifactUrl = new URL(e.url, url); } catch { result.errors.push(`${name}: url irresoluble: ${e.url}`); continue; }
    count++;
    try {
      const res = await fetchImpl(artifactUrl.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_SKILL_BYTES) { result.errors.push(`${name}: demasiado grande (${body.length} B)`); continue; }
      const actual = sha256hex(body);
      if (actual !== digest.slice("sha256:".length).toLowerCase()) {
        result.errors.push(`${name}: DIGEST NO COINCIDE — esperado ${digest}, obtenido sha256:${actual} (no se instala)`);
        continue;
      }
      responses.push({ entry: { ...(e as CatalogEntry), name, type, url: artifactUrl.toString(), digest }, body });
    } catch (err) {
      result.errors.push(`${name}: descarga fallida: ${(err as Error).message}`);
    }
  }

  // 3) reemplazar la caché (limpio) y escribir meta
  try {
    rmSync(cacheDir, { recursive: true, force: true });
    mkdirSync(cacheDir, { recursive: true });
    for (const { entry, body } of responses) {
      const dir = join(cacheDir, entry.name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), body);
      result.ok++;
    }
    writeFileSync(join(cacheDir, "catalog.json"), JSON.stringify({ url, updatedAt: new Date().toISOString(), skills: responses.map((r) => r.entry.name) }, null, 2));
  } catch (err) {
    result.errors.push(`no se pudo escribir la caché ${cacheDir}: ${(err as Error).message}`);
  }
  return result;
}

/** Actualiza varios catálogos en orden. */
export async function updateCatalogs(urls: string[], opts: { fetchImpl?: typeof fetch; cacheRoot?: string } = {}): Promise<CatalogUpdateResult[]> {
  const out: CatalogUpdateResult[] = [];
  for (const url of urls) out.push(await updateCatalog(url, opts));
  return out;
}
