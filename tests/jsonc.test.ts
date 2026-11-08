import { describe, test, expect } from "bun:test";
import { parseJsonc, stripJsonc } from "../src/util/jsonc.js";

describe("jsonc", () => {
  test("quita comentarios de línea y bloque", () => {
    const src = `{
      // comentario
      "a": 1, /* bloque */ "b": 2,
    }`;
    expect(parseJsonc(src)).toEqual({ a: 1, b: 2 });
  });
  test("URLs dentro de strings no se toman como comentarios", () => {
    const src = `{ "url": "https://example.com/path//deep" }`;
    expect((parseJsonc(src) as any).url).toBe("https://example.com/path//deep");
  });
  test("comas colgantes", () => {
    expect(parseJsonc(`{ "a": [1, 2,], "b": { "c": 3, }, }`)).toEqual({ a: [1, 2], b: { c: 3 } });
  });
  test("error con contexto de archivo", () => {
    expect(() => parseJsonc("{ roto", "demo.jsonc")).toThrow(/demo\.jsonc/);
  });
  test("stripJsonc respeta strings con escapes", () => {
    expect(() => parseJsonc(`{ "a": "\\" // no es comentario }" }`)).not.toThrow();
  });
});
