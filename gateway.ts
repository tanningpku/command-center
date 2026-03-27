/**
 * Command Center Gateway
 *
 * Lightweight HTTP server that:
 *   - Serves the unified Command Center UI
 *   - Maintains a project registry (loaded from YAML configs)
 *   - Proxies /api/* requests to the correct project instance
 *   - Exposes /api/registry for the project list
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { GitHubPlugin } from "./github-plugin.js";
import { TaskStore } from "./task-store.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ProjectConfig {
  id: string;
  name: string;
  port: number;
  repo: string;
  status: "active" | "inactive";
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
  private readonly uiDir: string;
  private readonly dataDir: string;
  private readonly port: number;

  constructor(opts: GatewayOptions) {
    this.port = opts.port;
    this.uiDir = opts.uiDir;
    this.dataDir = opts.dataDir;
    this.projects = new Map(opts.projects.map((p) => [p.id, p]));
    this.githubPlugins = new Map();
    this.taskStores = new Map();

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
  }

  async start(): Promise<void> {
    // Initialize task stores for each project
    fs.mkdirSync(this.dataDir, { recursive: true });
    for (const [id] of this.projects) {
      const dbPath = path.join(this.dataDir, `${id}-tasks.db`);
      this.taskStores.set(id, new TaskStore(dbPath));
      console.log(`[gateway] Task store initialized for ${id}`);
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

    this.server.listen(this.port, () => {
      console.log(`[gateway] Command Center listening on http://localhost:${this.port}`);
    });
  }

  stop(): void {
    for (const plugin of this.githubPlugins.values()) plugin.shutdown();
    this.server.close();
  }

  /* ---------------------------------------------------------------- */
  /*  Request router                                                   */
  /* ---------------------------------------------------------------- */

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const parsed = new URL(rawUrl, `http://localhost:${this.port}`);
    const pathname = parsed.pathname;

    try {
      // --- Registry endpoints ---
      if (method === "GET" && pathname === "/api/registry") {
        this.handleRegistryList(res);
        return;
      }

      const healthMatch = pathname.match(/^\/api\/registry\/([^/]+)\/health$/);
      if (method === "GET" && healthMatch) {
        await this.handleHealthCheck(healthMatch[1], res);
        return;
      }

      // --- GitHub data endpoints (served by gateway directly) ---
      if (method === "GET" && (pathname === "/api/board" || pathname === "/api/actions" || pathname === "/api/pulls")) {
        const projectId = this.resolveProjectId(req, parsed);
        if (!projectId) {
          this.sendJson(res, 400, { error: "Missing project context." });
          return;
        }
        const ghPlugin = this.githubPlugins.get(projectId);
        if (!ghPlugin) {
          this.sendJson(res, 404, { error: `No GitHub plugin for project: ${projectId}` });
          return;
        }
        if (pathname === "/api/board") {
          this.sendJson(res, 200, ghPlugin.getBoard());
        } else if (pathname === "/api/actions") {
          this.sendJson(res, 200, { runs: ghPlugin.getActions(), lastUpdated: new Date().toISOString() });
        } else if (pathname === "/api/pulls") {
          this.sendJson(res, 200, { pulls: ghPlugin.getPulls(), lastUpdated: new Date().toISOString() });
        }
        return;
      }

      // --- Task endpoints (served by gateway) ---
      if (pathname.startsWith("/api/tasks")) {
        const projectId = this.resolveProjectId(req, parsed);
        if (!projectId) { this.sendJson(res, 400, { error: "Missing project context." }); return; }
        const store = this.taskStores.get(projectId);
        if (!store) { this.sendJson(res, 404, { error: `No task store for project: ${projectId}` }); return; }
        await this.handleTaskRequest(method, pathname, req, res, store);
        return;
      }

      // --- Proxy /api/* to project instance ---
      if (pathname.startsWith("/api/")) {
        const projectId = this.resolveProjectId(req, parsed);
        if (!projectId) {
          this.sendJson(res, 400, { error: "Missing project context. Set X-Project-Id header or ?projectId= query param." });
          return;
        }
        const project = this.projects.get(projectId);
        if (!project) {
          this.sendJson(res, 404, { error: `Unknown project: ${projectId}` });
          return;
        }
        await this.proxyRequest(req, res, project);
        return;
      }

      // --- Static file serving ---
      this.serveStatic(pathname, res);
    } catch (err) {
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
      id: p.id,
      name: p.name,
      port: p.port,
      repo: p.repo,
      status: p.status,
    }));
    this.sendJson(res, 200, { projects });
  }

  private async handleHealthCheck(projectId: string, res: http.ServerResponse): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project) {
      this.sendJson(res, 404, { error: `Unknown project: ${projectId}` });
      return;
    }

    try {
      const healthy = await this.pingProject(project);
      this.sendJson(res, 200, {
        id: project.id,
        name: project.name,
        healthy,
        port: project.port,
      });
    } catch {
      this.sendJson(res, 200, {
        id: project.id,
        name: project.name,
        healthy: false,
        port: project.port,
      });
    }
  }

  /**
   * Quick TCP-level health check: try to GET /api/status on the project port.
   */
  private pingProject(project: ProjectConfig): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: project.port, path: "/api/status", method: "GET", timeout: 2000 },
        (res) => {
          // Drain the response
          res.resume();
          resolve(res.statusCode === 200);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Proxy                                                            */
  /* ---------------------------------------------------------------- */

  private resolveProjectId(req: http.IncomingMessage, parsed: URL): string | null {
    // Header takes priority
    const header = req.headers["x-project-id"];
    if (typeof header === "string" && header.length > 0) return header;

    // Fall back to query param
    const param = parsed.searchParams.get("projectId");
    if (param) return param;

    // If there's only one project, use it as default
    if (this.projects.size === 1) {
      return this.projects.keys().next().value ?? null;
    }

    return null;
  }

  private async proxyRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    project: ProjectConfig,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const proxyReq = http.request(
        {
          hostname: "127.0.0.1",
          port: project.port,
          path: clientReq.url,
          method: clientReq.method,
          headers: {
            ...clientReq.headers,
            host: `127.0.0.1:${project.port}`,
          },
        },
        (proxyRes) => {
          clientRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(clientRes);
          proxyRes.on("end", resolve);
        },
      );

      proxyReq.on("error", (err) => {
        console.error(`[gateway] Proxy error for ${project.id}:`, err.message);
        if (!clientRes.headersSent) {
          this.sendJson(clientRes, 502, { error: `Project ${project.id} is unreachable` });
        }
        resolve();
      });

      // Pipe the client request body to the proxy
      clientReq.pipe(proxyReq);
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Static files                                                     */
  /* ---------------------------------------------------------------- */

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    // Default to index.html
    let filePath = pathname === "/" ? "/index.html" : pathname;

    const fullPath = path.join(this.uiDir, filePath);

    // Prevent directory traversal
    if (!fullPath.startsWith(this.uiDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // Check if file exists
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) {
        // Try appending .html
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
    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
  }

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- */
  /*  Task endpoints                                                   */
  /* ---------------------------------------------------------------- */

  private async handleTaskRequest(
    method: string,
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    store: TaskStore,
  ): Promise<void> {
    if (method === "GET" && pathname === "/api/tasks") {
      const url = new URL(req.url ?? "/", `http://localhost`);
      const state = url.searchParams.get("state") ?? undefined;
      const assignee = url.searchParams.get("assignee") ?? undefined;
      const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
      this.sendJson(res, 200, { tasks: store.list({ state, assignee, limit }) });
      return;
    }

    if (method === "POST" && pathname === "/api/tasks") {
      const body = await this.readBody(req);
      if (!body.title) { this.sendJson(res, 400, { error: "title is required" }); return; }
      const task = store.create({
        title: body.title, description: body.description, githubIssue: body.githubIssue,
        priority: body.priority, labels: body.labels, createdBy: body.createdBy ?? "unknown",
        assignee: body.assignee,
      });
      this.sendJson(res, 201, task);
      return;
    }

    if (method === "PATCH" && pathname.startsWith("/api/tasks/")) {
      const id = pathname.split("/")[3];
      if (!id) { this.sendJson(res, 400, { error: "task id required" }); return; }
      const body = await this.readBody(req);
      const task = store.update(id, body, body.actor ?? "unknown");
      this.sendJson(res, 200, task);
      return;
    }

    if (method === "POST" && pathname.endsWith("/complete")) {
      const parts = pathname.split("/");
      const id = parts[3]; // /api/tasks/T-1/complete
      if (!id) { this.sendJson(res, 400, { error: "task id required" }); return; }
      const body = await this.readBody(req);
      const task = store.complete(id, body.actor ?? "unknown", body.notes);
      this.sendJson(res, 200, task);
      return;
    }

    this.sendJson(res, 404, { error: "Task endpoint not found" });
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

/**
 * Load project configs from a directory of YAML files.
 * Uses a simple line-by-line parser to avoid a YAML dependency.
 */
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

    projects.push({ id, name, port, repo, status });
  }

  return projects;
}

/**
 * Minimal YAML parser for flat key: value files.
 * Handles quoted and unquoted string values, numbers.
 */
function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
