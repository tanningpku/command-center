/**
 * KB Manager for Command Center
 *
 * Manages per-project knowledge base files (markdown).
 * Adapted from companion/src/kb/manager.ts.
 */
import path from "node:path";
import fs from "node:fs";

const PROTECTED_FILES = new Set(["identity.md", "tools.md"]);

/** A parsed section boundary within a markdown file. */
export interface SectionInfo {
  level: number;
  heading: string;
  /** 1-based line number of the heading. */
  line: number;
  /** Character offset where this section (heading line) starts. */
  start: number;
  /** Character offset where this section ends (exclusive). */
  end: number;
}

/** Mode A: find/replace */
export interface PatchOpFindReplace {
  find: string;
  replace: string;
  replace_all?: boolean;
}

/** Mode B: section replace */
export interface PatchOpSectionReplace {
  section: string;
  content: string;
}

/** Mode C: append */
export interface PatchOpAppend {
  append: string;
  section?: string;
}

export type PatchOp = PatchOpFindReplace | PatchOpSectionReplace | PatchOpAppend;

/** Detailed search result. */
export interface SearchResult {
  file: string;
  section: string | null;
  line: number;
  text: string;
}

function isModeFindReplace(op: PatchOp): op is PatchOpFindReplace {
  return "find" in op && "replace" in op;
}

function isModeSectionReplace(op: PatchOp): op is PatchOpSectionReplace {
  return "section" in op && "content" in op && !("find" in op) && !("append" in op);
}

function isModeAppend(op: PatchOp): op is PatchOpAppend {
  return "append" in op;
}

export class KbManager {
  constructor(private readonly kbDir: string) {}

  /** Ensure the KB directory exists. */
  ensureDir(): void {
    fs.mkdirSync(this.kbDir, { recursive: true });
  }

  /** List all markdown files in the KB. */
  list(): string[] {
    try {
      return fs.readdirSync(this.kbDir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      return [];
    }
  }

  /** Read a full file. */
  read(fileName: string): string {
    return fs.readFileSync(path.join(this.kbDir, path.basename(fileName)), "utf-8");
  }

  /** Read a specific section by heading substring match. */
  readSection(fileName: string, sectionQuery: string): { section: string; content: string } | null {
    const content = this.read(fileName);
    const sections = this.parseSections(content);
    const q = sectionQuery.toLowerCase();
    const match = sections.find((s) => s.heading.toLowerCase().includes(q));
    if (!match) return null;
    return { section: match.heading, content: content.slice(match.start, match.end) };
  }

  /** Write a full file (atomic via temp + rename). */
  write(fileName: string, content: string): void {
    const safe = path.basename(fileName);
    const full = path.join(this.kbDir, safe);
    const tmp = `${full}.tmp`;
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, full);
  }

  /** Append a timestamped note to a file. */
  appendNote(fileName: string, text: string): void {
    const full = path.join(this.kbDir, path.basename(fileName));
    fs.appendFileSync(full, `\n- ${new Date().toISOString()}: ${text}\n`, "utf-8");
  }

  /** List the heading structure of a file. */
  listSections(fileName: string): Array<{ level: number; heading: string; line: number }> {
    const content = this.read(fileName);
    return this.parseSections(content).map(({ level, heading, line }) => ({ level, heading, line }));
  }

  /**
   * Surgical edit with three modes:
   * - Mode A (find/replace): { find, replace, replace_all? }
   * - Mode B (section replace): { section, content }
   * - Mode C (append): { append, section? }
   */
  patch(fileName: string, op: PatchOp): { replacements?: number; section?: string } {
    const safe = path.basename(fileName);
    let content = this.read(safe);

    if (isModeFindReplace(op)) {
      const { find, replace, replace_all } = op;
      if (replace_all) {
        const count = content.split(find).length - 1;
        content = content.split(find).join(replace);
        this.write(safe, content);
        return { replacements: count };
      }
      const firstIdx = content.indexOf(find);
      if (firstIdx === -1) {
        throw Object.assign(new Error(`string not found: ${JSON.stringify(find)}`), { code: "NOT_FOUND" });
      }
      const secondIdx = content.indexOf(find, firstIdx + 1);
      if (secondIdx !== -1) {
        let count = 0, pos = 0;
        while (true) {
          const idx = content.indexOf(find, pos);
          if (idx === -1) break;
          count++;
          pos = idx + 1;
        }
        throw Object.assign(
          new Error(`Found ${count} occurrences — provide more context or set replace_all: true`),
          { code: "AMBIGUOUS", count },
        );
      }
      content = content.slice(0, firstIdx) + replace + content.slice(firstIdx + find.length);
      this.write(safe, content);
      return { replacements: 1 };
    }

    if (isModeSectionReplace(op)) {
      const { section: sectionQuery, content: newContent } = op;
      const sections = this.parseSections(content);
      const q = sectionQuery.toLowerCase();
      const match = sections.find((s) => s.heading.toLowerCase().includes(q));
      if (!match) {
        throw Object.assign(new Error(`section not found: ${JSON.stringify(sectionQuery)}`), { code: "NOT_FOUND" });
      }
      const replacement = newContent.endsWith("\n") ? newContent : `${newContent}\n`;
      content = content.slice(0, match.start) + replacement + content.slice(match.end);
      this.write(safe, content);
      return { section: match.heading };
    }

    if (isModeAppend(op)) {
      const { append, section: sectionQuery } = op;
      if (sectionQuery) {
        const sections = this.parseSections(content);
        const q = sectionQuery.toLowerCase();
        const match = sections.find((s) => s.heading.toLowerCase().includes(q));
        if (!match) {
          throw Object.assign(new Error(`section not found: ${JSON.stringify(sectionQuery)}`), { code: "NOT_FOUND" });
        }
        let insertion = append.endsWith("\n") ? append : `${append}\n`;
        const before = content.slice(0, match.end);
        const after = content.slice(match.end);
        const needsLeadingNewline = !before.endsWith("\n");
        const needsTrailingBlank = after.length > 0 && !after.startsWith("\n");
        content = before + (needsLeadingNewline ? "\n" : "") + insertion + (needsTrailingBlank ? "\n" : "") + after;
      } else {
        if (!content.endsWith("\n")) content += "\n";
        content += append.endsWith("\n") ? append : `${append}\n`;
      }
      this.write(safe, content);
      return {};
    }

    throw new Error("unrecognized patch operation");
  }

  /** Delete a section from a file. Returns the deleted heading text. */
  deleteSection(fileName: string, sectionQuery: string): string {
    const safe = path.basename(fileName);
    let content = this.read(safe);
    const q = sectionQuery.toLowerCase();
    let deletedHeading: string | null = null;

    while (true) {
      const sections = this.parseSections(content);
      const match = sections.find((s) => s.heading.toLowerCase().includes(q));
      if (!match) break;
      if (!deletedHeading) deletedHeading = match.heading;
      content = content.slice(0, match.start) + content.slice(match.end);
    }

    if (!deletedHeading) {
      throw Object.assign(new Error(`section not found: ${JSON.stringify(sectionQuery)}`), { code: "NOT_FOUND" });
    }
    this.write(safe, content);
    return deletedHeading;
  }

  /** Search across KB files. Returns up to 50 results with section attribution. */
  search(keyword: string, targetFile?: string): SearchResult[] {
    const mdFiles = this.list();
    const files = targetFile ? [path.basename(targetFile)] : mdFiles;
    const out: SearchResult[] = [];
    const lowerKeyword = keyword.toLowerCase();

    for (const file of files) {
      if (out.length >= 50) break;
      let content: string;
      try {
        content = this.read(file);
      } catch {
        continue;
      }

      const sections = this.parseSections(content);
      const lines = content.split("\n");
      let charOffset = 0;

      for (let i = 0; i < lines.length; i++) {
        if (out.length >= 50) break;
        if (lines[i].toLowerCase().includes(lowerKeyword)) {
          const lineStart = charOffset;
          let sectionHeading: string | null = null;
          for (let s = sections.length - 1; s >= 0; s--) {
            if (sections[s].start <= lineStart && sections[s].end > lineStart) {
              sectionHeading = sections[s].heading;
              break;
            }
          }
          out.push({ file, section: sectionHeading, line: i + 1, text: lines[i] });
        }
        charOffset += lines[i].length + 1;
      }
    }
    return out;
  }

  /** Delete a KB file. Refuses to delete protected files. */
  deleteFile(fileName: string): void {
    const safe = path.basename(fileName);
    if (PROTECTED_FILES.has(safe)) {
      throw Object.assign(new Error(`${safe} is a protected file and cannot be deleted`), { code: "PROTECTED" });
    }
    fs.unlinkSync(path.join(this.kbDir, safe));
  }

  /** Parse markdown into sections. */
  parseSections(content: string): SectionInfo[] {
    const lines = content.split("\n");
    const headingRe = /^(#{1,6})\s+(.+)$/;
    const headings: Array<{ level: number; heading: string; lineIndex: number; charOffset: number }> = [];
    let charOffset = 0;

    for (let i = 0; i < lines.length; i++) {
      const m = headingRe.exec(lines[i]);
      if (m) {
        headings.push({ level: m[1].length, heading: m[2].trim(), lineIndex: i, charOffset });
      }
      charOffset += lines[i].length + 1;
    }

    const sections: SectionInfo[] = [];
    for (let h = 0; h < headings.length; h++) {
      const current = headings[h];
      let endOffset = content.length;
      for (let k = h + 1; k < headings.length; k++) {
        if (headings[k].level <= current.level) {
          endOffset = headings[k].charOffset;
          break;
        }
      }
      sections.push({
        level: current.level,
        heading: current.heading,
        line: current.lineIndex + 1,
        start: current.charOffset,
        end: endOffset,
      });
    }
    return sections;
  }
}
