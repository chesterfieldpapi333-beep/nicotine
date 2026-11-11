// Sesión en JSONL (append-only). Sin DB: una línea por mensaje/evento.
// Ubicación: $XDG_DATA_HOME/nicotine/sessions/<id>.jsonl

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "./types.js";

export interface SessionMeta { id: string; created: string; cwd: string; model: string; title: string }
export interface SessionLine { type: "meta" | "message"; [k: string]: unknown }

/** Raíz de datos de nicotine ($XDG_DATA_HOME/nicotine). */
export function dataHome(): string {
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "nicotine");
}

export function sessionsDir(): string {
  return join(dataHome(), "sessions");
}

export class Session {
  readonly id: string;
  readonly path: string;
  private constructor(id: string, cwd: string) {
    this.id = id;
    this.path = join(sessionsDir(), `${id}.jsonl`);
    mkdirSync(sessionsDir(), { recursive: true });
    if (!existsSync(this.path)) {
      const meta: SessionMeta = { id, created: new Date().toISOString(), cwd, model: "", title: "(nueva)" };
      appendFileSync(this.path, JSON.stringify({ type: "meta", ...meta }) + "\n");
    }
  }

  static create(cwd: string): Session { return new Session(randomUUID().slice(0, 8), cwd); }

  static load(id: string): Session | null {
    const path = join(sessionsDir(), `${id}.jsonl`);
    if (!existsSync(path)) return null;
    // recuperar cwd del meta para que las rutas relativas tengan sentido
    let cwd = process.cwd();
    try {
      const meta = JSON.parse(readFileSync(path, "utf8").split("\n")[0]) as SessionMeta;
      if (meta.cwd) cwd = meta.cwd;
    } catch { /* meta ilegible: usar cwd actual */ }
    return new Session(id, cwd);
  }

  static latest(): Session | null {
    const dir = sessionsDir();
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files.length ? Session.load(files[0].f.replace(/\.jsonl$/, "")) : null;
  }

  /** Lee la cabecera meta/title (cwd + created). Nunca lanza. */
  static meta(id: string): { cwd?: string; created?: string; title?: string } | null {
    const path = join(sessionsDir(), `${id}.jsonl`);
    if (!existsSync(path)) return null;
    let cwd: string | undefined, created: string | undefined, title: string | undefined;
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj.type === "meta") {
          if (typeof obj.cwd === "string") cwd = obj.cwd;
          if (typeof obj.created === "string") created = obj.created;
          if (typeof obj.title === "string") title = obj.title;
        } else if (obj.type === "title" && typeof obj.title === "string") title = obj.title;
      }
    } catch { return { cwd, created, title }; }
    return { cwd, created, title };
  }

  static list(): { id: string; title: string; mtime: number }[] {
    const dir = sessionsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => {
      const path = join(dir, f);
      let title = "(sin título)";
      try {
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const obj = JSON.parse(line) as { type?: string; title?: string };
          if (obj.type === "meta" || obj.type === "title") title = obj.title ?? title; // gana la última
        }
      } catch { /* línea corrupta: ignorar */ }
      return { id: f.replace(/\.jsonl$/, ""), title, mtime: statSync(path).mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime);
  }

  /** Bifurca una sesión: nueva sesión que hereda TODOS los mensajes de `source`. */
  static forkFrom(source: Session, cwd: string): Session {
    const fork = new Session(randomUUID().slice(0, 8), cwd);
    let title = "(sin título)";
    try {
      // mismo criterio que list(): la ÚLTIMA línea meta/title gana
      for (const line of readFileSync(source.path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const obj = JSON.parse(line) as { type?: string; title?: string };
        if (obj.type === "meta" || obj.type === "title") title = obj.title ?? title;
      }
    } catch { /* sin título legible */ }
    fork.setTitle(`fork: ${title}`.slice(0, 80));
    for (const m of source.messages()) fork.appendMessage(m);
    return fork;
  }

  /** Borra el archivo de la sesión. Devuelve false si no existía. */
  static remove(id: string): boolean {
    const path = join(sessionsDir(), `${id}.jsonl`);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  }

  /** Reescribe el título (append; gana la última línea title/meta al listar). */
  setTitle(title: string): void {
    appendFileSync(this.path, JSON.stringify({ type: "title", title: title.slice(0, 80) }) + "\n");
  }

  appendMessage(msg: ChatMessage): void {
    appendFileSync(this.path, JSON.stringify({ type: "message", ts: Date.now(), ...msg }) + "\n");
  }

  messages(): ChatMessage[] {
    return this.messagesWithTs().map(({ ts: _ts, ...m }) => m);
  }

  /** messages() pero conservando el ts de cada línea (para las APIs que llevan time.created). */
  messagesWithTs(): (ChatMessage & { ts?: number })[] {
    if (!existsSync(this.path)) return [];
    const out: (ChatMessage & { ts?: number })[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as SessionLine & ChatMessage & { ts?: number };
        if (obj.type === "message") {
          const { role, content, tool_calls, tool_call_id, ts } = obj;
          out.push({ role, content: content ?? null, ...(tool_calls ? { tool_calls } : {}), ...(tool_call_id ? { tool_call_id } : {}), ...(typeof ts === "number" ? { ts } : {}) });
        }
      } catch { /* línea corrupta: se ignora deliberadamente */ }
    }
    return out;
  }
}
