/**
 * GitHub Plugin for Command Center
 *
 * Fetches issues, PRs, and workflow runs via the `gh` CLI,
 * caches results, and provides a Kanban board view for the Board tab.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface CachedIssue {
  number: number;
  title: string;
  state: string;
  assignees: string[];
  labels: string[];
  updatedAt: string;
  createdAt: string;
  age: string;
}

export interface CachedPR {
  number: number;
  title: string;
  state: string;
  author: string;
  reviewRequests: string[];
  updatedAt: string;
  createdAt: string;
  headRefName: string;
  age: string;
}

export interface CachedRun {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string;
  createdAt: string;
  updatedAt: string;
  age: string;
}

export interface BoardColumn {
  id: string;
  label: string;
  issues: CachedIssue[];
}

export interface BoardData {
  columns: BoardColumn[];
  lastUpdated: string;
  source: "github" | "cache";
}

interface GitHubPluginOptions {
  repo: string;
  cacheTtlMs?: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function humanAge(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? "" : "s"}`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks} week${weeks === 1 ? "" : "s"}`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? "" : "s"}`;
}

async function ghJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("gh", args, {
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

/* ------------------------------------------------------------------ */
/*  Raw GH response shapes                                             */
/* ------------------------------------------------------------------ */

interface GhIssue {
  number: number;
  title: string;
  state: string;
  assignees: { login: string }[];
  labels: { name: string }[];
  updatedAt: string;
  createdAt: string;
}

interface GhPR {
  number: number;
  title: string;
  state: string;
  author: { login: string };
  reviewRequests: { login?: string; name?: string }[];
  updatedAt: string;
  createdAt: string;
  headRefName: string;
}

interface GhRun {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/*  Plugin                                                             */
/* ------------------------------------------------------------------ */

export class GitHubPlugin {
  private repo: string;
  private issuesTtl: number;
  private actionsTtl: number;

  private issuesCache: CachedIssue[] = [];
  private pullsCache: CachedPR[] = [];
  private runsCache: CachedRun[] = [];

  private issuesUpdatedAt = "";
  private pullsUpdatedAt = "";
  private runsUpdatedAt = "";

  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(opts: GitHubPluginOptions) {
    this.repo = opts.repo;
    this.issuesTtl = opts.cacheTtlMs ?? 5 * 60_000; // 5 min
    this.actionsTtl = Math.min(this.issuesTtl, 2 * 60_000); // 2 min
  }

  /* ----- public API ------------------------------------------------- */

  async init(): Promise<void> {
    // Warm all caches in parallel
    await Promise.allSettled([
      this.refreshIssues(),
      this.refreshPulls(),
      this.refreshRuns(),
    ]);

    // Schedule background refreshes
    this.timers.push(
      setInterval(() => void this.refreshIssues(), this.issuesTtl),
      setInterval(() => void this.refreshPulls(), this.issuesTtl),
      setInterval(() => void this.refreshRuns(), this.actionsTtl),
    );

    console.log(
      `[github-plugin] Initialized for ${this.repo} — ` +
        `${this.issuesCache.length} issues, ` +
        `${this.pullsCache.length} PRs, ` +
        `${this.runsCache.length} runs`,
    );
  }

  shutdown(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  getIssues(): CachedIssue[] {
    return this.issuesCache;
  }

  getPulls(): CachedPR[] {
    return this.pullsCache;
  }

  getActions(): CachedRun[] {
    return this.runsCache;
  }

  getBoard(): BoardData {
    const prBranches = new Set(this.pullsCache.map((pr) => pr.headRefName));
    const prNumbers = new Set(this.pullsCache.map((pr) => pr.number));

    const done: CachedIssue[] = [];
    const inReview: CachedIssue[] = [];
    const inProgress: CachedIssue[] = [];
    const backlog: CachedIssue[] = [];

    for (const issue of this.issuesCache) {
      if (issue.state === "CLOSED") {
        done.push(issue);
        continue;
      }

      // Check if there's a linked PR — heuristic: branch contains issue number
      const hasLinkedPR = this.pullsCache.some(
        (pr) =>
          pr.state === "OPEN" &&
          (pr.headRefName.includes(`${issue.number}`) ||
            pr.title.toLowerCase().includes(`#${issue.number}`)),
      );

      if (hasLinkedPR) {
        inReview.push(issue);
        continue;
      }

      const hasInProgressLabel = issue.labels.some(
        (l) => l.toLowerCase() === "in-progress" || l.toLowerCase() === "in progress",
      );
      if (hasInProgressLabel || issue.assignees.length > 0) {
        inProgress.push(issue);
        continue;
      }

      backlog.push(issue);
    }

    return {
      columns: [
        { id: "backlog", label: "Backlog", issues: backlog },
        { id: "in-progress", label: "In Progress", issues: inProgress },
        { id: "in-review", label: "In Review", issues: inReview },
        { id: "done", label: "Done", issues: done.slice(0, 20) }, // cap done to recent 20
      ],
      lastUpdated: this.issuesUpdatedAt || new Date().toISOString(),
      source: this.issuesUpdatedAt ? "github" : "cache",
    };
  }

  /* ----- internal refresh ------------------------------------------- */

  private async refreshIssues(): Promise<void> {
    try {
      const raw = await ghJson<GhIssue[]>([
        "issue",
        "list",
        "--repo",
        this.repo,
        "--state",
        "all",
        "--json",
        "number,title,state,assignees,labels,updatedAt,createdAt",
        "--limit",
        "100",
      ]);

      this.issuesCache = raw.map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        assignees: i.assignees.map((a) => a.login),
        labels: i.labels.map((l) => l.name),
        updatedAt: i.updatedAt,
        createdAt: i.createdAt,
        age: humanAge(i.createdAt),
      }));
      this.issuesUpdatedAt = new Date().toISOString();
    } catch (err) {
      console.warn("[github-plugin] Failed to refresh issues, using stale cache:", (err as Error).message);
    }
  }

  private async refreshPulls(): Promise<void> {
    try {
      const raw = await ghJson<GhPR[]>([
        "pr",
        "list",
        "--repo",
        this.repo,
        "--state",
        "all",
        "--json",
        "number,title,state,author,reviewRequests,updatedAt,createdAt,headRefName",
        "--limit",
        "50",
      ]);

      this.pullsCache = raw.map((p) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        author: p.author?.login ?? "unknown",
        reviewRequests: (p.reviewRequests ?? []).map((r) => r.login ?? r.name ?? ""),
        updatedAt: p.updatedAt,
        createdAt: p.createdAt,
        headRefName: p.headRefName,
        age: humanAge(p.createdAt),
      }));
      this.pullsUpdatedAt = new Date().toISOString();
    } catch (err) {
      console.warn("[github-plugin] Failed to refresh PRs, using stale cache:", (err as Error).message);
    }
  }

  private async refreshRuns(): Promise<void> {
    try {
      const raw = await ghJson<GhRun[]>([
        "run",
        "list",
        "--repo",
        this.repo,
        "--json",
        "databaseId,name,status,conclusion,createdAt,updatedAt",
        "--limit",
        "20",
      ]);

      this.runsCache = raw.map((r) => ({
        databaseId: r.databaseId,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion ?? "",
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        age: humanAge(r.createdAt),
      }));
      this.runsUpdatedAt = new Date().toISOString();
    } catch (err) {
      console.warn("[github-plugin] Failed to refresh runs, using stale cache:", (err as Error).message);
    }
  }
}
