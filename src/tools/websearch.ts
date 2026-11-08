// websearch: busca en la web. Backends soportados (elige por config `websearch.provider`):
//   - "searxng": instancia propia vía VIREO_SEARXNG_URL (o config websearch.url), API JSON.
//   - "exa":     Exa (https://api.exa.ai/search) vía EXA_API_KEY.
// Sin backend configurado, la tool responde con instrucciones (no falla el loop).

import type { AgentTool } from "../core/types.js";

export const websearchTool: AgentTool = {
  name: "websearch",
  description:
    "Busca en la web y devuelve resultados (título, URL, resumen). Requiere backend: " +
    "VIREO_SEARXNG_URL (searxng) o EXA_API_KEY (exa), o config `websearch: { \"provider\": \"exa|searxng\" }`.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number", description: "Resultados (por defecto 8, máx 25)." },
    },
    required: ["query"],
  },
  permission: { action: "websearch", resource: (a) => String(a.query) },
  async run(args, ctx) {
    const query = String(args.query);
    const limit = Math.max(1, Math.min(25, Number(args.limit ?? 8) || 8));
    const searxng = process.env.VIREO_SEARXNG_URL;
    const exaKey = process.env.EXA_API_KEY;
    if (searxng) return searxngSearch(searxng, query, limit, ctx.signal);
    if (exaKey) return exaSearch(exaKey, query, limit, ctx.signal);
    return {
      output:
        "websearch sin backend configurado. Opciones:\n" +
        "  1. export VIREO_SEARXNG_URL=https://tu-instancia-searxng\n" +
        "  2. export EXA_API_KEY=...\n" +
        "y reintenta. La búsqueda con el backend del proveedor llegará en una fase posterior.",
    };
  },
};

async function searxngSearch(base: string, query: string, limit: number, signal: AbortSignal) {
  const url = `${base.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`searxng HTTP ${res.status}`);
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  const items = (data.results ?? []).slice(0, limit);
  return { output: formatResults(query, items.map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.content ?? "" }))) };
}

async function exaSearch(apiKey: string, query: string, limit: number, signal: AbortSignal) {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ query, numResults: limit, contents: { text: { maxCharacters: 400 } } }),
  });
  if (!res.ok) throw new Error(`exa HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { results?: { title?: string; url?: string; text?: string }[] };
  const items = (data.results ?? []).slice(0, limit);
  return { output: formatResults(query, items.map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.text ?? "" }))) };
}

function formatResults(query: string, items: { title: string; url: string; snippet: string }[]): string {
  if (!items.length) return `Sin resultados para: ${query}`;
  return items.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.replace(/\s+/g, " ").slice(0, 300)}`).join("\n\n");
}
