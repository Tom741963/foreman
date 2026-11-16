/**
 * 对话线程
 *
 * `dsh headless` 是一次性的（跑完即退出，不带上下文），所以“多轮”只能在 Foreman 这边做：
 * 每次派活时把最近几轮对话压成一段前言，拼在任务前面，让新进程知道前面聊过什么。
 * 这不是真正的会话状态，但足够让“接着上一轮继续说”成立。
 */
import fs from "node:fs";
import path from "node:path";
import { LOG_ROOT } from "./logs.ts";

export type Role = "user" | "assistant";

export type Message = {
  role: Role;
  text: string;
  thinking?: string;
  at: number;
  runId?: string;
  /** 这句是哪个 agent 说的，用户消息为空 */
  agent?: "dsh" | "codex";
};

export type Thread = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 各 agent 自己的会话 id；有它就能直接续会话，而不是复述历史 */
  sessions?: { dsh?: string; codex?: string };
  messages: Message[];
};

const DIR = path.join(LOG_ROOT, "threads");
const MAX_HISTORY = 4000; // 拼进 prompt 的历史总字数
const MAX_MESSAGE = 800; // 单条历史最多保留多少字

function ensureDir(): void {
  try {
    fs.mkdirSync(DIR, { recursive: true });
  } catch {
    // 日志目录都建不出来时，退化为纯内存
  }
}

const cache = new Map<string, Thread>();

function fileOf(id: string): string {
  return path.join(DIR, `${id}.json`);
}

export function listThreads(): Thread[] {
  ensureDir();
  const out: Thread[] = [];
  try {
    for (const name of fs.readdirSync(DIR)) {
      if (!name.endsWith(".json")) continue;
      const t = readThread(name.slice(0, -5));
      if (t) out.push(t);
    }
  } catch {
    // ignore
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readThread(id: string): Thread | null {
  const hit = cache.get(id);
  if (hit) return hit;
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(id), "utf8")) as Thread;
    if (!raw?.id) return null;
    cache.set(raw.id, raw);
    return raw;
  } catch {
    return null;
  }
}

export function saveThread(t: Thread): void {
  cache.set(t.id, t);
  ensureDir();
  try {
    fs.writeFileSync(fileOf(t.id), JSON.stringify(t, null, 2), "utf8");
  } catch {
    // ignore
  }
}

export function newThread(first: string): Thread {
  const now = Date.now();
  const t: Thread = {
    id: `T-${now.toString(36)}`,
    title: first.replace(/\s+/g, " ").slice(0, 40) || "未命名对话",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  saveThread(t);
  return t;
}

export function appendMessage(t: Thread, m: Message): Thread {
  t.messages.push(m);
  t.updatedAt = m.at;
  saveThread(t);
  return t;
}

function clip(s: string, n: number): string {
  const text = s.replace(/\s+/g, " ").trim();
  return text.length > n ? `${text.slice(0, n)}…` : text;
}

/**
 * 把历史压成一段前言。历史从新往旧取，凑满上限为止，再翻回正序。
 * 只取“用户说了什么 / 我上次回答了什么”，不塞工具输出，避免把 prompt 撑爆。
 */
export function buildPrompt(t: Thread, task: string, cwd: string): string {
  const picked: Message[] = [];
  let used = 0;
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i];
    const piece = clip(m.text, MAX_MESSAGE);
    if (used + piece.length > MAX_HISTORY) break;
    used += piece.length;
    picked.unshift(m);
  }

  const history = picked.length
    ? picked.map((m) => `${m.role === "user" ? "用户" : "你上次回答"}：${clip(m.text, MAX_MESSAGE)}`).join("\n")
    : "（这是第一轮，没有历史）";

  return [
    `你是 Foreman 派出去执行任务的 agent，当前工作目录：${cwd}。`,
    "下面是我们之前的对话，只作为背景，不要复述、不要评价：",
    history,
    "",
    "现在的新任务：",
    task,
  ].join("\n");
}
