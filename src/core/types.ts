// Tipos internos compartidos. Un solo lugar para las formas de datos del núcleo.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** ts de persistencia (lo estampa serve/core al persistir; el núcleo lo tolera). */
  ts?: number;
}

export interface ToolParameters {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

// Lo que el modelo ve como "tool" (formato OpenAI chat/completions).
export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: ToolParameters };
}

export interface ToolResult {
  /** Salida corta para el modelo. Mantener concisa: cuesta tokens. */
  output: string;
  metadata?: Record<string, unknown>;
}

export interface AgentTool {
  name: string;
  /** Descripción que ve el modelo; escribe para el modelo, no para humanos. */
  description: string;
  parameters: ToolParameters;
  /** Acción de permiso y recurso por defecto (puede refinarse en run()). */
  permission: { action: string; resource: (args: Record<string, unknown>) => string };
  /** Opcional: devuelve TODOS los recursos afectados (p. ej. apply_patch multi-archivo). */
  permissionResources?: (args: Record<string, unknown>) => string[];
  /** Opcional: calcula diff/preview SIN escribir (para el diálogo de permiso). */
  preview?: (args: Record<string, unknown>, ctx: ToolContext) => Promise<{ diff?: string }>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// Contexto que recibe cada tool: cwd real, señal de abort, y hooks de UI.
export interface ToolContext {
  cwd: string;
  sessionId: string;
  signal: AbortSignal;
  /** Pregunta/confirmación interactiva (la UI la implementa; en no-TTY deniega o auto-aprueba con --auto). */
  ui: UiHooks;
  /** Archivos leídos en esta sesión (edit exige lectura previa). */
  readFiles: Set<string>;
  emit: (event: import("./events.js").AgentEvent) => void;
  /** true dentro de un subagente (task). Permite vetar la recursión. */
  isSubagent?: boolean;
  /** Cambio de agente en caliente (plan-enter/plan-exit y TUI). */
  switchAgent?: (agentId: string) => boolean;
  /** Ejecuta un subagente y devuelve su respuesta final (tool `task`). */
  runSubagent?: (opts: { agentId: string; prompt: string; description: string }) => Promise<string>;
  /** Snapshots para /undo//redo (undefined = deshacer deshabilitado). */
  undo?: import("./undo.js").UndoManager;
  /** Índice de skills ya cargado (tool `skill`); ausente en contextos sin compat. */
  skills?: import("../compat/skills.js").SkillIndex;
  /** false desactiva el rescate de tool-calls en texto (config `compat.text_tool_calls: false`). Por defecto activado. */
  textToolCalls?: boolean;
  /** Hooks de otras CLIs (fase 7). preTool → razón de bloqueo o null; postTool → void. */
  hooks?: {
    preTool?(tool: string, args: Record<string, unknown>): Promise<string | null>;
    postTool?(tool: string, args: Record<string, unknown>): Promise<void>;
  };
  /** Persistencia del "always" de permisos, alcance proyecto (XDG data, nunca en el repo). */
  approvals?: { save(action: string, resource: string): void };
}

export interface UiHooks {
  /** Pide confirmación de permiso. Devuelve "once" | "always" | "reject". */
  confirm(req: PermissionRequest): Promise<PermissionDecision>;
  /** Pregunta al usuario (tool `question`). */
  question(questions: QuestionPrompt[]): Promise<string[] | null>;
  /** Log informativo no fatal (se muestra en stderr en modos texto). */
  info(text: string): void;
}

export interface PermissionRequest {
  action: string;
  resource: string;
  /** Diff unificado opcional para mostrarlo ANTES de pedir permiso (spec edit/write). */
  diff?: string;
  /** Patrón que se guardará si el usuario elige «siempre» (carpeta/* para rutas; el recurso exacto si no). Informativo. */
  alwaysPattern?: string;
}

export type PermissionDecision = "once" | "always" | "reject";

export interface QuestionPrompt {
  header: string;
  question: string;
  options: string[];
  multiple?: boolean;
  /** Oculta el texto tecleado (p. ej. API keys) con «*». */
  mask?: boolean;
}
