// Extensión de referencia de Nicotine (mínima pero completa).
//
// Instalación (elige una):
//   · por proyecto:  copia este archivo a  <raíz>/.nicotine/extensions/shout.ts
//       → pide confirmación UNA vez por sesión antes de importarse (ejecuta código).
//   · global:        cp a  ~/.config/nicotine/extensions/shout.ts
//       → no pide confirmación (confías en tu propia carpeta).
//   · por config:    "extensions": ["./ruta/shout.ts"]  en opencode.json
//       → el origen manda (capa sistema/global/proyecto).
//
// En la TUI:  /shout hola mundo   (comando de extensión; los builtins ganan en colisiones)
// En headless: las tools y on(...) funcionan; los registros de UI se ignoran con aviso.
//
// E2E con el proveedor falso:
//   NICOTINE_MOCK_SCENARIO=extshout nicotine --auto --print "usa la extensión"
//   → el modelo pide ext_shout {text:"nicotine"} y recibe "NICOTINE".

import type { ExtensionAPI } from "../../src/ext/api.js";

export default function activate(api: ExtensionAPI): void {
  api.on("turn_end", () => api.log("turno terminado"));

  api.registerTool({
    name: "ext_shout",
    description: "Devuelve el texto en MAYÚSCULAS. Úsala cuando el usuario pida «gritar» o pasar algo a mayúsculas.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "Texto a convertir a mayúsculas" } },
      required: ["text"],
      additionalProperties: false,
    },
    permission: { action: "ext_shout", resource: () => "ext_shout" },
    async run(args) {
      return { output: String(args.text ?? "").toUpperCase() };
    },
  });

  api.registerCommand({
    name: "shout",
    hint: "/shout <texto> — registra el texto EN MAYÚSCULAS en el log",
    run: (app, raw) => app.info(String(raw ?? "").toUpperCase() || "(nada que gritar)"),
  });

  // Barra de estado mínima sustituible: nicotine-ext listo · ext_shout
  api.ui.setSlot("footer", {
    render(width: number): string[] {
      const line = "nicotine-ext · listo · ext_shout";
      return [line.length > width ? line.slice(0, width) : line];
    },
  });
}
