// Tests del decoder ANSI (decodeAnsiKeys) — incluye ratón SGR (1006).
import { test, expect, describe } from "bun:test";
import { decodeAnsiKeys } from "../src/ui/ansi.js";

const enc = (s: string) => Buffer.from(s, "utf8");

describe("decodeAnsiKeys", () => {
  test("rueda SGR: \x1b[<64;10;20M → wheelup, <65... → wheeldown", () => {
    expect(decodeAnsiKeys(enc("\x1b[<64;10;20M")).map((k) => k.name)).toEqual(["wheelup"]);
    expect(decodeAnsiKeys(enc("\x1b[<65;10;20M")).map((k) => k.name)).toEqual(["wheeldown"]);
    expect(decodeAnsiKeys(enc("\x1b[<66;10;20M")).map((k) => k.name)).toEqual(["unknown"]); // wheel izq: ignorada
    expect(decodeAnsiKeys(enc("\x1b[<64;10;20m")).map((k) => k.name)).toEqual(["unknown"]); // release: ignorada
  });

  test("clicks SGR se ignoran (unknown), no rompen el stream", () => {
    expect(decodeAnsiKeys(enc("\x1b[<0;5;5M")).map((k) => k.name)).toEqual(["unknown"]);
    expect(decodeAnsiKeys(enc("\x1b[<0;5;5m")).map((k) => k.name)).toEqual(["unknown"]);
    expect(decodeAnsiKeys(enc("\x1b[<2;30;24M")).map((k) => k.name)).toEqual(["unknown"]);
  });

  test("rueda + texto en el mismo chunk: ambos se decodifican", () => {
    const keys = decodeAnsiKeys(enc("a\x1b[<64;1;1Mb"));
    expect(keys.map((k) => k.name)).toEqual(["a", "wheelup", "b"]);
  });

  test("secuencias CSI básicas siguen funcionando", () => {
    expect(decodeAnsiKeys(enc("\x1b[A")).map((k) => k.name)).toEqual(["up"]);
    expect(decodeAnsiKeys(enc("\x1b[5~")).map((k) => k.name)).toEqual(["pageup"]);
    expect(decodeAnsiKeys(enc("\x1b[1;5A")).map((k) => [k.name, k.ctrl])).toEqual([["up", true]]);
  });
});
