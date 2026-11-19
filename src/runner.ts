/**
 * 派活通道：把一个任务交给真实的 CLI agent 跑，边跑边把输出变成事件
 *
 * 现在支持：
 *   dsh   → `dsh headless "<task>"`（DSH 自己的无头入口）
 *   codex → `codex exec "<task>"`（装了 @openai/codex 才有）
 *
 * 一律 spawn + 参数数组，不经过 shell，任务文本里的引号、中文、换行都不会被二次解释。
 */
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type RunAgent = "dsh" | "codex";
export type RunState = "running" | "done" | "failed";

export type RunEvent = {
  ts: number;
  kind:
    | "run/start"
    | "run/out"
    | "run/err"
    | "run/exit"
    | "run/session"
    | "run/think"
    | "run/text"
    | "run/final";
  text: string;
};

export type RunUsage = { input: number; output: number; cached: number; total: number };

export type Run = {
  id: string;
  agent: RunAgent;
  prompt: string;
  cwd: string;
  startedAt: number;
  endedAt: number | null;
  state: RunState;
  exitCode: number | null;
  label?: string;
  sessionId?: string;
  usage?: RunUsage;
  events: RunEvent[];
};

const DSH_EXE = process.env.FOREMAN_DSH_EXE ?? "E:\\dsh\\DeepSeek Harness.exe";
const DSH_CLI =
  process.env.FOREMAN_DSH_CLI ??
  "E:\\dsh\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js";

/** Codex 桌面版自带一个 codex CLI，版本目录每次更新都会变，所以按目录扫最新的一个 */
function resolveCodexExe(): string {
  if (process.env.FOREMAN_CODEX_EXE) return process.env.FOREMAN_CODEX_EXE;
  const root = path.join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin");
  try {
    const dirs = fs.readdirSync(root).sort();
    for (const d of dirs.reverse()) {
      const exe = path.join(root, d, "codex.exe");
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    // 没装桌面版就退回 PATH 里的 codex
  }
  return "codex";
}

const CODEX_EXE = resolveCodexExe();
const ENV_FILE = path.join(os.homedir(), ".foreman", "env.json");
// 默认在项目目录里干活：这样网页上派的活能直接改 Foreman 自己
const WORK_DIR =
  process.env.FOREMAN_CWD ??
  (fs.existsSync("D:\\foreman") ? "D:\\foreman" : path.join(os.homedir(), "foreman-work"));
export const DEFAULT_WORK_DIR = WORK_DIR;

/**
 * 本机私密配置：`~/.foreman/env.json`
 * 形如 `{"DEEPSEEK_API_KEY": "sk-..."}`，只在启动子进程时注入，
 * 不写日志、不进仓库，也不出现在网页里。
 */
function localEnv(): Record<string, string> {
  try {
    const text = fs.readFileSync(ENV_FILE, "utf8").replace(/^\uFEFF/, "");
    const raw = JSON.parse(text) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export function envStatus(): { file: string; keys: string[] } {
  return { file: ENV_FILE, keys: Object.keys(localEnv()) };
}

const runs = new Map<string, Run>();
const children = new Map<string, ChildProcess>();
/** runId -> 往外推事件的那个函数（stopRun 被强杀后要补一条 run/exit） */
const emitters = new Map<string, (kind: RunEvent["kind"], text: string) => void>();
let seq = 0;

export function listRuns(): Run[] {
  return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function getRun(id: string): Run | undefined {
  return runs.get(id);
}

export function runningFor(agent: RunAgent): Run | undefined {
  for (const r of runs.values()) {
    if (r.agent === agent && r.state === "running") return r;
  }
  return undefined;
}

/** 去掉 ANSI 颜色和退格，日志里只留可读文本 */
function clean(line: string): string {
  return line
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .trimEnd();
}

type StartOptions = {
  agent: RunAgent;
  prompt: string;
  label?: string;
  sessionId?: string;
  cwd?: string;
  /** 图片附件（相对工作目录的路径）；只有 codex 能用原生图片输入 */
  images?: string[];
  onEvent: (run: Run, e: RunEvent) => void;
};

export function startRun({ agent, prompt, label, sessionId, cwd, images, onEvent }: StartOptions): Run {
  const busy = runningFor(agent);
  if (busy) throw new Error(`${agent} 正在跑任务（${busy.id}），等它结束再来`);

  const id = `R-${Date.now().toString(36)}-${++seq}`;
  const dir = cwd ?? WORK_DIR;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // 目录建不出来就退回当前目录
  }
  const run: Run = {
    id,
    agent,
    prompt,
    label: label ?? prompt,
    cwd: fs.existsSync(dir) ? dir : process.cwd(),
    startedAt: Date.now(),
    endedAt: null,
    state: "running",
    exitCode: null,
    sessionId,
    events: [],
  };
  runs.set(id, run);

  const push = (kind: RunEvent["kind"], text: string): void => {
    const e: RunEvent = { ts: Date.now(), kind, text };
    run.events.push(e);
    onEvent(run, e);
  };
  emitters.set(id, push);

  const secret = localEnv();
  const spec =
    agent === "dsh"
      ? {
          exe: DSH_EXE,
          args: [
            "--expose-internals",
            DSH_CLI,
            "headless",
            "--json",
            ...(sessionId ? ["--session-id", sessionId] : []),
            prompt,
          ],
          env: { ...process.env, ...secret, ELECTRON_RUN_AS_NODE: "1" },
        }
      : {
          exe: CODEX_EXE,
          args: sessionId
            ? [
                "exec",
                "resume",
                "--json",
                "--skip-git-repo-check",
                sessionId,
                // 注意：--image 是可变参数，必须把提示词放在它前面，否则会被当成图片吞掉
                prompt,
                ...(images ?? []).flatMap((p) => ["--image", p]),
              ]
            : [
                "exec",
                "--json",
                "--skip-git-repo-check",
                "--sandbox",
                "workspace-write",
                prompt,
                ...(images ?? []).flatMap((p) => ["--image", p]),
              ],
          env: { ...process.env, ...secret },
        };

  push("run/start", `${agent} · ${prompt}`);

  let child: ChildProcess;
  try {
    child = spawn(spec.exe, spec.args, {
      cwd: run.cwd,
      env: spec.env,
      windowsHide: true,
      // stdin 必须关掉：codex exec 发现 stdin 是管道会一直等输入
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    run.state = "failed";
    run.endedAt = Date.now();
    push("run/err", `启动失败：${(err as Error).message}`);
    return run;
  }
  children.set(id, child);

  const handleEventLine = (line: string): void => {
    if (!line) return;
    if (!line.startsWith("{")) {
      push("run/out", line);
      return;
    }
    let ev: {
      type?: string;
      text?: string;
      sessionId?: string;
      thread_id?: string;
      message?: string;
      item?: { type?: string; text?: string; command?: string };
      usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
      reason?: { kind?: string; error?: { message?: string } };
    };
    try {
      ev = JSON.parse(line) as typeof ev;
    } catch {
      push("run/out", line);
      return;
    }
    switch (ev.type) {
      // dsh headless --json
      case "session":
        if (ev.sessionId) {
          run.sessionId = ev.sessionId;
          push("run/session", `会话 ${ev.sessionId}`);
        }
        break;
      case "thinking":
        if (ev.text) push("run/think", ev.text);
        break;
      case "text":
        if (ev.text) push("run/text", ev.text);
        break;
      case "status":
        break;
      case "final": {
        const err = ev.reason?.kind === "error" ? (ev.reason.error?.message ?? "未知错误") : "";
        if (err) push("run/final", `失败：${err}`);
        break;
      }
      // codex exec --json
      case "thread.started":
        if (ev.thread_id) {
          run.sessionId = ev.thread_id;
          push("run/session", `会话 ${ev.thread_id}`);
        }
        break;
      case "item.completed": {
        const item = ev.item;
        if (item?.type === "agent_message" && item.text) push("run/text", item.text);
        else if (item?.type === "command_execution" && item.command) push("run/out", `$ ${item.command}`);
        else if (item?.type === "reasoning" && item.text) push("run/think", item.text);
        break;
      }
      case "turn.failed":
        push("run/final", `失败：${ev.message ?? "本轮失败"}`);
        break;
      case "turn.completed":
        if (ev.usage) {
          const input = ev.usage.input_tokens ?? 0;
          const output = ev.usage.output_tokens ?? 0;
          const cached = ev.usage.cached_input_tokens ?? 0;
          run.usage = { input, output, cached, total: input + output + cached };
        }
        break;
      case "error":
        push("run/err", ev.message ?? "未知错误");
        break;
      default:
        if (ev.text) push("run/out", ev.text);
    }
  };

  const pipeJson = (stream: NodeJS.ReadableStream | null): void => {
    if (!stream) return;
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const raw of lines) handleEventLine(clean(raw));
    });
    stream.on("end", () => {
      const line = clean(buf);
      if (line) handleEventLine(line);
    });
  };

  const pipeStderr = (stream: NodeJS.ReadableStream | null): void => {
    if (!stream) return;
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = clean(raw);
        // 模型列表、思考过程之类的诊断噪音不进对话
        if (
          !line ||
          line.startsWith("[llm-") ||
          line.startsWith("dsh: reasoning:") ||
          line.startsWith("Reading additional input")
        )
          continue;
        push("run/err", line);
      }
    });
  };

  pipeJson(child.stdout);
  pipeStderr(child.stderr);

  child.on("error", (err) => {
    run.state = "failed";
    run.endedAt = Date.now();
    push("run/err", `进程错误：${err.message}`);
  });

  child.on("close", (code) => {
    run.exitCode = code;
    run.endedAt = Date.now();
    run.state = code === 0 ? "done" : "failed";
    children.delete(id);
    emitters.delete(id);
    push("run/exit", `退出码 ${code ?? "?"}`);
  });

  return run;
}

export function stopRun(id: string, reason = "手动停止"): boolean {
  const child = children.get(id);
  const run = runs.get(id);
  if (!child || !run) return false;

  // Windows 上 child.kill() 常杀不干净（codex 还会留下子进程），用 taskkill /T 连子树一起收
  try {
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill();
    }
  } catch {
    child.kill();
  }

  run.state = "failed";
  run.endedAt = Date.now();

  // 兜底：进程被强杀时 close 事件可能不来，排队器会一直等下去，3 秒后自己收尾
  const timer = setTimeout(() => {
    if (children.get(id) === child) {
      children.delete(id);
      run.exitCode = run.exitCode ?? null;
      emitters.get(id)?.("run/exit", `已停止（${reason}）`);
      emitters.delete(id);
    }
  }, 3000);
  timer.unref?.();
  return true;
}

/** 只保留最近 30 个任务，避免内存无限涨 */
export function pruneRuns(keep = 30): void {
  const all = listRuns();
  for (const r of all.slice(keep)) {
    if (r.state !== "running") runs.delete(r.id);
  }
}
