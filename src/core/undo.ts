// Undo/redo de cambios de archivos, por turno de usuario.
//
// Cada turno empieza con beginTurn(label). Las tools que modifican archivos
// (write/edit/apply_patch) copian PRE-imagen (antes de ejecutarse) y POST-imagen
// (después) a $XDG_DATA_HOME/vireo/snapshots/<sesión>/. `bash` se registra como
// paso NO deshacible (los efectos de un shell arbitrario no son reversibles en
// general) — /undo lo reporta y lo consume.
//
// Seguridad ante todo: antes de sobrescribir o borrar CUALQUIER archivo durante
// undo/redo, el estado actual se respalda en snapshots/<sesión>/pre-undo/<ts>/.
// Así, aunque el usuario haya editado archivos después del turno del agente,
// su versión nunca se pierde.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, dirname, isAbsolute } from "node:path";

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB: por encima, el archivo no se respalda
const MAX_TURNS = 30;                    // poda: se conservan los últimos N turnos

export interface UndoStep {
  path: string;          // absoluta
  existedPre: boolean;   // ¿existía antes del turno?
  existedPost: boolean;  // ¿existe tras el turno?
  pre?: string;          // archivo de imagen en files/<rec>/
  post?: string;
  restorable: boolean;   // false si superó el límite o hubo error de lectura
  note?: string;
}

export interface UndoRecord {
  turn: number;
  tool: string;
  label?: string;
  restorable: boolean;
  undone: boolean;
  invalidated: boolean;  // redo invalidado por un beginTurn posterior
  steps: UndoStep[];
  dir?: string;          // subcarpeta de files/ con las imágenes
}

interface Manifest { seq: number; records: UndoRecord[] }

export interface UndoResult {
  ok: boolean;
  message: string;
  restored: string[];
  deleted: string[];
  skipped: string[];
  backupDir?: string;
}

export function snapshotsRoot(): string {
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "vireo", "snapshots");
}

export class UndoManager {
  private dir: string;
  private filesDir: string;
  private manifest: Manifest;
  private pending: { tool: string; turn: number; label?: string; steps: UndoStep[]; recDir: string } | null = null;
  private turnLabels = new Map<number, string>();

  constructor(readonly sessionId: string) {
    this.dir = join(snapshotsRoot(), sessionId);
    this.filesDir = join(this.dir, "files");
    mkdirSync(this.filesDir, { recursive: true });
    this.manifest = this.load();
  }

  private load(): Manifest {
    try {
      const raw = JSON.parse(readFileSync(join(this.dir, "manifest.json"), "utf8")) as Manifest;
      if (typeof raw.seq === "number" && Array.isArray(raw.records)) return raw;
    } catch { /* manifest ausente/corrupto: empezar limpio */ }
    return { seq: 0, records: [] };
  }

  private save(): void {
    mkdirSync(this.filesDir, { recursive: true });
    writeFileSync(join(this.dir, "manifest.json"), JSON.stringify(this.manifest));
    this.prune();
  }

  /** Conserva solo los últimos MAX_TURNS turnos con registros. */
  private prune(): void {
    const turns = [...new Set(this.manifest.records.map((r) => r.turn))].sort((a, b) => a - b);
    if (turns.length <= MAX_TURNS) return;
    const drop = new Set(turns.slice(0, turns.length - MAX_TURNS));
    for (const rec of this.manifest.records) {
      if (drop.has(rec.turn) && rec.dir) rmSync(join(this.filesDir, rec.dir), { recursive: true, force: true });
    }
    this.manifest.records = this.manifest.records.filter((r) => !drop.has(r.turn));
  }

  /** Empieza un turno. Invalida los turnos deshechos (redo ya no vale). */
  beginTurn(label?: string): number {
    this.manifest.seq += 1;
    if (label) this.turnLabels.set(this.manifest.seq, label.slice(0, 120));
    for (const rec of this.manifest.records) if (rec.undone) rec.invalidated = true;
    this.save();
    return this.manifest.seq;
  }

  /** ¿Hay algún turno con cambios sin deshacer? */
  canUndo(): boolean { return this.manifest.records.some((r) => !r.undone); }
  canRedo(): boolean { return this.manifest.records.some((r) => r.undone && !r.invalidated); }

  /** Pre-imágenes (copia previa) de los archivos que la tool va a tocar. */
  snapshotPre(tool: string, paths: string[]): void {
    const turn = this.manifest.seq;
    if (turn === 0) this.beginTurn("(sin etiqueta)");
    const recDir = `${turn}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    mkdirSync(join(this.filesDir, recDir), { recursive: true });
    const steps: UndoStep[] = paths.map((p, i) => {
      const abs = isAbsolute(p) ? p : resolve(p);
      const step: UndoStep = { path: abs, existedPre: existsSync(abs), existedPost: false, restorable: true };
      if (step.existedPre) {
        try {
          const stat = statSync(abs);
          if (stat.size > MAX_FILE_BYTES) { step.restorable = false; step.note = "demasiado grande para respaldar"; }
          else {
            step.pre = join("files", recDir, `pre-${i}`);
            copyFileSync(abs, join(this.dir, step.pre));
          }
        } catch (err) { step.restorable = false; step.note = `pre-imagen ilegible: ${(err as Error).message}`; }
      }
      return step;
    });
    this.pending = { tool, turn: this.manifest.seq, label: this.turnLabels.get(this.manifest.seq), steps, recDir };
  }

  /** Post-imágenes y persistencia del registro. Llamar tras run() (también si falló: restaura parciales). */
  snapshotPost(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.steps.forEach((step, i) => {
      step.existedPost = existsSync(step.path);
      if (!step.existedPost) return;
      if (!step.restorable && step.note) return; // el pre ya falló; conservar nota
      try {
        const stat = statSync(step.path);
        if (stat.size > MAX_FILE_BYTES) { step.restorable = false; step.note = step.note ?? "demasiado grande para respaldar"; return; }
        step.post = join("files", pending.recDir, `post-${i}`);
        copyFileSync(step.path, join(this.dir, step.post));
      } catch (err) { step.restorable = false; step.note = step.note ?? `post-imagen ilegible: ${(err as Error).message}`; }
    });
    const restorable = pending.tool !== "bash" && pending.steps.every((s) => s.restorable);
    this.manifest.records.push({
      turn: pending.turn, tool: pending.tool, label: pending.label,
      restorable, undone: false, invalidated: false, steps: pending.steps, dir: pending.recDir,
    });
    try { this.save(); } catch { /* fallo de disco: el snapshot no persistirá; la sesión sigue */ }
  }

  /** Descarta las pre-imágenes de una tool cuyo run() no llegó a ejecutarse. */
  abortPending(): void {
    const pending = this.pending;
    if (pending) rmSync(join(this.filesDir, pending.recDir), { recursive: true, force: true });
    this.pending = null;
  }

  /** Deshace el ÚLTIMO turno con cambios (revierte las imágenes previas en orden inverso). */
  undo(): UndoResult {
    const turn = this.targetTurn((r) => !r.undone);
    if (turn === null) return { ok: false, message: "no hay cambios que deshacer", restored: [], deleted: [], skipped: [] };
    const touched = new Set<string>();
    const result: UndoResult = { ok: true, message: "", restored: [], deleted: [], skipped: [] };
    const backup = this.startBackup();
    try {
      for (const rec of this.recordsOf(turn).reverse()) {
        for (const step of [...rec.steps].reverse()) {
          this.backupCurrent(backup, step.path);
          if (step.existedPre) {
            if (!step.pre) { result.skipped.push(`${relTo(step.path)} (sin pre-imagen${step.note ? `: ${step.note}` : ""})`); continue; }
            copyFileSync(join(this.dir, step.pre), step.path);
            result.restored.push(relTo(step.path));
          } else if (step.restorable) {
            // el turno creó el archivo: borrar solo si sigue siendo lo que escribió la tool
            if (!step.post || !existsSync(step.path) || readFileSync(step.path).equals(readFileSync(join(this.dir, step.post)))) {
              if (existsSync(step.path)) rmSync(step.path);
              result.deleted.push(relTo(step.path));
            } else {
              result.skipped.push(`${relTo(step.path)} (modificado después del turno; respaldado en pre-undo/)`);
            }
          } else {
            result.skipped.push(`${relTo(step.path)}${step.note ? ` (${step.note})` : ""}`);
          }
        }
        if (rec.tool === "bash") result.skipped.push("bash (los cambios de un shell no son deshacibles)");
        rec.undone = true;
      }
    } finally {
      result.backupDir = backup?.dir;
      this.save();
    }
    if (result.restored.length === 0 && result.deleted.length === 0 && result.skipped.length === 0) result.ok = false;
    result.message = `turno ${turn} deshecho: ${result.restored.length} restaurados, ${result.deleted.length} borrados${result.skipped.length ? `, ${result.skipped.length} omitidos` : ""} (la conversación no se toca)`;
    return result;
  }

  /** Rehace el último turno deshecho e invalidado como redo. */
  redo(): UndoResult {
    const turn = this.targetTurn((r) => r.undone && !r.invalidated);
    if (turn === null) return { ok: false, message: "no hay nada que rehacer", restored: [], deleted: [], skipped: [] };
    const result: UndoResult = { ok: true, message: "", restored: [], deleted: [], skipped: [] };
    const backup = this.startBackup();
    try {
      for (const rec of this.recordsOf(turn)) {
        for (const step of rec.steps) {
          try {
            if (step.existedPost) {
              if (!step.post) { result.skipped.push(`${relTo(step.path)} (sin post-imagen${step.note ? `: ${step.note}` : ""})`); continue; }
              this.backupCurrent(backup, step.path);
              mkdirSync(dirname(step.path), { recursive: true });
              copyFileSync(join(this.dir, step.post), step.path);
              result.restored.push(relTo(step.path));
            } else {
              this.backupCurrent(backup, step.path);
              if (existsSync(step.path)) rmSync(step.path);
              result.deleted.push(relTo(step.path));
            }
          } catch (err) {
            result.skipped.push(`${relTo(step.path)} (error: ${(err as Error).message})`);
          }
        }
        if (rec.tool === "bash") result.skipped.push("bash (no deshacible)");
        rec.undone = false;
      }
    } finally {
      result.backupDir = backup.used ? backup.dir : undefined;
      this.save();
    }
    result.message = `turno ${turn} rehecho: ${result.restored.length} restaurados, ${result.deleted.length} borrados${result.skipped.length ? `, ${result.skipped.length} omitidos` : ""}`;
    return result;
  }

  private targetTurn(pred: (r: UndoRecord) => boolean): number | null {
    let turn: number | null = null;
    for (const r of this.manifest.records) if (pred(r) && (turn === null || r.turn > turn)) turn = r.turn;
    return turn;
  }

  private recordsOf(turn: number): UndoRecord[] {
    return this.manifest.records.filter((r) => r.turn === turn);
  }

  private startBackup(): { dir: string; used: boolean } {
    return { dir: join(this.dir, "pre-undo", new Date().toISOString().replace(/[:.]/g, "-")), used: false };
  }

  private backupCurrent(backup: { dir: string; used: boolean }, path: string): void {
    if (!existsSync(path)) return;
    const dest = join(backup.dir, relTo(path));
    try {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(path, dest);
      backup.used = true;
    } catch { /* el respaldo es best-effort; el restore sigue siendo la función principal */ }
  }
}

export function relTo(abs: string): string {
  const rel = relative(process.cwd(), abs);
  return rel && !rel.startsWith("..") ? rel : abs;
}
