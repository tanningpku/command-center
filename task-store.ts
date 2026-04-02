/**
 * Task Store for Command Center
 *
 * Lightweight SQLite-backed task management. Each Command Center instance
 * has its own task DB separate from any Companion harness.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type TaskState = "created" | "assigned" | "in_progress" | "in_review" | "qa" | "blocked" | "done" | "cancelled";

export interface Task {
  id: string;
  title: string;
  description: string;
  githubIssue?: number;
  githubPR?: number;
  state: TaskState;
  assignee?: string;
  collaborators: string[];
  createdBy: string;
  priority: "critical" | "high" | "normal" | "low";
  labels: string[];
  threadId?: string;
  latestUpdate?: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

export class TaskStore {
  private db: DatabaseSync;
  private nextNum = 1;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        github_issue INTEGER,
        github_pr INTEGER,
        state TEXT NOT NULL DEFAULT 'created',
        assignee TEXT,
        created_by TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        labels TEXT,
        collaborators TEXT,
        thread_id TEXT,
        latest_update TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    // Migration: add collaborators column if missing
    try {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN collaborators TEXT`);
    } catch { /* column already exists */ }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        actor TEXT NOT NULL,
        note TEXT,
        timestamp TEXT NOT NULL
      )
    `);

    // Find highest task number
    const row = this.db.prepare(`SELECT id FROM tasks ORDER BY created_at DESC LIMIT 1`).get() as { id: string } | undefined;
    if (row?.id?.startsWith("T-")) {
      this.nextNum = parseInt(row.id.slice(2), 10) + 1;
    }
  }

  create(opts: { title: string; description?: string; githubIssue?: number; priority?: string; labels?: string[]; createdBy: string; assignee?: string; collaborators?: string[] }): Task {
    const id = `T-${this.nextNum++}`;
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO tasks (id, title, description, github_issue, state, assignee, collaborators, created_by, priority, labels, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, opts.title, opts.description ?? null, opts.githubIssue ?? null,
      opts.assignee ? "assigned" : "created", opts.assignee ?? null,
      opts.collaborators?.length ? JSON.stringify(opts.collaborators) : null,
      opts.createdBy, opts.priority ?? "normal", JSON.stringify(opts.labels ?? []), now, now);
    this.recordEvent(id, null, opts.assignee ? "assigned" : "created", opts.createdBy);
    return this.get(id)!;
  }

  get(id: string): Task | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as any;
    return row ? this.rowToTask(row) : null;
  }

  findByGithubIssue(issueNumber: number): Task | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE github_issue = ?`).get(issueNumber) as any;
    return row ? this.rowToTask(row) : null;
  }

  list(opts?: { state?: string; assignee?: string; priority?: string; labels?: string[]; search?: string; limit?: number }): Task[] {
    const conds: string[] = [];
    const params: any[] = [];
    if (opts?.state && opts.state !== "all") { conds.push("state = ?"); params.push(opts.state); }
    if (opts?.assignee) { conds.push("assignee = ?"); params.push(opts.assignee); }
    if (opts?.priority) { conds.push("priority = ?"); params.push(opts.priority); }
    if (opts?.search) {
      conds.push("(title LIKE ? OR description LIKE ?)");
      const term = `%${opts.search}%`;
      params.push(term, term);
    }
    if (opts?.labels?.length) {
      for (const label of opts.labels) {
        // Match the exact JSON-encoded label string (e.g. "bug" not "debug")
        conds.push("labels LIKE ?");
        params.push(`%${JSON.stringify(label)}%`);
      }
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT * FROM tasks ${where} ORDER BY
        CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        created_at DESC LIMIT ?`,
    ).all(...params, opts?.limit ?? 100) as any[];
    return rows.map((r: any) => this.rowToTask(r));
  }

  private static readonly VALID_STATES = new Set<TaskState>(["created", "assigned", "in_progress", "in_review", "qa", "blocked", "done", "cancelled"]);

  update(id: string, opts: Partial<{ state: TaskState; assignee: string; collaborators: string[]; githubPR: number; latestUpdate: string; priority: string; labels: string[]; threadId: string }>, actor: string): Task {
    const task = this.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    if (opts.state && !TaskStore.VALID_STATES.has(opts.state)) {
      throw new Error(`Invalid task state: ${opts.state}. Valid states: ${[...TaskStore.VALID_STATES].join(", ")}`);
    }
    const sets: string[] = ["updated_at = ?"];
    const params: any[] = [new Date().toISOString()];
    if (opts.state) { sets.push("state = ?"); params.push(opts.state); this.recordEvent(id, task.state, opts.state, actor); }
    if (opts.assignee !== undefined) { sets.push("assignee = ?"); params.push(opts.assignee); }
    if (opts.githubPR !== undefined) { sets.push("github_pr = ?"); params.push(opts.githubPR); }
    if (opts.latestUpdate !== undefined) { sets.push("latest_update = ?"); params.push(opts.latestUpdate); }
    if (opts.priority) { sets.push("priority = ?"); params.push(opts.priority); }
    if (opts.collaborators) { sets.push("collaborators = ?"); params.push(JSON.stringify(opts.collaborators)); }
    if (opts.labels) { sets.push("labels = ?"); params.push(JSON.stringify(opts.labels)); }
    if (opts.threadId !== undefined) { sets.push("thread_id = ?"); params.push(opts.threadId); }
    params.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.get(id)!;
  }

  complete(id: string, actor: string, notes?: string): Task {
    return this.update(id, { state: "done", latestUpdate: notes ?? "Completed" }, actor);
  }

  private recordEvent(taskId: string, from: string | null, to: string, actor: string): void {
    this.db.prepare(
      `INSERT INTO task_events (task_id, from_state, to_state, actor, timestamp) VALUES (?, ?, ?, ?, ?)`,
    ).run(taskId, from, to, actor, new Date().toISOString());
  }

  private rowToTask(row: any): Task {
    return {
      id: row.id, title: row.title, description: row.description ?? "",
      githubIssue: row.github_issue ?? undefined, githubPR: row.github_pr ?? undefined,
      state: row.state, assignee: row.assignee ?? undefined,
      collaborators: row.collaborators ? JSON.parse(row.collaborators) : [],
      createdBy: row.created_by,
      priority: row.priority, labels: row.labels ? JSON.parse(row.labels) : [],
      threadId: row.thread_id ?? undefined, latestUpdate: row.latest_update ?? undefined,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  /** Returns the ISO timestamp of the most recent task_event for a given task, or null. */
  getLastEventTime(taskId: string): string | null {
    const row = this.db.prepare(
      `SELECT timestamp FROM task_events WHERE task_id = ? ORDER BY timestamp DESC LIMIT 1`,
    ).get(taskId) as { timestamp: string } | undefined;
    return row?.timestamp ?? null;
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
