// tui.json(c): configuración SOLO de la TUI (separada de opencode.json).
// Precedencia: $NICOTINE_TUI_CONFIG > ~/.config/opencode/tui.json(c) > .opencode/tui.json(c) (cwd→raíz).
// Los keybinds se fusionan sobre los defaults; "none" desactiva una acción.
// En v1 solo se honran las opciones listadas (resto se ignora con aviso en stderr).

import { envAlias } from "../core/env.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { parseJsonc } from "../util/jsonc.js";

export interface TuiConfig {
  theme: string;
  leaderTimeout: number;
  keybinds: Record<string, string>;
  scrollSpeed: number;
  diffStyle: "auto" | "stacked";
  mouse: boolean;
  cursor: { style: "block" | "line" | "underline" | "default"; blinking: boolean };
  layers: string[];
}

// Subconjunto v1 de los defaults de OpenCode (docs.opencode.ai/docs/keybinds).
export const DEFAULT_KEYBINDS: Record<string, string> = {
  leader: "ctrl+x",
  command_list: "ctrl+p",
  help_show: "none",
  editor_open: "<leader>e",
  theme_list: "<leader>t",
  session_new: "<leader>n",
  session_list: "<leader>l",
  session_compact: "<leader>c",
  session_undo: "<leader>u",
  session_redo: "<leader>r",
  session_interrupt: "escape",
  model_list: "<leader>m",
  agent_list: "<leader>a",
  agent_cycle: "tab",
  agent_cycle_reverse: "shift+tab",
  app_exit: "ctrl+c,ctrl+d,<leader>q",
  input_submit: "return",
  input_newline: "ctrl+j,shift+return,alt+return",
  input_clear: "ctrl+c",
  messages_page_up: "pageup",
  messages_page_down: "pagedown",
};

const KNOWN_KEYS = new Set(["$schema", "theme", "leader_timeout", "keybinds", "scroll_speed", "scroll_acceleration", "diff_style", "mouse", "cursor", "attention"]);

function readLayer(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  return parseJsonc<Record<string, unknown>>(readFileSync(path, "utf8"), path);
}

export function loadTuiConfig(cwd: string): TuiConfig {
  const layers: { path: string; data: Record<string, unknown> }[] = [];
  const tuiCfg = envAlias("TUI_CONFIG");
  if (tuiCfg) {
    const data = readLayer(tuiCfg);
    if (data) layers.push({ path: tuiCfg, data });
  }
  for (const p of [join(homedir(), ".config", "opencode", "tui.json"), join(homedir(), ".config", "opencode", "tui.jsonc")]) {
    const data = readLayer(p);
    if (data) layers.push({ path: p, data });
  }
  const trail: string[] = [];
  let cur = resolve(cwd);
  for (;;) { trail.push(cur); const parent = dirname(cur); if (parent === cur) break; cur = parent; }
  for (const dir of trail.reverse()) {
    for (const name of ["tui.json", "tui.jsonc"]) {
      for (const sub of ["", ".opencode"]) {
        const p = join(dir, sub, name);
        const data = readLayer(p);
        if (data) layers.push({ path: p, data });
      }
    }
  }

  // avisos de claves desconocidas (no fatales)
  for (const layer of layers) {
    for (const key of Object.keys(layer.data)) {
      if (!KNOWN_KEYS.has(key)) console.error(`[nicotine] tui.json: clave ignorada "${key}" en ${layer.path}`);
    }
  }

  const merged: Record<string, unknown> = {};
  for (const layer of layers) Object.assign(merged, layer.data);
  const keybinds = { ...DEFAULT_KEYBINDS, ...((merged["keybinds"] ?? {}) as Record<string, string>) };
  for (const [action, binding] of Object.entries(keybinds)) {
    if (binding === "none" || binding === "false") keybinds[action] = ""; // desactivado
  }

  const cursor = (merged["cursor"] ?? {}) as { style?: string; blinking?: boolean };
  return {
    theme: typeof merged["theme"] === "string" ? merged["theme"] : "nicotine-dark",
    leaderTimeout: Number(merged["leader_timeout"] ?? 2000) || 2000,
    keybinds,
    scrollSpeed: Number(merged["scroll_speed"] ?? 3) || 3,
    diffStyle: merged["diff_style"] === "stacked" ? "stacked" : "auto",
    mouse: merged["mouse"] !== false,
    cursor: {
      style: (["block", "line", "underline", "default"].includes(String(cursor.style)) ? cursor.style : "block") as TuiConfig["cursor"]["style"],
      blinking: cursor.blinking !== false,
    },
    layers: layers.map((l) => l.path),
  };
}

/** ¿La tecla coincide con el binding configurado para `action`? */
export function bindingMatches(binding: string | undefined, leader: boolean, key: { name: string; ctrl: boolean; shift: boolean; meta: boolean }): boolean {
  if (!binding) return false;
  return binding.split(",").map((s) => s.trim()).some((candidate) => {
    if (candidate.startsWith("<leader>")) return leader && simpleKeyMatches(candidate.slice(8), key);
    return simpleKeyMatches(candidate, key);
  });
}

function simpleKeyMatches(candidate: string, key: { name: string; ctrl: boolean; shift: boolean; meta: boolean }): boolean {
  // "ctrl+x", "shift+tab", "f2", "return", "c"
  const parts = candidate.toLowerCase().split("+").map((p) => p.trim());
  const name = parts.pop()!;
  const wantCtrl = parts.includes("ctrl");
  const wantShift = parts.includes("shift");
  const wantMeta = parts.includes("meta") || parts.includes("alt");
  const kn = key.name.toLowerCase();
  if (wantCtrl !== key.ctrl || wantShift !== key.shift || wantMeta !== key.meta) return false;
  return kn === name;
}
