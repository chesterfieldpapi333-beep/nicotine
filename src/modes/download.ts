// nic download — descarga robusta y verificable: reintentos con backoff, límite
// de bytes, escritura a <out>.part + rename atómico, sha256 al final. No ejecuta
// nada ni sigue a ciegas servidores lentos (timeouts duros).

import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { envAlias } from "../core/env.js";

export interface DownloadOptions {
  url: string;
  out?: string;
  maxBytes?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX = 128 * 1024 * 1024; // 128 MiB
const DEFAULT_RETRIES = 3;
const BACKOFF_MS = [250, 1000, 4000];

function outName(url: string): string {
  try {
    const u = new URL(url);
    const base = basename(decodeURIComponent(u.pathname) || "descarga").replace(/[^\w.-]+/g, "_").slice(0, 120);
    return base && base !== "/" ? base : "descarga.bin";
  } catch { return "descarga.bin"; }
}

export async function runDownload(opts: DownloadOptions): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = String(opts.url);
  if (!/^https?:\/\//i.test(url)) {
    process.stderr.write("nic download: solo URLs http(s)\n");
    return 2;
  }
  const maxBytes = Math.min(1024 * 1024 * 1024, Math.max(1024, opts.maxBytes ?? DEFAULT_MAX));
  const retries = Math.min(8, Math.max(1, opts.retries ?? DEFAULT_RETRIES));
  let target = opts.out ? resolve(opts.out) : resolve(process.cwd(), outName(url));
  try {
    if (statSync(target).isDirectory()) target = join(target, outName(url));
  } catch { /* no existe aún */ }
  process.stderr.write(`nic download: ${url} → ${target} (máx ${maxBytes} bytes, ${retries} intento(s))\n`);
  let lastError = "desconocido";
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(60_000),
        headers: { "user-agent": "nicotine/0.1" },
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (no reintentable)`);
      const len = Number(res.headers.get("content-length") ?? "0");
      if (len && len > maxBytes) throw new Error(`content-length ${len} > límite ${maxBytes}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`descarga ${buf.length} bytes > límite ${maxBytes}`);
      const sha = createHash("sha256").update(buf).digest("hex");
      mkdirSync(dirname(target), { recursive: true });
      const part = `${target}.part`;
      writeFileSync(part, buf);
      renameSync(part, target);
      process.stdout.write(JSON.stringify({ tool: "download", url, out: target, bytes: buf.length, sha256: sha, contentType: res.headers.get("content-type") ?? null }) + "\n");
      return 0;
    } catch (err) {
      lastError = (err as Error).message;
      process.stderr.write(`intento ${attempt}/${retries} falló: ${lastError}\n`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]));
    }
  }
  process.stderr.write(`nic download: fallo definitivo: ${lastError}\n`);
  return 1;
}
