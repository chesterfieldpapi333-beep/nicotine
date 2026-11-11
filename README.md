# nicotine

**nicotine** (`nic`) es un agente de código CLI *lite*: un bucle agéntico completo en
TypeScript sobre Bun, cero dependencias de runtime (solo `@opentui/core` opcional para la
TUI), compatible con el formato `opencode.json(c)`, que lee skills, comandos, temas y
servidores MCP de **Claude Code, Codex CLI, Gemini CLI, OpenCode y Pi**.

- Español en la UI; internamente TypeScript estricto.
- Sin telemetría, sin cuentas, sin servidores obligatorios. `serve` está **apagado por defecto**.
- Permisos siempre explícitos: `allow` / `ask` / `deny`, **deny-wins**, **fail-closed**.
- Herramientas: `bash`, `read`/`edit`/`write`/`glob`/`grep`/`list`, `apply_patch`, `todowrite`,
  `skill`, `task` (subagentes), `lsp` (opt-in), `vault_search`/`vault_read`/`vault_write` (memoria),
  `webfetch`/`websearch`, MCP cliente, ejecución multi-paso con deshacer (`undo`).
- `--solo-bash` (perfil minimal, estilo mini-swe-agent): solo `bash` + solo-lectura
  (`read`/`glob`/`grep`/`webfetch`); sin vault, MCP ni LSP.
- TUI con etiqueta de fase en el footer derivada de la herramienta en marcha
  («analizando…», «editando…», «ejecutando comando…»); toggle `ui.action_stream` (activado por defecto).

## Requisitos

- [Bun](https://bun.sh) ≥ 1.1 (Linux, macOS, Windows con WSL).

## Instalación

```bash
git clone https://github.com/chesterfieldpapi333-beep/nicotine.git
cd nicotine
bun install
chmod +x bin/nic   # si el sistema no preservó el bit
./bin/nic --help
```

Para usarlo en PATH: `bun link` (o symlink `nic` a un directorio de tu PATH).
No hay binarios firmados ni paquetes npm publicados: se ejecuta desde el clone.

## Configuración mínima

`opencode.json(c)` en la raíz del proyecto (o `~/.config/nicotine/opencode.json`):

```jsonc
{
  "provider": {
    "openai": {
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "model": "gpt-4o-mini"
    }
  }
}
```

También por entorno: `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `NICOTINE_MODEL`. Cualquier
endpoint OpenAI-compatible sirve (OpenAI, Nous/FreeLLMAPI, Shchiy, Ollama, llama-swap…).

## Comandos principales

| Comando | Qué hace |
|---|---|
| `nic` | TUI interactiva (por defecto). Headless: `nic -p "…"`, `nic --json` |
| `nic doctor` | Diagnóstico del entorno (config, provider, permisos, vault, tool-call stats) |
| `nic doctor --security [--json]` | Chequeos defensivos: permisos de credenciales, secretos en sesiones/config (redactados), umask, .git/config; exit 0/1 |
| `nic models [--json] [--filter …]` | Lista `/v1/models` del provider con badges tools/censura (heurística conservadora + overrides propios: `nic models override`) |
| `nic download <url>` | Descarga con reintentos/backoff, límite 128 MiB, sha256 (`nic analyze <archivo>` para inspección local) |
| `nic policy export [--readonly]` / `nic policy import <archivo>` | Exporta/importa la política efectiva (defaults→config→`.nicotine/policy.json`→CLI), versionada, deny-wins |
| `nic policy explain <action> <resource> [--json]` | Por qué se permitió/denegó (regla ganadora, origen, reglas cercanas) |
| `nic --readonly` | Sin escrituras: edit/bash/vault-write → deny global (deny-wins, no relajable) |
| `nic --solo-bash` | Perfil «minimal»: solo `bash` + `read`/`glob`/`grep`/`webfetch` |
| `nic serve` | API HTTP compatible OpenCode (**apagada por defecto**; requiere password) |
| `nic audit export` | Vuelca el JSONL de auditoría (opt-in `NICOTINE_AUDIT=1`); sin secretos |

## Memoria persistente (vault de Obsidian)

```bash
export NICOTINE_VAULT="/ruta/a/obsidian-hermes"
```

El agente lee decisiones previas (`01-Decisiones/`), el contexto reciente
(`03-Contexto/`) y te recuerda a escribir (`vault_write`) solo en zonas permitidas
(`00-Inbox/`, `01-Decisiones/`, `03-Contexto/`). `02-Sesiones/` está reservada. Las
credenciales nunca llegan al modelo: se filtran o bloquean (fail-closed). Ver
[`docs/vault-memoria.md`](docs/vault-memoria.md).

## Seguridad (en 4 bullets)

1. **Permisos** allow/ask/deny por `action`/`resource`; deny gana siempre. Default `allow` (última regla gana) salvo `read *.env`/`external_directory` (ask); `--readonly` fuerza edit/bash/vault-write → deny. Sin TTY una regla `ask` rechaza; en TTY preguntá.
2. **Sin telemetría** ni red salvo la que el provider/tus tools configuran; `nic doctor` muestra todo lo que carga.
3. **Credenciales**: fuera del modelo (filtradas en lecturas, rechazadas en escrituras, nunca impresas ni en logs ni en `audit`).
4. **Bloqueo duro de rutas** (`~/.ssh`, `~/.aws`, `~/.gnupg`, cualquier `.git`): ninguna regla puede abrirlas.
   **Análisis destructivo de bash** (`rm`/`dd`/`mkfs`/`curl|sh`/…): fuerza confirmación y gana a cualquier `allow`.
4. **Sin privilegios**: las tools solo tocan lo que sus reglas permiten; una regla `ask` en modo no interactivo se rechaza (no se auto-aprueba; `--auto` es opt-in explícito).

Modelo y límites: [`docs/threat-model.md`](docs/threat-model.md).

## Verificación

```bash
bun install --frozen-lockfile
bun test          # 409 tests; 1 skip (integración live vercel-ai)
bun x tsc --noEmit
bun scripts/check-style.ts
./scripts/verify-release.sh   # instala limpio, corre todo y verifica release/ in-repo
```

El release es el código fuente: `release/SHA256SUMS` (184 archivos) y `release/SBOM.json`
(42 paquetes, generada sin red desde `bun.lock`) están verificables en el tag correspondiente.
Guía: [`docs/release.md`](docs/release.md). Estado de endurecimiento H0–H10 y hallazgo
readonly corregido: [`docs/verification-10f.md`](docs/verification-10f.md).

## Limitaciones honestas

- No publica binarios. El «release» es el código fuente.
- El modelo de permisos es **advisory sobre un modelo cooperativo**, no un sandbox de kernel: para aislar de verdad, corré nicotine dentro de una VM/contenedor. Ver `docs/plan-hardening.md`.
- Paridad con OpenCode: ver `docs/parity.md` (fila por fila).
- `/fusion` no se implementará (decisión 2026-11).

## Licencia

MIT — ver [LICENSE](LICENSE).
