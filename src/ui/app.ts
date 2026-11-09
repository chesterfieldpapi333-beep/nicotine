// TuiApp: estado + composición del frame + teclado. No dibuja directamente:
// devuelve líneas ANSI y una posición de cursor; los engines hacen el resto.

import { EditorState } from "./editor.js";
import type { KeyEventLike } from "./key.js";
import { fgHex, token, reset, bold, dimmed, type Theme } from "./theme.js";
import { wrapMessage, oneLine, type DisplayMessage } from "./components.js";
import { applyDiffStyle } from "./diff-style.js";
import { visibleWidth, stripAnsi, fitAnsi } from "./ansi-wrap.js";
import { bindingMatches, type TuiConfig } from "./tui-config.js";
import type { TodoItem } from "../core/events.js";
import type { PermissionRequest, PermissionDecision, QuestionPrompt } from "../core/types.js";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeRender, type Component } from "./component.js";
import type { SlotName } from "../ext/api.js";

export interface SlashCommand {
  name: string;
  hint: string;
  /** `rawArgs` = texto tras el nombre (puede ser ""). Los comandos builtins lo ignoran. */
  run: (app: TuiApp, rawArgs?: string) => void;
}

export interface TuiAppDeps {
  theme: Theme;
  setTheme: (name: string) => void;
  tui: TuiConfig;
  cwd: string;
  themes: string[];
  commands: SlashCommand[];
  /** Ejecuta un turno del agente (async, no bloquea el render). */
  submit: (prompt: string) => void;
  abortTurn: () => void;
  cycleAgent: () => string;
  newSession: () => { id: string };
  switchSession: (id: string) => boolean;
  listSessions: () => { id: string; title: string }[];
  fetchModels: () => Promise<string[] | null>;
  setModel: (model: string) => void;
  renameSession?: (id: string, title: string) => void;
  deleteSession?: (id: string) => void;
  currentModel: () => string;
  currentAgent: () => string;
  currentSession: () => string;
  exit: () => void;
}

type Dialog =
  | { kind: "none" }
  | { kind: "permission"; req: PermissionRequest; resolve: (d: PermissionDecision) => void; selected: number }
  | { kind: "question"; questions: QuestionPrompt[]; resolve: (a: string[] | null) => void; index: number; answers: string[]; freeMode: boolean; freeText: string }
  | { kind: "list"; title: string; items: { id: string; label: string; hint?: string }[]; selected: number; onPick: (id: string) => void; onKey?: (key: KeyEventLike) => boolean; hint?: string };

interface Autocomplete {
  kind: "slash" | "file";
  query: string;
  items: string[];
  selected: number;
}

export class TuiApp {
  private editor = new EditorState();
  // ————— extensión API: slots, widgets y atajos —————
  private slots: Partial<Record<SlotName, Component | null>> = {};
  private widgets: Component[] = [];
  private extShortcuts: { ctrl: boolean; alt: boolean; name: string; handler: () => void }[] = [];

  setSlot(slot: SlotName, component: Component | null): void {
    this.slots[slot] = component;
    this.render();
  }

  addWidget(component: Component): void {
    this.widgets.push(component);
    this.render();
  }

  registerShortcut(spec: { ctrl: boolean; alt: boolean; name: string }, handler: () => void): void {
    this.extShortcuts.push({ ...spec, handler });
  }

  /** Atajos de extensión: se evalúan tras los builtins (no pisan ctrl+x/ctrl+p/…). */
  private handleExtShortcut(key: KeyEventLike): boolean {
    for (const sc of this.extShortcuts) {
      if (sc.ctrl !== key.ctrl) continue;
      if (sc.alt !== !!key.meta) continue; // alt debe coincidir en AMBOS sentidos (shift no se compara)
      if (key.name !== sc.name) continue;
      try { sc.handler(); } catch (err) { this.error(`atajo de extensión falló: ${(err as Error).message}`); }
      return true;
    }
    return false;
  }

  private slotRows(slot: SlotName, width: number, max: number): string[] {
    const comp = this.slots[slot];
    if (!comp) return [];
    return safeRender(comp, width).slice(0, max).map((l) => fitAnsi(l, width));
  }

  private widgetRows(width: number, max: number): string[] {
    const out: string[] = [];
    for (const w of this.widgets) {
      for (const line of safeRender(w, width)) {
        if (out.length >= max) return out;
        out.push(fitAnsi(line, width));
      }
    }
    return out;
  }
  private messages: DisplayMessage[] = [];
  private dialog: Dialog = { kind: "none" };
  private autocomplete: Autocomplete | null = null;
  private scrollFromBottom = 0;
  private streaming = false;
  private tokens = 0;
  private todos: TodoItem[] = [];
  private leaderUntil = 0;
  private fileCache: string[] | null = null;
  private _cursor = { row: 0, col: 0 };
  private spinnerStarted = 0;
  requestRender: () => void = () => {};

  constructor(public deps: TuiAppDeps) {}

  // ————— entradas desde el bus de eventos del agente —————
  pushUser(text: string): void { this.messages.push({ role: "user", text }); this.scrollFromBottom = 0; this.render(); }
  appendAssistantDelta(text: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "assistant" && this.streaming) last.text += text;
    else this.messages.push({ role: "assistant", text });
    this.render();
  }
  toolStart(id: string, name: string, args: Record<string, unknown>): void {
    this.messages.push({ role: "tool", text: args ? JSON.stringify(args) : "", toolName: name });
    this.render();
  }
  toolEnd(_id: string, name: string, output: string, isError: boolean, durationMs: number): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === "tool" && m.toolName === name && m.output === undefined) {
        m.output = output; m.isError = isError; m.durationMs = durationMs; break;
      }
    }
    this.render();
  }
  turnEnd(reason: string, totalTokens?: number): void {
    this.streaming = false;
    if (totalTokens) this.tokens = totalTokens;
    if (reason === "max_steps") this.messages.push({ role: "error", text: "se alcanzó el máximo de pasos" });
    this.render();
  }
  turnStarted(): void { this.streaming = true; this.spinnerStarted = Date.now(); this.render(); }
  /** Texto actual del buffer del editor (para /editor). */
  getEditorText(): string { return this.editor.buffer(); }
  /** Reemplaza el buffer (cursor al final) y repinta. */
  setEditorText(text: string): void { this.editor.setBuffer(text); this.render(); }
  error(msg: string): void { this.messages.push({ role: "error", text: msg }); this.render(); }
  todosUpdated(todos: TodoItem[]): void { this.todos = todos; this.render(); }
  info(text: string): void { this.messages.push({ role: "system", text }); this.render(); }
  setHistory(display: DisplayMessage[]): void { this.messages = display; this.scrollFromBottom = 0; this.render(); }

  // ————— permisos y preguntas desde la UI —————
  confirmPermission(req: PermissionRequest): Promise<PermissionDecision> {
    return new Promise((resolve) => { this.dialog = { kind: "permission", req, resolve, selected: 0 }; this.render(); });
  }
  askQuestions(questions: QuestionPrompt[]): Promise<string[] | null> {
    return new Promise((resolve) => {
      const first = questions[0];
      this.dialog = { kind: "question", questions, resolve, index: 0, answers: [], freeMode: !first || first.options.length === 0, freeText: "" };
      this.render();
    });
  }

  // ————— frame —————
  get cursor(): { row: number; col: number } { return this._cursor; }

  computeFrame(width: number, height: number): string[] {
    const theme = this.deps.theme;
    const lines: string[] = [];
    lines.push(...this.slotRows("header", width, 3));
    lines.push(this.headerLine(width));
    const bottomRows = this.bottomRows(width, height);
    const bodyHeight = Math.max(1, height - 1 - bottomRows.length);
    const body = this.messageLines(width);
    const visible = body.length <= bodyHeight ? body
      : this.scrollFromBottom > 0
        ? body.slice(Math.max(0, body.length - bodyHeight - this.scrollFromBottom), body.length - this.scrollFromBottom)
        : body.slice(body.length - bodyHeight);
    for (let i = 0; i < bodyHeight; i++) lines.push(fitAnsi(visible[i] ?? "", width));
    if (this.scrollFromBottom > 0) lines[1] = fgHex(token(theme, "warning")) + fitAnsi(`↑ ${this.scrollFromBottom} líneas — PgDn para bajar`, Math.max(0, width - 1)) + reset;
    lines.push(...this.slotRows("messages", width, 5));
    const bottomBase = lines.length;
    lines.push(...bottomRows);
    // cursor: el bottomRows() deja this.pendingCursor { visualRow, col } si hay
    if (this.pendingCursor) {
      this._cursor = { row: bottomBase + this.pendingCursor.visualRow, col: this.pendingCursor.col };
      this.pendingCursor = null;
    } else {
      this._cursor = { row: -1, col: -1 }; // oculto (diálogo sin entrada)
    }
    return lines.map((l) => fitAnsi(l, width));
  }

  private headerLine(width: number): string {
    const t = this.deps.theme;
    const left = fgHex(token(t, "accent")) + bold + "vireo" + reset + dimmed + ` · ${this.deps.currentAgent()} · ${this.deps.currentModel()} · ${this.deps.cwd.split("/").filter(Boolean).pop() ?? "/"}` + reset;
    const right = dimmed + `sesión ${this.deps.currentSession()}` + reset;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return left + " ".repeat(gap) + right;
  }

  private messageLines(width: number): string[] {
    const out: string[] = [];
    for (const msg of this.messages) {
      out.push(...wrapMessage(msg, this.deps.theme, width, this.deps.tui.diffStyle));
      out.push(""); // respiro entre mensajes
    }
    return out;
  }

  // Elementos de abajo: separator, (autocomplete|dialog|editor+todos), footer
  private bottomRows(width: number, height: number): string[] {
    const t = this.deps.theme;
    const rows: string[] = [];
    const todo = this.todoStrip(width);
    const editorArea = this.dialog.kind !== "none" ? this.dialogRows(width, Math.max(4, Math.floor(height / 2))) : this.editorRows(width);
    if (todo) rows.push(todo);
    rows.push(...this.widgetRows(width, 2));
    rows.push(...this.slotRows("widgets", width, 2));
    rows.push(dimmed + "─".repeat(width) + reset);
    if (this.autocomplete) rows.push(...this.autocompleteRows(width));
    rows.push(...this.slotRows("editor", width, 3));
    const editorOffset = rows.length; // cursor relativo al área de editor/diálogo
    rows.push(...editorArea);
    if (this.pendingCursor) this.pendingCursor = { visualRow: this.pendingCursor.visualRow + editorOffset, col: this.pendingCursor.col };
    rows.push(this.footerLine(width));
    rows.push(...this.slotRows("footer", width, 2));
    return rows;
  }

  private todoStrip(width: number): string | null {
    if (!this.todos.length) return null;
    const t = this.deps.theme;
    const cur = this.todos.find((x) => x.status === "in_progress") ?? this.todos.find((x) => x.status === "pending");
    const done = this.todos.filter((x) => x.status === "completed").length;
    const icon = { pending: "[ ]", in_progress: "[~]", completed: "[x]" } as const;
    const text = cur ? `${icon[cur.status]} ${cur.content}` : "todas completadas";
    return fgHex(token(t, "warning")) + fitAnsi(`tareas ${done}/${this.todos.length} · ${text}`, Math.max(0, width - 1)) + reset;
  }

  private editorRows(width: number): string[] {
    const t = this.deps.theme;
    const rows: string[] = [];
    const lines = this.editor.logicalLines();
    const maxRows = 8;
    const visible = lines.slice(Math.max(0, lines.length - maxRows));
    const skipped = lines.length - visible.length;
    for (let i = 0; i < visible.length; i++) {
      const prefix = (i === visible.length - 1 && skipped + i === this.editor.row) ? fgHex(token(t, "accent")) + "❯ " + reset : "  ";
      const line = visible[i];
      const slice = line.length > width - 2 ? line.slice(line.length - (width - 2)) : line;
      rows.push(prefix + slice);
      if (skipped + i === this.editor.row) {
        const sliceStart = line.length > width - 2 ? line.length - (width - 2) : 0;
        const colInSlice = Math.min(this.editor.col, line.length) - sliceStart;
        this.pendingCursor = { visualRow: rows.length - 1, col: Math.max(0, Math.min(colInSlice, width - 3)) + 2 };
      }
    }
    return rows;
  }

  private pendingCursor: { visualRow: number; col: number } | null = null;

  private footerLine(width: number): string {
    const t = this.deps.theme;
    const state = this.streaming ? `${fgHex(token(t, "accent"))}pensando… ${Math.floor((Date.now() - this.spinnerStarted) / 1000)}s${reset}` : dimmed + "listo" + reset;
    const hints = dimmed + "tab agente · ctrl+p comandos · ctrl+x atajos · esc abortar" + reset;
    const right = this.tokens > 0 ? dimmed + `${this.tokens} tok` + reset : "";
    const left = `${state}${dimmed}  ·  ${hints}${reset}`;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return left + " ".repeat(gap) + right;
  }

  private autocompleteRows(width: number): string[] {
    const t = this.deps.theme;
    if (!this.autocomplete) return [];
    const rows = [dimmed + "─ sugerencias (tab completa, esc cierra) ─" + reset];
    const maxItems = 8;
    const items = this.autocomplete.items.slice(0, maxItems);
    items.forEach((item, i) => {
      const selected = i === this.autocomplete!.selected;
      const line = (selected ? fgHex(token(t, "accent")) + "› " : "  ") + item;
      rows.push(selected ? fgHex(token(t, "accent")) + fitAnsi(line, Math.max(0, width - 1)) + reset : fitAnsi(line, width));
    });
    return rows;
  }

  private dialogRows(width: number, maxHeight: number): string[] {
    const t = this.deps.theme;
    const d = this.dialog;
    const rows: string[] = [];
    if (d.kind === "permission") {
      rows.push(fgHex(token(t, "warning")) + bold + "permiso requerido" + reset);
      rows.push(fgHex(token(t, "fg")) + `${d.req.action} → ${d.req.resource}` + reset);
      if (d.req.alwaysPattern) rows.push(dimmed + `siempre guardará: ${d.req.alwaysPattern} (solo este proyecto)` + reset);
      if (d.req.diff) {
        const diffLines = applyDiffStyle(d.req.diff, this.deps.tui.diffStyle).split("\n");
        const budget = Math.max(2, maxHeight - 5);
        for (const raw of diffLines.slice(0, budget)) {
          const colored = raw.startsWith("+") && !raw.startsWith("+++") ? fgHex(token(t, "diffAdd")) + raw + reset
            : raw.startsWith("-") && !raw.startsWith("---") ? fgHex(token(t, "diffDel")) + raw + reset
            : raw.startsWith("@@") ? fgHex(token(t, "diffHunk")) + raw + reset : dimmed + raw + reset;
          rows.push(fitAnsi("  " + colored, width));
        }
        if (diffLines.length > budget) rows.push(dimmed + `  …(${diffLines.length - budget} líneas de diff más)` + reset);
      }
      const opts = ["[y] permitir una vez", "[a] permitir siempre", "[n] rechazar"];
      opts.forEach((o, i) => rows.push((i === d.selected ? fgHex(token(t, "accent")) + "› " : "  ") + (i === d.selected ? bold + o + reset : o)));
      return rows;
    }
    if (d.kind === "question") {
      const q = d.questions[d.index];
      rows.push(fgHex(token(t, "accent")) + bold + `${q.header} (${d.index + 1}/${d.questions.length})` + reset);
      rows.push(q.question);
      if (d.freeMode) {
        const shown = q.mask ? "*".repeat(d.freeText.length) : d.freeText;
        rows.push(q.mask ? "respuesta libre (oculta):" : "respuesta libre:");
        rows.push("❯ " + shown);
        this.pendingCursor = { visualRow: rows.length - 1, col: 2 + d.freeText.length };
      } else {
        q.options.forEach((o, i) => rows.push(`  ${i + 1}) ${o}`));
        rows.push("  0) respuesta libre");
      }
      return rows;
    }
    if (d.kind === "list") {
      rows.push(fgHex(token(t, "accent")) + bold + d.title + reset);
      const budget = Math.max(2, maxHeight - 2);
      const start = Math.max(0, Math.min(d.selected - Math.floor(budget / 2), d.items.length - budget));
      d.items.slice(start, start + budget).forEach((item, i) => {
        const idx = start + i;
        const selected = idx === d.selected;
        const line = `${selected ? "› " : "  "}${item.label}${item.hint ? dimmed + "  " + item.hint + reset : ""}`;
        rows.push(selected ? fgHex(token(t, "accent")) + fitAnsi(line, Math.max(0, width - 1)) + reset : fitAnsi(line, width));
      });
      if (d.hint) rows.push(dimmed + "  " + d.hint + reset);
      if (d.items.length > budget) rows.push(dimmed + `  ${d.selected + 1}/${d.items.length}` + reset);
      return rows;
    }
    return rows;
  }

  // ————— teclado —————
  handleKey(key: KeyEventLike): void {
    // diálogos primero
    if (this.dialog.kind !== "none") { this.handleDialogKey(key); this.render(); return; }
    // leader
    const now = Date.now();
    const leaderPending = now < this.leaderUntil;
    const leader = this.deps.tui.keybinds["leader"] === "" ? "" : "ctrl+x";
    const isLeaderKey = !leaderPending && key.ctrl && key.name === "x";
    if (isLeaderKey) { this.leaderUntil = now + this.deps.tui.leaderTimeout; return; }
    if (leaderPending) {
      this.leaderUntil = 0;
      if (this.handleLeaderKey(key)) { this.render(); return; }
      // tecla desconocida tras leader: se ignora (o cae al editor si no es binding)
      return;
    }
    // tab con autocompletado abierto = completar (antes de ciclo de agente)
    if (key.name === "tab" && this.autocomplete) { this.completeAutocomplete(); return; }
    // ciclo de agente
    if (bindingMatches(this.deps.tui.keybinds["agent_cycle"], false, key)) { this.cycleAgent(1); return; }
    if (bindingMatches(this.deps.tui.keybinds["agent_cycle_reverse"], false, key)) { this.cycleAgent(-1); return; }
    // abortar
    if (key.name === "escape") { if (this.autocomplete) { this.autocomplete = null; this.render(); } else if (this.streaming) this.deps.abortTurn(); else { this.editor.clear(); this.render(); } return; }
    // comandos con ctrl+p
    if (key.ctrl && key.name === "p") { this.openCommandPalette(); return; }
    // paginado
    const pageStep = Math.max(1, Math.round(this.deps.tui.scrollSpeed * 4)); // vireo-lite: scrollSpeed 3 → 12 líneas
    if (key.name === "pageup") { this.scrollFromBottom = Math.min(this.scrollFromBottom + pageStep, 10000); this.render(); return; }
    if (key.name === "pagedown") { this.scrollFromBottom = Math.max(0, this.scrollFromBottom - pageStep); this.render(); return; }
    // envío / nueva línea
    if (bindingMatches(this.deps.tui.keybinds["input_submit"], false, key)) {
      this.submitEditor();
      return;
    }
    if (bindingMatches(this.deps.tui.keybinds["input_newline"], false, key)) { this.editor.insertNewline(); this.refreshAutocomplete(); this.render(); return; }
    if (key.name === "up" && this.autocomplete) { this.autocomplete.selected = Math.max(0, this.autocomplete.selected - 1); this.render(); return; }
    if (key.name === "down" && this.autocomplete) { this.autocomplete.selected = Math.min(this.autocomplete.items.length - 1, this.autocomplete.selected + 1); this.render(); return; }
    if (key.ctrl && key.name === "c") { if (this.editor.isEmpty()) this.deps.exit(); else { this.editor.clear(); this.render(); } return; }
    if (key.ctrl && key.name === "d" && this.editor.isEmpty()) { this.deps.exit(); return; }
    if (key.ctrl && key.name === "l") { this.messages = []; this.render(); return; } // limpiar vista (no la sesión)
    // edición
    if (key.ctrl) {
      switch (key.name) {
        case "a": this.editor.moveHome(); break;
        case "e": this.editor.moveEnd(); break;
        case "k": this.editor.deleteToLineEnd(); break;
        case "u": this.editor.deleteToLineStart(); break;
        case "w": this.editor.deleteWordBackward(); break;
        case "b": this.editor.wordBackward(); break;
        case "f": this.editor.wordForward(); break;
        default:
          // las extensiones pueden usar ctrl+<tecla> libre (builtins ganan)
          if (this.handleExtShortcut(key)) { this.render(); return; }
          return;
      }
      this.refreshAutocomplete(); this.render(); return;
    }
    if (key.name === "backspace") { this.editor.backspace(); this.refreshAutocomplete(); this.render(); return; }
    if (key.name === "delete") { this.editor.deleteRight(); this.refreshAutocomplete(); this.render(); return; }
    if (key.name === "left") { this.editor.moveLeft(); this.render(); return; }
    if (key.name === "right") { this.editor.moveRight(); this.render(); return; }
    if (key.name === "up") { if (this.editor.lines.length > 1) this.editor.moveUp(); else this.scrollFromBottom = Math.min(this.scrollFromBottom + 1, 10000); this.render(); return; }
    if (key.name === "down") { if (this.editor.lines.length > 1) this.editor.moveDown(); else this.scrollFromBottom = Math.max(0, this.scrollFromBottom - 1); this.render(); return; }
    if (key.name === "home") { this.editor.moveHome(); this.render(); return; }
    if (key.name === "end") { this.editor.moveEnd(); this.render(); return; }
    if (this.handleExtShortcut(key)) { this.render(); return; }
    if (key.sequence && !key.meta) { this.editor.insert(key.sequence); this.refreshAutocomplete(); this.render(); }
  }

  private cycleAgent(_dir: 1 | -1): void { const id = this.deps.cycleAgent(); this.info(`agente: ${id}`); }

  private handleLeaderKey(key: KeyEventLike): boolean {
    const kb = this.deps.tui.keybinds;
    const match = (action: string) => bindingMatches(kb[action], true, key);
    if (match("session_new")) { this.startNewSession(); return true; }
    if (match("session_list")) { this.openSessions(); return true; }
    if (match("model_list")) { void this.openModels(); return true; }
    if (match("theme_list")) { this.openThemes(); return true; }
    if (match("agent_list")) { this.info("agentes: build (tab alterna) · plan (sin edición)"); return true; }
    if (match("session_compact")) { this.deps.commands.find((c) => c.name === "compact")?.run(this); return true; }
    if (match("session_undo")) { this.deps.commands.find((c) => c.name === "undo")?.run(this); return true; }
    if (match("session_redo")) { this.deps.commands.find((c) => c.name === "redo")?.run(this); return true; }
    if (match("app_exit")) { this.deps.exit(); return true; }
    return false;
  }

  private handleDialogKey(key: KeyEventLike): void {
    const d = this.dialog;
    if (d.kind === "permission") {
      if (key.name === "y" || (key.name === "return" && d.selected === 0)) return this.resolvePermission("once");
      if (key.name === "a" || (key.name === "return" && d.selected === 1)) return this.resolvePermission("always");
      if (key.name === "n" || key.name === "escape" || (key.name === "return" && d.selected === 2)) return this.resolvePermission("reject");
      if (key.name === "up") d.selected = Math.max(0, d.selected - 1);
      if (key.name === "down") d.selected = Math.min(2, d.selected + 1);
      return;
    }
    if (d.kind === "question") {
      const q = d.questions[d.index];
      if (d.freeMode) {
        if (key.name === "escape") { if (q.options.length === 0) return this.resolveQuestion(null); d.freeMode = false; return; }
        if (key.name === "return") return this.answerQuestion(d.freeText);
        if (key.name === "backspace") d.freeText = d.freeText.slice(0, -1);
        else if (key.sequence && !key.ctrl && !key.meta) d.freeText += key.sequence;
        return;
      }
      const n = Number(key.name);
      if (key.name === "escape") return this.resolveQuestion(null);
      if (key.name === "0") { d.freeMode = true; d.freeText = ""; return; }
      if (Number.isInteger(n) && n >= 1 && n <= q.options.length) return this.answerQuestion(q.options[n - 1]);
      return;
    }
    if (d.kind === "list") {
      if (d.onKey && d.onKey(key)) return; // la lista gestionó la tecla (p. ej. d/r en sesiones)
      if (key.name === "escape") { this.dialog = { kind: "none" }; return; }
      if (key.name === "up") d.selected = Math.max(0, d.selected - 1);
      else if (key.name === "down") d.selected = Math.min(d.items.length - 1, d.selected + 1);
      else if (key.name === "pageup") d.selected = Math.max(0, d.selected - 8);
      else if (key.name === "pagedown") d.selected = Math.min(d.items.length - 1, d.selected + 8);
      else if (key.name === "return") { const pick = d.items[d.selected]?.id; this.dialog = { kind: "none" }; if (pick !== undefined) d.onPick(pick); }
      return;
    }
  }

  private resolvePermission(decision: PermissionDecision): void {
    const d = this.dialog as Extract<Dialog, { kind: "permission" }>;
    this.dialog = { kind: "none" };
    d.resolve(decision);
  }

  private answerQuestion(answer: string): void {
    const d = this.dialog as Extract<Dialog, { kind: "question" }>;
    d.answers.push(answer);
    if (d.index + 1 < d.questions.length) { d.index++; d.freeMode = false; d.freeText = ""; return; }
    const answers = d.answers;
    this.dialog = { kind: "none" };
    d.resolve(answers);
  }

  private resolveQuestion(result: string[] | null): void {
    const d = this.dialog as Extract<Dialog, { kind: "question" }>;
    this.dialog = { kind: "none" };
    d.resolve(result);
  }

  // ————— acciones —————
  private submitEditor(): void {
    const text = this.editor.buffer().trim();
    if (!text || this.streaming) return;
    this.editor.clear();
    this.autocomplete = null;
    // ¿comando slash?
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const command = this.deps.commands.find((c) => c.name === cmd);
      if (command) { command.run(this, rest.join(" ")); return; }
      this.messages.push({ role: "error", text: `comando desconocido: /${cmd} (ctrl+p lista los comandos)` });
      this.render();
      return;
    }
    this.pushUser(text);
    this.deps.submit(text);
  }

  startNewSession(): void {
    const s = this.deps.newSession();
    this.setHistory([]);
    this.info(`nueva sesión ${s.id}`);
  }

  openSessions(): void {
    this.renderSessionsDialog(this.deps.listSessions().slice(0, 30).map((s) => ({ id: s.id, label: `${s.id}  ${s.title}` })), 0);
  }

  private renderSessionsDialog(items: { id: string; label: string }[], selected: number): void {
    if (!items.length) { this.info("no hay sesiones guardadas"); return; }
    this.dialog = {
      kind: "list", title: "sesiones (enter carga)", items, selected: Math.min(selected, items.length - 1),
      hint: "r renombrar · d borrar · enter cargar",
      onPick: (id) => { if (this.deps.switchSession(id)) this.info(`sesión cargada: ${id}`); else this.info(`no se pudo cargar ${id}`); },
      onKey: (key) => {
        const d = this.dialog as Extract<Dialog, { kind: "list" }>;
        const target = d.items[d.selected]?.id;
        if (!target) return false;
        if (key.name === "d") {
          if (target === this.deps.currentSession()) { this.info("la sesión activa no se puede borrar"); return true; }
          void this.confirmDeleteSession(target);
          return true;
        }
        if (key.name === "r") { void this.renameSessionFlow(target); return true; }
        return false;
      },
    };
    this.render();
  }

  private async confirmDeleteSession(id: string): Promise<void> {
    const answers = await this.askQuestions([{ header: "Borrar sesión", question: `¿Borrar la sesión ${id}? Esta acción no se puede deshacer.`, options: ["Sí, borrar", "No"] }]);
    if (answers?.[0]?.startsWith("Sí")) {
      this.deps.deleteSession?.(id);
      this.info(`sesión borrada: ${id}`);
      this.renderSessionsDialog(this.deps.listSessions().slice(0, 30).map((s) => ({ id: s.id, label: `${s.id}  ${s.title}` })), 0);
    }
  }

  private async renameSessionFlow(id: string): Promise<void> {
    const answers = await this.askQuestions([{ header: "Renombrar sesión", question: "Nuevo título:", options: [] }]);
    const title = answers?.[0]?.trim();
    if (title) {
      this.deps.renameSession?.(id, title);
      this.info(`sesión ${id} renombrada`);
      this.renderSessionsDialog(this.deps.listSessions().slice(0, 30).map((s) => ({ id: s.id, label: `${s.id}  ${s.title}` })), 0);
    }
  }

  async openModels(): Promise<void> {
    const models = await this.deps.fetchModels();
    if (!models?.length) { this.info("el proveedor no lista modelos (o no responde); edita `model` en opencode.json"); return; }
    this.dialog = {
      kind: "list", title: "modelos (enter selecciona para esta sesión)",
      items: models.map((m) => ({ id: m, label: m, hint: m === this.deps.currentModel() ? "actual" : undefined })),
      selected: Math.max(0, models.indexOf(this.deps.currentModel())),
      onPick: (id) => { this.deps.setModel(id); this.info(`modelo: ${id} (solo esta sesión; guárdalo en opencode.json para hacerlo permanente)`); },
    };
    this.render();
  }

  openThemes(): void {
    const items = this.deps.themes.map((name) => ({ id: name, label: name, hint: name === this.deps.theme.name ? "actual" : undefined }));
    this.dialog = { kind: "list", title: "temas", items, selected: 0, onPick: (id) => { this.deps.setTheme(id); this.info(`tema: ${id}`); } };
    this.render();
  }

  openHelp(): void {
    const kb = this.deps.tui.keybinds;
    const L = (a: string) => (kb[a] ?? "").replace(/,/g, "/");
    const items = [
      { id: "tab", label: `${L("agent_cycle") || "tab"}  alternar agente build/plan` },
      { id: "ctrl+p", label: "ctrl+p  paleta de comandos" },
      { id: "leader", label: `${L("leader") || "ctrl+x"}  leader: ${L("session_new")} nueva sesión · ${L("session_list")} sesiones · ${L("model_list")} modelos · ${L("theme_list")} temas · ${L("app_exit")} salir` },
      { id: "submit", label: `${L("input_submit") || "return"}  enviar · ${L("input_newline")} nueva línea` },
      { id: "escape", label: "esc  abortar turno / cerrar paleta / limpiar editor" },
      { id: "pageup", label: "pgup/pgdn  desplazar historial" },
      { id: "editor", label: "ctrl+a/e inicio/fin · ctrl+k a fin de línea · ctrl+u al inicio · ctrl+w borra palabra" },
      { id: "refs", label: "@archivo  referencia difusa (tab completa)" },
      { id: "slash", label: "/comando  /new /sessions /models /themes /help /exit …" },
    ];
    this.dialog = { kind: "list", title: "atajos (esc cierra)", items, selected: 0, onPick: () => {} };
    this.render();
  }

  openCommandPalette(): void {
    const items = this.deps.commands.map((c) => ({ id: c.name, label: "/" + c.name, hint: c.hint }));
    this.dialog = { kind: "list", title: "comandos", items, selected: 0, onPick: (id) => this.deps.commands.find((c) => c.name === id)?.run(this) };
    this.render();
  }

  // ————— autocompletado —————
  private refreshAutocomplete(): void {
    const line = this.editor.logicalLines()[this.editor.row]?.slice(0, this.editor.col) ?? "";
    const slash = /^\/([\w:-]*)$/.exec(line);
    if (slash) {
      const q = slash[1].toLowerCase();
      const items = this.deps.commands.map((c) => c.name).filter((n) => n.startsWith(q)).sort();
      this.autocomplete = items.length ? { kind: "slash", query: q, items, selected: 0 } : null;
      return;
    }
    const at = /@([\w./-]*)$/.exec(line);
    if (at) {
      const q = at[1].toLowerCase();
      const items = this.fuzzyFiles(q);
      this.autocomplete = items.length ? { kind: "file", query: q, items, selected: 0 } : null;
      return;
    }
    this.autocomplete = null;
  }

  private fuzzyFiles(query: string): string[] {
    if (!this.fileCache) this.fileCache = walkProject(this.deps.cwd);
    return fuzzyFilter(this.fileCache, query).slice(0, 40);
  }

  private completeAutocomplete(): void {
    const ac = this.autocomplete;
    if (!ac) return;
    if (ac.kind === "slash") {
      const cmd = ac.items[ac.selected];
      this.replaceCurrentLinePrefix(/^\/[\w:-]*/, `/${cmd}`);
    } else {
      const file = ac.items[ac.selected];
      this.replaceCurrentLinePrefix(/@[\w./-]*$/, `@${file}`);
    }
    this.autocomplete = null;
    this.render();
  }

  private replaceCurrentLinePrefix(re: RegExp, replacement: string): void {
    const before = this.editor.lines[this.editor.row];
    const upto = before.slice(0, this.editor.col);
    const after = before.slice(this.editor.col);
    const m = upto.match(re);
    if (!m) return;
    const newUpto = upto.slice(0, upto.length - m[0].length) + replacement;
    this.editor.lines[this.editor.row] = newUpto + after;
    this.editor.col = newUpto.length;
  }

  private render(): void {
    // ancla el scroll al fondo salvo que el usuario haya subido manualmente
    this.requestRender();
  }
}


const IGNORED_DIRS = new Set([".git", "node_modules", "target", "dist", "build", ".next", ".venv", "__pycache__", ".cache", "out", "coverage"]);

function walkProject(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || out.length >= 6000) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 6000) return;
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      const rel = dir === root ? e.name : `${dir.slice(root.length + 1)}/${e.name}`;
      if (e.isDirectory()) { if (!IGNORED_DIRS.has(e.name)) walk(join(dir, e.name), depth + 1); }
      else out.push(rel);
    }
  };
  walk(root, 0);
  return out;
}

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
