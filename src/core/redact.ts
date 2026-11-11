// Redacción de credenciales en superfícies persistidas (sesión JSONL, auditoría).
// No toca el contexto vivo del modelo ni la terminal del usuario.

const REPLACERS: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{8,}/g, "sk-***"],
  [/github_pat_[A-Za-z0-9_]{10,}/g, "github_pat_***"],
  [/gh[opsur]_[A-Za-z0-9]{10,}/g, "gh*_***"],
  [/AIza[0-9A-Za-z_-]{10,}/g, "AIza***"],
  [/xox[baprs]-[0-9A-Za-z-]{8,}/g, "xox*-***"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[clave privada redactada]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "eyJ***"],
  [/(https?:\/\/)[^\/\s"'@]*@/g, "$1***@"],
  [/\b((?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']?)[A-Za-z0-9_\-./+]{12,}/gi, "$1***"],
];

/** Devuelve `text` con cada patrón de credencial sustituido por un marcador `***`. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, repl] of REPLACERS) out = out.replace(re, repl);
  return out;
}
