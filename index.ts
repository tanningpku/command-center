/**
 * Command Center entry point.
 *
 * Phase 1: starts the gateway server only.
 * Project instances are expected to be started separately.
 *
 * Usage:
 *   npx tsx command-center/index.ts
 *   # or after build:
 *   node dist-cc/index.js
 */

import path from "node:path";
import { Gateway, loadProjectConfigs } from "./gateway.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const GATEWAY_PORT = Number(process.env.CC_PORT ?? 3300);
// Resolve paths relative to the command-center source directory (not dist/)
// When running compiled (dist/index.js), go up one level. When running source, use cwd.
const CC_ROOT = process.env.CC_ROOT ?? path.resolve(import.meta.dirname, import.meta.dirname.endsWith("/dist") ? ".." : ".");
const PROJECTS_DIR = path.resolve(CC_ROOT, "projects");
const UI_DIR = path.resolve(CC_ROOT, "ui");

/* ------------------------------------------------------------------ */
/*  Boot                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("[command-center] Starting Command Center...");

  // Load project registry from YAML configs
  const projects = loadProjectConfigs(PROJECTS_DIR);
  if (projects.length === 0) {
    console.warn("[command-center] No project configs found in", PROJECTS_DIR);
  } else {
    console.log(`[command-center] Loaded ${projects.length} project(s): ${projects.map((p) => p.name).join(", ")}`);
  }

  // Start the gateway
  const DATA_DIR = path.resolve(CC_ROOT, "data");

  const gateway = new Gateway({
    port: GATEWAY_PORT,
    projects,
    uiDir: UI_DIR,
    dataDir: DATA_DIR,
    configDir: PROJECTS_DIR,
  });

  await gateway.start();

  // Graceful shutdown
  const shutdown = () => {
    console.log("[command-center] Shutting down...");
    gateway.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[command-center] Fatal error:", err);
  process.exit(1);
});
