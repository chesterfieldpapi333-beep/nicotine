// API pública de extensiones de Nicotine (diseño propio, lite).
// Una extensión = un módulo .ts/.js con `export default function activate(api)`
// (o `export function activate(api)` / `export function setup(api)`). Se carga en el arranque, DESPUÉS de la
// config y ANTES del primer turno. Errores de una extensión no tumban las demás.
//
// Confianza (igual que MCP): extensiones de proyecto o de capas de proyecto
// piden confirmación UNA vez por extensión y sesión; sin TTY → se omiten;
// --auto → aprueba con aviso. Las globales (~/.config/nicotine/extensions) no preguntan.
//
// Fuera de la TUI, los comandos/atajos/slots/temas son no-op con aviso;
// tools y `on(...)` funcionan en todos los modos.

import type { AgentTool } from "../core/types.js";
import type { AgentEvent } from "../core/events.js";
import type { Component } from "../ui/component.js";
import type { Theme } from "../ui/theme.js";

export type SlotName = "header" | "messages" | "widgets" | "editor" | "footer";

/** Lo mínimo que una extensión puede hacer con la app (tipado laxo a propósito). */
export interface ExtAppLike {
  info(text: string): void;
  error(text: string): void;
  requestRender(): void;
}

export interface ExtCommand {
  /** nombre slash sin / (p. ej. "wordcount"). Las extensiones no pisan builtins. */
  name: string;
  hint: string;
  run: (app: ExtAppLike, rawArgs: string) => void | Promise<void>;
}

/** Puente a la UI (lo implementa la TUI; en modos planos no existe). */
export interface UiBridge {
  registerCommand(cmd: { name: string; hint: string; run: (app: ExtAppLike, rawArgs: string) => void | Promise<void> }): void;
  registerShortcut(spec: { ctrl: boolean; alt: boolean; name: string }, handler: () => void): void;
  setSlot(slot: SlotName, component: Component | null): void;
  addWidget(component: Component): void;
  registerTheme(theme: Theme): boolean;
  applyTheme(name: string): boolean;
  refresh(): void;
  /** App real (para ExtAppLike). */
  app: ExtAppLike;
}

export interface ExtensionAPI {
  readonly id: string;
  /** Directorio del archivo de la extensión. */
  readonly dir: string;
  /** Descripción de origen para logs (ruta). */
  readonly source: string;
  readonly cwd: string;
  /** Log informativo (stderr en flat; línea de info en TUI). */
  log(text: string): void;
  /** Suscribe al bus de eventos del núcleo ("*" = todos). Devuelve unsubscribe. */
  on(event: AgentEvent["type"] | "*", handler: (ev: AgentEvent) => void): () => void;
  /** Registra una tool con el nombre completo que quieras (p. ej. `ext_shout`; no se antepone ningún prefijo). */
  registerTool(tool: AgentTool): void;
  /** Slash command (solo TUI). */
  registerCommand(cmd: ExtCommand): void;
  /** Atajo con modificador, p. ej. "ctrl+g" (solo TUI). Sin modificador → rechazado. */
  registerShortcut(key: string, handler: () => void): void;
  ui: {
    /** Sustituye (o limpia con null) un slot renderizable: header|messages|widgets|editor|footer. */
    setSlot(slot: SlotName, component: Component | null): void;
    /** Añade un componente al strip de widgets (sobre el separador del editor). */
    addWidget(component: Component): void;
    /** Registra un tema (tokens sobre nicotine-dark) y lo aplica. */
    setTheme(theme: Theme): void;
    /** Fuerza un render (p. ej. tras cambiar un widget por tiempo). */
    refresh(): void;
  };
}

/** Resultado de carga (para doctor y logs). */
export interface ExtensionReport {
  id: string;
  source: string;
  origin: "system" | "global" | "project" | "custom";
  status: "loaded" | "failed" | "untrusted" | "skipped";
  tools: number;
  commands: number;
  error?: string;
}
