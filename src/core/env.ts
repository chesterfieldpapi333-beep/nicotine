// Lectura de variables de entorno con alias deprecado vireo → nicotine (fase 10f).
// NICOTINE_<NOMBRE> gana siempre; VIREO_<NOMBRE> se acepta como alias deprecado
// con un aviso único por nombre (va a stderr, nunca a stdout --json).

const warned = new Set<string>();

/** Lee NICOTINE_<NOMBRE>; si falta, acepta VIREO_<NOMBRE> (alias deprecado). */
export function envAlias(name: string): string | undefined {
  const fresh = process.env[`NICOTINE_${name}`];
  if (fresh !== undefined) return fresh;
  const legacy = process.env[`VIREO_${name}`];
  if (legacy !== undefined && !warned.has(name)) {
    warned.add(name);
    try { process.stderr.write(`aviso: VIREO_${name} está deprecada; usa NICOTINE_${name}\n`); } catch { /* sin stderr */ }
  }
  return legacy;
}
