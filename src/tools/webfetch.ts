// webfetch: descarga una URL http(s) y la devuelve como markdown (default), text o html.
// HTML→markdown es NAIVE (títulos, enlaces, listas, párrafos; sin tablas ni código);
// para páginas complejas usa format=html y procesa con tools. Máx 50 KiB de salida.

import type { AgentTool } from "../core/types.js";

const MAX_OUT = 50 * 1024;
const MAX_TIMEOUT = 120_000;

export const webfetchTool: AgentTool = {
  name: "webfetch",
  description:
    "Descarga una URL http(s) y devuelve su contenido como markdown (por defecto), text o html. " +
    "timeout en ms (máx 120000). No sigue binarios (imágenes, pdf sin soporte aún).",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string" },
      format: { type: "string", enum: ["markdown", "text", "html"] },
      timeout: { type: "number" },
    },
    required: ["url"],
  },
  permission: { action: "webfetch", resource: (a) => String(a.url) },
  async run(args, ctx) {
    const url = String(args.url);
    if (!/^https?:\/\//i.test(url)) throw new Error("solo URLs http(s)");
    const timeout = Math.min(MAX_TIMEOUT, Math.max(1000, Number(args.timeout ?? 30_000) || 30_000));
    const res = await fetch(url, {
      headers: { "user-agent": "vireo/0.1 (+https://localhost)", accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.5" },
      signal: AbortSignal.any([AbortSignal.timeout(timeout), ctx.signal]),
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const type = res.headers.get("content-type") ?? "";
    if (/^(image|audio|video|application\/(zip|octet-stream|pdf))/.test(type)) {
      throw new Error(`contenido no textual (${type || "desconocido"}); webfetch solo devuelve texto`);
    }
    const raw = await res.text();
    const format = String(args.format ?? "markdown");
    let out: string;
    const isHtml = /html/i.test(type) || /<html[\s>]/i.test(raw.slice(0, 2000));
    if (format === "html") out = raw;
    else if (format === "text") out = isHtml ? htmlToText(raw, false) : raw;
    else out = isHtml ? htmlToText(raw, true) : raw; // markdown por defecto
    const truncated = out.length > MAX_OUT;
    return { output: (truncated ? out.slice(0, MAX_OUT) + `\n… (truncado, ${out.length} bytes en total)` : out) || "(respuesta vacía)" };
  },
};

// Conversor naive: comentarios/scripts fuera; h*, a, li, p/br/div/tr como saltos;
// enlaces como [texto](href) si markdown=true.
export function htmlToText(html: string, markdown: boolean): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n${"#".repeat(Number(n))} ${stripTags(t).trim()}\n\n`);
  if (markdown) s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => `[${stripTags(t).trim()}](${href})`);
  s = s.replace(/<li[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "");
  s = s.replace(/<(p|div|section|article|tr|pre|blockquote)[^>]*>/gi, "\n").replace(/<\/(p|div|section|article|tr|pre|blockquote)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<hr\s*\/?>/gi, "\n---\n");
  s = stripTags(s);
  s = decodeEntities(s);
  return s.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}
