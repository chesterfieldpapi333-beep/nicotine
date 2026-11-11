// Tools de memoria persistente contra el vault de Obsidian del usuario.
// vault_search / vault_read: solo lectura. vault_write: zonas permitidas +
// rechazo de contenido con credenciales + frontmatter automático.

import type { AgentTool } from "../core/types.js";
import {
  resolveVault, searchVault, safeJoin, vaultRelPath, isWritableRel, containsCredential,
  type VaultState,
} from "../compat/obsidian-vault.js";
import { statSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, basename, extname } from "node:path";

export function makeVaultTools(state: VaultState): AgentTool[] {
  const vaultSearch: AgentTool = {
    name: "vault_search",
    description:
      "Busca en el vault de Obsidian del usuario (notas Markdown entre sesiones). " +
      "query: texto literal sin regex. folder: subcarpeta del vault (opcional). limit: 1-50 (defecto 20). " +
      "Devuelve líneas «ruta:línea: fragmento». Úsala para recordar decisiones previas antes de re-discutirlas.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        folder: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
    permission: { action: "vault", resource: (a) => `search:${String(a.query).slice(0, 128)}` },
    async run(args) {
      if (!state.enabled) return { output: "vault no activo (define NICOTINE_VAULT o memory.vaultPath)" };
      const hits = searchVault(state, String(args.query), args.folder === undefined ? undefined : String(args.folder), Number(args.limit ?? 20));
      return { output: hits.join("\n") };
    },
  };

  const vaultRead: AgentTool = {
    name: "vault_read",
    description:
      "Lee una nota del vault de Obsidian. path: ruta relativa a la raíz del vault (p. ej. «01-Decisiones/2026-11-06 - lit.md»). " +
      "Máx 32 KiB. Úsala tras vault_search para ver el detalle de una decisión.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    permission: { action: "vault", resource: (a) => `read:${String(a.path).slice(0, 200)}` },
    async run(args) {
      if (!state.enabled || !state.root) return { output: "vault no activo (define NICOTINE_VAULT o memory.vaultPath)" };
      const abs = safeJoin(state.root, String(args.path));
      const st = statSync(abs);
      if (!st.isFile()) return { output: `no es un archivo: ${vaultRelPath(state.root, abs)}` };
      const raw = readFileSync(abs, "utf8");
      const LIMIT = 32 * 1024;
      const rel = vaultRelPath(state.root, abs);
      if (raw.length > LIMIT) return { output: `# ${rel}\n\n${raw.slice(0, LIMIT)}\n\n…(truncada; ${raw.length} bytes)` };
      return { output: `# ${rel}\n\n${raw}` };
    },
  };

  const vaultWrite: AgentTool = {
    name: "vault_write",
    description:
      "Crea o sobreescribe una nota en el vault de Obsidian dentro de una zona permitida. " +
      "path relativo (p. ej. «00-Inbox/cli-ideas.md» o «01-Decisiones/2026-11-11 - decisión.md»). " +
      "Aplica frontmatter mínimo automático si falta. Si el contenido contiene credenciales, se rechaza. " +
      "`02-Sesiones` está reservada y NUNCA se escribe. Sobreescribe, no fusiona.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    permission: { action: "vault", resource: (a) => `write:${String(a.path).slice(0, 200)}` },
    async run(args) {
      if (!state.enabled || !state.root) return { output: "vault no activo (define NICOTINE_VAULT o memory.vaultPath)" };
      const relInput = String(args.path).trim();
      const content = String(args.content ?? "");
      if (!/\.(md|markdown)$/i.test(relInput)) throw new Error("vault_write solo escribe .md");
      const abs = safeJoin(state.root, relInput);
      const rel = vaultRelPath(state.root, abs);
      if (!rel.includes("/")) throw new Error("escribe dentro de una zona: 00-Inbox/, 01-Decisiones/ o 03-Contexto/");
      if (!isWritableRel(state, rel)) {
        throw new Error(`zona no permitida «${rel}». Permitidas: ${state.writeZones.join(", ") || "(ninguna)"}; 02-Sesiones está reservada`);
      }
      if (content.length > 256 * 1024) throw new Error("contenido demasiado grande (máx 256 KiB)");
      if (containsCredential(content)) {
        throw new Error("el contenido parece contener credenciales (sk-/gh*/AIza/PRIVATE KEY/…); no se escribe");
      }
      let body = content;
      if (!/^---\s*\n/.test(body)) {
        const title = basename(relInput, extname(relInput));
        const today = new Date().toISOString().slice(0, 10);
        body = `---\ntitulo: ${title}\nfecha: ${today}\norigen: nicotine\ntipo: nota\n---\n\n${body}`;
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, "utf8");
      return { output: `escrito ${rel} (${Buffer.byteLength(body, "utf8")} bytes)` };
    },
  };

  return [vaultSearch, vaultRead, vaultWrite];
}

/** Tools para cuando no se quiere resolver el estado dos veces. */
export function vaultToolsFromConfig(config: Record<string, unknown>): { tools: AgentTool[]; state: VaultState } {
  const state = resolveVault(config);
  return { tools: state.enabled ? makeVaultTools(state) : [], state };
}
