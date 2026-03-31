/**
 * Claude Bridge for Command Center
 *
 * Spawns the Claude CLI per project, manages the WebSocket SDK connection,
 * handles the NDJSON protocol, and emits typed events.
 *
 * Reference: companion/src/core/claude-server.ts + protocol.ts
 */
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocket, WebSocketServer } from "ws";

/* ------------------------------------------------------------------ */
/*  Port cleanup utilities                                             */
/* ------------------------------------------------------------------ */

/**
 * Check if a PID is orphaned (its parent process no longer exists, so it
 * was reparented to PID 1/init). Orphaned processes from a prior gateway
 * run are safe to kill since their parent is gone.
 */
function isOrphaned(pid: number): boolean {
  try {
    const ppid = Number(execSync(`ps -p ${pid} -o ppid=`, { encoding: "utf-8", timeout: 3_000 }).trim());
    return ppid === 1;
  } catch {
    return false;
  }
}

/**
 * Describe what's on a port for error messages. Returns a human-readable
 * string like "PID 1234 (node dist/index.js)".
 */
export function describePortOccupant(port: number): string {
  try {
    const out = execSync(`lsof -ti tcp:${port}`, { encoding: "utf-8", timeout: 5_000 });
    const pids = out.trim().split("\n").map(Number).filter((n) => !isNaN(n) && n > 0);
    if (pids.length === 0) return "(no process found)";
    const descs: string[] = [];
    for (const pid of pids) {
      try {
        const cmd = execSync(`ps -p ${pid} -o args=`, { encoding: "utf-8", timeout: 3_000 }).trim();
        descs.push(`PID ${pid} (${cmd})`);
      } catch {
        descs.push(`PID ${pid}`);
      }
    }
    return descs.join(", ");
  } catch {
    return "(unable to determine)";
  }
}

/**
 * Find and kill orphaned claude CLI processes whose --sdk-url matches any of
 * the given WS ports. Only kills processes that are:
 * 1. Confirmed claude CLI (command line contains "claude" and "--sdk-url")
 * 2. Confirmed orphaned (PPID = 1, reparented to init after parent gateway died)
 *
 * This avoids killing healthy bridges belonging to a still-running gateway.
 */
export function killStaleClaude(wsPorts: number[]): number {
  if (wsPorts.length === 0) return 0;
  let killed = 0;
  try {
    const out = execSync("ps aux", { encoding: "utf-8", timeout: 5_000 });
    for (const line of out.split("\n")) {
      if (!line.includes("claude") || !line.includes("--sdk-url")) continue;
      for (const port of wsPorts) {
        if (line.includes(`ws://localhost:${port}/claude`)) {
          const parts = line.trim().split(/\s+/);
          const pid = Number(parts[1]);
          if (!pid || pid === process.pid) continue;
          if (!isOrphaned(pid)) {
            console.log(`[bridge-cleanup] claude PID ${pid} (port ${port}) has a live parent — skipping`);
            continue;
          }
          try {
            process.kill(pid, "SIGKILL");
            killed++;
            console.log(`[bridge-cleanup] Killed orphaned claude PID ${pid} (port ${port})`);
          } catch {
            // already gone
          }
          break;
        }
      }
    }
  } catch {
    // ps not available or failed — non-fatal
  }
  return killed;
}

/* ------------------------------------------------------------------ */
/*  NDJSON Protocol (ported from companion/src/core/protocol.ts)       */
/* ------------------------------------------------------------------ */

interface NdjsonState { buffer: string }

function createNdjsonState(): NdjsonState { return { buffer: "" }; }

function encodeNdjson(msg: unknown): string { return `${JSON.stringify(msg)}\n`; }

function parseNdjsonChunk(state: NdjsonState, chunk: string): Record<string, unknown>[] {
  const input = state.buffer + chunk;
  const lines = input.split("\n");
  state.buffer = lines.pop() ?? "";
  const parsed: Record<string, unknown>[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    parsed.push(JSON.parse(trimmed));
  }
  return parsed;
}

function buildInitializeRequest(appendSystemPrompt: string): Record<string, unknown> {
  return {
    type: "control_request",
    request_id: randomUUID(),
    request: { subtype: "initialize", appendSystemPrompt },
  };
}

function buildUserMessage(content: string): Record<string, unknown> {
  return {
    type: "user",
    session_id: "",
    uuid: randomUUID(),
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

function buildPermissionResponse(requestId: string, behavior: "allow" | "deny", toolInput: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: { behavior, updatedInput: toolInput },
    },
  };
}

function extractAssistantText(message: Record<string, unknown>): string {
  const payload = message.message as { content?: unknown } | undefined;
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  const out: string[] = [];
  for (const block of blocks) {
    const candidate = block as { type?: string; text?: string };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      out.push(candidate.text);
    }
  }
  return out.join("\n\n").trim();
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ClaudeBridgeOptions {
  projectId: string;
  /** Agent ID (e.g. "captain", "backend-lead") */
  agentId?: string;
  /** WebSocket port for Claude SDK (convention: HTTP port + 10000) */
  wsPort: number;
  /** Working directory for Claude subprocess */
  projectDir: string;
  /** System prompt appended to Claude's default */
  systemPrompt: string;
  /** Claude CLI binary (default: "claude") */
  claudeCommand?: string;
  /** Skip spawning Claude (for testing) */
  mockClaude?: boolean;
  /** Absolute path to command-center bin/ dir (prepended to PATH so `cc` resolves correctly) */
  ccBinDir?: string;
  /** Initial prompt sent via -p flag (default: "{agentId} online — ready for work") */
  initialPrompt?: string;
}

export interface AssistantTextPayload {
  text: string;
  fullText: string;
  raw: Record<string, unknown>;
}

export interface ResultPayload {
  sessionId: string;
  totalCostUsd: number;
  subtype: string;
  resultText: string;
  raw: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  Bridge                                                             */
/* ------------------------------------------------------------------ */

export class ClaudeBridge extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private activeSocket: WebSocket | null = null;
  private activeState = createNdjsonState();
  private child: ChildProcess | null = null;
  private _ready = false;
  private seenUuids = new Set<string>();
  private stopped = false;
  private intentionalRestart = false;
  private autoRestartPending = false;
  private backoffMs = 1_000;
  private static readonly MAX_BACKOFF_MS = 60_000;

  /* ---- Watchdog state ---- */
  /** Timestamp of most recent activity (SDK message, stdout, stderr) */
  private lastActivityAt = Date.now();
  /** Timestamp of most recent user message sent to bridge */
  private lastUserMessageAt = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** Timeout in ms with no activity after sending a message before considering stuck (default: 5min) */
  static readonly STUCK_TIMEOUT_MS = 300_000;
  /** How often the watchdog checks for stuck bridges (default: 30s) */
  private static readonly WATCHDOG_INTERVAL_MS = 30_000;
  /** Idle timeout in ms — bridge not ready AND no activity triggers restart (default: 10min) */
  static readonly IDLE_TIMEOUT_MS = 600_000;

  /** The thread that the most recent user message was sent in. */
  activeThreadId = "main";

  /* ---- Metrics ---- */
  private bridgeStartedAt = 0;
  private _restartCount = 0;
  private _lastRestartReason: string | null = null;
  private _messagesReceived = 0;
  private _messagesSent = 0;
  private _errors = 0;

  /* ---- Restart escalation ---- */
  /** Timestamps of recent restarts for escalation tracking */
  private restartTimestamps: number[] = [];
  /** Max restarts within the escalation window before stopping the bridge */
  static readonly ESCALATION_MAX_RESTARTS = 5;
  /** Window in ms for restart escalation (default: 10min) */
  static readonly ESCALATION_WINDOW_MS = 600_000;
  /** Whether the bridge was stopped by escalation (not a normal stop) */
  private _escalationStopped = false;

  /** True if the bridge was stopped due to restart escalation. */
  get escalationStopped(): boolean { return this._escalationStopped; }

  /** Return health diagnostics for this bridge. */
  getHealthInfo(): {
    agent_id: string;
    status: string;
    ready: boolean;
    uptime_seconds: number;
    started_at: string | null;
    last_activity_at: string;
    restart_count: number;
    last_restart_reason: string | null;
    ws_port: number;
    active_thread_id: string;
    pid: number | null;
    messages_received: number;
    messages_sent: number;
    errors: number;
  } {
    const now = Date.now();
    let status: string;
    if (this.stopped) status = "stopped";
    else if (this.autoRestartPending) status = "restarting";
    else if (this.isReady()) status = "ready";
    else if (this.child) status = "connecting";
    else status = "disconnected";

    return {
      agent_id: this.opts.agentId ?? "captain",
      status,
      ready: this.isReady(),
      uptime_seconds: this.bridgeStartedAt > 0 ? Math.floor((now - this.bridgeStartedAt) / 1000) : 0,
      started_at: this.bridgeStartedAt > 0 ? new Date(this.bridgeStartedAt).toISOString() : null,
      last_activity_at: new Date(this.lastActivityAt).toISOString(),
      restart_count: this._restartCount,
      last_restart_reason: this._lastRestartReason,
      ws_port: this.opts.wsPort,
      active_thread_id: this.activeThreadId,
      pid: this.child?.pid ?? null,
      messages_received: this._messagesReceived,
      messages_sent: this._messagesSent,
      errors: this._errors,
    };
  }

  private get tag(): string {
    return `claude-bridge:${this.opts.projectId}/${this.opts.agentId ?? "captain"}`;
  }

  constructor(private readonly opts: ClaudeBridgeOptions) {
    super();
  }

  private static readonly MAX_PORT_RETRIES = 3;

  async start(): Promise<void> {
    this.stopped = false;
    this.bridgeStartedAt = Date.now();
    await this.listenWithRetry();

    if (this.opts.mockClaude) {
      console.log(`[${this.tag}] MOCK mode — no subprocess`);
      return;
    }
    this.spawnChild();
    this.startWatchdog();
  }

  /**
   * Attempt to bind the WebSocket server. On EADDRINUSE, wait and retry
   * (handles transient port conflicts during gateway restart). After all
   * retries, includes diagnostics about what holds the port.
   */
  private async listenWithRetry(): Promise<void> {
    for (let attempt = 1; attempt <= ClaudeBridge.MAX_PORT_RETRIES; attempt++) {
      try {
        await this.bindWss();
        console.log(`[${this.tag}] WS server listening on port ${this.opts.wsPort}`);
        return;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE") throw err;
        if (attempt === ClaudeBridge.MAX_PORT_RETRIES) {
          const occupant = describePortOccupant(this.opts.wsPort);
          throw new Error(
            `EADDRINUSE: port ${this.opts.wsPort} is held by ${occupant}. ` +
            `Stop the other process or change the project port config.`,
          );
        }
        console.warn(
          `[${this.tag}] EADDRINUSE on port ${this.opts.wsPort} (attempt ${attempt}/${ClaudeBridge.MAX_PORT_RETRIES}). Retrying in ${attempt}s...`,
        );
        await new Promise((r) => setTimeout(r, 1_000 * attempt));
      }
    }
  }

  /** Create a WebSocketServer and wait for it to be listening (or error). */
  private bindWss(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.opts.wsPort, path: "/claude" });
      wss.on("listening", () => {
        this.wss = wss;
        wss.on("connection", (socket) => this.onConnection(socket));
        resolve();
      });
      wss.on("error", (err) => {
        wss.close();
        reject(err);
      });
    });
  }

  stop(): void {
    this.stopped = true;
    this.autoRestartPending = false;
    this.hasInitialized = false;
    this.stopWatchdog();
    this.child?.kill();
    this.child = null;
    this.activeSocket?.close();
    this.activeSocket = null;
    this._ready = false;
    this.wss?.close();
    this.wss = null;
  }

  isReady(): boolean {
    return this._ready && this.activeSocket !== null && this.activeSocket.readyState === WebSocket.OPEN;
  }

  /** Send a user message to Claude, with thread context, history, and timestamp. */
  sendUserMessage(text: string, threadId: string, sender?: string, context?: string): void {
    this.activeThreadId = threadId;
    const now = new Date();
    const local = now.toLocaleString("en-US", {
      weekday: "short", year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
    });
    const parts: string[] = [`[${local}]`];
    if (context) parts.push(context);
    parts.push(`${sender ?? "User"}: ${text}`);
    this.send(buildUserMessage(parts.join("\n")));
    this._messagesSent++;
    const ts = Date.now();
    this.lastUserMessageAt = ts;
    this.lastActivityAt = ts; // Reset so watchdog gives a full timeout window
  }

  /* ---- Child process management ---- */

  private spawnChild(): void {
    const cmd = this.opts.claudeCommand ?? "claude";
    const agentId = this.opts.agentId ?? "captain";
    const prompt = this.opts.initialPrompt ?? `${agentId} online — ready for work`;
    const args = [
      "--sdk-url", `ws://localhost:${this.opts.wsPort}/claude`,
      "--dangerously-skip-permissions",
      "-p", prompt,
    ];
    const childPath = this.opts.ccBinDir
      ? `${this.opts.ccBinDir}:${process.env.PATH ?? ""}`
      : process.env.PATH;
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: this.opts.projectDir,
      env: { ...process.env, CLAUDECODE: undefined, CC_PROJECT: this.opts.projectId, CC_AGENT: agentId, PATH: childPath },
    });
    this.child = child;

    child.stdout?.on("data", (data: Buffer) => {
      this.lastActivityAt = Date.now();
      for (const line of data.toString().trim().split("\n")) {
        console.log(`[${this.tag}:out] ${line}`);
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      this.lastActivityAt = Date.now();
      for (const line of data.toString().trim().split("\n")) {
        console.error(`[${this.tag}:err] ${line}`);
      }
    });
    child.on("exit", (code, signal) => {
      console.warn(`[${this.tag}] Claude exited (code=${code}, signal=${signal})`);
      this.child = null;
      this._ready = false;
      if (!this.stopped && !this.intentionalRestart) {
        this.scheduleAutoRestart("subprocess_exit");
      }
    });
  }

  private scheduleAutoRestart(reason: string): void {
    if (this.autoRestartPending) return;

    // Restart escalation: if too many restarts in the window, stop instead
    const now = Date.now();
    this.restartTimestamps.push(now);
    const cutoff = now - ClaudeBridge.ESCALATION_WINDOW_MS;
    this.restartTimestamps = this.restartTimestamps.filter((t) => t >= cutoff);
    if (this.restartTimestamps.length >= ClaudeBridge.ESCALATION_MAX_RESTARTS) {
      console.error(
        `[${this.tag}] ESCALATION: ${this.restartTimestamps.length} restarts in ${ClaudeBridge.ESCALATION_WINDOW_MS / 1000}s — stopping bridge`,
      );
      this._escalationStopped = true;
      this.emit("escalation_stop", {
        agentId: this.opts.agentId ?? "captain",
        restartCount: this.restartTimestamps.length,
        windowMs: ClaudeBridge.ESCALATION_WINDOW_MS,
        lastReason: reason,
      });
      this.stop();
      return;
    }

    this.autoRestartPending = true;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, ClaudeBridge.MAX_BACKOFF_MS);
    console.log(`[${this.tag}] Auto-restart in ${delay}ms (reason: ${reason})`);
    setTimeout(() => {
      this.autoRestartPending = false;
      if (this.stopped) return;
      // If bridge recovered during the backoff window, skip the restart
      if (this.isReady()) {
        console.log(`[${this.tag}] Bridge recovered during backoff — cancelling restart (reason: ${reason})`);
        this.backoffMs = 1_000;
        return;
      }
      this.intentionalRestart = true;
      this._restartCount++;
      this._lastRestartReason = reason;
      this.bridgeStartedAt = Date.now();
      this.killChild();
      this.spawnChild();
      const onReady = () => {
        this.removeListener("ready", onReady);
        this.backoffMs = 1_000;
        this.intentionalRestart = false;
        this.emit("restarted", { reason });
      };
      this.on("ready", onReady);
    }, delay);
  }

  private killChild(): void {
    this._ready = false;
    this.hasInitialized = false;
    // Reset watchdog state — interrupted turn is no longer in-flight
    this.lastUserMessageAt = 0;
    this.lastActivityAt = Date.now();
    if (this.child) {
      this.child.removeAllListeners("exit");
      this.child.kill();
      this.child = null;
    }
    if (this.activeSocket) {
      this.activeSocket.removeAllListeners();
      this.activeSocket.close();
      this.activeSocket = null;
    }
  }

  /* ---- WebSocket handling ---- */

  private hasInitialized = false;

  private onConnection(socket: WebSocket): void {
    // Overwrite activeSocket without closing old one. Old socket's close event
    // fires later, but activeSocket === socket guard makes it a no-op.
    this.activeSocket = socket;
    this.activeState = createNdjsonState();

    socket.on("message", (raw) => {
      const chunk = typeof raw === "string" ? raw : raw.toString();
      for (const msg of parseNdjsonChunk(this.activeState, chunk)) {
        this.onMessage(msg);
      }
    });

    socket.on("close", () => {
      if (this.activeSocket === socket) {
        this.activeSocket = null;
        this._ready = false;
        if (!this.stopped && !this.intentionalRestart) {
          if (this.child) this.child.kill();
          this.scheduleAutoRestart("socket_closed");
        }
      }
    });

    socket.on("error", (err) => {
      this._errors++;
      console.error(`[${this.tag}] Socket error:`, err.message);
    });

    if (!this.hasInitialized) {
      // First connection — send initialize with system prompt
      console.log(`[${this.tag}] Claude connected, initializing`);
      this._ready = false;
      this.send(buildInitializeRequest(this.opts.systemPrompt));
    } else {
      // WebSocket reconnect — CLI already initialized, just swap socket
      console.log(`[${this.tag}] Claude reconnected (socket swap)`);
    }
  }

  private onMessage(message: Record<string, unknown>): void {
    const type = String(message.type ?? "unknown");

    // Track activity for watchdog
    this.lastActivityAt = Date.now();
    this._messagesReceived++;

    // Forward all raw messages as SSE events
    this.emit("message", message);

    // Initialize acknowledgement
    if (type === "control_response") {
      const response = message.response as Record<string, unknown> | undefined;
      const subtype = String(response?.subtype ?? "");
      if (subtype === "success") {
        const inner = response?.response as Record<string, unknown> | undefined;
        if (inner && ("models" in inner || "commands" in inner)) {
          this._ready = true;
          this.hasInitialized = true;
          this.emit("ready");
          console.log(`[${this.tag}] Claude ready`);
        }
      }
      return;
    }

    // Permission requests — auto-allow everything
    if (type === "control_request") {
      const request = message.request as Record<string, unknown> | undefined;
      const subtype = String(request?.subtype ?? "");
      if (subtype === "can_use_tool") {
        const requestId = String(message.request_id ?? "");
        const toolInput = (request?.input ?? request?.tool_input ?? {}) as Record<string, unknown>;
        this.send(buildPermissionResponse(requestId, "allow", toolInput));
      }
      return;
    }

    // Result — turn complete
    if (type === "result") {
      this.lastUserMessageAt = 0; // Turn done — stop watchdog monitoring
      this.emit("result", {
        sessionId: String(message.session_id ?? ""),
        totalCostUsd: Number(message.total_cost_usd ?? 0),
        subtype: String(message.subtype ?? ""),
        resultText: String(message.result ?? ""),
        raw: message,
      } satisfies ResultPayload);
      return;
    }

    // Assistant response
    if (type === "assistant") {
      const uuid = String(message.uuid ?? "");
      if (uuid && this.seenUuids.has(uuid)) return;
      if (uuid) this.seenUuids.add(uuid);

      const fullText = extractAssistantText(message);
      if (fullText) {
        this.emit("assistant_text", {
          text: fullText,
          fullText,
          raw: message,
        } satisfies AssistantTextPayload);
      }
      return;
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.activeSocket || this.activeSocket.readyState !== WebSocket.OPEN) {
      console.warn(`[${this.tag}] No active socket, dropping message`);
      return;
    }
    this.activeSocket.send(encodeNdjson(payload));
  }

  /* ---- Watchdog ---- */

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => this.checkStuck(), ClaudeBridge.WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private checkStuck(): void {
    if (this.stopped || this.autoRestartPending) return;

    const now = Date.now();
    const sinceActivity = now - this.lastActivityAt;

    // Idle detection: bridge not ready AND no activity for IDLE_TIMEOUT_MS
    // This catches bridges that disconnected silently and never reconnected.
    if (!this.isReady() && this.child && sinceActivity >= ClaudeBridge.IDLE_TIMEOUT_MS) {
      console.warn(
        `[${this.tag}] WATCHDOG: Bridge idle — not ready and no activity for ` +
        `${Math.round(sinceActivity / 1000)}s. Auto-restarting.`,
      );
      this.emit("idle_restart", {
        agentId: this.opts.agentId ?? "captain",
        sinceActivityMs: sinceActivity,
      });
      this.scheduleAutoRestart("idle_not_ready");
      return;
    }

    // Stuck detection: only if we've sent a message and are waiting for a response
    if (this.lastUserMessageAt === 0) return;
    if (!this.child) return;

    // Not stuck if there's been recent activity (SDK messages, stdout, stderr)
    if (sinceActivity < ClaudeBridge.STUCK_TIMEOUT_MS) return;

    console.warn(
      `[${this.tag}] WATCHDOG: Bridge appears stuck — no activity (SDK, stdout, stderr) ` +
      `for ${Math.round(sinceActivity / 1000)}s. Killing subprocess.`,
    );

    // Reset so we don't fire again immediately on restart
    this.lastUserMessageAt = 0;
    this.emit("watchdog_kill", {
      agentId: this.opts.agentId ?? "captain",
      sinceActivityMs: sinceActivity,
    });
    this.scheduleAutoRestart("watchdog_stuck");
  }
}
