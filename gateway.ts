/**
 * Command Center Gateway
 *
 * Lightweight HTTP server that:
 *   - Serves the unified Command Center UI
 *   - Maintains a project registry (loaded from YAML configs)
 *   - Manages threads, messages, and Claude bridges natively
 *   - Exposes /api/registry for the project list
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import { exec, execFileSync } from "node:child_process";
import { GitHubPlugin } from "./github-plugin.js";
import { TaskStore } from "./task-store.js";
import { AgentStore, CAPTAIN_IDENTITY, CAPTAIN_TOOLS } from "./agent-store.js";
import { ThreadStore } from "./thread-store.js";
import { ClaudeBridge, killStaleClaude, type AssistantTextPayload, type ResultPayload } from "./claude-bridge.js";
import { SseHub } from "./sse-hub.js";
import { KbManager } from "./kb-manager.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ProjectConfig {
  id: string;
  name: string;
  port: number;
  repo: string;
  status: "active" | "inactive";
  directory?: string;
}

export interface GatewayOptions {
  /** Port for the gateway itself */
  port: number;
  /** Loaded project configs */
  projects: ProjectConfig[];
  /** Directory containing the static UI files */
  uiDir: string;
  /** Directory for data files (task DB, etc.) */
  dataDir: string;
  /** Directory containing project YAML config files */
  configDir: string;
}

/** Canonical message structure — every message flows through this. */
export interface ChannelMessage {
  projectId: string;
  threadId: string;
  sender: {
    id: string;           // "ning", "captain", "ios-lead", "system"
    type: "user" | "assistant" | "system";
  };
  channel: "thread";      // future: "dm", "broadcast"
  mode: "text";           // future: "voice"
  content: string;
  kind?: "message" | "thought" | "system";
  source?: string;        // "webui" | "cli" | "assistant" | "gateway" | "task-update"
  metadata?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  MIME types                                                         */
/* ------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/* ------------------------------------------------------------------ */
/*  Gateway                                                            */
/* ------------------------------------------------------------------ */

export class Gateway {
  private readonly server: http.Server;
  private readonly projects: Map<string, ProjectConfig>;
  private readonly githubPlugins: Map<string, GitHubPlugin>;
  private readonly taskStores: Map<string, TaskStore>;
  private readonly agentStores: Map<string, AgentStore>;
  private readonly threadStores: Map<string, ThreadStore> = new Map();
  private readonly kbManagers: Map<string, KbManager> = new Map();
  /** Bridges keyed by "projectId:agentId" */
  private readonly claudeBridges: Map<string, ClaudeBridge> = new Map();
  /** Bridges stopped by restart escalation — prevents ensureBridge from respawning them. */
  private readonly escalationStoppedBridges: Set<string> = new Set();
  private readonly sseHub = new SseHub();
  /** Next available worker port per project */
  private readonly nextWorkerPort: Map<string, number> = new Map();
  private readonly uiDir: string;
  private readonly dataDir: string;
  private readonly configDir: string;
  private readonly port: number;
  /** Active auth tokens (in-memory). Only used when CC_PASSWORD is set. */
  private readonly authTokens: Set<string> = new Set();
  private readonly authPassword: string | undefined = process.env.CC_PASSWORD;

  /* ---- Health metrics ---- */
  private readonly gatewayStartedAt = Date.now();
  private requestCount = 0;
  private readonly errorTimestamps: number[] = [];

  private trackError(): void {
    this.errorTimestamps.push(Date.now());
  }

  private errorsLastHour(): number {
    const cutoff = Date.now() - 3_600_000;
    // Prune old entries
    while (this.errorTimestamps.length > 0 && this.errorTimestamps[0] < cutoff) {
      this.errorTimestamps.shift();
    }
    return this.errorTimestamps.length;
  }

  constructor(opts: GatewayOptions) {
    this.port = opts.port;
    this.uiDir = opts.uiDir;
    this.dataDir = opts.dataDir;
    this.configDir = opts.configDir;
    this.projects = new Map(opts.projects.map((p) => [p.id, p]));
    this.githubPlugins = new Map();
    this.taskStores = new Map();
    this.agentStores = new Map();

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
  }

  private bridgeKey(projectId: string, agentId: string): string {
    return `${projectId}:${agentId}`;
  }

  private allocateWsPort(projectId: string, agentId: string): number {
    const project = this.projects.get(projectId)!;
    if (agentId === "captain") return project.port + 10000;
    let next = this.nextWorkerPort.get(projectId) ?? (project.port + 10100);
    this.nextWorkerPort.set(projectId, next + 1);
    return next;
  }

  async start(): Promise<void> {
    // Initialize stores for each project
    fs.mkdirSync(this.dataDir, { recursive: true });
    for (const [id, project] of this.projects) {
      this.taskStores.set(id, new TaskStore(path.join(this.dataDir, `${id}-tasks.db`)));
      this.agentStores.set(id, new AgentStore(path.join(this.dataDir, `${id}-agents.db`)));
      this.threadStores.set(id, new ThreadStore(path.join(this.dataDir, `${id}-threads.db`)));
      const kbDir = path.join(this.dataDir, "agents", id, "captain", "kb");
      const kb = new KbManager(kbDir);
      kb.ensureDir();
      this.kbManagers.set(this.bridgeKey(id, "captain"), kb);
      // Backfill existing agents into the team broadcast thread
      this.backfillTeamParticipants(id);
      console.log(`[gateway] Stores initialized for ${id}`);
    }

    // Verify DB health for all stores
    for (const [id] of this.projects) {
      const stores = [
        { name: "tasks", store: this.taskStores.get(id) },
        { name: "agents", store: this.agentStores.get(id) },
        { name: "threads", store: this.threadStores.get(id) },
      ];
      for (const { name, store } of stores) {
        if (!store || !store.checkHealth()) {
          console.error(`[gateway] DB health check FAILED for ${id}/${name} — store may be corrupt`);
        }
      }
    }

    // Initialize GitHub plugins for projects with repos
    for (const [id, project] of this.projects) {
      if (project.repo) {
        const plugin = new GitHubPlugin({ repo: project.repo });
        try {
          await plugin.init();
          this.githubPlugins.set(id, plugin);
        } catch (err) {
          console.warn(`[gateway] Failed to init GitHub plugin for ${id}:`, (err as Error).message);
        }
      }
    }

    // Auto-sync GitHub issues to tasks on startup
    for (const [id, plugin] of this.githubPlugins) {
      const store = this.taskStores.get(id);
      if (store) {
        const synced = this.syncGithubIssuesToTasks(plugin, store);
        if (synced > 0) {
          console.log(`[gateway] Auto-synced ${synced} GitHub issues to tasks for ${id}`);
        }
      }
    }

    // Clean up stale bridge processes from prior runs
    this.cleanupStaleBridges();

    // Start captain bridges for each project
    for (const [id, project] of this.projects) {
      if (project.status === "inactive") continue;
      await this.startAgentBridge(id, project, "captain");
    }

    this.server.listen(this.port, () => {
      console.log(`[gateway] Command Center listening on http://localhost:${this.port}`);
    });
  }

  stop(): void {
    for (const plugin of this.githubPlugins.values()) plugin.shutdown();
    for (const [id, bridge] of this.claudeBridges) {
      console.log(`[gateway] Stopping Claude bridge for ${id}`);
      bridge.stop();
    }
    this.claudeBridges.clear();
    this.server.close();
  }

  /** Ensure all existing agents are participants on the team broadcast thread. */
  private backfillTeamParticipants(projectId: string): void {
    const agentStore = this.agentStores.get(projectId);
    const threadStore = this.threadStores.get(projectId);
    if (!agentStore || !threadStore) return;
    for (const agent of agentStore.list()) {
      threadStore.addParticipant("team", { participantType: "assistant", participantId: agent.id });
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Claude Bridge lifecycle                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Kill stale claude CLI processes from prior gateway runs.
   * Only targets processes confirmed to be claude CLI instances via their
   * command-line arguments (--sdk-url matching our expected WS ports).
   * Called once at startup before any bridges are created.
   */
  private cleanupStaleBridges(): void {
    // Collect all WS ports we'll need (captain ports + known agent ports)
    const wsPorts: number[] = [];
    for (const [id, project] of this.projects) {
      if (project.status === "inactive") continue;
      wsPorts.push(project.port + 10000);
      const agentStore = this.agentStores.get(id);
      if (agentStore) {
        let workerPort = project.port + 10100;
        for (const agent of agentStore.list()) {
          if (agent.id === "captain") continue;
          wsPorts.push(workerPort++);
        }
      }
    }

    const killed = killStaleClaude(wsPorts);
    if (killed > 0) {
      console.log(`[gateway] Cleaned up ${killed} stale claude process(es)`);
    }
  }

  private async startAgentBridge(projectId: string, project: ProjectConfig, agentId: string): Promise<ClaudeBridge> {
    const projectDir = project.directory || this.dataDir;
    const ccBinDir = path.resolve(this.configDir, "..", "bin");
    const isCaptain = agentId === "captain";
    const compositeKey = this.bridgeKey(projectId, agentId);

    // Resolve KB directory
    let kbDir: string;
    if (isCaptain) {
      kbDir = path.join(this.dataDir, "agents", projectId, "captain", "kb");
      fs.mkdirSync(kbDir, { recursive: true });
      fs.writeFileSync(path.join(kbDir, "identity.md"), CAPTAIN_IDENTITY, "utf-8");
      fs.writeFileSync(path.join(kbDir, "tools.md"), CAPTAIN_TOOLS, "utf-8");
    } else {
      const agentStore = this.agentStores.get(projectId)!;
      kbDir = agentStore.getKBDir(agentId);
    }

    // Build system prompt from KB files + project context
    const identity = fs.readFileSync(path.join(kbDir, "identity.md"), "utf-8");
    const tools = fs.readFileSync(path.join(kbDir, "tools.md"), "utf-8");
    const projectContext = [
      `## Project Context`,
      `- **Project**: ${project.name} (id: ${projectId})`,
      `- **Directory**: ${projectDir}`,
      project.repo ? `- **Repo**: ${project.repo}` : null,
      ``,
      `You are scoped to this project only. Do not access or reference other projects, their directories, or the command-center gateway codebase. Your working directory is ${projectDir}.`,
    ].filter(Boolean).join("\n");

    const currentState = this.buildInitialStateForPrompt(projectId);
    const systemPrompt = `${identity}\n\n${projectContext}\n\n${currentState}\n\n---\n\n${tools}`;

    // Resolve agent display name for initial prompt
    let agentName = agentId;
    if (!isCaptain) {
      const agentStore = this.agentStores.get(projectId);
      agentName = agentStore?.get(agentId)?.name ?? agentId;
    } else {
      agentName = "Captain";
    }

    const bridge = new ClaudeBridge({
      projectId,
      agentId,
      wsPort: this.allocateWsPort(projectId, agentId),
      projectDir,
      systemPrompt,
      claudeCommand: process.env.CLAUDE_BIN ?? "claude",
      mockClaude: process.env.MOCK_CLAUDE === "1",
      ccBinDir,
      initialPrompt: `${agentName} online — ready for work`,
    });

    // Wire bridge events — agentId captured in closure
    bridge.on("ready", () => {
      this.sseHub.publish(projectId, "claude_ready", { agentId, ready: true });
      this.sseHub.publish(projectId, "bridge_status_changed", { agentId, status: "ready", previousStatus: "connecting" });
      console.log(`[gateway] Claude ready for ${projectId}/${agentId}`);
    });

    bridge.on("assistant_text", (payload: AssistantTextPayload) => {
      // Stream preview to captain bar only — not persisted.
      // Agents must use `cc msg send` to post messages to threads.
      this.sseHub.publish(projectId, "assistant_text", {
        agentId,
        content: payload.fullText,
        createdAt: new Date().toISOString(),
      });
    });

    bridge.on("result", (payload: ResultPayload) => {
      // Metadata-only — the agent's actual message is sent via `cc msg send`
      this.sseHub.publish(projectId, "claude_result", {
        agentId,
        sessionId: payload.sessionId,
        totalCostUsd: payload.totalCostUsd,
        subtype: payload.subtype,
      });
    });

    bridge.on("restarted", (info: { reason: string }) => {
      // Note: "restarted" fires after "ready" — the bridge is already up.
      // We publish agent_restarted for logging/alerting but don't duplicate
      // the bridge_status_changed event (ready handler covers that).
      this.sseHub.publish(projectId, "agent_restarted", { agentId, reason: info.reason });
      this.postHealthAlert(projectId, `✅ Bridge **${agentId}** recovered — restarted successfully (reason: ${info.reason}).`);
    });

    bridge.on("watchdog_kill", (info: { agentId: string; sinceActivityMs: number }) => {
      console.warn(`[gateway] Watchdog killed bridge for ${projectId}/${info.agentId} (no activity for ${Math.round(info.sinceActivityMs / 1000)}s)`);
      this.sseHub.publish(projectId, "bridge_watchdog_kill", {
        agentId: info.agentId,
        sinceActivityMs: info.sinceActivityMs,
        timestamp: new Date().toISOString(),
      });
      this.sseHub.publish(projectId, "bridge_status_changed", { agentId: info.agentId, status: "stuck", previousStatus: "ready" });
      this.postHealthAlert(projectId, `⚠️ Bridge **${agentId}** appears stuck — no activity for ${Math.round(info.sinceActivityMs / 1000)}s. Auto-restarting.`);
    });

    bridge.on("idle_restart", (info: { agentId: string; sinceActivityMs: number }) => {
      console.warn(`[gateway] Idle restart for ${projectId}/${info.agentId} (not ready, no activity for ${Math.round(info.sinceActivityMs / 1000)}s)`);
      this.sseHub.publish(projectId, "bridge_idle_restart", {
        agentId: info.agentId,
        sinceActivityMs: info.sinceActivityMs,
        timestamp: new Date().toISOString(),
      });
      this.sseHub.publish(projectId, "bridge_status_changed", { agentId: info.agentId, status: "idle_restart", previousStatus: "disconnected" });
      this.postHealthAlert(projectId, `⚠️ Bridge **${agentId}** idle — not ready for ${Math.round(info.sinceActivityMs / 1000)}s. Auto-restarting.`);
    });

    bridge.on("escalation_stop", (info: { agentId: string; restartCount: number; windowMs: number; lastReason: string }) => {
      console.error(`[gateway] Escalation stop for ${projectId}/${info.agentId} — ${info.restartCount} restarts in ${info.windowMs / 1000}s`);
      this.sseHub.publish(projectId, "bridge_escalation_stop", {
        agentId: info.agentId,
        restartCount: info.restartCount,
        windowMs: info.windowMs,
        lastReason: info.lastReason,
        timestamp: new Date().toISOString(),
      });
      this.sseHub.publish(projectId, "bridge_status_changed", { agentId: info.agentId, status: "escalation_stopped", previousStatus: "restarting" });
      // Keep bridge in claudeBridges so health/status APIs can still report it as stopped
      this.escalationStoppedBridges.add(compositeKey);
      this.postHealthAlert(projectId, `🚨 Bridge **${agentId}** stopped — ${info.restartCount} restarts in ${Math.round(info.windowMs / 1000)}s (last: ${info.lastReason}). Manual intervention required.`);
    });

    this.claudeBridges.set(compositeKey, bridge);
    await bridge.start();
    return bridge;
  }

  /* ---------------------------------------------------------------- */
  /*  Context builders                                                 */
  /* ---------------------------------------------------------------- */

  /** Build a snapshot of current project state for the captain's system prompt. */
  private buildInitialStateForPrompt(projectId: string): string {
    const lines: string[] = ["## Current State"];

    const agentStore = this.agentStores.get(projectId);
    if (agentStore) {
      const agents = agentStore.list();
      if (agents.length > 0) {
        lines.push("", "### Team");
        for (const a of agents) {
          lines.push(`- **${a.name}** (${a.id}): ${a.role || "no role set"} [${a.status}]`);
        }
      }
    }

    const taskStore = this.taskStores.get(projectId);
    if (taskStore) {
      const tasks = taskStore.list({ limit: 20 });
      const active = tasks.filter(t => t.state !== "done" && t.state !== "cancelled");
      if (active.length > 0) {
        lines.push("", "### Active Tasks");
        for (const t of active) {
          lines.push(`- **${t.id}**: ${t.title} [${t.state}]${t.assignee ? ` → ${t.assignee}` : ""}${t.threadId ? ` (thread: ${t.threadId})` : ""}`);
        }
      }
    }

    if (lines.length === 1) {
      lines.push("", "No agents or tasks yet. This may be a new project — consider scanning the codebase and setting up the team.");
    }

    return lines.join("\n");
  }

  /** Build thread context (title + recent history) for bridge forwarding. */
  private buildThreadContext(projectId: string, threadId: string): string {
    const threadStore = this.threadStores.get(projectId);
    if (!threadStore) return `[thread:${threadId}]`;

    const thread = threadStore.getThread(threadId);
    const title = thread?.title ?? threadId;
    const lines: string[] = [`[thread:${threadId} "${title}"]`];

    const messages = threadStore.getMessages(threadId, { limit: 15 });
    if (messages.length > 0) {
      lines.push("", "--- Recent thread history ---");
      for (const m of messages) {
        const sender = m.sender ?? m.role;
        const time = m.createdAt ? new Date(m.createdAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "";
        let content = m.content;
        const paths = Array.isArray(m.metadata?.imagePaths) ? m.metadata.imagePaths as string[] : [];
        if (paths.length > 0 && !content.startsWith("[image:")) {
          content = `[image: ${paths.join(", ")}]\n${content}`;
        }
        lines.push(`[${time}] ${sender}: ${content}`);
      }
      lines.push("--- End of history ---", "");
    }

    return lines.join("\n");
  }

  /* ---------------------------------------------------------------- */
  /*  Unified message pipeline                                         */
  /* ---------------------------------------------------------------- */

  /** Format a ChannelMessage into the text string sent to a Claude bridge. */
  private formatForBridge(msg: ChannelMessage): string {
    const now = new Date();
    const timestamp = now.toLocaleString("en-US", {
      weekday: "short", year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
    });
    const threadContext = this.buildThreadContext(msg.projectId, msg.threadId);
    return [
      `[${timestamp}]`,
      threadContext,
      `[from: ${msg.sender.id} (${msg.sender.type}) via ${msg.source ?? "unknown"}]`,
      ``,
      msg.content,
    ].join("\n");
  }

  /**
   * Single entry point for all messages. Persists, broadcasts via SSE,
   * and fans out to participant bridges.
   */
  private dispatchMessage(msg: ChannelMessage): void {
    const threadStore = this.threadStores.get(msg.projectId);
    if (!threadStore) return;

    // 1. Persist
    const role: "user" | "assistant" = msg.sender.type === "user" ? "user" : "assistant";
    threadStore.insertMessage(msg.threadId, role, msg.content, {
      kind: msg.kind,
      sender: msg.sender.id,
      source: msg.source,
      metadata: {
        ...msg.metadata,
        senderType: msg.sender.type,
        channel: msg.channel,
        mode: msg.mode,
      },
    });

    // 2. Broadcast to UI via SSE
    this.sseHub.publish(msg.projectId, "thread_message", {
      threadId: msg.threadId,
      role: msg.sender.type === "user" ? "user" : "assistant",
      sender: msg.sender.id,
      channel: msg.channel,
      mode: msg.mode,
      content: msg.content,
      kind: msg.kind ?? "message",
      source: msg.source,
      metadata: msg.metadata,
      createdAt: new Date().toISOString(),
    });

    // 3. Fan out to participant bridges (skip sender)
    void this.fanOutToBridges(msg);
  }

  /** Forward a message to all participant bridges except the sender's. */
  private async fanOutToBridges(msg: ChannelMessage): Promise<void> {
    const threadStore = this.threadStores.get(msg.projectId);
    if (!threadStore) return;

    const participants = threadStore.getParticipants(msg.threadId);
    const formatted = this.formatForBridge(msg);

    for (const p of participants) {
      if (p.participantType !== "assistant") continue;
      if (p.participantId === msg.sender.id) continue;

      const bridge = await this.ensureBridge(msg.projectId, p.participantId);
      if (!bridge?.isReady()) continue;

      bridge.sendUserMessage(formatted, msg.threadId, msg.sender.id);
    }
  }

  /** Look up an existing bridge for an agent. */
  private resolveBridge(projectId: string, agentId: string): ClaudeBridge | undefined {
    return this.claudeBridges.get(this.bridgeKey(projectId, agentId));
  }

  /** Get or on-demand spawn a bridge for an agent. Returns undefined for archived/stopped agents. */
  private async ensureBridge(projectId: string, agentId: string): Promise<ClaudeBridge | undefined> {
    const existing = this.resolveBridge(projectId, agentId);
    if (existing) return existing;

    // Don't respawn bridges stopped by escalation — requires manual restart
    const key = this.bridgeKey(projectId, agentId);
    if (this.escalationStoppedBridges.has(key)) return undefined;

    const agentStore = this.agentStores.get(projectId);
    if (agentId !== "captain") {
      const agent = agentStore?.get(agentId);
      if (!agent || agent.status === "archived" || agent.status === "stopped") return undefined;
    }

    const project = this.projects.get(projectId);
    if (!project) return undefined;

    console.log(`[gateway] On-demand bridge spawn for ${projectId}/${agentId}`);
    const bridge = await this.startAgentBridge(projectId, project, agentId);

    // Wait for ready (up to 30s)
    if (!bridge.isReady()) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 30_000);
        bridge.once("ready", () => { clearTimeout(timeout); resolve(); });
      });
    }
    return bridge;
  }

  /* ---------------------------------------------------------------- */
  /*  Authentication                                                   */
  /* ---------------------------------------------------------------- */

  /** Returns true if auth is required (CC_PASSWORD is set). */
  private get authEnabled(): boolean {
    return !!this.authPassword;
  }

  /** Extract token from Authorization header or cc-token cookie. */
  private extractToken(req: http.IncomingMessage): string | null {
    // Check Authorization: Bearer <token>
    const authHeader = req.headers["authorization"];
    if (authHeader?.startsWith("Bearer ")) {
      return authHeader.slice(7);
    }
    // Fallback: check cc-token cookie
    const cookies = req.headers["cookie"];
    if (cookies) {
      const match = cookies.match(/(?:^|;\s*)cc-token=([^\s;]+)/);
      if (match) return match[1];
    }
    return null;
  }

  /** Check if a request originates from a local/private network address. */
  private isLocalRequest(req: http.IncomingMessage): boolean {
    // If behind a reverse proxy (Cloudflare tunnel), check X-Forwarded-For
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) {
      // If X-Forwarded-For is present, the original client is NOT local
      // (local clients connect directly without the proxy)
      return false;
    }
    const ip = req.socket.remoteAddress ?? "";
    return (
      ip === "127.0.0.1" ||
      ip === "::1" ||
      ip === "::ffff:127.0.0.1" ||
      ip.startsWith("192.168.") ||
      ip.startsWith("::ffff:192.168.") ||
      ip.startsWith("10.") ||
      ip.startsWith("::ffff:10.")
    );
  }

  /** Check if request is authenticated. Returns true if auth is disabled, local, or token is valid. */
  private isAuthenticated(req: http.IncomingMessage): boolean {
    if (!this.authEnabled) return true;
    if (this.isLocalRequest(req)) return true;
    const token = this.extractToken(req);
    return !!token && this.authTokens.has(token);
  }

  /** Handle POST /api/login */
  private async handleLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.authEnabled) {
      this.sendJson(res, 200, { token: "none", message: "Auth not enabled" });
      return;
    }
    const body = await this.readBody(req);
    const { password } = body;
    if (!password || password !== this.authPassword) {
      this.sendJson(res, 401, { error: "Invalid password" });
      return;
    }
    const token = randomBytes(32).toString("hex");
    this.authTokens.add(token);
    // Set cookie with httpOnly for browser sessions
    res.setHeader("Set-Cookie", `cc-token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`);
    this.sendJson(res, 200, { token });
  }

  /** Handle GET /api/auth/check */
  private handleAuthCheck(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.authEnabled) {
      this.sendJson(res, 200, { authenticated: true, authEnabled: false });
      return;
    }
    const local = this.isLocalRequest(req);
    const authenticated = local || this.isAuthenticated(req);
    this.sendJson(res, authenticated ? 200 : 401, { authenticated, authEnabled: true, local });
  }

  /** Handle POST /api/logout */
  private async handleLogout(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const token = this.extractToken(req);
    if (token) this.authTokens.delete(token);
    res.setHeader("Set-Cookie", `cc-token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    this.sendJson(res, 200, { ok: true });
  }

  /* ---------------------------------------------------------------- */
  /*  Request router                                                   */
  /* ---------------------------------------------------------------- */

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const parsed = new URL(rawUrl, `http://localhost:${this.port}`);
    const pathname = parsed.pathname;

    this.requestCount++;

    try {
      // --- Auth endpoints (always accessible) ---
      if (method === "POST" && pathname === "/api/login") {
        await this.handleLogin(req, res);
        return;
      }
      if (method === "POST" && pathname === "/api/logout") {
        await this.handleLogout(req, res);
        return;
      }
      if (method === "GET" && pathname === "/api/auth/check") {
        this.handleAuthCheck(req, res);
        return;
      }

      // --- Auth gate: all other /api/* routes require authentication ---
      if (pathname.startsWith("/api/") && !this.isAuthenticated(req)) {
        this.sendJson(res, 401, { error: "Authentication required" });
        return;
      }

      // --- Registry endpoints ---
      if (method === "GET" && pathname === "/api/registry") {
        this.handleRegistryList(res);
        return;
      }
      if (method === "GET" && pathname === "/api/projects") {
        this.handleRegistryList(res);
        return;
      }
      if (method === "POST" && pathname === "/api/projects") {
        await this.handleCreateProject(req, res);
        return;
      }
      const projectDeleteMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (method === "DELETE" && projectDeleteMatch) {
        this.handleDeleteProject(projectDeleteMatch[1], res);
        return;
      }

      const healthMatch = pathname.match(/^\/api\/registry\/([^/]+)\/health$/);
      if (method === "GET" && healthMatch) {
        this.handleHealthCheck(healthMatch[1], res);
        return;
      }

      // --- SSE events (native) ---
      if (method === "GET" && pathname === "/api/events") {
        const projectId = this.resolveProjectId(req, parsed) || "_global";
        this.sseHub.addClient(res, projectId);
        return;
      }

      // --- Thread endpoints (native) ---
      if (pathname.startsWith("/api/threads")) {
        const projectId = this.resolveProjectId(req, parsed);
        if (!projectId) { this.sendJson(res, 400, { error: "Missing project context." }); return; }
        const store = this.threadStores.get(projectId);
        if (!store) { this.sendJson(res, 404, { error: `No thread store for project: ${projectId}` }); return; }
        await this.handleThreadRequest(method, pathname, req, res, store, projectId);
        return;
      }

      // --- Message endpoint (native) ---
      if (method === "POST" && pathname === "/api/message") {
        await this.handleSendMessage(req, res, parsed);
        return;
      }

      // --- Status endpoint (native) ---
      if (method === "GET" && pathname === "/api/status") {
        const projectId = this.resolveProjectId(req, parsed);
        const bridge = projectId ? this.claudeBridges.get(this.bridgeKey(projectId, "captain")) : undefined;
        this.sendJson(res, 200, { ready: bridge?.isReady() ?? false });
        return;
      }

      // --- Restart endpoint ---
      if (method === "POST" && pathname === "/api/restart") {
        console.log("[gateway] Restart requested via API");
        this.sendJson(res, 200, { ok: true, message: "Restarting gateway..." });
        setTimeout(() => {
          this.stop();
          process.exit(0);
        }, 500);
        return;
      }

      // --- Health endpoints ---
      if (method === "GET" && pathname === "/api/health") {
        this.handleHealthDeep(res);
        return;
      }
      if (method === "GET" && pathname === "/api/health/bridges") {
        const projectId = this.resolveProjectId(req, parsed);
        if (!projectId) { this.sendJson(res, 400, { error: "Missing project context." }); return; }
        this.handleHealthBridges(projectId, res);
        return;
      }

      // --- Recovery action endpoints ---
      if (method === "POST" && pathname === "/api/health/cleanup") {
        const wsPorts: number[] = [];
        for (const [id, project] of this.projects) {
          if (project.status === "inactive") continue;
          wsPorts.push(project.port + 10000);
          const agentStore = this.agentStores.get(id);
          if (agentStore) {
            let workerPort = project.port + 10100;
            for (const agent of agentStore.list()) {
              if (agent.id === "captain") continue;
              wsPorts.push(workerPort++);
            }
          }
        }
        const killed = killStaleClaude(wsPorts);
        this.sseHub.publish("_global", "cleanup_completed", { killed });
        this.sendJson(res, 200, { ok: true, killed });
        return;
      }

      const bridgeActionMatch = pathname.match(/^\/api\/health\/bridges\/([^/]+)\/(restart|stop|start)$/);
      if (method === "POST" && bridgeActionMatch) {
        const agentId = bridgeActionMatch[1];
        const action = bridgeActionMatch[2];
        const projectId = this.resolveProjectId(req, parsed);
        if (!projectId) { this.sendJson(res, 400, { error: "Missing project context." }); return; }
        const project = this.projects.get(projectId);
        if (!project) { this.sendJson(res, 404, { error: `Unknown project: ${projectId}` }); return; }
        await this.handleBridgeAction(projectId, project, agentId, action, res);
        return;
      }

      // --- Assistants endpoint (alias for agents) ---
      if (method === "GET" && pathname === "/api/assistants") {
        const projectId = this.resolveProjectId(req, parsed);
        if (!projectId) { this.sendJson(res, 400, { error: "Missing project context." }); return; }
        const store = this.agentStores.get(projectId);
        if (!store) { this.sendJson(res, 200, { assistants: [] }); return; }
        this.sendJson(res, 200, { assistants: store.list() });
        return;
      }

      // --- GitHub data endpoints ---
      if (method === "GET" && (pathname === "/api/board" || pathname === "/api/actions" || pathname === "/api/pulls")) {
        const projectId = this.resolveProjectId(req, parsed);
        if (!projectId) { this.sendJson(res, 400, { error: "Missing project context." }); return; }
        const ghPlugin = this.githubPlugins.get(projectId);
        if (!ghPlugin) { this.sendJson(res, 404, { error: `No GitHub plugin for project: ${projectId}` }); return; }
        if (pathname === "/api/board") {
          this.sendJson(res, 200, ghPlugin.getBoard());
        } else if (pathname === "/api/actions") {
          this.sendJson(res, 200, { runs: ghPlugin.getActions(), lastUpdated: new Date().toISOString() });
        } else {
          this.sendJson(res, 200, { pulls: ghPlugin.getPulls(), lastUpdated: new Date().toISOString() });
        }
        return;
      }

      // --- KB endpoints ---
      if (pathname.startsWith("/api/kb")) {
        const projectId = this.resolveProjectId(req, parsed);
        if (!projectId) { this.sendJson(res, 400, { error: "Missing project context." }); return; }
        const agentId = this.resolveAgentId(req, parsed) ?? "captain";
        const kb = this.resolveKb(projectId, agentId);
        if (!kb) { this.sendJson(res, 404, { error: `No KB for ${projectId}/${agentId}` }); return; }
        await this.handleKbRequest(method, pathname, req, res, kb);
        return;
      }

      // --- Image upload endpoint ---
      if (method === "POST" && pathname === "/api/message/image") {
        const projectId = this.resolveProjectId(req, parsed);
        if (!projectId) { this.sendJson(res, 400, { error: "Missing project context." }); return; }
        await this.handleImageUpload(req, res, parsed, projectId);
        return;
      }

      // --- Media serving endpoint ---
      if (method === "GET" && pathname === "/api/harness/media") {
        const filePath = parsed.searchParams.get("path");
        if (!filePath) { this.sendJson(res, 400, { error: "path query parameter is required" }); return; }
        this.handleMediaServe(res, filePath);
        return;
      }

      // --- Voice transcription proxy ---
      if (method === "POST" && pathname === "/api/harness/voice/transcribe") {
        await this.handleVoiceTranscribe(req, res);
        return;
      }

      // --- Harness exec endpoint ---
      if (method === "POST" && pathname === "/api/harness/exec") {
        const projectId = this.resolveProjectId(req, parsed);
        if (!projectId) { this.sendJson(res, 400, { error: "Missing project context." }); return; }
        const project = this.projects.get(projectId);
        if (!project) { this.sendJson(res, 404, { error: `Unknown project: ${projectId}` }); return; }
        await this.handleHarnessExec(req, res, project);
        return;
      }

      // --- Agent endpoints ---
      if (pathname.startsWith("/api/agents")) {
        const projectId = this.resolveProjectId(req, parsed);
        if (!projectId) { this.sendJson(res, 400, { error: "Missing project context." }); return; }
        const store = this.agentStores.get(projectId);
        if (!store) { this.sendJson(res, 404, { error: `No agent store for project: ${projectId}` }); return; }
        await this.handleAgentRequest(method, pathname, req, res, store, projectId);
        return;
      }

      // --- Ops endpoint ---
      if (method === "GET" && pathname === "/api/ops") {
        const projectId = this.resolveProjectId(req, parsed);
        if (!projectId) { this.sendJson(res, 400, { error: "Missing project context." }); return; }
        const ghPlugin = this.githubPlugins.get(projectId);
        const runs = ghPlugin?.getActions() ?? [];
        const pulls = ghPlugin?.getPulls() ?? [];
        this.sendJson(res, 200, {
          builds: runs,
          pulls: pulls.filter((p: any) => p.state === "OPEN"),
          lastUpdated: new Date().toISOString(),
        });
        return;
      }

      // --- Task endpoints ---
      if (pathname.startsWith("/api/tasks")) {
        const projectId = this.resolveProjectId(req, parsed);
        if (!projectId) { this.sendJson(res, 400, { error: "Missing project context." }); return; }
        const store = this.taskStores.get(projectId);
        if (!store) { this.sendJson(res, 404, { error: `No task store for project: ${projectId}` }); return; }
        await this.handleTaskRequest(method, pathname, req, res, store, projectId);
        return;
      }

      // --- Dashboard endpoints ---
      if (pathname === "/api/dashboard") {
        const projectId = this.resolveProjectId(req, parsed);
        if (!projectId) { this.sendJson(res, 400, { error: "Missing project context." }); return; }
        if (method === "GET") {
          this.handleDashboardGet(res, projectId);
          return;
        }
        if (method === "POST") {
          await this.handleDashboardPost(req, res, projectId);
          return;
        }
        this.sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      // --- Catch-all for unknown API routes ---
      if (pathname.startsWith("/api/")) {
        this.sendJson(res, 404, { error: `Unknown endpoint: ${method} ${pathname}` });
        return;
      }

      // --- Static file serving ---
      this.serveStatic(pathname, res);
    } catch (err) {
      this.trackError();
      console.error("[gateway] Request error:", err);
      if (!res.headersSent) {
        this.sendJson(res, 500, { error: "Internal server error" });
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Registry                                                         */
  /* ---------------------------------------------------------------- */

  private handleRegistryList(res: http.ServerResponse): void {
    const projects = Array.from(this.projects.values()).map((p) => ({
      id: p.id, name: p.name, port: p.port, repo: p.repo, status: p.status,
    }));
    this.sendJson(res, 200, { projects });
  }

  private async handleCreateProject(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const projectName = typeof body.name === "string" ? body.name : (typeof body.projectName === "string" ? body.projectName : "");
    let directory = typeof body.directory === "string" ? body.directory : "";
    const captainName = typeof body.captainName === "string" && body.captainName ? body.captainName : "Captain";

    // Require at least a name or directory
    if (!projectName && !directory) {
      this.sendJson(res, 400, { error: "name is required (e.g. 'my-project')" });
      return;
    }

    // Default directory to ~/code/<name> if not provided
    if (!directory) {
      const home = process.env.HOME || "/home/" + (process.env.USER || "user");
      directory = path.join(home, "code", projectName);
    }

    const dirName = projectName || path.basename(directory.replace(/\/+$/, ""));
    const id = dirName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

    if (!id) {
      this.sendJson(res, 400, { error: "name must contain at least one alphanumeric character" });
      return;
    }

    if (this.projects.has(id)) {
      this.sendJson(res, 409, { error: `Project '${id}' already exists` });
      return;
    }

    // Ensure project directory exists (after duplicate check)
    fs.mkdirSync(directory, { recursive: true });

    // Auto-assign next available port starting from 3200
    const usedPorts = new Set(Array.from(this.projects.values()).map((p) => p.port));
    let port = 3200;
    while (usedPorts.has(port)) port++;

    const name = dirName.charAt(0).toUpperCase() + dirName.slice(1);
    const config: ProjectConfig = { id, name, port, repo: "", status: "active", directory };

    // Write YAML config file
    fs.mkdirSync(this.configDir, { recursive: true });
    const yamlContent = [
      `name: "${name}"`,
      `port: ${port}`,
      `repo: ""`,
      `status: "active"`,
      `directory: "${directory}"`,
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(this.configDir, `${id}.yaml`), yamlContent, "utf-8");

    // Initialize stores
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.taskStores.set(id, new TaskStore(path.join(this.dataDir, `${id}-tasks.db`)));
    this.agentStores.set(id, new AgentStore(path.join(this.dataDir, `${id}-agents.db`)));
    this.threadStores.set(id, new ThreadStore(path.join(this.dataDir, `${id}-threads.db`)));
    const kbDir = path.join(this.dataDir, "agents", id, "captain", "kb");
    const kb = new KbManager(kbDir);
    kb.ensureDir();
    this.kbManagers.set(this.bridgeKey(id, "captain"), kb);
    const agentStore = this.agentStores.get(id)!;
    agentStore.create({ name: captainName, role: "Project lead — coordinates work, manages the team, triages issues", createdBy: "system", isCaptain: true });
    this.backfillTeamParticipants(id);

    this.projects.set(id, config);
    console.log(`[gateway] Created project '${id}' (port ${port}, captain: ${captainName})`);

    // Start Claude bridge for the new project
    await this.startAgentBridge(id, config, "captain");

    this.sseHub.publishGlobal("project_created", { projectId: config.id, project: config });

    this.sendJson(res, 201, { project: config });
  }

  private handleDeleteProject(projectId: string, res: http.ServerResponse): void {
    const config = this.projects.get(projectId);
    if (!config) {
      this.sendJson(res, 404, { error: `Project '${projectId}' not found` });
      return;
    }

    // Stop all bridges for this project
    for (const [key, bridge] of this.claudeBridges) {
      if (key.startsWith(projectId + ":")) {
        bridge.stop();
        this.claudeBridges.delete(key);
      }
    }

    // Remove stores and delete persisted databases
    this.taskStores.delete(projectId);
    this.agentStores.delete(projectId);
    this.threadStores.delete(projectId);
    for (const suffix of ["tasks", "agents", "threads"]) {
      const dbPath = path.join(this.dataDir, `${projectId}-${suffix}.db`);
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
    for (const [key] of this.kbManagers) {
      if (key.startsWith(projectId + ":")) this.kbManagers.delete(key);
    }
    const plugin = this.githubPlugins.get(projectId);
    if (plugin) plugin.shutdown();
    this.githubPlugins.delete(projectId);

    // Remove YAML config file
    const yamlPath = path.join(this.configDir, `${projectId}.yaml`);
    if (fs.existsSync(yamlPath)) fs.unlinkSync(yamlPath);

    this.projects.delete(projectId);
    console.log(`[gateway] Deleted project '${projectId}'`);

    this.sseHub.publishGlobal("project_deleted", { projectId });

    this.sendJson(res, 200, { deleted: projectId });
  }

  /** Post a health-related system message to the project's main thread. */
  private postHealthAlert(projectId: string, content: string): void {
    this.dispatchMessage({
      projectId,
      threadId: "main",
      sender: { id: "system", type: "system" },
      channel: "thread",
      mode: "text",
      content,
      kind: "system",
      source: "gateway",
    });
  }

  private handleHealthCheck(projectId: string, res: http.ServerResponse): void {
    const project = this.projects.get(projectId);
    if (!project) {
      this.sendJson(res, 404, { error: `Unknown project: ${projectId}` });
      return;
    }
    const bridge = this.claudeBridges.get(this.bridgeKey(projectId, "captain"));
    this.sendJson(res, 200, {
      id: project.id,
      name: project.name,
      healthy: bridge?.isReady() ?? false,
      port: project.port,
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Deep health endpoints                                            */
  /* ---------------------------------------------------------------- */

  private handleHealthDeep(res: http.ServerResponse): void {
    const now = Date.now();
    const mem = process.memoryUsage();

    // Build per-project health
    const projectsHealth: Record<string, unknown> = {};
    let anyDegraded = false;
    let allDown = true;

    for (const [id, project] of this.projects) {
      // Collect bridge info for this project
      const bridges: Record<string, unknown> = {};
      for (const [key, bridge] of this.claudeBridges) {
        if (key.startsWith(`${id}:`)) {
          const info = bridge.getHealthInfo();
          bridges[info.agent_id] = info;
          if (info.ready) allDown = false;
          else anyDegraded = true;
        }
      }

      // Check store health
      const stores: Record<string, unknown> = {};
      const taskStore = this.taskStores.get(id);
      const agentStore = this.agentStores.get(id);
      const threadStore = this.threadStores.get(id);

      stores.tasks = this.checkStoreHealth("tasks", id, taskStore);
      stores.agents = this.checkStoreHealth("agents", id, agentStore);
      stores.threads = this.checkStoreHealth("threads", id, threadStore);

      // If any store is not ok, mark degraded
      for (const s of Object.values(stores) as Array<{ ok: boolean }>) {
        if (!s.ok) anyDegraded = true;
      }

      projectsHealth[id] = {
        status: project.status,
        bridges,
        stores,
      };

      // Only active projects with bridges count toward the allDown check
      if (project.status !== "active" || Object.keys(bridges).length === 0) continue;
    }

    let status: string;
    if (allDown && this.claudeBridges.size > 0) status = "unhealthy";
    else if (anyDegraded) status = "degraded";
    else status = "healthy";

    this.sendJson(res, 200, {
      status,
      uptime_seconds: Math.floor((now - this.gatewayStartedAt) / 1000),
      started_at: new Date(this.gatewayStartedAt).toISOString(),
      memory: {
        rss_mb: Math.round(mem.rss / 1_048_576),
        heap_used_mb: Math.round(mem.heapUsed / 1_048_576),
        heap_total_mb: Math.round(mem.heapTotal / 1_048_576),
      },
      projects: projectsHealth,
      sse: {
        connected_clients: this.sseHub.clientCount(),
        buffer_size: this.sseHub.bufferSize(),
      },
      request_count: this.requestCount,
      errors_last_hour: this.errorsLastHour(),
    });
  }

  private handleHealthBridges(projectId: string, res: http.ServerResponse): void {
    const bridges: unknown[] = [];
    for (const [key, bridge] of this.claudeBridges) {
      if (key.startsWith(`${projectId}:`)) {
        bridges.push(bridge.getHealthInfo());
      }
    }
    this.sendJson(res, 200, { bridges });
  }

  private checkStoreHealth(name: string, projectId: string, store: { checkHealth?: () => boolean } | undefined): { ok: boolean; path: string } {
    const dbPath = `data/${projectId}-${name}.db`;
    if (!store) return { ok: false, path: dbPath };
    try {
      if (typeof store.checkHealth === "function") {
        return { ok: store.checkHealth(), path: dbPath };
      }
      return { ok: true, path: dbPath };
    } catch {
      return { ok: false, path: dbPath };
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Recovery action endpoints                                        */
  /* ---------------------------------------------------------------- */

  private async handleBridgeAction(
    projectId: string, project: ProjectConfig, agentId: string, action: string, res: http.ServerResponse,
  ): Promise<void> {
    const key = this.bridgeKey(projectId, agentId);

    // For start/restart, verify the agent is eligible (not archived/stopped)
    if (action === "start" || action === "restart") {
      if (agentId !== "captain") {
        const agentStore = this.agentStores.get(projectId);
        const agent = agentStore?.get(agentId);
        if (!agent) { this.sendJson(res, 404, { error: `Agent ${agentId} not found` }); return; }
        if (agent.status === "archived" || agent.status === "stopped") {
          this.sendJson(res, 409, { error: `Agent ${agentId} is ${agent.status} — update agent status first` });
          return;
        }
      }
    }

    if (action === "stop") {
      const bridge = this.claudeBridges.get(key);
      if (!bridge) { this.sendJson(res, 404, { error: `No bridge found for ${agentId}` }); return; }
      bridge.stop();
      this.claudeBridges.delete(key);
      this.sseHub.publish(projectId, "bridge_status_changed", { agentId, status: "stopped", previousStatus: "ready" });
      this.sendJson(res, 200, { ok: true, agent_id: agentId, action: "stopped" });
      return;
    }

    if (action === "start") {
      // For escalation-stopped bridges, the old bridge is still in the map — remove it first
      const stale = this.claudeBridges.get(key);
      if (stale && !this.escalationStoppedBridges.has(key)) {
        this.sendJson(res, 409, { error: `Bridge for ${agentId} is already running` });
        return;
      }
      if (stale) { this.claudeBridges.delete(key); }
      try {
        await this.startAgentBridge(projectId, project, agentId);
        this.escalationStoppedBridges.delete(key);
        this.sseHub.publish(projectId, "bridge_status_changed", { agentId, status: "connecting", previousStatus: "stopped" });
        this.sendJson(res, 200, { ok: true, agent_id: agentId, action: "starting" });
      } catch (err) {
        this.sendJson(res, 500, { error: `Failed to start bridge: ${(err as Error).message}` });
      }
      return;
    }

    if (action === "restart") {
      const existing = this.claudeBridges.get(key);
      if (existing) {
        existing.stop();
        this.claudeBridges.delete(key);
      }
      try {
        await this.startAgentBridge(projectId, project, agentId);
        this.escalationStoppedBridges.delete(key);
        this.sseHub.publish(projectId, "bridge_status_changed", { agentId, status: "restarting", previousStatus: existing ? "ready" : "stopped" });
        this.sendJson(res, 200, { ok: true, agent_id: agentId, action: "restarting" });
      } catch (err) {
        this.sendJson(res, 500, { error: `Failed to restart bridge: ${(err as Error).message}` });
      }
      return;
    }

    this.sendJson(res, 400, { error: `Unknown action: ${action}` });
  }

  /* ---------------------------------------------------------------- */
  /*  Thread endpoints (native)                                        */
  /* ---------------------------------------------------------------- */

  private async handleThreadRequest(
    method: string,
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    store: ThreadStore,
    projectId: string,
  ): Promise<void> {
    // GET /api/threads (with unread counts)
    if (method === "GET" && pathname === "/api/threads") {
      const userId = this.resolveUserId(req);
      const threads = store.listThreadsWithParticipants();
      const unreadCounts = store.getUnreadCounts(userId);
      const enriched = threads.map((t) => ({
        ...t,
        unreadCount: unreadCounts.get(t.id) ?? 0,
      }));
      this.sendJson(res, 200, { threads: enriched });
      return;
    }

    // POST /api/threads
    if (method === "POST" && pathname === "/api/threads") {
      const body = await this.readBody(req);
      if (!body.title) { this.sendJson(res, 400, { error: "title is required" }); return; }
      // Normalize participant format: accept {id} shorthand or full {participantType, participantId}
      const rawParticipants = Array.isArray(body.participants) ? body.participants : [];
      const participants = rawParticipants.map((p: any) => ({
        participantType: p.participantType ?? "assistant",
        participantId: p.participantId ?? p.id,
        role: p.role,
      })).filter((p: any) => p.participantId);
      try {
        const thread = store.createThread({ title: body.title, participants });
        this.sseHub.publish(projectId, "thread_created", thread);
        this.sendJson(res, 201, { thread });
      } catch (err: any) {
        if (err.message?.includes("duplicate")) {
          this.sendJson(res, 409, { error: err.message });
        } else {
          throw err;
        }
      }
      return;
    }

    // GET /api/threads/:id/messages
    const messagesMatch = pathname.match(/^\/api\/threads\/([^/]+)\/messages$/);
    if (messagesMatch && method === "GET") {
      const threadId = decodeURIComponent(messagesMatch[1]);
      const url = new URL(req.url ?? "/", "http://localhost");
      const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
      const before = url.searchParams.get("before") ?? undefined;
      this.sendJson(res, 200, { messages: store.getMessages(threadId, { limit, before }) });
      return;
    }

    // GET /api/threads/:id/participants
    const participantsMatch = pathname.match(/^\/api\/threads\/([^/]+)\/participants$/);
    if (participantsMatch && method === "GET") {
      const threadId = decodeURIComponent(participantsMatch[1]);
      this.sendJson(res, 200, { participants: store.getParticipants(threadId) });
      return;
    }

    // POST /api/threads/:id/read — mark thread as read for current user
    const readMatch = pathname.match(/^\/api\/threads\/([^/]+)\/read$/);
    if (readMatch && method === "POST") {
      const threadId = decodeURIComponent(readMatch[1]);
      const userId = this.resolveUserId(req);
      store.markRead(threadId, userId);
      this.sendJson(res, 200, { ok: true, threadId, userId });
      return;
    }

    // GET /api/threads/:id
    const threadMatch = pathname.match(/^\/api\/threads\/([^/]+)$/);
    if (threadMatch && method === "GET") {
      const threadId = decodeURIComponent(threadMatch[1]);
      const thread = store.getThread(threadId);
      if (!thread) { this.sendJson(res, 404, { error: "Thread not found" }); return; }
      this.sendJson(res, 200, thread);
      return;
    }

    // PATCH /api/threads/:id
    if (threadMatch && method === "PATCH") {
      const threadId = decodeURIComponent(threadMatch[1]);
      const body = await this.readBody(req);
      const thread = store.updateThread(threadId, body);
      this.sseHub.publish(projectId, "thread_updated", thread);
      this.sendJson(res, 200, thread);
      return;
    }

    // DELETE /api/threads/:id
    if (threadMatch && method === "DELETE") {
      const threadId = decodeURIComponent(threadMatch[1]);
      store.updateThread(threadId, { status: "archived" });
      this.sseHub.publish(projectId, "thread_deleted", { id: threadId });
      this.sendJson(res, 200, { ok: true });
      return;
    }

    this.sendJson(res, 404, { error: "Thread endpoint not found" });
  }

  /* ---------------------------------------------------------------- */
  /*  Message endpoint (native)                                        */
  /* ---------------------------------------------------------------- */

  private async handleSendMessage(req: http.IncomingMessage, res: http.ServerResponse, parsed: URL): Promise<void> {
    const projectId = this.resolveProjectId(req, parsed);
    if (!projectId) { this.sendJson(res, 400, { error: "Missing project context." }); return; }

    const body = await this.readBody(req);
    const text = String(body.text ?? "").trim();
    if (!text) { this.sendJson(res, 400, { error: "text is required" }); return; }

    const threadId = String(body.thread_id ?? body.threadId ?? "main");
    const senderId = String(body.sender ?? "Ning");
    const source = String(body.source ?? "webui");

    // Determine sender type: known agent IDs are "assistant", otherwise "user"
    const agentStore = this.agentStores.get(projectId);
    const isAgent = senderId === "captain" || (agentStore?.get(senderId) != null);

    this.dispatchMessage({
      projectId,
      threadId,
      sender: { id: senderId, type: isAgent ? "assistant" : "user" },
      channel: "thread",
      mode: "text",
      content: text,
      source,
      metadata: body.requestId ? { requestId: body.requestId } : undefined,
    });

    this.sendJson(res, 200, { ok: true, accepted: true });
  }

  /* ---------------------------------------------------------------- */
  /*  Agent endpoints                                                  */
  /* ---------------------------------------------------------------- */

  private async handleAgentRequest(
    method: string,
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    store: AgentStore,
    projectId: string,
  ): Promise<void> {
    if (method === "GET" && pathname === "/api/agents") {
      const url = new URL(req.url ?? "/", `http://localhost`);
      const status = url.searchParams.get("status") ?? undefined;
      const agents = store.list({ status }).map((agent) => {
        const bKey = this.bridgeKey(projectId, agent.id);
        const bridge = this.claudeBridges.get(bKey);
        let bridgeStatus: "connected" | "disconnected" | "idle" = "idle";
        if (bridge) {
          bridgeStatus = bridge.isReady() ? "connected" : "disconnected";
        }
        return { ...agent, bridgeStatus };
      });
      this.sendJson(res, 200, { agents });
      return;
    }

    if (method === "POST" && pathname === "/api/agents") {
      const body = await this.readBody(req);
      if (!body.name) { this.sendJson(res, 400, { error: "name is required" }); return; }
      const agent = store.create({
        id: body.id, name: body.name, role: body.role,
        createdBy: body.createdBy ?? "captain",
      });
      this.sseHub.publish(projectId, "agent_created", agent);
      // Auto-add agent to team broadcast thread
      const threads = this.threadStores.get(projectId);
      if (threads) {
        threads.addParticipant("team", { participantType: "assistant", participantId: agent.id });
      }
      this.dispatchMessage({
        projectId,
        threadId: "main",
        sender: { id: "system", type: "system" },
        channel: "thread",
        mode: "text",
        content: `Agent **${agent.name}** (${agent.id}) created. Role: ${agent.role || "unspecified"}`,
        kind: "system",
        source: "gateway",
      });
      this.sendJson(res, 201, agent);
      return;
    }

    if (method === "GET" && pathname.startsWith("/api/agents/")) {
      const id = pathname.split("/")[3];
      if (!id) { this.sendJson(res, 400, { error: "agent id required" }); return; }
      const agent = store.get(id);
      if (!agent) { this.sendJson(res, 404, { error: `Agent not found: ${id}` }); return; }
      const bKey = this.bridgeKey(projectId, id);
      const bridge = this.claudeBridges.get(bKey);
      let bridgeStatus: "connected" | "disconnected" | "idle" = "idle";
      if (bridge) {
        bridgeStatus = bridge.isReady() ? "connected" : "disconnected";
      }
      this.sendJson(res, 200, { ...agent, bridgeStatus });
      return;
    }

    if (method === "PATCH" && pathname.startsWith("/api/agents/")) {
      const id = pathname.split("/")[3];
      if (!id) { this.sendJson(res, 400, { error: "agent id required" }); return; }
      const body = await this.readBody(req);
      const agent = store.update(id, body);
      this.sseHub.publish(projectId, "agent_updated", agent);
      this.dispatchMessage({
        projectId,
        threadId: "main",
        sender: { id: "system", type: "system" },
        channel: "thread",
        mode: "text",
        content: `Agent **${agent.name}** (${agent.id}) updated${body.status ? `: status → ${body.status}` : ""}${body.role ? `: role → ${body.role}` : ""}`,
        kind: "system",
        source: "gateway",
      });
      this.sendJson(res, 200, agent);
      return;
    }

    if (method === "DELETE" && pathname.startsWith("/api/agents/")) {
      const id = pathname.split("/")[3];
      if (!id) { this.sendJson(res, 400, { error: "agent id required" }); return; }
      const agent = store.get(id);
      store.archive(id);
      // Stop agent's bridge and clean up worktree
      const bKey = this.bridgeKey(projectId, id);
      const agentBridge = this.claudeBridges.get(bKey);
      if (agentBridge) {
        agentBridge.stop();
        this.claudeBridges.delete(bKey);
      }
      this.sseHub.publish(projectId, "agent_archived", { id });
      this.dispatchMessage({
        projectId,
        threadId: "main",
        sender: { id: "system", type: "system" },
        channel: "thread",
        mode: "text",
        content: `Agent **${agent?.name ?? id}** (${id}) archived`,
        kind: "system",
        source: "gateway",
      });
      this.sendJson(res, 200, { ok: true });
      return;
    }

    this.sendJson(res, 404, { error: "Agent endpoint not found" });
  }

  /* ---------------------------------------------------------------- */
  /*  KB endpoints                                                     */
  /* ---------------------------------------------------------------- */

  private async handleKbRequest(
    method: string,
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    kb: KbManager,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost`);

    // GET /api/kb/list
    if (method === "GET" && pathname === "/api/kb/list") {
      this.sendJson(res, 200, { files: kb.list() });
      return;
    }

    // GET /api/kb/read?file=X[&section=Y]
    if (method === "GET" && pathname === "/api/kb/read") {
      const file = url.searchParams.get("file");
      if (!file) { this.sendJson(res, 400, { error: "file param is required" }); return; }
      try {
        const section = url.searchParams.get("section");
        if (section) {
          const result = kb.readSection(file, section);
          if (!result) { this.sendJson(res, 404, { error: "section_not_found" }); return; }
          this.sendJson(res, 200, { file, section: result.section, content: result.content });
        } else {
          this.sendJson(res, 200, { file, content: kb.read(file) });
        }
      } catch {
        this.sendJson(res, 404, { error: `File not found: ${file}` });
      }
      return;
    }

    // GET /api/kb/sections?file=X
    if (method === "GET" && pathname === "/api/kb/sections") {
      const file = url.searchParams.get("file");
      if (!file) { this.sendJson(res, 400, { error: "file param is required" }); return; }
      try {
        this.sendJson(res, 200, { file, sections: kb.listSections(file) });
      } catch {
        this.sendJson(res, 404, { error: `File not found: ${file}` });
      }
      return;
    }

    // GET /api/kb/search?q=X[&file=Y]
    if (method === "GET" && pathname === "/api/kb/search") {
      const q = url.searchParams.get("q");
      if (!q) { this.sendJson(res, 400, { error: "q param is required" }); return; }
      const file = url.searchParams.get("file") ?? undefined;
      this.sendJson(res, 200, { results: kb.search(q, file) });
      return;
    }

    // POST /api/kb/write
    if (method === "POST" && pathname === "/api/kb/write") {
      const body = await this.readBody(req);
      if (!body.file) { this.sendJson(res, 400, { error: "file is required" }); return; }
      if (body.content === undefined) { this.sendJson(res, 400, { error: "content is required" }); return; }
      kb.write(body.file, body.content);
      this.sendJson(res, 200, { ok: true, file: body.file });
      return;
    }

    // POST /api/kb/append
    if (method === "POST" && pathname === "/api/kb/append") {
      const body = await this.readBody(req);
      if (!body.file) { this.sendJson(res, 400, { error: "file is required" }); return; }
      if (!body.text) { this.sendJson(res, 400, { error: "text is required" }); return; }
      kb.appendNote(body.file, body.text);
      this.sendJson(res, 200, { ok: true, file: body.file });
      return;
    }

    // POST /api/kb/patch
    if (method === "POST" && pathname === "/api/kb/patch") {
      const body = await this.readBody(req);
      if (!body.file) { this.sendJson(res, 400, { error: "file is required" }); return; }
      try {
        const result = kb.patch(body.file, body as any);
        this.sendJson(res, 200, { ok: true, file: body.file, ...result });
      } catch (err: any) {
        if (err.code === "AMBIGUOUS") {
          this.sendJson(res, 409, { ok: false, error: "ambiguous_match", count: err.count, message: err.message });
        } else if (err.code === "NOT_FOUND") {
          this.sendJson(res, 404, { ok: false, error: "not_found", message: err.message });
        } else {
          this.sendJson(res, 400, { ok: false, error: err.message });
        }
      }
      return;
    }

    // POST /api/kb/delete-section
    if (method === "POST" && pathname === "/api/kb/delete-section") {
      const body = await this.readBody(req);
      if (!body.file) { this.sendJson(res, 400, { error: "file is required" }); return; }
      if (!body.section) { this.sendJson(res, 400, { error: "section is required" }); return; }
      try {
        const deleted = kb.deleteSection(body.file, body.section);
        this.sendJson(res, 200, { ok: true, file: body.file, deleted_section: deleted });
      } catch (err: any) {
        this.sendJson(res, 404, { ok: false, error: "not_found", message: err.message });
      }
      return;
    }

    // POST /api/kb/delete
    if (method === "POST" && pathname === "/api/kb/delete") {
      const body = await this.readBody(req);
      if (!body.file) { this.sendJson(res, 400, { error: "file is required" }); return; }
      try {
        kb.deleteFile(body.file);
        this.sendJson(res, 200, { ok: true, file: body.file });
      } catch (err: any) {
        if (err.code === "PROTECTED") {
          this.sendJson(res, 403, { ok: false, error: "protected", message: err.message });
        } else {
          this.sendJson(res, 404, { ok: false, error: err.message });
        }
      }
      return;
    }

    this.sendJson(res, 404, { error: "KB endpoint not found" });
  }

  /* ---------------------------------------------------------------- */
  /*  Task endpoints                                                   */
  /* ---------------------------------------------------------------- */

  private async handleTaskRequest(
    method: string,
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    store: TaskStore,
    projectId: string,
  ): Promise<void> {
    if (method === "GET" && pathname === "/api/tasks") {
      const url = new URL(req.url ?? "/", `http://localhost`);
      const state = url.searchParams.get("state") ?? undefined;
      const assignee = url.searchParams.get("assignee") ?? undefined;
      const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
      this.sendJson(res, 200, { tasks: store.list({ state, assignee, limit }) });
      return;
    }

    // GET /api/tasks/:id
    if (method === "GET" && pathname.startsWith("/api/tasks/") && !pathname.endsWith("/complete")) {
      const id = pathname.split("/")[3];
      if (!id) { this.sendJson(res, 400, { error: "task id required" }); return; }
      const task = store.get(id);
      if (!task) { this.sendJson(res, 404, { error: `Task not found: ${id}` }); return; }
      this.sendJson(res, 200, task);
      return;
    }

    if (method === "POST" && pathname === "/api/tasks") {
      const body = await this.readBody(req);
      if (!body.title) { this.sendJson(res, 400, { error: "title is required" }); return; }
      const collaborators = Array.isArray(body.collaborators) ? body.collaborators.map((s: string) => String(s).trim()).filter(Boolean)
        : typeof body.collaborators === "string" ? body.collaborators.split(",").map((s: string) => s.trim()).filter(Boolean)
        : undefined;
      const task = store.create({
        title: body.title, description: body.description, githubIssue: body.githubIssue,
        priority: body.priority, labels: body.labels, createdBy: body.createdBy ?? "unknown",
        assignee: body.assignee, collaborators,
      });

      // Create git worktree for this task (isolation per task)
      const project = this.projects.get(projectId);
      const projDir = project?.directory || this.dataDir;
      let taskWorktree: string | undefined;
      if (task.assignee && task.assignee !== "captain" && project) {
        const branchName = `task/${task.id}`;
        const worktreeDir = path.join(projDir, ".worktrees", task.id);
        if (!fs.existsSync(worktreeDir)) {
          fs.mkdirSync(path.join(projDir, ".worktrees"), { recursive: true });
          try {
            try { execFileSync("git", ["branch", branchName], { cwd: projDir, stdio: "ignore" }); } catch { /* exists */ }
            execFileSync("git", ["worktree", "add", worktreeDir, branchName], { cwd: projDir, stdio: "ignore" });
            taskWorktree = worktreeDir;
            console.log(`[gateway] Created worktree for task ${task.id} at ${worktreeDir} (branch: ${branchName})`);
          } catch (err) {
            console.warn(`[gateway] Failed to create worktree for task ${task.id}:`, (err as Error).message);
          }
        }
      }

      // Auto-create a thread for this task with participants
      const threadStore = this.threadStores.get(projectId);
      if (threadStore) {
        const participants: Array<{ participantType: "user" | "assistant"; participantId: string; role?: string }> = [
          { participantType: "assistant", participantId: "captain", role: "lead" },
        ];
        if (task.assignee && task.assignee !== "captain") {
          participants.push({ participantType: "assistant", participantId: task.assignee, role: "assignee" });
        }
        for (const collab of task.collaborators) {
          if (collab !== "captain" && collab !== task.assignee) {
            participants.push({ participantType: "assistant", participantId: collab, role: "collaborator" });
          }
        }
        const thread = threadStore.createThread({
          title: `${task.id}: ${task.title}`,
          participants,
        });
        store.update(task.id, { threadId: thread.id } as any, task.createdBy);
        task.threadId = thread.id;

        const worktreeInfo = taskWorktree
          ? `\nWorking directory: \`${taskWorktree}\` (branch: \`task/${task.id}\`)`
          : "";
        this.dispatchMessage({
          projectId,
          threadId: thread.id,
          sender: { id: "system", type: "system" },
          channel: "thread",
          mode: "text",
          content: `Task **${task.id}** created: ${task.title}${task.assignee ? ` (assigned to ${task.assignee})` : ""}${task.priority ? ` (priority: ${task.priority})` : ""}${worktreeInfo}`,
          kind: "system",
          source: "gateway",
        });
      }

      this.sseHub.publish(projectId, "task_created", task);
      this.sendJson(res, 201, task);
      return;
    }

    if (method === "PATCH" && pathname.startsWith("/api/tasks/")) {
      const id = pathname.split("/")[3];
      if (!id) { this.sendJson(res, 400, { error: "task id required" }); return; }
      const body = await this.readBody(req);
      // Normalize collaborators before storing
      if (body.collaborators) {
        body.collaborators = Array.isArray(body.collaborators)
          ? body.collaborators.map((s: string) => String(s).trim()).filter(Boolean)
          : typeof body.collaborators === "string"
            ? body.collaborators.split(",").map((s: string) => s.trim()).filter(Boolean)
            : [];
      }
      const task = store.update(id, body, body.actor ?? "unknown");

      // Post status update to task thread + add assignee/collaborators as participants
      if (task.threadId) {
        const threadStore = this.threadStores.get(projectId);
        if (threadStore) {
          if (body.assignee) {
            threadStore.addParticipant(task.threadId, { participantType: "assistant", participantId: body.assignee, role: "assignee" });
          }
          if (body.collaborators) {
            for (const collab of body.collaborators) {
              threadStore.addParticipant(task.threadId, { participantType: "assistant", participantId: collab, role: "collaborator" });
            }
          }
          if (body.state || body.latestUpdate) {
            const parts: string[] = [];
            if (body.state) parts.push(`State → **${body.state}**`);
            if (body.latestUpdate) parts.push(body.latestUpdate);
            this.dispatchMessage({
              projectId,
              threadId: task.threadId,
              sender: { id: body.actor ?? "system", type: body.actor && body.actor !== "System" ? "assistant" : "system" },
              channel: "thread",
              mode: "text",
              content: parts.join(" — "),
              kind: "system",
              source: "task-update",
            });
          }
        }
      }

      this.sseHub.publish(projectId, "task_updated", task);
      this.sendJson(res, 200, task);
      return;
    }

    if (method === "POST" && pathname.endsWith("/complete")) {
      const parts = pathname.split("/");
      const id = parts[3];
      if (!id) { this.sendJson(res, 400, { error: "task id required" }); return; }
      const body = await this.readBody(req);
      const task = store.complete(id, body.actor ?? "unknown", body.notes);

      // Post completion to task thread
      if (task.threadId) {
        this.dispatchMessage({
          projectId,
          threadId: task.threadId,
          sender: { id: body.actor ?? "system", type: body.actor && body.actor !== "System" ? "assistant" : "system" },
          channel: "thread",
          mode: "text",
          content: `Task **${task.id}** completed${body.notes ? `: ${body.notes}` : ""}`,
          kind: "system",
          source: "task-update",
        });
      }

      // Clean up task worktree (agent already merged to main)
      const completedProject = this.projects.get(projectId);
      if (completedProject) {
        const taskWorktreeDir = path.join(completedProject.directory || this.dataDir, ".worktrees", task.id);
        if (fs.existsSync(taskWorktreeDir)) {
          try {
            execFileSync("git", ["worktree", "remove", taskWorktreeDir, "--force"], {
              cwd: completedProject.directory || this.dataDir, stdio: "ignore",
            });
            console.log(`[gateway] Cleaned up worktree for completed task ${task.id}`);
          } catch { /* ignore cleanup failures */ }
        }
      }

      this.sseHub.publish(projectId, "task_completed", task);
      this.sendJson(res, 200, task);
      return;
    }

    // POST /api/tasks/:id/subscribe — add the requesting agent as a thread participant
    if (method === "POST" && pathname.match(/^\/api\/tasks\/[^/]+\/subscribe$/)) {
      const id = pathname.split("/")[3];
      if (!id) { this.sendJson(res, 400, { error: "task id required" }); return; }
      const task = store.get(id);
      if (!task) { this.sendJson(res, 404, { error: `Task not found: ${id}` }); return; }
      if (!task.threadId) { this.sendJson(res, 400, { error: `Task ${id} has no thread` }); return; }
      const agentId = this.resolveAgentId(req, new URL(req.url ?? "/", "http://localhost")) ?? "captain";
      const threadStore = this.threadStores.get(projectId);
      if (threadStore) {
        threadStore.addParticipant(task.threadId, { participantType: "assistant", participantId: agentId, role: "subscriber" });
      }
      this.sendJson(res, 200, { ok: true, taskId: id, threadId: task.threadId, subscriber: agentId });
      return;
    }

    if (method === "POST" && pathname === "/api/tasks/sync-from-github") {
      const ghPlugin = this.githubPlugins.get(projectId);
      if (!ghPlugin) { this.sendJson(res, 404, { error: "No GitHub plugin available for this project" }); return; }
      const synced = this.syncGithubIssuesToTasks(ghPlugin, store);
      this.sendJson(res, 200, { synced });
      return;
    }

    this.sendJson(res, 404, { error: "Task endpoint not found" });
  }

  /* ---------------------------------------------------------------- */
  /*  GitHub sync                                                      */
  /* ---------------------------------------------------------------- */

  private syncGithubIssuesToTasks(ghPlugin: GitHubPlugin, store: TaskStore): number {
    const issues = ghPlugin.getIssues();
    let synced = 0;

    for (const issue of issues) {
      if (issue.state !== "OPEN") continue;
      if (store.findByGithubIssue(issue.number)) continue;

      let priority: "critical" | "high" | "normal" | "low" = "normal";
      const labelNames = issue.labels.map((l) => l.toLowerCase());
      if (labelNames.includes("critical") || labelNames.includes("p0")) priority = "critical";
      else if (labelNames.includes("high") || labelNames.includes("p1") || labelNames.includes("priority: high")) priority = "high";
      else if (labelNames.includes("low") || labelNames.includes("p3") || labelNames.includes("priority: low")) priority = "low";

      store.create({
        title: issue.title,
        description: `GitHub issue #${issue.number}`,
        githubIssue: issue.number,
        priority,
        labels: issue.labels,
        createdBy: "github-sync",
        assignee: issue.assignees.length > 0 ? issue.assignees[0] : undefined,
      });
      synced++;
    }

    return synced;
  }

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */

  private resolveProjectId(req: http.IncomingMessage, parsed: URL): string | null {
    const header = req.headers["x-project-id"];
    if (typeof header === "string" && header.length > 0) return header;
    const param = parsed.searchParams.get("projectId");
    if (param) return param;
    if (this.projects.size === 1) {
      return this.projects.keys().next().value ?? null;
    }
    return null;
  }

  private resolveUserId(req: http.IncomingMessage): string {
    const header = req.headers["x-user-id"];
    return typeof header === "string" && header.length > 0 ? header : "user";
  }

  private resolveAgentId(req: http.IncomingMessage, parsed: URL): string | null {
    const header = req.headers["x-agent-id"];
    if (typeof header === "string" && header.length > 0) return header;
    return parsed.searchParams.get("agent") ?? null;
  }

  private resolveKb(projectId: string, agentId: string): KbManager | null {
    const key = this.bridgeKey(projectId, agentId);
    const existing = this.kbManagers.get(key);
    if (existing) return existing;

    let kbDir: string;
    if (agentId === "captain") {
      kbDir = path.join(this.dataDir, "agents", projectId, "captain", "kb");
    } else {
      const agentStore = this.agentStores.get(projectId);
      if (!agentStore) return null;
      kbDir = agentStore.getKBDir(agentId);
    }
    if (!fs.existsSync(kbDir)) return null;
    const kb = new KbManager(kbDir);
    this.kbManagers.set(key, kb);
    return kb;
  }

  /* ---------------------------------------------------------------- */
  /*  Static files                                                     */
  /* ---------------------------------------------------------------- */

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    let filePath = pathname === "/" ? "/index.html" : pathname;
    const fullPath = path.join(this.uiDir, filePath);

    if (!fullPath.startsWith(this.uiDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) {
        const htmlPath = fullPath + ".html";
        if (fs.existsSync(htmlPath)) {
          this.streamFile(htmlPath, res);
          return;
        }
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      this.streamFile(fullPath, res);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  }

  private streamFile(filePath: string, res: http.ServerResponse): void {
    const ext = path.extname(filePath);
    const contentType = MIME[ext] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    fs.createReadStream(filePath).pipe(res);
  }

  /* ---------------------------------------------------------------- */
  /*  Harness exec                                                     */
  /* ---------------------------------------------------------------- */

  private async handleHarnessExec(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    project: ProjectConfig,
  ): Promise<void> {
    const body = await this.readBody(req);
    const { command, cwd, timeout } = body;

    if (!command || typeof command !== "string") {
      this.sendJson(res, 400, { error: "command is required (string)" });
      return;
    }

    // Resolve working directory: explicit cwd > project directory > gateway data dir
    const projectDir = project.directory || this.dataDir;
    let execCwd = typeof cwd === "string" && cwd.length > 0 ? cwd : projectDir;

    // Resolve to absolute path
    execCwd = path.resolve(execCwd);

    // Verify the directory exists
    try {
      const stat = fs.statSync(execCwd);
      if (!stat.isDirectory()) {
        this.sendJson(res, 400, { error: `cwd is not a directory: ${execCwd}` });
        return;
      }
    } catch {
      this.sendJson(res, 400, { error: `cwd does not exist: ${execCwd}` });
      return;
    }

    // Timeout: default 120s, max 600s
    const execTimeout = Math.min(
      typeof timeout === "number" && timeout > 0 ? timeout * 1000 : 120_000,
      600_000,
    );

    console.log(`[harness] exec for ${project.id}: ${command.slice(0, 200)}${command.length > 200 ? "..." : ""} (cwd: ${execCwd})`);

    try {
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        exec(command, {
          cwd: execCwd,
          timeout: execTimeout,
          maxBuffer: 10 * 1024 * 1024, // 10MB
          env: { ...process.env, FORCE_COLOR: "0" },
        }, (error, stdout, stderr) => {
          const exitCode = error ? (error as any).code ?? 1 : 0;
          resolve({ stdout, stderr, exitCode: typeof exitCode === "number" ? exitCode : 1 });
        });
      });
      this.sendJson(res, 200, result);
    } catch (err) {
      this.sendJson(res, 500, { error: `Execution failed: ${(err as Error).message}` });
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Image upload                                                      */
  /* ---------------------------------------------------------------- */

  private async handleImageUpload(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parsed: URL,
    projectId: string,
  ): Promise<void> {
    const parts = await this.parseMultipart(req);
    if (!parts.length) {
      this.sendJson(res, 400, { error: "No file uploaded. Send multipart/form-data with an image field." });
      return;
    }

    // Separate text fields from file parts
    const fields: Record<string, string> = {};
    const fileParts: typeof parts = [];
    for (const part of parts) {
      if (part.filename) {
        fileParts.push(part);
      } else {
        fields[part.fieldName] = part.data.toString("utf-8");
      }
    }

    if (!fileParts.length) {
      this.sendJson(res, 400, { error: "No file uploaded. Send multipart/form-data with an image field." });
      return;
    }

    const uploadsDir = path.join(this.dataDir, "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });

    const savedPaths: string[] = [];
    for (const part of fileParts) {
      if (!part.data.length) continue;
      let ext = ".bin";
      if (part.filename) {
        const dotIdx = part.filename.lastIndexOf(".");
        if (dotIdx >= 0) ext = part.filename.slice(dotIdx);
      } else if (part.contentType) {
        const sub = part.contentType.split("/")[1]?.split(";")[0];
        if (sub) ext = `.${sub}`;
      }
      const uuid = randomUUID();
      const filename = `${uuid}${ext}`;
      fs.writeFileSync(path.join(uploadsDir, filename), part.data);
      savedPaths.push(`uploads/${filename}`);
    }

    if (!savedPaths.length) {
      this.sendJson(res, 400, { error: "No valid file data received." });
      return;
    }

    // Filter to only actual image files for metadata
    const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
    const imagePaths = savedPaths.filter(p => imageExts.some(ext => p.toLowerCase().endsWith(ext)));

    // Post a message with image paths in metadata if thread_id provided
    const threadId = parsed.searchParams.get("thread_id") ?? parsed.searchParams.get("threadId") ?? fields["threadId"] ?? undefined;
    if (threadId) {
      const sender = fields["sender"] ?? req.headers["x-user-id"] as string | undefined ?? "user";
      const caption = fields["caption"] || "";
      const pathsForContent = imagePaths.length ? imagePaths : savedPaths;
      this.dispatchMessage({
        projectId,
        threadId,
        sender: { id: sender, type: "user" },
        channel: "thread",
        mode: "text",
        content: caption || `[image: ${pathsForContent.join(", ")}]`,
        source: fields["source"] ?? "upload",
        metadata: { imagePaths: imagePaths.length ? imagePaths : savedPaths, ...(caption ? { caption } : {}) },
      });
    }

    this.sendJson(res, 200, { paths: savedPaths });
  }

  /* ---------------------------------------------------------------- */
  /*  Media serving                                                     */
  /* ---------------------------------------------------------------- */

  private handleMediaServe(res: http.ServerResponse, filePath: string): void {
    // Normalize and prevent directory traversal
    const resolved = path.resolve(this.dataDir, filePath);
    if (!resolved.startsWith(this.dataDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        this.sendJson(res, 404, { error: "Not found" });
        return;
      }
    } catch {
      this.sendJson(res, 404, { error: "Not found" });
      return;
    }

    const ext = path.extname(resolved);
    const mediaMime: Record<string, string> = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
      ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
      ".mp4": "video/mp4", ".webm": "video/webm",
    };
    const contentType = mediaMime[ext.toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(resolved).pipe(res);
  }

  /* ---------------------------------------------------------------- */
  /*  Voice transcription proxy                                         */
  /* ---------------------------------------------------------------- */

  private async handleVoiceTranscribe(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Read the raw body and forward to Whisper service
    const rawBody = await this.readRawBody(req);
    const contentType = req.headers["content-type"] ?? "application/octet-stream";

    const whisperPort = Number(process.env.WHISPER_PORT ?? 8787);

    try {
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const proxyReq = http.request(
          {
            hostname: "127.0.0.1",
            port: whisperPort,
            path: "/transcribe",
            method: "POST",
            headers: {
              "Content-Type": contentType,
              "Content-Length": rawBody.length,
            },
          },
          (proxyRes) => {
            let data = "";
            proxyRes.on("data", (chunk: Buffer) => { data += chunk.toString(); });
            proxyRes.on("end", () => {
              resolve({ status: proxyRes.statusCode ?? 502, body: data });
            });
          },
        );
        proxyReq.on("error", (err) => reject(err));
        proxyReq.write(rawBody);
        proxyReq.end();
      });

      // Forward the Whisper response as-is
      try {
        const parsed = JSON.parse(result.body);
        this.sendJson(res, result.status, parsed);
      } catch {
        res.writeHead(result.status, { "Content-Type": "text/plain" });
        res.end(result.body);
      }
    } catch (err) {
      this.sendJson(res, 502, { error: `Whisper service unreachable at port ${whisperPort}: ${(err as Error).message}` });
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Multipart / raw body parsing                                      */
  /* ---------------------------------------------------------------- */

  private async readRawBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      req.on("end", () => { resolve(Buffer.concat(chunks)); });
    });
  }

  private async parseMultipart(req: http.IncomingMessage): Promise<{ fieldName: string; filename?: string; contentType?: string; data: Buffer }[]> {
    const contentType = req.headers["content-type"] ?? "";
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/);
    if (!boundaryMatch) return [];
    const boundary = boundaryMatch[1] ?? boundaryMatch[2];

    const rawBody = await this.readRawBody(req);
    const delimiter = Buffer.from(`--${boundary}`);
    const results: { fieldName: string; filename?: string; contentType?: string; data: Buffer }[] = [];

    // Split on boundary
    let start = 0;
    const positions: number[] = [];
    while (true) {
      const idx = rawBody.indexOf(delimiter, start);
      if (idx === -1) break;
      positions.push(idx);
      start = idx + delimiter.length;
    }

    for (let i = 0; i < positions.length - 1; i++) {
      const partStart = positions[i] + delimiter.length;
      const partEnd = positions[i + 1];
      const part = rawBody.subarray(partStart, partEnd);

      // Find headers/body separator (CRLFCRLF)
      const headerEnd = part.indexOf("\r\n\r\n");
      if (headerEnd === -1) continue;

      const headerStr = part.subarray(0, headerEnd).toString();
      // Strip trailing CRLF from body (before next boundary)
      let bodyData = part.subarray(headerEnd + 4);
      if (bodyData.length >= 2 && bodyData[bodyData.length - 2] === 0x0d && bodyData[bodyData.length - 1] === 0x0a) {
        bodyData = bodyData.subarray(0, bodyData.length - 2);
      }

      // Parse headers
      const nameMatch = headerStr.match(/name="([^"]+)"/);
      const filenameMatch = headerStr.match(/filename="([^"]+)"/);
      const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);

      if (nameMatch) {
        results.push({
          fieldName: nameMatch[1],
          filename: filenameMatch?.[1],
          contentType: ctMatch?.[1]?.trim(),
          data: bodyData,
        });
      }
    }

    return results;
  }

  /* ---------------------------------------------------------------- */
  /*  Dashboard handlers                                               */
  /* ---------------------------------------------------------------- */

  private dashboardPath(projectId: string): string {
    return path.join(this.dataDir, `${projectId}-dashboard.json`);
  }

  private handleDashboardGet(res: http.ServerResponse, projectId: string): void {
    const filePath = this.dashboardPath(projectId);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      this.sendJson(res, 200, data);
    } catch {
      // No dashboard yet — return empty default
      this.sendJson(res, 200, { updatedAt: null, updatedBy: null, blocks: [] });
    }
  }

  private async handleDashboardPost(req: http.IncomingMessage, res: http.ServerResponse, projectId: string): Promise<void> {
    const body = await this.readBody(req);
    const blocks = body.blocks;
    if (!Array.isArray(blocks)) {
      this.sendJson(res, 400, { error: "blocks must be an array" });
      return;
    }

    const updatedBy = body.updatedBy ?? this.resolveUserId(req);
    const dashboard = {
      updatedAt: new Date().toISOString(),
      updatedBy,
      blocks,
    };

    const filePath = this.dashboardPath(projectId);
    fs.writeFileSync(filePath, JSON.stringify(dashboard, null, 2), "utf-8");

    // Broadcast SSE event
    this.sseHub.publish(projectId, "dashboard_update", dashboard);

    this.sendJson(res, 200, dashboard);
  }

  private async readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
    return new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      req.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({}); }
      });
    });
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }
}

/* ------------------------------------------------------------------ */
/*  Config loader                                                      */
/* ------------------------------------------------------------------ */

export function loadProjectConfigs(dir: string): ProjectConfig[] {
  const projects: ProjectConfig[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    console.warn(`[gateway] No project config directory found at ${dir}`);
    return projects;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml")) continue;

    const filePath = path.join(dir, entry.name);
    const content = fs.readFileSync(filePath, "utf-8");
    const config = parseSimpleYaml(content);

    const id = path.basename(entry.name, path.extname(entry.name));
    const name = config.name ?? id;
    const port = Number(config.port);
    const repo = config.repo ?? "";
    const status = config.status === "inactive" ? "inactive" : "active";

    if (!port || isNaN(port)) {
      console.warn(`[gateway] Skipping ${entry.name}: missing or invalid port`);
      continue;
    }

    const directory = config.directory || undefined;
    projects.push({ id, name, port, repo, status, directory });
  }

  return projects;
}

function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
