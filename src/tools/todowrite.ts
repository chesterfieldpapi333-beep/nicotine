// todowrite: mantiene la lista de tareas de la sesión (la ve el usuario en la UI).
// Reemplaza el listado completo en cada llamada (como OpenCode).

import type { AgentTool } from "../core/types.js";

export const todowriteTool: AgentTool = {
  name: "todowrite",
  description:
    "Reemplaza la lista de tareas de la sesión. Cada tarea: { content, status: pending|in_progress|completed }. " +
    "Mantén UNA tarea in_progress. Úsala para trabajo de varios pasos.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  permission: { action: "todowrite", resource: () => "*" },
  async run(args, ctx) {
    const todos = (Array.isArray(args.todos) ? args.todos : []) as { content: string; status: string }[];
    const items = todos.map((t) => ({ content: String(t.content), status: (["pending", "in_progress", "completed"].includes(t.status) ? t.status : "pending") as "pending" | "in_progress" | "completed" }));
    ctx.emit({ type: "todos_updated", todos: items });
    const icon = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;
    const done = items.filter((t) => t.status === "completed").length;
    return { output: items.map((t) => `${icon[t.status]} ${t.content}`).join("\n") + `\n(${done}/${items.length} completadas)` };
  },
};
