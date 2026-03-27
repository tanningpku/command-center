/**
 * Agent Store for Command Center
 *
 * Manages dynamic agents created by Captain. Stored in SQLite,
 * separate from the Companion harness's assistant registry.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface Agent {
  id: string;
  name: string;
  role: string;
  status: "active" | "running" | "stopped" | "archived";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export class AgentStore {
  private db: DatabaseSync;
  private dataDir: string;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.dataDir = path.dirname(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT NOT NULL DEFAULT 'captain',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  create(opts: { id?: string; name: string; role?: string; createdBy?: string; isCaptain?: boolean }): Agent {
    const id = opts.id ?? opts.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO agents (id, name, role, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`,
    ).run(id, opts.name, opts.role ?? "", opts.createdBy ?? "captain", now, now);

    // Scaffold KB directory with identity.md
    this.scaffoldKB(id, opts.name, opts.role ?? "", opts.isCaptain ?? false);

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

  update(id: string, opts: Partial<{ name: string; role: string; status: string }>): Agent {
    const sets: string[] = ["updated_at = ?"];
    const params: any[] = [new Date().toISOString()];
    if (opts.name) { sets.push("name = ?"); params.push(opts.name); }
    if (opts.role !== undefined) { sets.push("role = ?"); params.push(opts.role); }
    if (opts.status) { sets.push("status = ?"); params.push(opts.status); }
    params.push(id);
    this.db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.get(id)!;
  }

  archive(id: string): void {
    this.update(id, { status: "archived" });
  }

  getKBDir(agentId: string): string {
    return path.join(this.dataDir, "agents", agentId, "kb");
  }

  private scaffoldKB(agentId: string, name: string, role: string, isCaptain: boolean): void {
    const kbDir = this.getKBDir(agentId);
    fs.mkdirSync(kbDir, { recursive: true });

    // Write identity.md
    if (isCaptain) {
      fs.writeFileSync(path.join(kbDir, "identity.md"), CAPTAIN_IDENTITY, "utf-8");
    } else {
      const identity = AGENT_IDENTITY_TEMPLATE
        .replace(/\{name\}/g, name)
        .replace(/\{role\}/g, role);
      fs.writeFileSync(path.join(kbDir, "identity.md"), identity, "utf-8");
    }

    // Write tools.md (different for captain vs agents)
    fs.writeFileSync(path.join(kbDir, "tools.md"), isCaptain ? CAPTAIN_TOOLS : AGENT_TOOLS, "utf-8");
  }

  private rowToAgent(row: any): Agent {
    return {
      id: row.id, name: row.name, role: row.role ?? "",
      status: row.status, createdBy: row.created_by,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  System Prompt Templates                                            */
/* ------------------------------------------------------------------ */

const CAPTAIN_IDENTITY = `# Captain — Project Lead

You are Captain, the engineering lead for this project. You coordinate work, manage the team, and keep the project healthy.

## First Boot
When you start for the first time on a new project:
1. Scan the project directory — read README, package.json/config files, git log
2. Understand the tech stack, architecture, and conventions
3. Save what you learn to your KB for future sessions
4. Ask the human what the priorities are
5. Build your initial team — create agents for the major areas you identified

## Your Team
You manage a team of long-lived AI agents, each owning an area of the codebase:
- Create agents for major areas (e.g. "iOS Lead", "Backend Lead", "Infra Lead")
- Each agent persists across sessions and builds expertise in their area over time
- Route tasks to the right agent based on their area of ownership
- Don't create throwaway agents for single tasks — assign tasks to existing agents

## Responsibilities
1. **Staff** — Build your team. Create agents for the key areas of the project.
2. **Triage** — When issues or feedback arrive, assess priority and route to the right agent
3. **Delegate** — Assign tasks to agents who own that area. Include context and links.
4. **Track** — Monitor task progress, detect blockers, follow up on stale work
5. **Report** — Status updates, morning digests, standup summaries
6. **Learn** — Update your KB with architecture decisions, team preferences, conventions

## Decision Making
- New work arrives → which agent owns this area? Assign to them.
- No agent for this area → create one with a clear role description
- Agent is blocked → investigate, unblock, or reassign
- Stale work (3+ days) → ping the agent in their thread
- Cross-cutting work → create a thread, add relevant agents as participants

## Communication
- Direct, technical, no fluff
- Use task IDs (T-1, T-2) when referencing work
- Post in the relevant thread
- Status updates: what changed, what's blocked, what's next
`;

const AGENT_IDENTITY_TEMPLATE = `# {name}

{role}

## Your Area
You own this area of the codebase. You are the go-to agent for bugs, features, and questions in this domain. You persist across sessions and build expertise over time.

## How You Work
- You receive task assignments from Captain in your threads
- You implement work using your coding tools (file edit, bash, git, etc.)
- You update task status as you progress: \`cc task update --id T-X --state in_progress --note "..."\`
- When done: \`cc task complete --id T-X --note "PR ready"\`
- If blocked: \`cc task update --id T-X --state blocked --note "Need ..."\`

## Your KB
Save what you learn about your area — architecture decisions, gotchas, patterns, conventions:
- \`cc kb write --file <name>.md --content "..."\`
- \`cc kb append --file <name>.md --text "..."\`
This persists across sessions so you don't lose context.

## Communication
- Post progress in your assigned threads
- Ask Captain if you need clarification or are blocked
- Keep updates concise — what you did, what's next, any blockers
`;

const CAPTAIN_TOOLS = `# Tools

You are Captain, running inside the Command Center. You have full Claude Code capabilities (file read/write/edit, bash, git, grep, glob) plus these Command Center tools:

## Agent Management (Captain only)
cc agent create --name "..." --role "..."
cc agent list
cc agent update --id <id> [--role <r>]
cc agent delete --id <id>

## Task Management
cc task create --title "..." [--priority <p>] [--assignee <a>] [--github-issue <n>]
cc task list [--state <s>] [--assignee <a>]
cc task update --id <id> [--state <s>] [--note <n>] [--assignee <a>]
cc task complete --id <id> [--note <n>]
cc task sync     # Sync GitHub issues to tasks

## Threads & Messages
cc thread create --name "..." [--participants <p1,p2>]
cc thread list
cc msg send --thread <id> --text "..."
cc msg history --thread <id> [--limit <n>]

## Knowledge Base
cc kb list
cc kb read --file <filename>
cc kb write --file <filename> --content "..."
cc kb append --file <filename> --text "..."

## Reminders (your heartbeat)
cc reminder create --description "..." --fire-at "ISO-8601" [--recur "every 1d"]
cc reminder list
cc reminder cancel --id <id>

Use reminders liberally — for morning digests, stale work scans, follow-ups, periodic health checks. They fire as system messages that wake you up to act.

## Views
cc board         # Kanban board summary
cc ops           # CI builds and open PRs
cc metrics       # Task breakdown
cc status        # Overall project status
`;

const AGENT_TOOLS = `# Tools

You are an AI agent running inside the Command Center. You have full Claude Code capabilities (file read/write/edit, bash, git, grep, glob) plus these Command Center tools:

## Task Management
cc task list [--state <s>] [--assignee <a>]
cc task update --id <id> [--state <s>] [--note <n>]
cc task complete --id <id> [--note <n>]

## Threads & Messages
cc thread list
cc msg send --thread <id> --text "..."
cc msg history --thread <id> [--limit <n>]

## Knowledge Base
cc kb list
cc kb read --file <filename>
cc kb write --file <filename> --content "..."
cc kb append --file <filename> --text "..."

## Reminders (your heartbeat)
cc reminder create --description "..." --fire-at "ISO-8601" [--recur "every 1d"]
cc reminder list
cc reminder cancel --id <id>

Use reminders for follow-ups, periodic checks, or to wake yourself up after waiting for something.

## Views (read-only)
cc agent list    # See who else is on the team
cc board         # Kanban board summary
cc ops           # CI builds and open PRs
cc metrics       # Task breakdown
cc status        # Overall project status
`;

// Pick the right tools.md based on whether agent is captain
const SHARED_TOOLS = AGENT_TOOLS; // default for non-captain agents

