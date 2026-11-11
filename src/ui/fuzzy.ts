// Búsqueda difusa compartida (TUI «@» autocomplete y serve /find/file).
// Subsecuencia con bonificación por inicio de palabra y rachas; sin deps.

export function fuzzyFilter(items: string[], query: string, limit = 50): string[] {
  if (!query) return items.slice(0, limit);
  const q = query.toLowerCase();
  const scored: { s: string; score: number }[] = [];
  for (const item of items) {
    const score = subsequenceScore(item.toLowerCase(), q);
    if (score >= 0) scored.push({ s: item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.s);
}

function subsequenceScore(item: string, q: string): number {
  let qi = 0, score = 0, lastIdx = -2;
  for (let i = 0; i < item.length && qi < q.length; i++) {
    if (item[i] === q[qi]) {
      score += i === lastIdx + 1 ? 10 : 1;     // bonus por consecutivos
      if (i === 0 || "/-_.".includes(item[i - 1])) score += 5; // bonus tras separador
      lastIdx = i;
      qi++;
    }
  }
  return qi === q.length ? score - item.length * 0.01 : -1;
}
