-- Foreman 数据库 schema（SQLite，Node 内置 node:sqlite）
-- 原则：events 只追加；任务状态由事件重放得出，界面不存第二份真相。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Agent 注册表：能力画像决定“谁适合干什么”
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,          -- codex / dsh
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,             -- cli | manual
  command       TEXT,                      -- cli 型：可执行文件或命令模板
  args_json     TEXT,                      -- 参数模板，支持 {{prompt}} {{task_id}}
  capabilities  TEXT,                      -- 逗号分隔：code, test, review, plan
  cost_per_1k   REAL DEFAULT 0,
  max_concurrency INTEGER DEFAULT 1,
  enabled       INTEGER DEFAULT 1,
  created_at    TEXT NOT NULL
);

-- 任务：一个可验收的工作单元
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  spec        TEXT NOT NULL,               -- 任务说明/验收标准
  status      TEXT NOT NULL,               -- todo | running | review | done | failed | blocked
  assignee    TEXT,                        -- agents.id
  parent_id   TEXT,
  priority    INTEGER DEFAULT 0,
  budget_usd  REAL DEFAULT 1.0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 一次执行：agent 跑一次就是一个 run
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,
  cwd         TEXT NOT NULL,               -- 每个 run 独立工作目录（git worktree）
  status      TEXT NOT NULL,               -- spawned | running | exited | killed | error
  exit_code   INTEGER,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  tokens_in   INTEGER DEFAULT 0,
  tokens_out  INTEGER DEFAULT 0,
  cost_usd    REAL DEFAULT 0
);

-- 事件日志：界面、统计、回放全部从这张表算
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT,
  task_id   TEXT,
  ts        TEXT NOT NULL,
  type      TEXT NOT NULL,                 -- spawn | stdout | stderr | handoff | artifact | gate | exit
  payload   TEXT                           -- JSON
);

-- 产物：必须可寻址、可校验
CREATE TABLE IF NOT EXISTS artifacts (
  id        TEXT PRIMARY KEY,
  run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path      TEXT NOT NULL,
  kind      TEXT NOT NULL,                 -- patch | file | report | screenshot
  sha256    TEXT,
  bytes     INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 交接单：唯一可信的“我干完了，接下来给你”
CREATE TABLE IF NOT EXISTS handoffs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_run    TEXT NOT NULL,
  to_agent    TEXT,
  status      TEXT NOT NULL,               -- done | blocked | partial
  summary     TEXT NOT NULL,
  decisions   TEXT,                        -- JSON 数组
  open_qs     TEXT,                        -- JSON 数组
  next_actions TEXT,                       -- JSON 数组
  payload     TEXT,                        -- 原始 handoff.json
  valid       INTEGER DEFAULT 1,           -- schema 校验是否通过
  accepted_at TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_run  ON events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, id);
CREATE INDEX IF NOT EXISTS idx_runs_task   ON runs(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority DESC, created_at);

-- 单用户、单机：不做 user 表，先不引入权限系统。
