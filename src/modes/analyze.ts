// nic analyze — análisis estático de un archivo, sin ejecutarlo: magic bytes
// (firmas comunes), sha256, tamaño, y comprobaciones OPCIONALES: ClamAV si está
// instalado (spawn `clamscan`) y VirusTotal SOLO por hash (GET api/v3/files/<sha256>,
// nunca sube el archivo). Con --json emite un objeto legible por máquina.

import { createHash } from "node:crypto";
import { createReadStream, statSync, openSync, readSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { env } from "node:process";

export interface AnalyzeOptions {
  file: string;
  json?: boolean;
  fetchImpl?: typeof fetch;
}

const SIGNATURES: { name: string; bytes: number[]; offset?: number }[] = [
  { name: "pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { name: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: "jpeg", bytes: [0xff, 0xd8, 0xff] },
  { name: "gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { name: "bmp", bytes: [0x42, 0x4d] },
  { name: "zip", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { name: "zip-empty", bytes: [0x50, 0x4b, 0x05, 0x06] },
  { name: "gzip", bytes: [0x1f, 0x8b] },
  { name: "7z", bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { name: "rar", bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { name: "elf", bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: "pe/pe32+ (mz)", bytes: [0x4d, 0x5a] },
  { name: "macho-64-le", bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: "macho-64-be", bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: "macho-32-le", bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { name: "sqlite3", bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00] },
  { name: "ogg", bytes: [0x4f, 0x67, 0x67, 0x53] },
  { name: "elf-reloc", bytes: [0x7f, 0x45, 0x4c, 0x01] },
];

export function detectMagic(head: Buffer): string {
  for (const sig of SIGNATURES) {
    const off = sig.offset ?? 0;
    if (head.length < off + sig.bytes.length) continue;
    let ok = true;
    for (let i = 0; i < sig.bytes.length; i++) if (head[off + i] !== sig.bytes[i]) { ok = false; break; }
    if (ok) return sig.name;
  }
  const textRatio = head.length === 0 ? 1 : head.filter((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)).length / head.length;
  if (textRatio > 0.85) return "text/plain?";
  return "desconocido";
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(path);
    s.on("data", (d) => h.update(d));
    s.on("error", reject);
    s.on("end", () => resolvePromise(h.digest("hex")));
  });
}

export async function runAnalyze(opts: AnalyzeOptions): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const file = String(opts.file);
  let st;
  try { st = statSync(file); } catch {
    process.stderr.write(`nic analyze: no existe: ${file}\n`);
    return 2;
  }
  if (!st.isFile()) {
    process.stderr.write(`nic analyze: no es un archivo: ${file}\n`);
    return 2;
  }
  const fd = openSync(file, "r");
  const headBuf = Buffer.alloc(512);
  const headRead = readSync(fd, headBuf, 0, 512, 0);
  closeSync(fd);
  const head = headBuf.subarray(0, headRead);
  const sha256 = await sha256File(file);
  const magic = detectMagic(head);
  const result: Record<string, unknown> = { path: file, bytes: st.size, sha256, magic };

  const clam = spawnSync("clamscan", ["--no-summary", "--", file], { timeout: 60_000, encoding: "utf8" });
  if (clam.error && (clam.error as NodeJS.ErrnoException).code === "ENOENT") {
    result["clamav"] = "no instalado (opcional)";
  } else if (clam.status === 0) {
    result["clamav"] = "limpio";
  } else if (clam.status === 1) {
    result["clamav"] = `DETECTADO: ${String(clam.stdout).trim().split("\n").pop()}`;
  } else {
    result["clamav"] = `error (código ${clam.status})`;
  }

  const vtKey = env["NICOTINE_VT_API_KEY"];
  if (vtKey) {
    try {
      const res = await fetchImpl(`https://www.virustotal.com/api/v3/files/${sha256}`, {
        headers: { "x-apikey": vtKey },
        signal: AbortSignal.timeout(12_000),
      });
      if (res.status === 404) {
        result["virustotal"] = "sin reporte (no encontrado)";
      } else if (!res.ok) {
        result["virustotal"] = `error HTTP ${res.status}`;
      } else {
        const data = (await res.json()) as { data?: { attributes?: { last_analysis_stats?: Record<string, number>; meaningful_name?: string } } };
        const stats = data.data?.attributes?.last_analysis_stats ?? {};
        result["virustotal"] = { name: data.data?.attributes?.meaningful_name ?? null, stats };
      }
    } catch (err) {
      result["virustotal"] = `no disponible: ${(err as Error).message}`;
    }
  } else {
    result["virustotal"] = "omitido (sin NICOTINE_VT_API_KEY; solo lookup por hash)";
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(`archivo:    ${file}\n`);
    process.stdout.write(`bytes:      ${st.size}\n`);
    process.stdout.write(`sha256:     ${sha256}\n`);
    process.stdout.write(`magic:      ${magic}\n`);
    process.stdout.write(`clamav:     ${result["clamav"]}\n`);
    const vt = result["virustotal"];
    process.stdout.write(`virustotal: ${typeof vt === "string" ? vt : JSON.stringify(vt)}\n`);
  }
  return 0;
}
