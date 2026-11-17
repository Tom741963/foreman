// 产物清单：任务链跑完（或每步跑完）对比工作目录，算出「哪些文件被动过、动了多少」
// 只读文本文件、只做行级 diff，够用且不引入依赖。
import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "logs", ".dsh-office", "shots", ".idea", ".vscode"]);
const TEXT_EXT = new Set([
  ".ts", ".js", ".mjs", ".cjs", ".json", ".md", ".txt", ".css", ".html", ".htm",
  ".yml", ".yaml", ".sql", ".toml", ".ps1", ".sh", ".bat", ".env", ".gitignore",
]);
const MAX_FILE = 256 * 1024;
const MAX_FILES = 24;
const MAX_DIFF_LINES = 200;

export type FileSnap = Map<string, string>;

export type ArtifactChange = {
  path: string;
  change: "added" | "modified" | "deleted";
  added: number;
  removed: number;
  diff: string;
};

function collect(root: string, dir: string, out: FileSnap): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collect(root, full, out);
      continue;
    }
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!TEXT_EXT.has(ext) && e.name !== ".gitignore" && e.name !== ".gitattributes") continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE) continue;
    let text: string;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    out.set(path.relative(root, full).split(path.sep).join("/"), text);
  }
}

/** 把工作目录里的文本文件读进内存（跳过大目录和二进制） */
export function snapshotFiles(root: string): FileSnap {
  const snap: FileSnap = new Map();
  collect(root, root, snap);
  return snap;
}

/** 行级 diff：掐掉公共前后缀，中间整段算改动，够看清楚「改了什么」 */
function lineDiff(
  before: string,
  after: string,
  relPath: string,
  kind: "added" | "modified" | "deleted",
): { text: string; added: number; removed: number } {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const removedLines = a.slice(head, a.length - tail);
  const addedLines = b.slice(head, b.length - tail);
  const contextStart = Math.max(0, head - 2);
  const context = a.slice(contextStart, head);

  const left = kind === "added" ? "/dev/null" : `a/${relPath}`;
  const right = kind === "deleted" ? "/dev/null" : `b/${relPath}`;
  const body: string[] = [`--- ${left}`, `+++ ${right}`, `@@ -${head + 1} +${head + 1} @@`];
  for (const line of context) body.push(` ${line}`);
  for (const line of removedLines) body.push(`-${line}`);
  for (const line of addedLines) body.push(`+${line}`);

  const tailContext = b.slice(b.length - tail, b.length - tail + 2);
  for (const line of tailContext) body.push(` ${line}`);

  const text = body.length > MAX_DIFF_LINES ? body.slice(0, MAX_DIFF_LINES).join("\n") + "\n…（diff 太长，已截断）" : body.join("\n");
  return { text, added: addedLines.length, removed: removedLines.length };
}

/** 对比两份快照，返回被改动的文件（最多 MAX_FILES 个，按改动行数排序） */
export function diffSnapshots(before: FileSnap, after: FileSnap): ArtifactChange[] {
  const changes: ArtifactChange[] = [];
  for (const [rel, text] of after) {
    const old = before.get(rel);
    if (old === text) continue;
    const kind = old === undefined ? "added" : "modified";
    const d = lineDiff(old ?? "", text, rel, kind);
    changes.push({
      path: rel,
      change: kind,
      added: d.added,
      removed: d.removed,
      diff: d.text,
    });
  }
  for (const [rel, text] of before) {
    if (after.has(rel)) continue;
    const d = lineDiff(text, "", rel, "deleted");
    changes.push({ path: rel, change: "deleted", added: 0, removed: d.removed, diff: d.text });
  }
  changes.sort((x, y) => y.added + y.removed - (x.added + x.removed));
  return changes.slice(0, MAX_FILES);
}

export function summarize(artifacts: ArtifactChange[]): string {
  if (!artifacts.length) return "没有文件改动";
  const added = artifacts.filter((a) => a.change === "added").length;
  const modified = artifacts.filter((a) => a.change === "modified").length;
  const removed = artifacts.filter((a) => a.change === "deleted").length;
  const parts: string[] = [];
  if (added) parts.push(`新增 ${added}`);
  if (modified) parts.push(`修改 ${modified}`);
  if (removed) parts.push(`删除 ${removed}`);
  return parts.join(" · ");
}
