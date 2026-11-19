/**
 * Foreman 本地服务
 *
 * v0.1 只做一件事：把 Codex 和 DSH 的真实活动流，实时推到一个网页上。
 * 零依赖，只用 Node 内置模块；`node src/server.ts` 直接跑。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexAvailable, recentEvents as codexEvents, recentTurns } from "./adapters/codex.ts";
import { dshAvailable, listSessions, recentEvents as dshEvents } from "./adapters/dsh.ts";
import { LOG_ROOT, logEvents, logServer, logTask } from "./logs.ts";
import type { AgentEvent } from "./adapters/codex.ts";
import { diffSnapshots, snapshotFiles } from "./artifacts.ts";
import { usageForSessionWithRetry } from "./adapters/dsh.ts";
import { DEFAULT_WORK_DIR, envStatus, listRuns, pruneRuns, startRun, stopRun } from "./runner.ts";
import type { RunUsage } from "./runner.ts";
import type { Run, RunAgent, RunEvent } from "./runner.ts";
import { appendMessage, buildPrompt, buildRoomPrompt, listThreads, newThread, readThread } from "./threads.ts";
import type { Thread } from "./threads.ts";
import {
  getOrch,
  listOrch,
  newOrch,
  parsePlan,
  parseVerification,
  planPrompt,
  saveOrch,
  verifyPrompt,
} from "./orchestrator.ts";
import type { Orchestration } from "./orchestrator.ts";

const PORT = Number(process.env.PORT ?? 4319);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, "web");
const POLL_MS = 2000;
const KEEP = 120;

type Status = {
  agents: Array<{
    id: "codex" | "dsh";
    name: string;
    available: boolean;
    state: string;
    detail: string;
    count: number;
  }>;
  total: number;
  updatedAt: number;
};

const seen = new Set<string>();
const buffer: AgentEvent[] = [];
const clients = new Set<http.ServerResponse>();
const counts = { codex: 0, dsh: 0 };

function keyOf(e: AgentEvent): string {
  return `${e.agent}|${e.ts}|${e.kind}|${e.text.slice(0, 80)}`;
}

function collect(): AgentEvent[] {
  const out: AgentEvent[] = [];
  // 读别人的数据库/日志随时可能失败（库被独占、文件写一半），一次失败不该带崩整个服务
  try {
    if (codexAvailable()) out.push(...codexEvents(40));
  } catch {
    // 下一轮再试
  }
  try {
    if (dshAvailable()) out.push(...dshEvents(40));
  } catch {
    // 下一轮再试
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function buildStatus(): Status {
  const turns = codexAvailable() ? recentTurns(3) : [];
  const last = turns[0];
  const sessions = dshAvailable() ? listSessions() : [];
  const dshSession = sessions[0];

  const codexState = !last
    ? "空闲"
    : last.status === "completed"
      ? "空闲"
      : `${last.status}`;
  const codexDetail = last
    ? `${last.status} · ${last.durationMs ? `${(last.durationMs / 1000).toFixed(1)}s` : "进行中"}`
    : "还没有记录";

  return {
    agents: [
      {
        id: "codex",
        name: "Codex",
        available: codexAvailable(),
        state: codexState,
        detail: codexDetail,
        count: counts.codex,
      },
      {
        id: "dsh",
        name: "DSH",
        available: dshAvailable(),
        state: dshSession ? "观察中" : "空闲",
        detail: dshSession
          ? `${path.basename(dshSession.cwd) || "会话"} · ${ago(dshSession.updatedAt)}`
          : "还没有记录",
        count: counts.dsh,
      },
    ],
    total: counts.codex + counts.dsh,
    updatedAt: Date.now(),
  };
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  return `${Math.round(s / 3600)} 小时前`;
}

function snapshot(): {
  events: AgentEvent[];
  status: Status;
  runs: RunSummary[];
  env: { file: string; hasKey: boolean };
} {
  const env = envStatus();
  return {
    events: buffer.slice(-KEEP),
    status: buildStatus(),
    runs: listRuns().slice(0, 6).map(toSummary),
    env: { file: env.file, hasKey: env.keys.includes("DEEPSEEK_API_KEY") },
  };
}

type RunSummary = {
  id: string;
  agent: RunAgent;
  prompt: string;
  state: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
};

function toSummary(r: Run): RunSummary {
  return {
    id: r.id,
    agent: r.agent,
    prompt: r.label ?? r.prompt,
    state: r.state,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    exitCode: r.exitCode,
  };
}

function broadcast(payload: unknown): void {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

let lastStatus = "";

/** run -> 对话线程；用于把输出收进对应的对话 */
const runThread = new Map<string, string>();
const runText = new Map<string, string[]>();
/** 每个任务攒下来的思考过程，结束时一并写进对话 */
const runThink = new Map<string, string[]>();

function threadOf(id: string): Thread | null {
  return readThread(id);
}

/** 把“派活”产生的事件并进同一条活动流：落日志、推页面、更新计数 */
function emitRunEvent(run: Run, e: RunEvent): void {
  const ev: AgentEvent = { agent: run.agent, ts: e.ts, kind: e.kind, text: e.text };
  buffer.push(ev);
  if (buffer.length > KEEP * 2) buffer.splice(0, buffer.length - KEEP);
  counts[run.agent] += 1;
  logEvents([ev]);
  broadcast({ type: "events", events: [ev] });
  lastStatus = ""; // 状态可能变了，下一轮强制推一次

  // 任务列表随进度推给页面，右侧「任务」面板在对话模式下也能刷新
  if (e.kind === "run/start" || e.kind === "run/exit") {
    broadcast({ type: "runs", runs: listRuns().slice(0, 6).map(toSummary) });
  }

  const threadId = runThread.get(run.id);
  if (threadId && e.kind === "run/think") {
    const bag = runThink.get(run.id) ?? [];
    bag.push(e.text);
    runThink.set(run.id, bag);
    broadcast({ type: "chat-think", threadId, runId: run.id, agent: run.agent, text: e.text });
  }

  if (threadId && (e.kind === "run/text" || e.kind === "run/err" || e.kind === "run/final")) {
    const line =
      e.kind === "run/err" ? `⚠ ${e.text}` : e.kind === "run/final" ? `⚠ ${e.text}` : e.text;
    const bag = runText.get(run.id) ?? [];
    bag.push(line);
    runText.set(run.id, bag);
    broadcast({ type: "chat-delta", threadId, runId: run.id, agent: run.agent, text: line });
  }

  if (e.kind === "run/exit") {
    pruneRuns(30);
    const t = threadId ? threadOf(threadId) : null;
    if (t) {
      // 记住这个 agent 的会话 id，下一轮直接续会话，而不是靠复述历史
      if (run.sessionId) {
        t.sessions = { ...(t.sessions ?? {}), [run.agent]: run.sessionId };
      }
      const text = (runText.get(run.id) ?? []).join("\n").trim();
      const thinking = (runThink.get(run.id) ?? []).join("\n\n").trim();
      appendMessage(t, {
        role: "assistant",
        text: text || `（没有输出，退出码 ${run.exitCode ?? "?"}）`,
        thinking: thinking || undefined,
        at: Date.now(),
        runId: run.id,
        agent: run.agent,
      });
      broadcast({ type: "thread", thread: t });

      // 圆桌：对方被 @ 到了就让它接着说，最多自动传两轮
      if (t.mode === "room") {
        const other: RunAgent = run.agent === "codex" ? "dsh" : "codex";
        const hops = roomHops.get(t.id) ?? 0;
        if (hops < ROOM_MAX_HOPS && new RegExp(`@${other}\\b`, "i").test(text)) {
          roomHops.set(t.id, hops + 1);
          startRoomTurn(t, [other]);
        }
      }
    }
    runText.delete(run.id);
    runThink.delete(run.id);
    runThread.delete(run.id);
    logTask({
      id: run.id,
      agent: run.agent,
      prompt: run.prompt,
      cwd: run.cwd,
      threadId: threadId ?? null,
      state: run.state,
      exitCode: run.exitCode,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      events: run.events.length,
    });
  }
}

type TaskBody = {
  agent?: string;
  prompt?: string;
  threadId?: string;
  task?: string;
  id?: string;
  i?: number;
};

/** 同一个 agent 同一时间只能跑一个任务；后来的排队等前面结束，而不是直接失败 */
const agentLocks = new Map<string, Promise<void>>();
const agentWaiting = new Map<string, number>();

async function withAgentLock<T>(agent: string, onQueued: (pos: number) => void, fn: () => Promise<T>): Promise<T> {
  const ahead = agentWaiting.get(agent) ?? 0;
  agentWaiting.set(agent, ahead + 1);
  const prev = agentLocks.get(agent) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  agentLocks.set(
    agent,
    prev.then(() => mine),
  );
  if (ahead > 0) onQueued(ahead);
  await prev.catch(() => {});
  agentWaiting.set(agent, Math.max(0, (agentWaiting.get(agent) ?? 1) - 1));
  try {
    return await fn();
  } finally {
    release();
  }
}

/** 跑一个任务并等它结束；超时就杀掉，避免 agent 自己绕进“再核对一遍”的死循环 */
function runToEnd(
  opts: {
    agent: RunAgent;
    prompt: string;
    label: string;
    cwd?: string;
    timeoutMs?: number;
    onStart?: (runId: string) => void;
    onQueued?: (pos: number) => void;
  },
): Promise<{
  text: string;
  thinking: string;
  exitCode: number | null;
  runId: string;
  timedOut: boolean;
  sessionId?: string;
  usage?: RunUsage;
}> {
  const { onStart, onQueued, ...call } = opts;
  return withAgentLock(opts.agent, onQueued ?? (() => {}), () => startAndWait(call, onStart));
}

function startAndWait(
  opts: { agent: RunAgent; prompt: string; label: string; cwd?: string; timeoutMs?: number },
  onStart?: (runId: string) => void,
): Promise<{
  text: string;
  thinking: string;
  exitCode: number | null;
  runId: string;
  timedOut: boolean;
  sessionId?: string;
  usage?: RunUsage;
}> {
  return new Promise((resolve) => {
    let text = "";
    let think = "";
    let sessionId = "";
    let usage: RunUsage | undefined;
    let finished = false;
    let runId = "";
    const finish = (code: number | null, timedOut: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ text: text.trim(), thinking: think.trim(), exitCode: code, runId, timedOut, sessionId, usage });
    };
    const timer = setTimeout(() => {
      if (runId) stopRun(runId);
      finish(null, true);
    }, opts.timeoutMs ?? 150_000);

    const run = startRun({
      agent: opts.agent,
      prompt: opts.prompt,
      label: opts.label,
      cwd: opts.cwd ?? DEFAULT_WORK_DIR,
      onEvent: (r, e) => {
        runId = r.id;
        emitRunEvent(r, e);
        if (e.kind === "run/text") text += (text ? "\n" : "") + e.text;
        if (e.kind === "run/think") think += (think ? "\n\n" : "") + e.text;
        if (e.kind === "run/session" && r.sessionId) sessionId = r.sessionId;
        if (e.kind === "run/err") text += `\n⚠ ${e.text}`;
        if (e.kind === "run/exit") {
          usage = r.usage;
          finish(r.exitCode, false);
        }
      },
    });
    runId = run.id;
    onStart?.(run.id);
  });
}

/** 圆桌里已经自动接过几次话，防止两个模型互相客气个没完 */
const roomHops = new Map<string, number>();
const ROOM_MAX_HOPS = 2;
/** 群里单次发言的上限：relay 服务过载时会一直重试，不给上限就会永远挂着 */
const ROOM_TIMEOUT_MS = Number(process.env.FOREMAN_ROOM_TIMEOUT ?? 120_000);

/** 让一组 agent 对着同一条聊天记录各说一句（并行，谁先想好谁先说） */
function startRoomTurn(t: Thread, agents: RunAgent[]): Run[] {
  const last = t.messages[t.messages.length - 1];
  const label = last ? last.text.replace(/\s+/g, " ").slice(0, 60) : "圆桌发言";
  return agents.map((agent) => {
    const run = startRun({
      agent,
      prompt: buildRoomPrompt(t, agent as "dsh" | "codex", DEFAULT_WORK_DIR),
      label,
      onEvent: emitRunEvent,
    });
    runThread.set(run.id, t.id);
    // 超时就掐掉，避免一条卡住的发言把整场对话拖死
    setTimeout(() => {
      if (run.state === "running") stopRun(run.id);
    }, ROOM_TIMEOUT_MS).unref?.();
    return run;
  });
}

/** 从一句话里找出被点名的人；没点名就是大家都说。
 *  引号里的内容（比如让 codex 复述一句带 @ 的话）不算点名。 */
function parseMentions(text: string): RunAgent[] {
  const clean = text.replace(/「[^」]*」|“[^”]*”|"[^"]*"|『[^』]*』/g, " ");
  const out: RunAgent[] = [];
  if (/@codex\b/i.test(clean)) out.push("codex");
  if (/@dsh\b/i.test(clean)) out.push("dsh");
  return out;
}

function pushOrch(o: Orchestration): void {
  saveOrch(o);
  broadcast({ type: "orch", orch: o });
}

/** 把一次运行的用量累加进任务链（没有 usage 也累加耗时） */
function addUsage(o: Orchestration, usage: RunUsage | undefined, ms: number): void {
  const base = o.usage ?? { input: 0, output: 0, cached: 0, total: 0, ms: 0 };
  o.usage = {
    input: base.input + (usage?.input ?? 0),
    output: base.output + (usage?.output ?? 0),
    cached: base.cached + (usage?.cached ?? 0),
    total: base.total + (usage?.total ?? 0),
    ms: base.ms + Math.max(0, ms),
  };
}

/** 当前正在跑的步骤，停的时候要知道杀哪个进程 */
const liveStep = new Map<string, string>();
/** 用户点过“停”的任务链 */
const stopFlag = new Set<string>();

/** 跑完链之后验收：不过就带着问题自动返工一次 */
async function verifyOrch(o: Orchestration): Promise<void> {
  o.state = "verifying";
  pushOrch(o);

  // 演练开关：只让第一次验收失败，用来验证返工分支（不调用模型，省钱省时）
  const stub = process.env.FOREMAN_VERIFY_STUB;
  if (stub === "fail-once" && !o.retried) {
    const problem = "演练：产出与要求不一致，需要重做";
    o.verify = { pass: false, summary: problem, issues: [{ step: 1, problem }], at: Date.now() };
  } else {
    const r = await runToEnd({
      agent: "dsh",
      prompt: verifyPrompt(o),
      label: "验收",
      timeoutMs: 120_000,
      onStart: (id) => liveStep.set(o.id, id),
    });
    liveStep.delete(o.id);
    if (!r.usage && r.sessionId) {
      r.usage = (await usageForSessionWithRetry(r.sessionId)) ?? undefined;
    }
    addUsage(o, r.usage, 0);
    if (stopFlag.has(o.id)) {
      o.state = "stopped";
      o.note = "已手动停止";
      pushOrch(o);
      return;
    }
    o.verify = parseVerification(r.text);
  }
  pushOrch(o);

  if (o.verify.pass || o.retried || !o.verify.issues.length) {
    o.state = "done";
    pushOrch(o);
    return;
  }

  o.retried = true;
  const first = o.verify.issues[0].step;
  const idx = Math.max(0, Math.min(o.steps.length - 1, first - 1));
  o.steps[idx].fixNote = o.verify.issues
    .map((x) => `第 ${x.step} 步：${x.problem}`)
    .join("；");
  for (let k = idx; k < o.steps.length; k++) {
    o.steps[k].state = "pending";
    o.steps[k].output = undefined;
  }
  pushOrch(o);
  await runFrom(o, idx);
}

/** 从第 from 步开始往后跑；每一步的产出接给下一步 */
async function runFrom(o: Orchestration, from: number): Promise<void> {
  // 开跑前拍一张工作目录的快照，跑完每一步再对比，算出这条链动了哪些文件
  const before = snapshotFiles(DEFAULT_WORK_DIR);
  const refreshArtifacts = () => {
    // 返工重跑时接着上一轮的结果合并，不要丢掉先前的改动
    const merged = new Map((o.artifacts ?? []).map((a) => [a.path, a] as const));
    for (const c of diffSnapshots(before, snapshotFiles(DEFAULT_WORK_DIR))) merged.set(c.path, c);
    o.artifacts = [...merged.values()];
  };

  try {
    o.state = "running";
    o.note = undefined;
    pushOrch(o);

    let carry = "";
    for (let k = 0; k < from; k++) {
      const prev = o.steps[k];
      if (prev.output) carry += `\n— ${prev.title} —\n${prev.output}`;
    }
    carry = carry.slice(-3000);

    for (let k = from; k < o.steps.length; k++) {
      const step = o.steps[k];
      if (stopFlag.has(o.id)) {
        step.state = "stopped";
        o.state = "stopped";
        o.note = "已手动停止";
        pushOrch(o);
        return;
      }

      step.state = "running";
      step.startedAt = undefined;
      step.queuePos = undefined;
      step.output = undefined;
      step.runId = undefined;
      step.endedAt = undefined;
      pushOrch(o);

      const base = step.fixNote
        ? `${step.prompt}\n\n【上次验收没通过，必须修正】${step.fixNote}`
        : step.prompt;
      const prompt = carry
        ? `${base}\n\n【前一棒交过来的产出，只取其中的最终正文，不要原样抄写过程性说明】\n${carry}`
        : base;
      const r = await runToEnd({
        agent: step.agent,
        prompt,
        label: `${step.title}`,
        onQueued: (pos) => {
          step.state = "queued";
          step.queuePos = pos;
          pushOrch(o);
        },
        onStart: (id) => {
          step.state = "running";
          step.startedAt = Date.now();
          step.queuePos = undefined;
          liveStep.set(o.id, id);
          pushOrch(o);
        },
      });
      liveStep.delete(o.id);

      // DSH 的 token 用量不在 stdout 里，跑完回读会话日志（刚退出时可能还没写完，轮询一下）
      if (!r.usage && r.sessionId) {
        r.usage = (await usageForSessionWithRetry(r.sessionId)) ?? undefined;
      }

      step.runId = r.runId;
      step.exitCode = r.exitCode;
      step.output = r.text;
      step.thinking = r.thinking || undefined;
      step.usage = r.usage ? { input: r.usage.input, output: r.usage.output, total: r.usage.total } : undefined;
      step.endedAt = Date.now();
      addUsage(o, r.usage, step.endedAt - (step.startedAt ?? step.endedAt));

      if (stopFlag.has(o.id)) {
        step.state = "stopped";
        o.state = "stopped";
        o.note = "已手动停止";
        pushOrch(o);
        return;
      }

      // 超时被杀也接受：已经写出的产出算这一步的结果
      step.state = r.exitCode === 0 || (r.timedOut && r.text) ? "done" : "failed";
      carry = `${carry}\n— ${step.title} —\n${r.text}`.slice(-3000);
      refreshArtifacts();
      pushOrch(o);

      if (step.state === "failed") {
        o.state = "failed";
        o.note = r.timedOut ? `第 ${step.i + 1} 步超时，已停止` : `第 ${step.i + 1} 步失败，已停止`;
        pushOrch(o);
        return;
      }
    }

    o.state = "done";
    pushOrch(o);
    await verifyOrch(o);
  } catch (err) {
    o.state = "failed";
    o.note = err instanceof Error ? err.message : String(err);
    pushOrch(o);
  } finally {
    stopFlag.delete(o.id);
    liveStep.delete(o.id);
  }
}

/** 拆解 → 从第一步开始跑 */
async function runOrchestration(o: Orchestration): Promise<void> {
  try {
    const plan = await runToEnd({
      agent: "dsh",
      prompt: planPrompt(o.task),
      label: "拆解任务",
      onStart: (id) => liveStep.set(o.id, id),
    });
    liveStep.delete(o.id);
    o.steps = parsePlan(plan.text, o.task);
    await runFrom(o, 0);
  } catch (err) {
    o.state = "failed";
    o.note = err instanceof Error ? err.message : String(err);
    pushOrch(o);
  }
}

function readJson(req: http.IncomingMessage, limit = 32_000): Promise<TaskBody> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > limit) {
        reject(new Error("请求体太大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? (JSON.parse(raw) as TaskBody) : {});
      } catch {
        reject(new Error("不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function tick(): void {
  const fresh: AgentEvent[] = [];
  for (const e of collect()) {
    const k = keyOf(e);
    if (seen.has(k)) continue;
    seen.add(k);
    fresh.push(e);
    counts[e.agent] += 1;
  }
  if (seen.size > 4000) seen.clear();

  if (fresh.length) {
    buffer.push(...fresh);
    if (buffer.length > KEEP * 2) buffer.splice(0, buffer.length - KEEP);
    logEvents(fresh);
    broadcast({ type: "events", events: fresh });
  }

  const status = buildStatus();
  const sig = JSON.stringify(status.agents);
  if (sig !== lastStatus) {
    lastStatus = sig;
    broadcast({ type: "status", status });
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "POST" && url.pathname === "/api/chat") {
    readJson(req)
      .then((body) => {
        const text = (body.prompt ?? "").trim();
        const agent = body.agent === "codex" ? "codex" : "dsh";
        const threadId = typeof body.threadId === "string" ? body.threadId : "";
        if (!text) throw new Error("说点什么再发");

        const existing = threadId ? readThread(threadId) : null;
        const t = existing ?? newThread(text);
        // 有会话 id 就直接续会话（真多轮）；没有才用“复述历史”兜底
        const sid = t.sessions?.[agent];
        const prompt = sid ? text : buildPrompt(t, text, DEFAULT_WORK_DIR);
        appendMessage(t, { role: "user", text, at: Date.now() });

        const run = startRun({
          agent,
          prompt,
          label: text,
          sessionId: sid,
          onEvent: emitRunEvent,
        });
        runThread.set(run.id, t.id);
        broadcast({ type: "thread", thread: t });

        res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, threadId: t.id, run: toSummary(run) }));
      })
      .catch((err: Error) => {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/room") {
    readJson(req)
      .then((body) => {
        const text = (body.prompt ?? "").trim();
        const threadId = typeof body.threadId === "string" ? body.threadId : "";
        if (!text) throw new Error("说点什么再发");
        if (text.length > 4000) throw new Error("太长了（上限 4000 字）");

        const existing = threadId ? readThread(threadId) : null;
        const t = existing ?? newThread(text);
        t.mode = "room";
        appendMessage(t, { role: "user", text, at: Date.now() });
        roomHops.set(t.id, 0);

        const asked = parseMentions(text);
        const targets: RunAgent[] = asked.length ? asked : ["codex", "dsh"];
        const runs = startRoomTurn(t, targets);
        broadcast({ type: "thread", thread: t });

        res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, threadId: t.id, targets, runs: runs.map(toSummary) }));
      })
      .catch((err: Error) => {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (url.pathname === "/api/threads") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify(
        listThreads().map((t) => ({
          id: t.id,
          title: t.title,
          mode: t.mode ?? "dm",
          updatedAt: t.updatedAt,
          messages: t.messages.length,
        })),
      ),
    );
    return;
  }

  if (url.pathname === "/api/thread") {
    const id = url.searchParams.get("id") ?? "";
    const t = readThread(id);
    res.writeHead(t ? 200 : 404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(t ?? { error: "没有这个对话" }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/task") {
    readJson(req)
      .then((body) => {
        const agent = body.agent === "codex" ? "codex" : body.agent === "dsh" ? "dsh" : null;
        const prompt = (body.prompt ?? "").trim();
        if (!agent) throw new Error("agent 只能是 codex 或 dsh");
        if (!prompt) throw new Error("任务不能为空");
        if (prompt.length > 4000) throw new Error("任务太长（上限 4000 字）");

        const run = startRun({ agent, prompt, onEvent: emitRunEvent });
        logTask({
          id: run.id,
          agent: run.agent,
          prompt: run.prompt,
          cwd: run.cwd,
          state: "running",
          startedAt: run.startedAt,
        });
        res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, run: toSummary(run) }));
      })
      .catch((err: Error) => {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/orch/stop") {
    readJson(req)
      .then((body) => {
        const o = getOrch(body.id ?? "");
        if (!o) throw new Error("没有这个任务链");
        if (o.state !== "running" && o.state !== "planning" && o.state !== "verifying") {
          throw new Error("这条任务链没在跑");
        }
        stopFlag.add(o.id);
        const runId = liveStep.get(o.id);
        if (runId) stopRun(runId);
        res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, stopping: Boolean(runId) }));
      })
      .catch((err: Error) => {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/orch/retry") {
    readJson(req)
      .then((body) => {
        const o = getOrch(body.id ?? "");
        if (!o) throw new Error("没有这个任务链");
        if (o.state === "running") throw new Error("先停掉当前执行");
        const i = Number(body.i ?? 0);
        if (!Number.isInteger(i) || i < 0 || i >= o.steps.length) throw new Error("步号不对");
        for (let k = i; k < o.steps.length; k++) {
          o.steps[k].state = "pending";
          o.steps[k].output = undefined;
          o.steps[k].exitCode = undefined;
        }
        res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
        void runFrom(o, i);
      })
      .catch((err: Error) => {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/orchestrate") {
    readJson(req)
      .then((body) => {
        const task = (body.task ?? body.prompt ?? "").trim();
        if (!task) throw new Error("任务不能为空");
        if (task.length > 2000) throw new Error("任务太长（上限 2000 字）");
        const orch = newOrch(task);
        res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, orch }));
        void runOrchestration(orch);
      })
      .catch((err: Error) => {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (url.pathname === "/api/orchs") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify(
        listOrch()
          .slice(0, 12)
          .map((o) => ({
            id: o.id,
            task: o.task,
            state: o.state,
            createdAt: o.createdAt,
            steps: o.steps.length,
          })),
      ),
    );
    return;
  }

  if (url.pathname === "/api/orch") {
    const id = url.searchParams.get("id") ?? "";
    const o = getOrch(id);
    res.writeHead(o ? 200 : 404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(o ?? { error: "没有这个任务链" }));
    return;
  }

  if (url.pathname === "/api/state") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(snapshot()));
    return;
  }

  if (url.pathname === "/api/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    res.write(`data: ${JSON.stringify({ type: "init", ...snapshot() })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(WEB, path.normalize(rel).replace(/^([.][.][\\/])+/, ""));
  if (!file.startsWith(WEB)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  });
});

// 先灌一次历史，再开始轮询
for (const e of collect()) {
  const k = keyOf(e);
  if (seen.has(k)) continue;
  seen.add(k);
  buffer.push(e);
  counts[e.agent] += 1;
}

setInterval(tick, POLL_MS).unref();

// 上次退出时还在跑的任务链，重启后一律标成已停止（进程已经没了，不能装作还在跑）
for (const o of listOrch()) {
  if (o.state !== "planning" && o.state !== "running" && o.state !== "verifying") continue;
  o.state = "stopped";
  o.note = "服务重启，已中断";
  for (const s of o.steps) if (s.state === "running") s.state = "stopped";
  saveOrch(o);
}

server.listen(PORT, "127.0.0.1", () => {
  logServer("start", { port: PORT, codex: codexAvailable(), dsh: dshAvailable() });
  console.log(`foreman  listening  http://127.0.0.1:${PORT}`);
  console.log(`logs     ${LOG_ROOT}`);
  console.log(
    `codex=${codexAvailable() ? "ok" : "missing"}  dsh=${dshAvailable() ? "ok" : "missing"}  events=${buffer.length}`,
  );
});
