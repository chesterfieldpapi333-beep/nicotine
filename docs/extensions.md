# Extensiones de Vireo

Una **extensión** es un módulo `.ts`/`.js` que Vireo carga al arrancar (después de la
config, antes del primer turno) y que recibe una API pequeña para registrar tools,
comandos, atajos y elementos de UI. Es diseño propio, inspirado en —no compatible con—
la API de plugins de OpenCode.

> ¿Buscas un punto de partida? Copia [`examples/extensions/shout.ts`](../examples/extensions/shout.ts).

## Dónde se instalan

| Origen | Ubicación | ¿Confianza? |
|---|---|---|
| global | `~/.config/vireo/extensions/<nombre>.ts` | Sí, no pregunta |
| proyecto | `<raíz o subdir>/.vireo/extensions/<nombre>.ts` | **No** — pide confirmación **antes de importarse** |
| config | `"extensions": ["./ruta/ext.ts", "./carpeta/con/extensiones"]` en `opencode.json(c)` | hereda la capa de la config; descartado → «project» → pregunta |

- El descubrimiento de proyecto recorre de la **raíz → cwd** (hereda directorios padres, igual que los context files).
- IDs duplicados: **la última fuente gana** con aviso en el log (config > proyecto > global).
- `doctor` **lista** extensiones descubiertas y **nunca las importa** (no ejecuta código).

## Compuerta de confianza

Importar una extensión **ejecuta su código al arranque**, así que la de proyecto pide
confirmación **una vez por extensión y sesión**, mostrando la ruta absoluta. Sin
confirmación la extensión se omite (`untrusted`) y **el módulo nunca se importa**.
`--auto` aprueba con aviso en el log; sin TTY se rechaza (igual que MCP). El diálogo
muestra qué se ahorraría: rutas y nada más.

## Ciclo de vida

1. Descubrimiento (lista archivos; no importa nada).
2. Compuerta por extensión (solo origen proyecto).
3. `import()` del módulo (`export default function activate(api)`, o
   `export function activate(api)`, o `export function setup(api)`).
4. `activate(api)` corre dentro de un `try/catch`: un fallo reporta
   `status: "failed"` en el log y **no tumba a las demás extensiones**.
5. Las tools registradas se añaden al runtime **solo si `activate` terminó bien**.

## API

```ts
import type { ExtensionAPI } from "vireo/ext/api";

export default function activate(api: ExtensionAPI) { /* ... */ }
```

| Miembro | Qué hace | Modos |
|---|---|---|
| `api.id` / `api.dir` / `api.source` / `api.cwd` | metadatos | todos |
| `api.log(text)` | log informativo (stderr en planos; línea de info en TUI) | todos |
| `api.on(event \| "*", handler) → unsubscribe` | suscribe al bus de eventos del núcleo (`turn_end`, `tool_start`, `tool_end`, …) | todos |
| `api.registerTool(tool)` | registra una tool del agente | todos |
| `api.registerCommand(cmd)` | comando slash `/nombre` (sin `/`); `cmd.run(app, rawArgs)` recibe **el resto de la línea crudo** | **solo TUI** |
| `api.registerShortcut(key, handler)` | atajo con modificador, p. ej. `"ctrl+g"`, `"alt+f2"` | **solo TUI** |
| `api.ui.setSlot(slot, component \| null)` | sustituye un slot renderizable | **solo TUI** |
| `api.ui.addWidget(component)` | añade un componente al strip de widgets | **solo TUI** |
| `api.ui.setTheme(theme)` | registra un tema (tokens sobre `vireo-dark`) y lo aplica | **solo TUI** |
| `api.ui.refresh()` | fuerza un render (p. ej. tras cambiar un widget por tiempo) | **solo TUI** |

Fuera de la TUI (`--print`, `--json`, REPL) lo marcado «solo TUI» se ignora con un
aviso; `tools` y `on(...)` funcionan igualmente.

### Tools

```ts
api.registerTool({
  name: "ext_shout",            // nombre completo, tal cual (sin prefijo automático)
  description: "Devuelve el texto en MAYÚSCULAS…",   // escribe para el modelo
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  permission: { action: "ext_shout", resource: () => "ext_shout" }, // siempre pasa por el motor de permisos
  async run(args) { return { output: String(args.text ?? "").toUpperCase() }; },
});
```

Toda tool de extensión pasa por el **mismo motor de permisos** que las builtins
(`deny` > `ask` > `allow`), incluido el diálogo con diff si define `preview(...)`.
Si eliges «permitir siempre» en el diálogo, el patrón guardado se muestra en el propio
diálogo antes de guardar (ver «Aprobaciones persistentes»).

### Comandos

- Nombre saneado a `[a-zA-Z0-9_-]`; inválido → descartado con aviso.
- **Los builtins ganan**: si tu comando se llama igual que uno del núcleo, el tuyo se ignora.
- `rawArgs` es el resto de la línea sin parsear (p. ej. `/shout hola mundo` → `rawArgs = "hola mundo"`).
- Aparecen en autocompletado de `/` y en la paleta (`ctrl+p`).

### Atajos

- Exigen **ctrl y/o alt**: `"ctrl+g"`, `"alt+enter"` no — solo letras/dígitos y `f1`–`f12`
  (`"ctrl+enter"`, `"ctrl+tab"` se rechazan para no robar teclas del núcleo).
- **shift no se compara**: `ctrl+shift+g` dispara el atajo de `ctrl+g`.
- Se evalúan **después de los builtins** (no pisan `ctrl+x`, `ctrl+p`, `ctrl+l`, …).
- `alt+` solo dispara si alt está presente; los modificadores coinciden en ambos sentidos.

### Slots

Slots renderizables (`render(width): string[]`), **solo lectura** (sin `onKey` en v1):

| Slot | Dónde se pinta | Tope de líneas |
|---|---|---|
| `header` | sobre la línea de cabecera | 3 |
| `messages` | tras el último mensaje del turno | 5 |
| `widgets` | sobre el separador del editor | 2 |
| `editor` | entre el autocompletado y el editor | 3 |
| `footer` | bajo la línea de estado | 2 |

- El slot **suma** filas; nunca reemplaza la cabecera/editor/estado del núcleo.
  `messages` añade filas tras el historial — no toca el historial.
- `null` limpia el slot.
- Cualquier excepción del `render()` la atrapa `safeRender`: el componente queda
  fuera de este frame y el TUI sigue vivo.

### Widgets

`addWidget(component)` apila componentes sobre el separador; tope global **2 líneas**.
Para un estado dinámico (reloj, contador), llama a `api.ui.refresh()` desde tu propio
timer.

### Temas

`api.ui.setTheme({ name, tokens })` — tokens sobre `vireo-dark`; registro parcial OK.
Si el registro falla (p. ej. tokens inválidos), no se aplica.

### Eventos

`api.on("turn_end" | "tool_start" | "tool_end" | "error" | … | "*", handler)`
devuelve la función para desuscribirse. Errores en handlers **no** tumban el loop:
se atrapan y se reportan.

## Aprobaciones persistentes ("siempre") por proyecto

Elegir **siempre** en el diálogo de permisos guarda el patrón
(`<carpeta>/*` para `read`/`edit`/`write`/`list`; el recurso exacto para `bash` y el
resto) en `$XDG_DATA_HOME/vireo/approvals/<sha1(cwd)>.json` — **fuera del repo**,
nunca en git. El motor re-evalúa `deny` **después** de aplicar estos allows: un
"siempre" jamás pisa un deny configurado. El diálogo muestra qué patrón se guardará.

## Limitaciones v1 (explícitas)

- Sin `onKey` en componentes; slots/widgets son render-only.
- Sin permisos declarativos por extensión ni sandbox: la compuerta de confianza **es** la frontera.
- `splitArgs` de comandos con `:` (p. ej. prompts MCP `/servidor:prompt`) soporta comillas simples/dobles, no escapes `\"`.
- El diálogo de confianza de proyecto se repite **cada sesión** (no persiste «confiar siempre en esta extensión»).
- Las extensiones de proyecto no se pueden usar headless sin `--auto` (sin TTY → rechazadas por defecto).
- No hay recarga en caliente (`/reload`): cambia el archivo y reinicia Vireo.

## Probar la tuya de punta a punta

```bash
VIREO_MOCK_SCENARIO=extshout vireo --auto --print "usa la extensión"
# → el modelo pide ext_shout {text:"vireo"} y recibe "VIREO" sin APIs reales.
```

Y `doctor` (sin ejecutar nada) lista lo descubierto:

```
Extensiones (1, sin ejecutar — doctor no las importa):
  ! shout  [project] /ruta/absoluta/.vireo/extensions/shout.ts — pide confirmación al arrancar
```

## Referencia

- Implementación: `src/ext/api.ts` (tipos), `src/ext/loader.ts` (descubrimiento/compuerta/activación).
- Extensión mínima completa: `examples/extensions/shout.ts`.
