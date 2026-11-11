# Memoria persistente: vault de Obsidian (fase 11a)

`nic` puede recordar decisiones entre sesiones usando tu vault de Obsidian
(o cualquier directorio de notas Markdown). Sin API, sin base de datos:
archivos planos que lee y escribe un agente.

## Activación

```bash
export NICOTINE_VAULT="/ruta/a/obsidian-hermes"   # o en opencode.json(c): "memory": { "vaultPath": "..." }
```

Desactivar: `NICOTINE_MEMORY_OFF=1` o `"memory": { "enabled": false }`.
Sin ambas, el sistema está apagado y no se inyecta nada en el prompt.

## Qué hace

| Pieza | Descripción |
|---|---|
| `vault_search(query, folder?, limit?)` | Busca en notas (nombre y contenido); devuelve `ruta:línea: fragmento`. |
| `vault_read(path)` | Lee una nota (máx 32 KiB). |
| `vault_write(path, content)` | Crea/sobreescribe dentro de zonas permitidas; frontmatter mínimo automático. |
| Digest | Bloque corto (≤8 KiB) en el system prompt: decisiones recientes (`01-Decisiones`), contexto reciente (`03-Contexto`) y reglas de uso. |

## Zonas de escritura

Por defecto: `00-Inbox/`, `01-Decisiones/`, `03-Contexto/`.
**`02-Sesiones/` está reservada y NUNCA se escribe** (sigue siendo de la
herramienta de volcado de sesiones). Override: `"memory": { "vaultWriteZones": ["00-Inbox"] }`
(nunca acepta `02-Sesiones`).

## Seguridad

- Toda ruta se resuelve DENTRO del vault; `..` que escape → error.
- Contenido con patrones de credenciales (`sk-…`, `ghp_…`, `AIza…`, claves privadas,
  `api_key=…`) → rechazado, la nota no se escribe.
- Escritura sobreescribe sin fusionar; no borra nada nunca.
- Nada de esto sube a la red; lectura local solamente.

## Qué recordar / qué no

Buenas notas: decisiones con fecha y motivo, estado del entorno, convenciones.
Malas notas: claves, tokens, datos de clientes, volcados crudos de sesión.

## Diagnóstico

`nic doctor` muestra la ruta resuelta, las zonas de escritura y si está activo.
Si el digest no aparece en el comportamiento del modelo, revisa que
`NICOTINE_MEMORY_OFF` no esté definida y que el path exista (doctor lo dice).
