// Helpers HTTP compartidos por vireo serve y el subconjunto opencode (src/modes/).
// Auth básica (cualquier usuario; la contraseña manda) con comparación en
// tiempo constante; body capado a 1 MiB.

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_BODY = 1 << 20;

export function passOk(header: string | undefined, password: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    const pass = i >= 0 ? decoded.slice(i + 1) : ""; // cualquier usuario vale; la clave manda
    const a = Buffer.from(pass), b = Buffer.from(password);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}

export function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(payload);
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body demasiado grande (máx 1 MiB)")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
