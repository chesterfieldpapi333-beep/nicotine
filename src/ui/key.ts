// Teclado normalizado: los motores traducen su formato de tecla propio a esto.
export interface KeyEventLike {
  /** nombre normalizado: "a".."z", "return", "escape", "backspace", "tab", "up"/"down"/"left"/"right", "pageup", "pagedown", "home", "end", "delete", "f2", "space" */
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  /** texto imprimible que llegó en el evento (vacío para teclas de control) */
  sequence: string;
}
