/**
 * Thread Store for Command Center
 *
 * SQLite-backed thread, message, and participant management.
 * Each project gets its own thread DB for isolation.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface Thread {
  id: string;
  title: string;
  status: "active" | "archived";
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Participant {
  threadId: string;
  participantType: "user" | "assistant";
  participantId: string;
  role: string;
  createdAt: string;
}

export interface ParticipantInput {
  participantType: "user" | "assistant";
  participantId: string;
  role?: string;
}

export interface ChatMessage {
  id: number;
  threadId: string;
  role: "user" | "assistant";
  kind: "message" | "thought" | "system";
  content: string;
  sender: string | null;
  source: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

export class ThreadStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_participants (
        thread_id TEXT NOT NULL,
        participant_type TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'participant',
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, participant_type, participant_id)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        kind TEXT NOT NULL DEFAULT 'message' CHECK(kind IN ('message', 'thought', 'system')),
        content TEXT NOT NULL,
        sender TEXT,
        source TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_thread ON chat_messages(thread_id, created_at)`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_reads (
        thread_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        last_read_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, user_id)
      )
    `);

    // Ensure a default "main" thread exists
    const main = this.db.prepare(`SELECT id FROM threads WHERE id = 'main'`).get();
    if (!main) {
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO threads (id, title, status, created_at, updated_at) VALUES ('main', 'Main', 'active', ?, ?)`).run(now, now);
      this.db.prepare(
        `INSERT INTO thread_participants (thread_id, participant_type, participant_id, role, created_at) VALUES ('main', 'assistant', 'captain', 'lead', ?)`,
      ).run(now);
    }

    // Ensure a "team" broadcast thread exists (all agents auto-joined)
    const team = this.db.prepare(`SELECT id FROM threads WHERE id = 'team'`).get();
    if (!team) {
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO threads (id, title, status, created_at, updated_at) VALUES ('team', 'Team', 'active', ?, ?)`).run(now, now);
      this.db.prepare(
        `INSERT INTO thread_participants (thread_id, participant_type, participant_id, role, created_at) VALUES ('team', 'assistant', 'captain', 'lead', ?)`,
      ).run(now);
    }
  }

  /* ---- Threads ---- */

  createThread(opts: { id?: string; title: string; participants?: ParticipantInput[] }): Thread {
    const id = opts.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO threads (id, title, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`).run(id, opts.title, now, now);
    if (opts.participants) {
      for (const p of opts.participants) {
        this.db.prepare(
          `INSERT OR IGNORE INTO thread_participants (thread_id, participant_type, participant_id, role, created_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(id, p.participantType, p.participantId, p.role ?? "participant", now);
      }
    }
    return this.getThread(id)!;
  }

  getThread(id: string): Thread | null {
    const row = this.db.prepare(`SELECT * FROM threads WHERE id = ?`).get(id) as any;
    return row ? this.rowToThread(row) : null;
  }

  listThreads(): Thread[] {
    const rows = this.db.prepare(`SELECT * FROM threads WHERE status = 'active' ORDER BY updated_at DESC`).all() as any[];
    return rows.map((r: any) => this.rowToThread(r));
  }

  /** List threads with participants embedded in each thread object. */
  listThreadsWithParticipants(): (Thread & { participants: Participant[] })[] {
    const threads = this.listThreads();
    return threads.map((t) => ({
      ...t,
      participants: this.getParticipants(t.id),
    }));
  }

  updateThread(id: string, opts: Partial<{ title: string; status: string; summary: string }>): Thread {
    const sets: string[] = ["updated_at = ?"];
    const params: any[] = [new Date().toISOString()];
    if (opts.title !== undefined) { sets.push("title = ?"); params.push(opts.title); }
    if (opts.status !== undefined) { sets.push("status = ?"); params.push(opts.status); }
    if (opts.summary !== undefined) { sets.push("summary = ?"); params.push(opts.summary); }
    params.push(id);
    this.db.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.getThread(id)!;
  }

  touchThread(id: string): void {
    this.db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  }

  /* ---- Participants ---- */

  getParticipants(threadId: string): Participant[] {
    const rows = this.db.prepare(`SELECT * FROM thread_participants WHERE thread_id = ?`).all(threadId) as any[];
    return rows.map((r: any) => ({
      threadId: r.thread_id,
      participantType: r.participant_type,
      participantId: r.participant_id,
      role: r.role,
      createdAt: r.created_at,
    }));
  }

  addParticipant(threadId: string, input: ParticipantInput): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT OR IGNORE INTO thread_participants (thread_id, participant_type, participant_id, role, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(threadId, input.participantType, input.participantId, input.role ?? "participant", now);
  }

  /* ---- Messages ---- */

  insertMessage(threadId: string, role: "user" | "assistant", content: string, opts?: {
    kind?: "message" | "thought" | "system";
    sender?: string;
    source?: string;
    metadata?: Record<string, unknown>;
  }): ChatMessage {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `INSERT INTO chat_messages (thread_id, role, kind, content, sender, source, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      threadId, role, opts?.kind ?? "message", content,
      opts?.sender ?? null, opts?.source ?? null,
      JSON.stringify(opts?.metadata ?? {}), now,
    );
    this.touchThread(threadId);
    return {
      id: Number(result.lastInsertRowid),
      threadId, role, kind: opts?.kind ?? "message",
      content, sender: opts?.sender ?? null,
      source: opts?.source ?? null,
      metadata: opts?.metadata ?? {},
      createdAt: now,
    };
  }

  getMessages(threadId: string, opts?: { limit?: number; before?: string }): ChatMessage[] {
    const conds = ["thread_id = ?"];
    const params: any[] = [threadId];
    if (opts?.before) { conds.push("created_at < ?"); params.push(opts.before); }
    params.push(opts?.limit ?? 50);
    const rows = this.db.prepare(
      `SELECT * FROM chat_messages WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params) as any[];
    // Return in chronological order
    return rows.reverse().map((r: any) => this.rowToMessage(r));
  }

  /* ---- Read receipts ---- */

  markRead(threadId: string, userId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO thread_reads (thread_id, user_id, last_read_at) VALUES (?, ?, ?)
       ON CONFLICT(thread_id, user_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
    ).run(threadId, userId, now);
  }

  getLastRead(threadId: string, userId: string): string | null {
    const row = this.db.prepare(
      `SELECT last_read_at FROM thread_reads WHERE thread_id = ? AND user_id = ?`,
    ).get(threadId, userId) as { last_read_at: string } | undefined;
    return row?.last_read_at ?? null;
  }

  /** Count unread messages per thread for a given user. Returns a map of threadId → unreadCount. */
  getUnreadCounts(userId: string): Map<string, number> {
    const rows = this.db.prepare(`
      SELECT t.id AS thread_id,
             COUNT(m.id) AS unread_count
      FROM threads t
      LEFT JOIN thread_reads r ON r.thread_id = t.id AND r.user_id = ?
      LEFT JOIN chat_messages m ON m.thread_id = t.id AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
      WHERE t.status = 'active'
      GROUP BY t.id
    `).all(userId) as { thread_id: string; unread_count: number }[];
    const result = new Map<string, number>();
    for (const row of rows) {
      result.set(row.thread_id, row.unread_count);
    }
    return result;
  }

  /* ---- Private ---- */

  private rowToThread(row: any): Thread {
    return {
      id: row.id, title: row.title, status: row.status,
      summary: row.summary ?? undefined,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  private rowToMessage(row: any): ChatMessage {
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(row.metadata_json); } catch {}
    return {
      id: row.id, threadId: row.thread_id, role: row.role, kind: row.kind,
      content: row.content, sender: row.sender, source: row.source,
      metadata, createdAt: row.created_at,
    };
  }

  /** Quick DB health check — returns true if a simple query succeeds. */
  checkHealth(): boolean {
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }
}
