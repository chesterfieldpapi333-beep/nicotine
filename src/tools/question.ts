// question: pausa y pregunta al usuario (una o más preguntas con opciones).
// La UI decide cómo mostrarla (flat: readline numerado; TUI: diálogo en fase 2).
// En modo no interactivo devuelve null y el modelo debe seguir sin respuesta.

import type { AgentTool } from "../core/types.js";
import type { QuestionPrompt } from "../core/types.js";

export const questionTool: AgentTool = {
  name: "question",
  description:
    "Pregunta al usuario y espera respuesta. Cada pregunta: { header, question, options[], multiple? }. " +
    "Úsala solo cuando la decisión sea del usuario y no puedas inferirla del código o del prompt.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            header: { type: "string", description: "Etiqueta corta (≤ 30 chars)." },
            question: { type: "string" },
            options: { type: "array", items: { type: "string" }, description: "Opciones (el usuario siempre puede responder libre)." },
            multiple: { type: "boolean" },
          },
          required: ["header", "question", "options"],
        },
      },
    },
    required: ["questions"],
  },
  permission: { action: "question", resource: () => "*" },
  async run(args, ctx) {
    const raw = Array.isArray(args.questions) ? args.questions : [];
    const questions: QuestionPrompt[] = raw.map((q: any) => ({
      header: String(q?.header ?? "pregunta"),
      question: String(q?.question ?? ""),
      options: Array.isArray(q?.options) ? q.options.map(String) : [],
      multiple: !!q?.multiple,
    }));
    if (!questions.length) throw new Error("se requiere al menos una pregunta");
    const answers = await ctx.ui.question(questions);
    if (!answers) return { output: "El usuario no respondió (modo no interactivo). Decide tú o termina el turno." };
    return { output: questions.map((q, i) => `${q.header}: ${answers[i] ?? "(sin respuesta)"}`).join("\n") };
  },
};
