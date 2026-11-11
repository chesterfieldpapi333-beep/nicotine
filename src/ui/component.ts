// Contrato de componente (spec): render(width) → líneas ANSI; onKey opcional.
// Todo render/onKey va envuelto en try/catch: una extensión rota no tumba la terminal.

import type { KeyEventLike } from "./key.js";

export interface Component {
  render(width: number): string[];
  onKey?(key: KeyEventLike): boolean;
}

export function safeRender(component: Component, width: number): string[] {
  try {
    const lines = component.render(width);
    return Array.isArray(lines) ? lines : ["（render() devolvió algo que no es string[])"];
  } catch (err) {
    return [`⚠ componente roto: ${(err as Error).message}`];
  }
}

export function safeOnKey(component: Component, key: KeyEventLike): boolean {
  try {
    return !!component.onKey?.(key);
  } catch (err) {
    console.error(`[nicotine] onKey roto: ${(err as Error).message}`);
    return false;
  }
}
