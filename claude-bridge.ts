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
 * Check the command line of a PID to see if it's a claude CLI process.
 * Returns true if the process cmdline contains "claude" and "--sdk-url".
 */
function isClaudeProcess(pid: number): boolean {
  try {
    const cmdline = execSync(`ps -p ${pid} -o args=`, { encoding: "utf-8", timeout: 3_000 }).trim();
    return cmdline.includes("claude") && cmdline.includes("--sdk-url");
  } catch {
    return false;
  }
}

/**
 * Find PIDs listening on a given port via lsof. Returns an array of PIDs.
 */
function findPidsOnPort(port: number): number[] {
  try {
    const out = execSync(`lsof -ti tcp:${port}`, { encoding: "utf-8", timeout: 5_000 });
    return out.trim().split("\n").map(Number).filter((n) => !isNaN(n) && n > 0);
  } catch {
    return []; // lsof exits non-zero when no matches
  }
}

/**
 * Get the command line of a PID for logging. Returns empty string on failure.
 */
function getProcessCmdline(pid: number): string {
  try {
    return execSync(`ps -p ${pid} -o args=`, { encoding: "utf-8", timeout: 3_000 }).trim();
  } catch {
    return "";
  }
}

/**
 * Check if a process command line looks like a stale gateway or claude process.
 */
function isOwnedProcess(cmdline: string): boolean {
  // Claude CLI bridge child
  if (cmdline.includes("claude") && cmdline.includes("--sdk-url")) return true;
  // Node gateway process (our own binary or tsx/node running gateway/index)
  if ((cmdline.includes("node") || cmdline.includes("tsx")) &&
      (cmdline.includes("gateway") || cmdline.includes("index") || cmdline.includes("command-center"))) return true;
  return false;
}

/**
 * Attempt to free a port held by a stale gateway or claude process.
 * Only sends SIGTERM to processes confirmed as owned (gateway node process
 * or claude CLI). Returns true if a process was signaled.
 */
export function freePort(port: number): boolean {
  const pids = findPidsOnPort(port);
  for (const pid of pids) {
    if (pid === process.pid) continue;
    const cmd = getProcessCmdline(pid);
    if (!cmd || !isOwnedProcess(cmd)) {
      console.warn(`[bridge-cleanup] Port ${port} held by unknown PID ${pid}: ${cmd || "(unknown)"} — not killing`);
      continue;
    }
    console.warn(`[bridge-cleanup] Port ${port} held by stale PID ${pid}: ${cmd}`);
    try {
      process.kill(pid, "SIGTERM");
      console.log(`[bridge-cleanup] Sent SIGTERM to PID ${pid} on port ${port}`);
      return true;
    } catch {
      // already gone
    }
  }
  return false;
}

/**
 * Find and kill stale claude CLI processes whose --sdk-url matches any of the
 * given WS ports. Used at gateway startup to clean up zombies from prior runs.
 * Each candidate PID is verified via isClaudeProcess() before being killed.
 */
export function killStaleClaude(wsPorts: number[]): number {
  if (wsPorts.length === 0) return 0;
  let killed = 0;
  try {
    const out = execSync("ps aux", { encoding: "utf-8", timeout: 5_000 });
    for (const line of out.split("\n")) {
      if (!line.includes("--sdk-url")) continue;
      for (const port of wsPorts) {
        if (line.includes(`ws://localhost:${port}/claude`)) {
          const parts = line.trim().split(/\s+/);
          const pid = Number(parts[1]);
          if (!pid || pid === process.pid) continue;
          if (!isClaudeProcess(pid)) continue;
          try {
            process.kill(pid, "SIGKILL");
            killed++;
            console.log(`[bridge-cleanup] Killed stale claude PID ${pid} (port ${port})`);
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

  /** The thread that the most recent user message was sent in. */
  activeThreadId = "main";

  private get tag(): string {
    return `claude-bridge:${this.opts.projectId}/${this.opts.agentId ?? "captain"}`;
  }

  constructor(private readonly opts: ClaudeBridgeOptions) {
    super();
  }

  private static readonly MAX_PORT_RETRIES = 3;

  async start(): Promise<void> {
    this.stopped = false;
    await this.listenWithRetry();

    if (this.opts.mockClaude) {
      console.log(`[${this.tag}] MOCK mode — no subprocess`);
      return;
    }
    this.spawnChild();
    this.startWatchdog();
  }

  /**
   * Attempt to bind the WebSocket server. On EADDRINUSE, attempt to free the
   * port (typically held by a stale gateway process) and retry.
   */
  private async listenWithRetry(): Promise<void> {
    for (let attempt = 1; attempt <= ClaudeBridge.MAX_PORT_RETRIES; attempt++) {
      try {
        await this.bindWss();
        console.log(`[${this.tag}] WS server listening on port ${this.opts.wsPort}`);
        return;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE" || attempt === ClaudeBridge.MAX_PORT_RETRIES) {
          throw err;
        }
        console.warn(
          `[${this.tag}] EADDRINUSE on port ${this.opts.wsPort} (attempt ${attempt}/${ClaudeBridge.MAX_PORT_RETRIES}). Attempting to free port...`,
        );
        freePort(this.opts.wsPort);
        // Wait for the OS to release the port after SIGTERM
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
    this.autoRestartPending = true;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, ClaudeBridge.MAX_BACKOFF_MS);
    console.log(`[${this.tag}] Auto-restart in ${delay}ms (reason: ${reason})`);
    setTimeout(() => {
      this.autoRestartPending = false;
      if (this.stopped) return;
      this.intentionalRestart = true;
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
    // Only check if we've actually sent a message (agent is expected to be working)
    if (this.lastUserMessageAt === 0) return;
    // Only relevant if child process is alive (exit handler covers crashes)
    if (!this.child) return;

    const now = Date.now();
    const sinceActivity = now - this.lastActivityAt;

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
