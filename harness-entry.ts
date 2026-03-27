/**
 * Minimal harness entry point for Command Center projects.
 *
 * Uses @companion/core's createInstance() with no personal integrations.
 * Configured entirely via environment variables.
 *
 * Required env:
 *   UI_PORT — port for this instance
 *   PROJECT_DIR — project working directory
 *   AGENT_DIR — path to agent KB/data directory
 */
import path from "node:path";
import fs from "node:fs";

// Import createInstance from the companion core (via compiled dist)
// This path is resolved at runtime via COMPANION_DIST env var
const companionDist = process.env.COMPANION_DIST ?? path.resolve(import.meta.dirname, "../../companion/dist");

async function main(): Promise<void> {
  const port = Number(process.env.UI_PORT ?? 3200);
  const projectDir = process.env.PROJECT_DIR ?? process.cwd();
  const agentDir = process.env.AGENT_DIR ?? path.resolve(projectDir, "data/captain");
  const agentDataDir = path.resolve(agentDir, "data");

  // Ensure directories exist
  fs.mkdirSync(agentDataDir, { recursive: true });
  fs.mkdirSync(path.resolve(agentDir, "kb"), { recursive: true });

  // Ensure config exists
  const configDir = path.resolve(projectDir, "config");
  const configPath = path.resolve(configDir, "config.json");
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(configDir, { recursive: true });
    // Write minimal config
    fs.writeFileSync(configPath, JSON.stringify({
      port: 0,
      backend: "claude",
      claude: {
        command: process.env.CLAUDE_BIN ?? "claude",
        args: ["--dangerously-skip-permissions"],
        appendSystemPromptFile: path.resolve(agentDir, "kb/identity.md"),
      },
      sources: {},
      privacy: {
        allowedWritePaths: [projectDir],
        blockedBashPatterns: [],
      },
    }, null, 2), "utf-8");
  }

  // Dynamic import of createInstance
  const { createInstance } = await import(path.join(companionDist, "core/instance.js"));

  const readJsonFile = async <T>(p: string): Promise<T> => {
    const text = await fs.promises.readFile(p, "utf-8");
    return JSON.parse(text) as T;
  };

  const config = await readJsonFile<any>(configPath);

  // Seed the captain assistant in the DB if it doesn't exist
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = path.resolve(agentDataDir, "chat.db");
  const db = new DatabaseSync(dbPath);
  // Ensure assistants table exists (createInstance will also do this, but we need to seed first)
  db.exec(`CREATE TABLE IF NOT EXISTS assistants (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'captain',
    hosting_mode TEXT NOT NULL DEFAULT 'local', backend TEXT NOT NULL DEFAULT 'claude',
    endpoint TEXT, config_json TEXT NOT NULL DEFAULT '{}',
    kb_root TEXT, data_root TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    avatar_url TEXT, avatar_source TEXT, avatar_default_key TEXT, avatar_updated_at TEXT
  )`);
  const existing = db.prepare("SELECT id FROM assistants WHERE id = 'captain'").get();
  if (!existing) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO assistants (id, name, type, hosting_mode, backend, config_json, kb_root, data_root, status, created_at, updated_at)
       VALUES ('captain', 'Captain', 'captain', 'local', 'claude', '{}', ?, ?, 'active', ?, ?)`
    ).run(path.resolve(agentDir, "kb"), agentDataDir, now, now);
    console.log("[harness] Seeded captain assistant in DB");
  }
  db.close();

  const instance = await createInstance({
    name: `Project (port ${port})`,
    projectRoot: projectDir,
    harnessConfig: config,
    agents: [{
      id: "captain",
      dir: agentDir,
      dataDir: agentDataDir,
      identityPromptPath: path.resolve(agentDir, "kb/identity.md"),
      isPrimary: true,
    }],
    plugins: [],
    sources: [],
    uiPort: port,
  });

  console.log(`[harness] Project instance started on port ${port}`);
}

main().catch((err) => {
  console.error("[harness] Fatal error:", err);
  process.exit(1);
});
