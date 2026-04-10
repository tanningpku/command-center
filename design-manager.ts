/**
 * Design Manager for Command Center
 *
 * Manages per-agent design artifact files (HTML, CSS, PNG, SVG, etc.).
 * Parallel to KbManager but simpler — whole-file read/write only,
 * no section parsing or patch operations.
 */
import path from "node:path";
import fs from "node:fs";

/** Binary file extensions that should be returned as base64. */
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp"]);

export interface DesignFileInfo {
  name: string;
  size: number;
  modified: string;
}

export class DesignManager {
  constructor(private readonly designDir: string) {}

  /** Ensure the designs directory exists. */
  ensureDir(): void {
    fs.mkdirSync(this.designDir, { recursive: true });
  }

  /** List all files in the designs directory with metadata. */
  list(): DesignFileInfo[] {
    try {
      const entries = fs.readdirSync(this.designDir);
      return entries
        .filter((f) => !f.startsWith("."))
        .map((f) => {
          const stat = fs.statSync(path.join(this.designDir, f));
          return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  /** Read a file. Returns text for text files, base64 for binary files. */
  read(fileName: string): { content: string; encoding: "utf-8" | "base64" } {
    const safe = path.basename(fileName);
    const full = path.join(this.designDir, safe);
    const ext = path.extname(safe).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      const buf = fs.readFileSync(full);
      return { content: buf.toString("base64"), encoding: "base64" };
    }
    return { content: fs.readFileSync(full, "utf-8"), encoding: "utf-8" };
  }

  /** Write a file (atomic via temp + rename). */
  write(fileName: string, content: string, encoding?: "base64"): void {
    this.ensureDir();
    const safe = path.basename(fileName);
    const full = path.join(this.designDir, safe);
    const tmp = `${full}.tmp`;
    if (encoding === "base64") {
      fs.writeFileSync(tmp, Buffer.from(content, "base64"));
    } else {
      fs.writeFileSync(tmp, content, "utf-8");
    }
    fs.renameSync(tmp, full);
  }

  /** Delete a file. */
  delete(fileName: string): void {
    const safe = path.basename(fileName);
    fs.unlinkSync(path.join(this.designDir, safe));
  }
}
