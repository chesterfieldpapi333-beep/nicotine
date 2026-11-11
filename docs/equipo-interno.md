# Equipo multi-modelo DENTRO de nicotine (modo agéntico)

¿Se puede? **Sí, con una condición**: todos los modelos del equipo comparten el mismo
endpoint OpenAI-compatible (un «gateway»). nicotine soporta agentes con `model` propio
(los subagentes vía la tool `task` heredan el `baseURL` y las claves del proveedor de la
sesión, pero pueden pinear otro modelo — ver `src/compat/agent-files.ts`).

Arquitectura resultante (todo in-session, sin services nuevos):

```
tu terminal
  └─ nic (modelo maestro: el de la sesión, p. ej. Claude/GPT-class)
       ├─ task → worker «deepseek-impl» (model: deepseek/...)  ← programa
       ├─ task → worker «glm-impl»      (model: glm/...)       ← programa
       └─ task → «gemini-analista»      (model: gemini/...)    ← analiza (solo lee)
```

## 1) El gateway (prerequisito)

Necesitás UN endpoint OpenAI-compatible que exponga todos los modelos: un router
(OpenRouter, Together, Novita, llama-swap local con varios modelos, etc.).
`opencode.json(c)` del proyecto:

```jsonc
{
  "model": "anthropic/claude-sonnet-4.5",          // el «maestro» de la sesión
  "provider": {
    "baseURL": "https://openrouter.ai/api/v1",
    "apiKey": "{env:OPENROUTER_API_KEY}",           // nunca hardcodeada; {env:VAR} aceptado
    "fallbackModels": ["anthropic/claude-opus-4.1"] // opcional; ver docs de compat.refusal_failover
  }
}
```

> Los `model` de cada agente se pasan al endpoint tal cual (se descartan prefijo
> `vendor/` y `#variante`): los IDs exactos dependen de TU gateway — verificá su
> catálogo antes de fijarlos. `nic doctor` no llama a la red; la primera prueba real es
> un turno de prueba (`nic -p "hola"`).

## 2) Definir el equipo: archivos de agente del proyecto

Ejemplos bajo `docs/examples/multi-modelo/agents/` (copiá a `.opencode/agents/`):

- `deepseek-impl.md` — implementador (puede escribir)
- `glm-impl.md` — segundo implementador (puede escribir)
- `gemini-analista.md` — analista (**solo lectura**: tools limitadas)

El frente `tools:` del frontmatter se traduce a `toolAllow`; el analista recibe
exactamente `[read, glob, grep, list, webfetch]` — no puede escribir, no puede correr
bash, aunque el resto de la sesión lo tenga permitido. deny-wins sigue intacto: las
reglas del proyecto pueden además restringir al equipo completo.

## 3) Flujo típico

```text
nic -m anthropic/claude-sonnet-4.5 "tarea: implementá D1 (tests adversariales bash-parser)
   1) delegá la implementación a deepseek-impl
   2) delegá la revisión del diff a gemini-analista
   3) resumí el diff + el informe del analista; NO mergees vos"
```

El maestro decide, los workers ejecutan en sesiones hijas (JSONL propias, contexto
propio), el analista devuelve un informe. El **merge siempre lo hacés vos** (o el
mantenedor en PRs): nicotine no mergea nada solo — los workers nunca empujan a master.

## 4) Límites honestos (leelos)

- **Mismo endpoint para todos**: no hay por-agente `baseURL`. Un gateway sin el modelo
  que pineaste ⇒ error claro del provider en esa rama (los demás siguen).
- **Sin orquesta-ción declarativa** (no hay YAML de pipeline): la coordinación es
  conversacional vía `task`; rondas, votación y «merge gate» los pedís vos en el prompt.
- **Coste**: cada `task` es una sesión entera del gateway; DeepSeek/GLM baratos +
  maestro caro es la asimetría correcta; el analista con contexto completo puede salir caro.
- **Denegaciones**: lo que un worker pida por `ask` y vos rechazaste no lo hereda el otro;
  `--auto` aprueba UNA vez por sesión, nunca persiste a master.
- **`--solo-bash` y `--readonly`** aplican a la SESIÓN ENTERA, incluido el maestro y los
  subagentes. Para un worker escribible no uses `--readonly` en la sesión maestro.
- **Verify before trust**: los workers no ejecutan tests por sí mismos salvo que su tools
  lo permitan; pedile al maestro que corra `bun test` como paso final y que rechace diffs
  con tests rojos.
- **Invariantes de seguridad**: permisos, vault, auth, `src/security` y `bash-parser` son
  intocables para cualquier worker; si un worker lo pide, el flujo YA está mal.

## 5) Roadmap posible (no implementado; decisión del dueño)

- `provider.instances` en config: varios endpoints+claves nombrados (hoy: uno).
- `task` con `verify: "bun test"` declarativo en el agente (hoy: pedilo en el prompt).
- Resumen automático del coste por subagente (hoy: `tokens` agregado por sesión).

Cada punto es media jornada aproximado y toca superficie sensible (config/auth): requiere
espec y OK del dueño antes de tocar `src/`.
