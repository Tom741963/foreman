/**
 * Codex 观察适配器（只读）
 *
 * Codex 桌面版把每一次 turn 和每个 item（思考/命令/改文件/回复/MCP 调用）
 * 都落在 `~/.codex/thread_history_1.sqlite` 里，所以我们不需要 hook、不需要 CLI，
 * 打开数据库就能看到它在干什么。
 */
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { oneLine, stripShellWrapper } from "./text.ts";

export type AgentEvent = {
  agent: "codex" | "dsh";
  ts: number;
  kind: string;
  text: string;
};

export type AgentTurn = {
  threadId: string;
  turnId: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
};

const DB_PATH = path.join(os.homedir(), ".codex", "thread_history_1.sqlite");

export function codexAvailable(): boolean {
  return fs.existsSync(DB_PATH);
}

function open(): DatabaseSync {
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

/** 最近的 turn：谁在跑、跑了多久、完成没有 */
export function recentTurns(limit = 10): AgentTurn[] {
  if (!codexAvailable()) return [];
  const db = open();
  try {
    const rows = db
      .prepare(
        `select thread_id, turn_id, status, started_at, completed_at, duration_ms
           from thread_turns
          order by coalesce(started_at, 0) desc
          limit ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      threadId: String(r.thread_id),
      turnId: String(r.turn_id),
      status: String(r.status),
      startedAt: Number(r.started_at ?? 0) * 1000,
      endedAt: r.completed_at ? Number(r.completed_at) * 1000 : null,
      durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    }));
  } finally {
    db.close();
  }
}

type ItemRow = { item_type: string; created_at_ms: number; item_json: string };

function summarize(itemType: string, raw: string): string {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return oneLine(raw, 160);
  }
  const pick = (k: string): string =>
    typeof payload[k] === "string" ? (payload[k] as string) : "";

  // 命令：剥掉 pwsh 外壳，只留真正跑的东西
  if (itemType === "commandExecution") {
    return stripShellWrapper(pick("command")) || "(命令)";
  }
  // 思考：摘要常常是空的，别显示一串空对象
  if (itemType === "reasoning") {
    const summary = payload["summary"];
    if (Array.isArray(summary) && summary.length) return oneLine(String(summary[0]), 160);
    return "思考中";
  }

  // 不同类型的字段不一样，按优先级尽量取出人能看懂的一句
  const text = pick("text") || pick("output") || pick("path") || pick("name") || "";
  const cleaned = oneLine(text, 200);
  if (cleaned) return cleaned;

  const changes = payload["changes"];
  if (Array.isArray(changes) && changes.length) {
    return changes
      .map((c) => (typeof c === "object" && c ? String((c as Record<string, unknown>)["path"] ?? "") : ""))
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");
  }
  return `[${String(payload["type"] ?? "item")}]`;
}

/** 最近的活动流，跨 thread 合并，按时间倒序 */
export function recentEvents(limit = 40): AgentEvent[] {
  if (!codexAvailable()) return [];
  const db = open();
  try {
    const rows = db
      .prepare(
        `select item_type, created_at_ms, item_json
           from thread_items
          order by created_at_ms desc
          limit ?`,
      )
      .all(limit) as ItemRow[];
    return rows.map((r) => ({
      agent: "codex" as const,
      ts: Number(r.created_at_ms),
      kind: r.item_type,
      text: summarize(r.item_type, r.item_json),
    }));
  } finally {
    db.close();
  }
}

/** 某个 turn 的完整活动（用于任务详情页） */
export function turnEvents(threadId: string, turnId: string): AgentEvent[] {
  if (!codexAvailable()) return [];
  const db = open();
  try {
    const rows = db
      .prepare(
        `select item_type, created_at_ms, item_json
           from thread_items
          where thread_id = ? and turn_id = ?
          order by created_at_ms asc`,
      )
      .all(threadId, turnId) as ItemRow[];
    return rows.map((r) => ({
      agent: "codex" as const,
      ts: Number(r.created_at_ms),
      kind: r.item_type,
      text: summarize(r.item_type, r.item_json),
    }));
  } finally {
    db.close();
  }
}
