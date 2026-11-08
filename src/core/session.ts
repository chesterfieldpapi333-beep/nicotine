// Sesión en JSONL (append-only). Sin DB: una línea por mensaje/evento.
// Ubicación: $XDG_DATA_HOME/vireo/sessions/<id>.jsonl

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "./types.js";

export interface SessionMeta { id: string; created: string; cwd: string; model: string; title: string }
export interface SessionLine { type: "meta" | "message"; [k: string]: unknown }

export function sessionsDir(): string {
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "vireo", "sessions");
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

  /** Reescribe el título (append; gana la última línea title/meta al listar). */
  setTitle(title: string): void {
    appendFileSync(this.path, JSON.stringify({ type: "title", title: title.slice(0, 80) }) + "\n");
  }

  appendMessage(msg: ChatMessage): void {
    appendFileSync(this.path, JSON.stringify({ type: "message", ts: Date.now(), ...msg }) + "\n");
  }

  messages(): ChatMessage[] {
    if (!existsSync(this.path)) return [];
    const out: ChatMessage[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as SessionLine & ChatMessage;
        if (obj.type === "message") {
          const { role, content, tool_calls, tool_call_id } = obj;
          out.push({ role, content: content ?? null, ...(tool_calls ? { tool_calls } : {}), ...(tool_call_id ? { tool_call_id } : {}) });
        }
      } catch { /* línea corrupta: se ignora deliberadamente */ }
    }
    return out;
  }
}
