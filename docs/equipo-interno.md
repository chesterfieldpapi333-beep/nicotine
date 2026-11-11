> **Nota de honesto naming (2026-11-11):** «Claude» en estos docs es el **nombre del rol del mantenedor** (el asistente que estructura y revisa), no una afirmación sobre qué modelo corre detrás en un momento dado — Arena.ai Agent Mode usa varios modelos (entre ellos familias Claude, ChatGPT, Gemini, Grok, Qwen y Kimi). La función es lo que importa: dirección, specs, revisión y release. Cuando quieras fijar un modelo en particular, se nombra el modelo explícitamente en la spec.

# Equipo Claude + DeepSeek DENTRO de nicotine (modo agéntico)

Reparto vigente (dueño, 2026-11-11): **Claude maestro · DeepSeek worker**. Sin GLM ni Gemini.
¿Se puede? Sí, con una condición: ambos modelos comparten el mismo endpoint
OpenAI-compatible (un «gateway»). nicotine soporta agentes con `model` propio; los
subagentes vía `task` heredan `baseURL` y claves de la sesión, pero pinean otro modelo
(ver `src/compat/agent-files.ts`).

```
tu terminal
  └─ nic (maestro: Claude — el modelo de la sesión)
       └─ task → «deepseek-impl» (model: deepseek/...)   ← implementa según spec
```

## 1) El gateway (prerequisito)

UN endpoint OpenAI-compatible que exponga a los dos modelos (router o despliegue propio):

```jsonc
{
  "model": "anthropic/claude-sonnet-4.5",     // maestro
  "provider": {
    "baseURL": "https://openrouter.ai/api/v1",
    "apiKey": "{env:OPENROUTER_API_KEY}"      // nunca hardcodeada
  }
}
```

> Los IDs exactos dependen de TU gateway — verificá su catálogo. `nic doctor` no llama
> a la red; la prueba real es un turno de prueba (`nic -p "hola"`).

## 2) El agente DeepSeek (`.opencode/agents/deepseek-impl.md`)

Copiar `docs/examples/multi-modelo/agents/deepseek-impl.md`. Frontmatter pinado
(`mode: subagent`, `model: deepseek/…`), cuerpo = system prompt con el contrato:
implementa según spec, español, sin dependencias nuevas, nunca toca la superficie
prohibida, «hecho» = tests verdes; spec ambigua → para y reporta.

## 3) Flujo típico

```text
nic "spec: <descripción exacta>.
   1) delegá la implementación a deepseek-impl
   2) al recibir el diff, corré bun test y verificá el reporte
   3) señalá riesgos; el merge lo apruebo yo"
```

Claude (maestro) decide el plan, delega, verifica (suite + lectura del diff) y presenta.
DeepSeek (subagente) spawnea en sesión hija con su modelo y contexto propio; su salida
entra como texto al razonamiento del maestro. **El merge siempre lo aprueba el dueño/Claude;
los workers nunca empujan a master.**

## 4) Límites honestos (leelos)

- **Mismo endpoint para maestro y worker**: si el gateway no tiene el modelo pineado,
  error claro en esa rama (el resto sigue).
- **Sin pipeline declarativo**: la orquestación es conversacional; rondas, reintentos y
  «merge gate» los pedís vos en el prompt.
- **Coste**: cada `task` es una sesión completa del gateway; usá el worker barato para
  lo repetitivo y el maestro para criterio.
- **`--readonly`/`--solo-bash`** aplican a la SESIÓN ENTERA (incluido el maestro); para
  sesiones de delegación escribible, no los uses.
- **Seguridad**: permisos/vault/auth son intocables para el worker; si lo pide, el flujo
  ya está mal. Deny-wins no cambia dentro de `task`.
- **Verify before trust**: el maestro corre `bun test` como paso final y rechaza diffs
  con tests rojos antes de mostrarte el resultado como listo.

## 5) Roadmap posible (no implementado; decisión del dueño)

- `provider.instances`: varios endpoints+claves nombrados (hoy: uno).
- `task` con `verify: "bun test"` declarativo en el agente (hoy: se pide en el prompt).
- Resumen de coste por subagente (hoy: tokens agregados por sesión).

Cada punto toca superficie sensible (config/auth): requiere spec y OK del dueño.
