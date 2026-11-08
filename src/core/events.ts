// Eventos del núcleo. El núcleo NUNCA imprime: emite estos eventos y cualquier
// UI (flat, TUI, serve, --json) se suscribe. Esto es lo que permite reutilizar
// el mismo flujo en todos los modos.

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_end"; id: string; name: string; output: string; isError: boolean; durationMs: number }
  | { type: "turn_end"; reason: "stop" | "max_steps" | "aborted"; usage?: TokenUsage }
  | { type: "error"; message: string }
  | { type: "todos_updated"; todos: TodoItem[] }
  | { type: "session_saved"; sessionId: string };

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export type EventListener = (event: AgentEvent) => void;

// Emitter minimalista (sin dependencias). setMaxListeners alto a propósito:
// la TUI y los widgets se suscriben libremente.
export class EventBus {
  private listeners = new Set<EventListener>();
  on(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(event: AgentEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(event);
      } catch (err) {
        // Una UI rota no debe tumbar el loop del agente.
        console.error(`[vireo] suscriptor de eventos falló: ${(err as Error).message}`);
      }
    }
  }
}
