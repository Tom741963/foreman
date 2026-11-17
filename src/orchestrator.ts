/**
 * 协作：一个任务拆成几步，分给更擅长的 agent，前一步的产出喂给后一步
 *
 * 拆解用 dsh（中文表达好、会写方案），落地改代码交给 codex。
 * 计划本身是严格 JSON，解析失败就退化成“单步直接执行”，不会卡住。
 */
import fs from "node:fs";
import path from "node:path";
import { LOG_ROOT } from "./logs.ts";
import type { ArtifactChange } from "./artifacts.ts";
import type { RunAgent } from "./runner.ts";

export type StepState = "pending" | "queued" | "running" | "done" | "failed" | "stopped";

export type OrchStep = {
  i: number;
  agent: RunAgent;
  title: string;
  prompt: string;
  state: StepState;
  /** 排队时前面还有几个任务 */
  queuePos?: number;
  /** 这一步的 token 用量（有就显示） */
  usage?: { input: number; output: number; total: number };
  runId?: string;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
  output?: string;
  thinking?: string;
  /** 上一轮验收没过时，这里存着要修正的问题 */
  fixNote?: string;
};

export type VerifyIssue = { step: number; problem: string };

export type OrchUsage = { input: number; output: number; cached: number; total: number; ms: number };

export type Verification = {
  pass: boolean;
  summary: string;
  issues: VerifyIssue[];
  at: number;
};

export type Orchestration = {
  id: string;
  task: string;
  createdAt: number;
  state: "planning" | "running" | "verifying" | "done" | "failed" | "stopped";
  steps: OrchStep[];
  note?: string;
  verify?: Verification;
  /** 这条链动过的文件（相对工作目录） */
  artifacts?: ArtifactChange[];
  /** 这条链的 token 用量与耗时 */
  usage?: OrchUsage;
  /** 只自动返工一次 */
  retried?: boolean;
};

const DIR = path.join(LOG_ROOT, "orchestrations");
const cache = new Map<string, Orchestration>();

function ensureDir(): void {
  try {
    fs.mkdirSync(DIR, { recursive: true });
  } catch {
    // 盘不可用就只留内存
  }
}

export function planPrompt(task: string): string {
  return [
    "你是任务拆解器。把下面这件事拆成 2-3 步，分给两个执行者：",
    "- dsh：中文写作、方案设计、代码审查、解释与总结",
    "- codex：在仓库里改代码、跑命令、执行具体改动",
    "",
    "只输出 JSON 数组，不要解释、不要代码块。每项格式：",
    '{"agent":"dsh|codex","title":"不超过12字的步骤名","prompt":"给这个执行者的完整指令"}',
    "",
    "要求：每步的 prompt 能独立执行，写清楚要读什么、产出什么；如果任务很小，就只给一步。",
    "每步要小：一次最多改一个文件，产出控制在 30 行以内。",
    "执行者的 prompt 里要写明：只输出最终产物，不要输出过程性说明（例如“我先读一下…”）。",
    "prompt 末尾必须加上这句约束：只做这一件事；不要跑测试、不要执行 git 命令、不要探索无关目录、不要重复核对。",
    "",
    "任务：" + task,
  ].join("\n");
}

export function parsePlan(text: string, task: string): OrchStep[] {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  const body = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try {
    const list = JSON.parse(body) as Array<Record<string, unknown>>;
    const steps = list
      .filter((x) => x && typeof x.prompt === "string" && String(x.prompt).trim())
      .slice(0, 3)
      .map((x, i) => ({
        i,
        agent: (x.agent === "codex" ? "codex" : "dsh") as RunAgent,
        title: String(x.title ?? `第 ${i + 1} 步`).slice(0, 16),
        prompt: String(x.prompt),
        state: "pending" as StepState,
      }));
    if (steps.length) return steps;
  } catch {
    // 落到兜底
  }
  return [{ i: 0, agent: "dsh", title: "直接执行", prompt: task, state: "pending" }];
}

export function newOrch(task: string): Orchestration {
  const o: Orchestration = {
    id: `O-${Date.now().toString(36)}`,
    task,
    createdAt: Date.now(),
    state: "planning",
    steps: [],
  };
  cache.set(o.id, o);
  saveOrch(o);
  return o;
}

export function saveOrch(o: Orchestration): void {
  cache.set(o.id, o);
  try {
    ensureDir();
    fs.writeFileSync(path.join(DIR, `${o.id}.json`), JSON.stringify(o, null, 2), "utf8");
  } catch {
    // 落盘失败不影响运行
  }
}

export function getOrch(id: string): Orchestration | null {
  const hit = cache.get(id);
  if (hit) return hit;
  try {
    const file = path.join(DIR, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    const o = JSON.parse(fs.readFileSync(file, "utf8")) as Orchestration;
    cache.set(o.id, o);
    return o;
  } catch {
    return null;
  }
}

export function listOrch(): Orchestration[] {
  const out: Orchestration[] = [];
  try {
    for (const name of fs.readdirSync(DIR)) {
      if (!name.endsWith(".json")) continue;
      const o = getOrch(name.replace(/\.json$/, ""));
      if (o) out.push(o);
    }
  } catch {
    // 目录还没建
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function verifyPrompt(o: Orchestration): string {
  const parts = o.steps.map(
    (s) =>
      `第 ${s.i + 1} 步（${s.agent}）${s.title}\n指令：${s.prompt.slice(0, 300)}\n产出：${(s.output ?? "").slice(0, 800)}`,
  );
  return [
    "你是验收员。判断这条任务链有没有真的完成用户的原始任务。",
    "",
    "原始任务：" + o.task,
    "",
    "各步产出：",
    parts.join("\n\n"),
    "",
    "检查要点：产出是否满足原始任务的要求（文件是否真的写了、内容是否完整、有没有把过程说明当成正文）。",
    "只输出 JSON，不要解释、不要代码块：",
    '{"pass":true|false,"summary":"一句话结论","issues":[{"step":1,"problem":"具体哪里不对"}]}',
    "通过时 issues 为空数组。",
  ].join("\n");
}

export function parseVerification(text: string): Verification {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const body = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  const at = Date.now();
  try {
    const raw = JSON.parse(body) as {
      pass?: unknown;
      summary?: unknown;
      issues?: Array<{ step?: unknown; problem?: unknown }>;
    };
    const issues = Array.isArray(raw.issues)
      ? raw.issues
          .filter((x) => x && typeof x.problem === "string")
          .map((x) => ({ step: Number(x.step ?? 1) || 1, problem: String(x.problem) }))
          .slice(0, 4)
      : [];
    return {
      pass: raw.pass === true,
      summary: String(raw.summary ?? (raw.pass === true ? "通过" : "未通过")),
      issues,
      at,
    };
  } catch {
    return { pass: false, summary: text.slice(0, 120) || "验收结果无法解析", issues: [], at };
  }
}
