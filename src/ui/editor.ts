// Editor del prompt: líneas + cursor, inserción/borrado/movimiento.
// Enter = submit (lo decide quien integra), este módulo solo mantiene estado y texto.

export class EditorState {
  lines: string[] = [""];
  row = 0;
  col = 0;

  buffer(): string { return this.lines.join("\n"); }
  isEmpty(): boolean { return this.buffer().trim().length === 0; }
  clear(): void { this.lines = [""]; this.row = 0; this.col = 0; }

  insert(text: string): void {
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const line = this.lines[this.row];
      this.lines[this.row] = line.slice(0, this.col) + parts[i] + line.slice(this.col);
      this.col += parts[i].length;
      if (i < parts.length - 1) {
        const rest = this.lines[this.row].slice(this.col);
        this.lines[this.row] = this.lines[this.row].slice(0, this.col);
        this.lines.splice(this.row + 1, 0, rest);
        this.row++;
        this.col = 0;
      }
    }
  }

  insertNewline(): void { this.insert("\n"); }

  backspace(): void {
    if (this.col > 0) {
      const line = this.lines[this.row];
      this.lines[this.row] = line.slice(0, this.col - 1) + line.slice(this.col);
      this.col--;
    } else if (this.row > 0) {
      const prev = this.lines[this.row - 1];
      this.col = prev.length;
      this.lines[this.row - 1] = prev + this.lines[this.row];
      this.lines.splice(this.row, 1);
      this.row--;
    }
  }

  deleteRight(): void {
    const line = this.lines[this.row];
    if (this.col < line.length) {
      this.lines[this.row] = line.slice(0, this.col) + line.slice(this.col + 1);
    } else if (this.row < this.lines.length - 1) {
      this.lines[this.row] = line + this.lines[this.row + 1];
      this.lines.splice(this.row + 1, 1);
    }
  }

  deleteWordBackward(): void {
    const line = this.lines[this.row];
    let i = this.col;
    while (i > 0 && line[i - 1] === " ") i--;
    while (i > 0 && line[i - 1] !== " ") i--;
    this.lines[this.row] = line.slice(0, i) + line.slice(this.col);
    this.col = i;
  }

  deleteToLineEnd(): void { this.lines[this.row] = this.lines[this.row].slice(0, this.col); }
  deleteToLineStart(): void {
    const line = this.lines[this.row];
    this.lines[this.row] = line.slice(this.col);
    this.col = 0;
  }

  moveLeft(): void { if (this.col > 0) this.col--; else if (this.row > 0) { this.row--; this.col = this.lines[this.row].length; } }
  moveRight(): void { const line = this.lines[this.row]; if (this.col < line.length) this.col++; else if (this.row < this.lines.length - 1) { this.row++; this.col = 0; } }
  moveUp(): void { if (this.row > 0) { this.row--; this.col = Math.min(this.col, this.lines[this.row].length); } }
  moveDown(): void { if (this.row < this.lines.length - 1) { this.row++; this.col = Math.min(this.col, this.lines[this.row].length); } }
  moveHome(): void { this.col = 0; }
  moveEnd(): void { this.col = this.lines[this.row].length; }

  wordForward(): void {
    const line = this.lines[this.row];
    let i = this.col;
    while (i < line.length && line[i] === " ") i++;
    while (i < line.length && line[i] !== " ") i++;
    this.col = i;
  }
  wordBackward(): void {
    const line = this.lines[this.row];
    let i = this.col;
    while (i > 0 && line[i - 1] === " ") i--;
    while (i > 0 && line[i - 1] !== " ") i--;
    this.col = i;
  }

  /** Línea visible (con wrap blando NO aplicado; la UI hace su propio wrap) */
  logicalLines(): string[] { return [...this.lines]; }
}
