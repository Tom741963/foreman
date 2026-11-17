/**
 * DSH 观察适配器（只读）
 *
 * DeepSeek Harness 把每个会话写成 `~/.dsh/sessions/<工作区>/<session-id>/session.v4.jsonl.zstd`，
 * 文件是「一条记录一个 zstd 帧」顺序追加的。这里按帧解压，还原成人能看的活动流。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

export type DshEvent = {
  agent: "dsh";
  ts: number;
  kind: string;
  text: string;
};

export type DshSession = {
  id: string;
  cwd: string;
  file: string;
  startedAt: number;
  updatedAt: number;
};

const ROOT = path.join(os.homedir(), ".dsh", "sessions");
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export function dshAvailable(): boolean {
  return fs.existsSync(ROOT);
}

function isMagic(buf: Buffer, i: number): boolean {
  return (
    buf[i] === MAGIC[0] &&
    buf[i + 1] === MAGIC[1] &&
    buf[i + 2] === MAGIC[2] &&
    buf[i + 3] === MAGIC[3]
  );
}

/** 把「多帧拼接」的 zstd 文件解成文本：文件里每个 JSON 行各占一帧 */
function readFrames(file: string): string {
  const buf = fs.readFileSync(file);
  const offsets: number[] = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (isMagic(buf, i)) offsets.push(i);
  }
  if (!offsets.length) return "";
  offsets.push(buf.length);

  const parts: string[] = [];
  for (let i = 0; i < offsets.length - 1; i++) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(offsets[i], offsets[i + 1])).toString("utf8"));
    } catch {
      // 正在写入的最后一帧可能不完整，跳过即可
    }
  }
  return parts.join("\n");
}

/** 会话文件所在目录（session-<id>） */
function sessionDir(sessionId: string): string | null {
  if (!dshAvailable()) return null;
  const name = sessionId.startsWith("session-") ? sessionId : `session-${sessionId}`;
  let hit: string | null = null;
  const walk = (dir: string, depth: number) => {
    if (hit || depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === name) {
        hit = full;
        return;
      }
      walk(full, depth + 1);
    }
  };
  walk(ROOT, 0);
  return hit;
}

const usageBaseline = new Map<string, number>();

export type DshUsage = { input: number; output: number; cached: number; total: number };

/**
 * 一次 headless 跑完，从该会话的日志里把 usage 加总。
 * 同一会话续聊会累计，所以记一个基线，返回「这一轮」的增量。
 */
export function usageForSession(sessionId: string): DshUsage | null {
  const dir = sessionDir(sessionId);
  if (!dir) return null;
  const file = path.join(dir, "session.v4.jsonl.zstd");
  if (!fs.existsSync(file)) return null;

  let input = 0;
  let output = 0;
  let cached = 0;
  for (const line of readFrames(file).split(/\r?\n/)) {
    if (!line.includes('"usage"')) continue;
    let rec: { data?: { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } } };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    // 日志里 usage 挂在 data 下面，不在事件顶层
    const u = rec.data?.usage;
    if (!u) continue;
    input += u.inputTokens ?? 0;
    output += u.outputTokens ?? 0;
    cached += u.cacheReadTokens ?? 0;
  }

  const total = input + output + cached;
  if (total === 0) return null; // 日志还没落盘，别把基线吃掉
  const base = usageBaseline.get(sessionId) ?? 0;
  usageBaseline.set(sessionId, total);
  return { input, output, cached, total: Math.max(0, total - base) };
}

/** 子进程刚退出时日志可能还没写完，轮询一会儿再取 */
export async function usageForSessionWithRetry(
  sessionId: string,
  tries = 6,
  gapMs = 250,
): Promise<DshUsage | null> {
  for (let i = 0; i < tries; i++) {
    const u = usageForSession(sessionId);
    if (u) return u;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return null;
}

export function listSessions(): DshSession[] {
  if (!dshAvailable()) return [];
  const out: DshSession[] = [];
  for (const workspace of fs.readdirSync(ROOT)) {
    const wsDir = path.join(ROOT, workspace);
    if (!fs.statSync(wsDir).isDirectory()) continue;
    for (const session of fs.readdirSync(wsDir)) {
      const file = path.join(wsDir, session, "session.v4.jsonl.zstd");
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      const header = sessionHeader(file);
      out.push({
        id: session,
        cwd: header.cwd,
        file,
        startedAt: header.startedAt,
        updatedAt: stat.mtimeMs,
      });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 只解第一帧，拿到会话头（cwd、创建时间） */
function sessionHeader(file: string): { cwd: string; startedAt: number } {
  try {
    const buf = fs.readFileSync(file);
    let end = buf.length;
    for (let i = 4; i + 3 < buf.length; i++) {
      if (isMagic(buf, i)) {
        end = i;
        break;
      }
    }
    const first = zlib.zstdDecompressSync(buf.subarray(0, end)).toString("utf8");
    const rec = JSON.parse(first.split("\n")[0] ?? "{}") as {
      cwd?: string;
      createdAt?: number;
    };
    return { cwd: rec.cwd ?? "", startedAt: Number(rec.createdAt ?? 0) };
  } catch {
    return { cwd: "", startedAt: 0 };
  }
}

type RawRecord = {
  type?: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
};

function textOf(message: unknown): string {
  const m = message as { content?: Array<{ type?: string; text?: string }> } | null;
  if (!m || !Array.isArray(m.content)) return "";
  return m.content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function describe(rec: RawRecord): { kind: string; text: string } | null {
  const d = rec.data ?? {};
  switch (rec.type) {
    case "turn/start":
      return { kind: "turn/start", text: `开始第 ${String(d["turn"] ?? "?")} 轮` };
    case "turn/end":
      return { kind: "turn/end", text: `结束第 ${String(d["turn"] ?? "?")} 轮` };
    case "user/message":
      return { kind: "user", text: textOf(d["message"] ?? d).slice(0, 160) };
    case "assistant/message": {
      const t = textOf(d["message"]);
      if (!t) return null; // 只带工具调用的空消息，紧接着就有 tool/call，别重复一遍
      return { kind: "assistant", text: t.slice(0, 200) };
    }
    case "tool/call":
      return {
        kind: "tool/call",
        text: `${String(d["name"] ?? "tool")} ${String(d["arguments"] ?? "").replace(/\s+/g, " ").slice(0, 120)}`,
      };
    case "tool/result": {
      const t = textOf(d["message"]);
      return { kind: "tool/result", text: t ? t.slice(0, 120) : "(返回)" };
    }
    case "job/registered":
      return { kind: "job", text: `后台任务 ${String(d["jobId"] ?? "")} 启动` };
    case "job/settled":
      return { kind: "job", text: `后台任务 ${String(d["jobId"] ?? "")} 结束` };
    case "session/title":
      return { kind: "title", text: String(d["title"] ?? "").slice(0, 80) };
    default:
      return null;
  }
}

/** 读一个会话的全部活动（带 mtime 缓存：轮询时不必反复解压同一个文件） */
const cache = new Map<string, { mtime: number; events: DshEvent[] }>();

export function sessionEvents(file: string, limit = 200): DshEvent[] {
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return [];
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.events.slice(-limit);

  const events = parseEvents(readFrames(file));
  cache.set(file, { mtime, events });
  if (cache.size > 16) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return events.slice(-limit);
}

function parseEvents(raw: string): DshEvent[] {
  const events: DshEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: RawRecord;
    try {
      rec = JSON.parse(line) as RawRecord;
    } catch {
      continue;
    }
    const desc = describe(rec);
    if (!desc || !desc.text) continue;
    events.push({ agent: "dsh", ts: Number(rec.time ?? 0), kind: desc.kind, text: desc.text });
  }
  return events;
}

/** 最近活跃会话的活动流 */
export function recentEvents(limit = 40): DshEvent[] {
  const sessions = listSessions().slice(0, 3);
  const all: DshEvent[] = [];
  for (const s of sessions) all.push(...sessionEvents(s.file, limit));
  return all.sort((a, b) => a.ts - b.ts).slice(-limit);
}
