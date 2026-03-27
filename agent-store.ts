/**
 * Agent Store for Command Center
 *
 * Manages dynamic agents created by Captain. Stored in SQLite,
 * separate from the Companion harness's assistant registry.
 */
import { DatabaseSync } from "node:sqlite";

export interface Agent {
  id: string;
  name: string;
  role: string;
  strengths: string[];
  status: "active" | "running" | "stopped" | "archived";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export class AgentStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT,
        strengths TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT NOT NULL DEFAULT 'captain',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  create(opts: { id?: string; name: string; role?: string; strengths?: string[]; createdBy?: string }): Agent {
    const id = opts.id ?? opts.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO agents (id, name, role, strengths, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(id, opts.name, opts.role ?? "", JSON.stringify(opts.strengths ?? []),
      opts.createdBy ?? "captain", now, now);
    return this.get(id)!;
  }

  get(id: string): Agent | null {
    const row = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as any;
    return row ? this.rowToAgent(row) : null;
  }

  list(opts?: { status?: string }): Agent[] {
    if (opts?.status && opts.status !== "all") {
      return (this.db.prepare(`SELECT * FROM agents WHERE status = ? ORDER BY created_at DESC`).all(opts.status) as any[])
        .map((r: any) => this.rowToAgent(r));
    }
    return (this.db.prepare(`SELECT * FROM agents WHERE status != 'archived' ORDER BY created_at DESC`).all() as any[])
      .map((r: any) => this.rowToAgent(r));
  }

  update(id: string, opts: Partial<{ name: string; role: string; strengths: string[]; status: string }>): Agent {
    const sets: string[] = ["updated_at = ?"];
    const params: any[] = [new Date().toISOString()];
    if (opts.name) { sets.push("name = ?"); params.push(opts.name); }
    if (opts.role !== undefined) { sets.push("role = ?"); params.push(opts.role); }
    if (opts.strengths) { sets.push("strengths = ?"); params.push(JSON.stringify(opts.strengths)); }
    if (opts.status) { sets.push("status = ?"); params.push(opts.status); }
    params.push(id);
    this.db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.get(id)!;
  }

  archive(id: string): void {
    this.update(id, { status: "archived" });
  }

  private rowToAgent(row: any): Agent {
    return {
      id: row.id, name: row.name, role: row.role ?? "",
      strengths: row.strengths ? JSON.parse(row.strengths) : [],
      status: row.status, createdBy: row.created_by,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
}
