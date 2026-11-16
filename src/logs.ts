/**
 * 任务日志落盘
 *
 * 所有 agent 活动都会追加到 `E:\foreman\logs\events-YYYY-MM-DD.jsonl`，
 * 一天一个文件，一行一条 JSON，方便后面做回放、审计、统计。
 * 目录不存在就建；E 盘不可用时退回仓库内的 ./logs，保证服务不会因为日志写不进去而挂掉。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "./adapters/codex.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFERRED = process.env.FOREMAN_LOGS ?? "E:\\foreman\\logs";
const FALLBACK = path.join(HERE, "..", "logs");

function pickRoot(): string {
  for (const root of [PREFERRED, FALLBACK]) {
    try {
      fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
      fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
      fs.mkdirSync(path.join(root, "archive"), { recursive: true });
      return root;
    } catch {
      // 换下一个候选目录
    }
  }
  return FALLBACK;
}

export const LOG_ROOT = pickRoot();

function day(ts = Date.now()): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function appendLine(file: string, line: string): void {
  try {
    fs.appendFileSync(file, line + "\n", "utf8");
  } catch {
    // 日志失败不影响主流程
  }
}

/** 追加一条或多条 agent 活动（按事件时间分文件） */
export function logEvents(events: AgentEvent[]): void {
  if (!events.length) return;
  const now = Date.now();
  for (const e of events) {
    const file = path.join(LOG_ROOT, `events-${day(e.ts || now)}.jsonl`);
    appendLine(file, JSON.stringify({ ...e, loggedAt: now }));
  }
}

/** 服务自己的启动/停止标记，方便对照时间轴 */
export function logServer(event: string, detail: Record<string, unknown> = {}): void {
  const file = path.join(LOG_ROOT, `server-${day()}.jsonl`);
  appendLine(file, JSON.stringify({ event, at: Date.now(), pid: process.pid, ...detail }));
}

/** 任务记录：一个任务一个文件，便于人工查看 */
export function logTask(task: Record<string, unknown>): void {
  const id = String(task.id ?? `task-${Date.now()}`);
  const file = path.join(LOG_ROOT, "tasks", `${id}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(task, null, 2), "utf8");
  } catch {
    // ignore
  }
}
