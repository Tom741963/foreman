const state = {
  events: [],
  counts: { codex: 0, dsh: 0 },
  filter: "all",
  follow: true,
  status: null,
  runs: [],
  env: { hasKey: false, file: "" },
  target: "dsh",
  sending: false,
  view: "events",
  threadId: null,
  thread: null,
  threads: [],
  orch: null,
  orchs: [],
  orchId: null,
  pending: "",
  pendingThink: "",
  /** 待发送的附件（/api/attach 返回的元信息） */
  attachments: [],
  /** 圆桌里这一轮允许自动接力几次 */
  roomHops: 2,
  /** 正在跑的每一路发言：runId -> {agent, text, think}。顺序圆桌里同时只有一路 */
  pendingRuns: new Map(),
};

const $ = (id) => document.getElementById(id);
const eventsEl = $("events");
const emptyEl = $("empty");

const KIND_ALIAS = {
  reasoning: "思考",
  commandExecution: "命令",
  agentMessage: "回复",
  fileChange: "改文件",
  mcpToolCall: "MCP",
  webSearch: "搜索",
  imageView: "看图",
  "tool/call": "工具",
  "tool/result": "返回",
  "turn/start": "开始",
  "turn/end": "结束",
  "job/registered": "后台任务",
  "job/settled": "后台任务",
  user: "用户",
  assistant: "回复",
  title: "标题",
  "step/start": "步骤",
  "run/start": "派活",
  "run/session": "会话",
  "run/out": "输出",
  "run/text": "回复",
  "run/think": "思考",
  "run/err": "错误",
  "run/final": "结果",
  "run/exit": "收工",
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function timeOf(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toTimeString().slice(0, 8);
}

const isCommand = (kind) =>
  kind === "commandExecution" || kind === "tool/call" || kind === "run/out" || kind === "run/err";

function eventHTML(e, isNew) {
  const cls = [
    isNew ? "new" : "",
    e.kind === "run/think" ? "think-row" : "",
    state.filter === "all" || state.filter === e.agent ? "" : "hide",
  ];
  return `<div class="event ${cls.join(" ")}" data-agent="${e.agent}">
    <div class="t">${timeOf(e.ts)}</div>
    <div class="who ${e.agent}">${e.agent === "codex" ? "Codex" : "DSH"}</div>
    <div class="kind" title="${esc(e.kind)}">${esc(KIND_ALIAS[e.kind] ?? e.kind)}</div>
    <div class="text ${isCommand(e.kind) ? "mono" : ""}">${esc(e.text)}</div>
  </div>`;
}

function visibleEvents() {
  return state.events.filter((e) => state.filter === "all" || e.agent === state.filter);
}

function renderStream() {
  const list = visibleEvents();
  emptyEl.style.display = list.length ? "none" : "block";
  const keepOpen = new Set(
    [...eventsEl.querySelectorAll(".event.open")].map((n) => n.dataset.key).filter(Boolean),
  );
  eventsEl.innerHTML = "";
  const frag = document.createDocumentFragment();
  const tpl = document.createElement("div");
  for (const e of list) {
    tpl.innerHTML = eventHTML(e, e._isNew === true);
    const node = tpl.firstElementChild;
    node.dataset.key = `${e.agent}|${e.ts}|${e.kind}`;
    if (keepOpen.has(node.dataset.key)) node.classList.add("open");
    node.addEventListener("click", () => node.classList.toggle("open"));
    e._isNew = false;
    frag.append(node);
  }
  eventsEl.append(frag);
  if (state.follow) eventsEl.scrollTop = eventsEl.scrollHeight;
}

function renderAgents() {
  const agents = state.status?.agents ?? [];
  $("agentList").innerHTML = agents
    .map(
      (a) => `<div class="agent ${a.available ? "" : "off"} ${state.filter === a.id ? "on" : ""}" data-agent="${a.id}">
        <div class="agent-head">
          <span class="dot"></span>
          <span class="agent-name">${esc(a.name)}</span>
          <span class="agent-state">${a.available ? esc(a.state) : "未发现"}</span>
        </div>
        <div class="agent-detail"><span>${esc(a.detail)}</span><b>${a.count}</b></div>
      </div>`,
    )
    .join("");

  for (const node of $("agentList").querySelectorAll(".agent")) {
    node.addEventListener("click", () => {
      state.filter = state.filter === node.dataset.agent ? "all" : node.dataset.agent;
      syncTabs();
      renderAgents();
      renderStream();
    });
  }

  $("sources").innerHTML = agents
    .map(
      (a) => `<span class="${a.available ? "ok" : ""}"><i></i>${
        a.id === "codex" ? "~/.codex/thread_history_1.sqlite" : "~/.dsh/sessions/**/*.zstd"
      }</span>`,
    )
    .join("");
}

function renderDetail() {
  const agents = state.status?.agents ?? [];
  $("statusCards").innerHTML = agents
    .map(
      (a) => `<div class="card">
        <div class="row"><span>${esc(a.name)}</span><b>${a.available ? "在线" : "缺失"}</b></div>
        <div class="row"><span>状态</span><b>${esc(a.state)}</b></div>
        <div class="row"><span>详情</span><b>${esc(a.detail)}</b></div>
      </div>`,
    )
    .join("");

  const max = Math.max(1, state.counts.codex, state.counts.dsh);
  $("bars").innerHTML = ["codex", "dsh"]
    .map(
      (id) => `<div class="bar-row">
        <div style="display:flex;justify-content:space-between">
          <span>${id === "codex" ? "Codex" : "DSH"}</span><span>${state.counts[id]} 条</span>
        </div>
        <div class="bar-track"><div class="bar-fill ${id}" style="width:${(state.counts[id] / max) * 100}%"></div></div>
      </div>`,
    )
    .join("");
}

function syncTabs() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("on", tab.dataset.agent === state.filter);
  }
}

const RUN_STATE = { running: "跑着", done: "完成", failed: "失败" };

function renderRuns() {
  const runs = state.runs ?? [];
  if (!runs.length) {
    $("runs").innerHTML = `<p class="note">还没派过活。挑个 agent，写一句话，回车。</p>`;
    return;
  }
  $("runs").innerHTML = runs
    .map((r) => {
      const dur = r.endedAt ? ((r.endedAt - r.startedAt) / 1000).toFixed(1) + "s" : "…";
      return `<div class="run ${r.state}">
        <div class="run-head">
          <span class="who ${r.agent}">${r.agent === "codex" ? "Codex" : "DSH"}</span>
          <b>${RUN_STATE[r.state] ?? r.state}</b>
          <span class="run-dur">${dur}</span>
        </div>
        <p title="${esc(r.prompt)}">${esc(r.prompt)}</p>
      </div>`;
    })
    .join("");
}

function syncPick() {
  for (const b of $("pick").querySelectorAll(".pick-btn")) {
    b.classList.toggle("on", b.dataset.agent === state.target);
  }
  $("hint").classList.remove("bad");
  $("hopPick").hidden = !state.room;
  if (state.room) {
    $("hopPick").value = String(state.roomHops);
    const hops = state.roomHops;
    $("hint").innerHTML =
      hops > 0
        ? `群聊：按顺序发言，一人说完另一个再说。<code>@codex</code> / <code>@dsh</code> 指定谁先开口，不 @ 就 Codex 先说；被对方点名会自动接，最多 ${hops} 轮。`
        : '群聊：按顺序发言。<code>@codex</code> / <code>@dsh</code> 指定谁开口，不 @ 就 Codex 先说；这一轮不自动接力，说完就停，等你总结。';
    return;
  }
  if (state.target === "dsh") {
    $("hint").innerHTML = state.env.hasKey
      ? '走 <code>dsh headless</code>：任务跑完就退出，输出实时回到时间轴。'
      : `走 <code>dsh headless</code>，但还没读到 API key：把 <code>DEEPSEEK_API_KEY</code> 写进 <code>${esc(
          state.env.file || "~/.foreman/env.json",
        )}</code> 后重启服务。`;
  } else {
    $("hint").innerHTML =
      '走 <code>codex exec</code>：需要先 <code>npm i -g @openai/codex</code> 并登录。';
  }
}

$("pick").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-agent]");
  if (!btn) return;
  state.target = btn.dataset.agent;
  syncPick();
});

function setView(v) {
  state.view = v;
  for (const b of document.querySelectorAll(".view")) b.classList.toggle("on", b.dataset.view === v);
  $("events").hidden = v !== "events";
  $("chat").hidden = v !== "chat";
  $("orch").hidden = v !== "orch";
  if (v === "chat") renderChat();
  if (v === "orch") renderOrch();
}

function bubbleHTML(m) {
  const who = m.role === "user" ? "你" : m.agent === "codex" ? "Codex" : "DSH";
  const cls = m.role === "user" ? "user" : m.agent === "codex" ? "codex" : "dsh";
  return `<div class="msg ${cls}${m.pending ? " pending" : ""}">
    <div class="msg-head"><span>${who}</span><time>${m.at ? timeOf(m.at) : "正在写…"}</time></div>
    ${
      m.thinking
        ? `<details class="think"${m.pending ? " open" : ""}><summary>思考过程 · ${m.thinking.length} 字</summary><div class="think-body">${esc(
            m.thinking.slice(0, 6000),
          )}</div></details>`
        : ""
    }
    <div class="msg-body">${esc(m.text || "…")}</div>
  </div>`;
}

function renderChat() {
  const list = state.thread?.messages ?? [];
  const live = [...state.pendingRuns.values()];
  const empty =
    list.length || live.length
      ? ""
      : state.room
        ? `<div class="empty"><p>群里还没人说话</p><span>说一句试试；@codex 或 @dsh 指定谁回，不 @ 就两人都回。</span></div>`
        : `<div class="empty"><p>还没有对话</p><span>在下面写一句，交给 dsh headless 跑，回答会实时出现在这里。</span></div>`;
  $("chatList").innerHTML =
    empty +
    list.map((m) => bubbleHTML(m)).join("") +
    live
      .map((p) =>
        bubbleHTML({
          role: "assistant",
          agent: p.agent,
          text: p.text,
          thinking: p.think || undefined,
          pending: true,
        }),
      )
      .join("");
  $("chatList").scrollTop = $("chatList").scrollHeight;
}

function threadLabel(t) {
  const title = (t.title || "未命名对话").slice(0, 24);
  const tag = t.mode === "room" ? "群聊 · " : "";
  return `${tag}${title}（${t.messages} 条）`;
}

function renderThreadPick() {
  const sel = $("threadPick");
  if (!sel) return;
  const items = state.threads.map((t) => ({ id: t.id, label: threadLabel(t) }));
  if (state.threadId && !items.some((i) => i.id === state.threadId)) {
    items.unshift({ id: state.threadId, label: "（当前对话）" });
  }
  sel.innerHTML = items
    .map((i) => `<option value="${esc(i.id)}">${esc(i.label)}</option>`)
    .join("");
  sel.value = state.threadId ?? "";
}

async function loadThreads() {
  try {
    const list = await fetch("./api/threads").then((r) => r.json());
    state.threads = Array.isArray(list) ? list : [];
  } catch {
    state.threads = [];
  }
  renderThreadPick();
}

async function openThread(id) {
  try {
    const t = await fetch(`./api/thread?id=${encodeURIComponent(id)}`).then((r) => r.json());
    if (!t || t.error) return;
    state.threadId = t.id;
    state.thread = t;
    state.room = t.mode === "room";
    state.roomHops = typeof t.maxHops === "number" ? t.maxHops : 2;
    state.pending = "";
    state.pendingThink = "";
    state.pendingRuns.clear();
    $("task").placeholder =
      state.room
        ? "跟群里说点什么；@codex 或 @dsh 指定谁先开口"
        : "派个活：比如「读一遍 src/server.ts，指出三个可改的地方」";
    renderChat();
    renderThreadPick();
    syncPick();
  } catch {
    // 切不过去就留在原地
  }
}

function startNewThread(room = false) {
  state.threadId = null;
  state.thread = { id: null, title: "", messages: [], mode: room ? "room" : "dm" };
  state.room = room;
  if (room) state.roomHops = 2;
  state.pending = "";
  state.pendingThink = "";
  state.pendingRuns.clear();
  $("task").placeholder = room
    ? "跟群里说点什么；@codex 或 @dsh 指定谁先开口"
    : "派个活：比如「读一遍 src/server.ts，指出三个可改的地方」";
  renderChat();
  renderThreadPick();
  syncPick();
  setView("chat");
  $("task").focus();
}

$("threadPick").addEventListener("change", (ev) => {
  const id = ev.target.value;
  if (id) openThread(id);
});
$("newThread").addEventListener("click", () => startNewThread(false));
$("newRoom").addEventListener("click", () => startNewThread(true));
$("hopPick").addEventListener("change", (ev) => {
  state.roomHops = Number(ev.target.value);
  syncPick();
});

const ORCH_STATE_TEXT = {
  planning: "拆解中",
  running: "执行中",
  verifying: "验收中",
  done: "已完成",
  failed: "失败",
  stopped: "已停止",
};

function renderOrchPick() {
  const sel = $("orchPick");
  if (!sel) return;
  if (!state.orchs.length) {
    sel.innerHTML = `<option value="">暂无任务链</option>`;
    return;
  }
  sel.innerHTML = state.orchs
    .map((o) => {
      const t = o.task.length > 26 ? o.task.slice(0, 26) + "…" : o.task;
      const st = ORCH_STATE_TEXT[o.state] ?? o.state;
      const cur = (state.orchId ?? state.orchs[0].id) === o.id ? " selected" : "";
      return `<option value="${o.id}"${cur}>${esc(t)}　·　${st}　·　${o.steps} 步</option>`;
    })
    .join("");
}

async function loadOrchs() {
  try {
    const list = await fetch("./api/orchs").then((r) => r.json());
    if (Array.isArray(list)) {
      state.orchs = list;
      renderOrchPick();
    }
  } catch {
    // 忽略
  }
}

async function openOrch(id) {
  state.orchId = id;
  try {
    const o = await fetch(`./api/orch?id=${encodeURIComponent(id)}`).then((r) => r.json());
    state.orch = o;
    renderOrch();
    renderOrchPick();
  } catch {
    // 忽略
  }
}

/** 回到最新那条（不锁定，后续新任务链会自动切过来） */
async function showLatestOrch() {
  state.orchId = null;
  await loadOrchs();
  const first = state.orchs[0];
  if (!first) {
    state.orch = null;
    renderOrch();
    return;
  }
  state.orch = await fetch(`./api/orch?id=${encodeURIComponent(first.id)}`).then((r) => r.json());
  renderOrch();
  renderOrchPick();
}

$("orchPick").addEventListener("change", (ev) => {
  const id = ev.target.value;
  if (id) openOrch(id);
});
$("orchNew").addEventListener("click", showLatestOrch);

function renderOrch() {
  const el = $("orchList");
  const o = state.orch;
  if (!el) return;
  if (!o) {
    el.innerHTML = `<div class="empty"><p>还没有任务链</p><span>在下面写一件复杂一点的事，交给它拆成几步，两个 agent 接力完成。</span></div>`;
    return;
  }
  const stateText = ORCH_STATE_TEXT[o.state] ?? o.state;
  const stepState = {
    pending: "等待",
    queued: "排队中",
    running: "执行中",
    done: "完成",
    failed: "失败",
    stopped: "已停止",
  };
  const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const steps = o.steps
    .map((s) => {
      const cost = s.startedAt && s.endedAt ? `${((s.endedAt - s.startedAt) / 1000).toFixed(1)}s` : "";
      const tok = s.usage?.total ? ` · ${fmt(s.usage.total)} tok` : "";
      const out = s.output ? esc(s.output.slice(0, 1200)) : "…";
      const canRetry = s.state === "failed" || s.state === "stopped";
      return `<div class="step ${s.state}">
        <div class="step-head">
          <span class="step-no">${s.i + 1}</span>
          <span class="who ${s.agent}">${s.agent === "codex" ? "Codex" : "DSH"}</span>
          <span class="step-title">${esc(s.title)}</span>
          <span class="step-state">${stepState[s.state] ?? s.state}${s.state === "queued" && s.queuePos ? ` · 前面 ${s.queuePos} 个` : ""}${
            cost ? " · " + cost : ""
          }${tok}</span>
          ${canRetry ? `<button class="step-retry" data-retry="${s.i}">重跑这一步</button>` : ""}
        </div>
        <div class="step-prompt">${esc(s.prompt.slice(0, 200))}</div>
        ${
          s.thinking
            ? `<details class="think"><summary>思考过程 · ${s.thinking.length} 字</summary><div class="think-body">${esc(
                s.thinking.slice(0, 4000),
              )}</div></details>`
            : ""
        }
        <div class="step-out">${out}</div>
      </div>`;
    })
    .join("");
  const running = o.state === "running" || o.state === "planning" || o.state === "verifying";
  const v = o.verify
    ? `<div class="verify ${o.verify.pass ? "ok" : "bad"}">
        <div class="verify-head">验收 · ${o.verify.pass ? "通过" : "未通过"}${
          o.retried ? (o.verify.pass ? "（返工一次后通过）" : "（已自动返工一次，仍未通过）") : ""
        }</div>
        <div class="verify-sum">${esc(o.verify.summary)}</div>
        ${
          o.verify.issues.length
            ? `<ul class="verify-issues">${o.verify.issues
                .map((x) => `<li>第 ${x.step} 步：${esc(x.problem)}</li>`)
                .join("")}</ul>`
            : ""
        }
      </div>`
    : "";
  const badge = { added: "新增", modified: "修改", deleted: "删除" };
  const arts = o.artifacts?.length
    ? (() => {
        const n = (c) => o.artifacts.filter((a) => a.change === c).length;
        const sum = [n("added") && `新增 ${n("added")}`, n("modified") && `修改 ${n("modified")}`, n("deleted") && `删除 ${n("deleted")}`]
          .filter(Boolean)
          .join(" · ");
        return `<div class="artifacts">
          <div class="art-head">产物 · ${o.artifacts.length} 个文件<span class="art-sum">${sum}</span></div>
          ${o.artifacts
            .map(
              (a) => `<details class="art">
            <summary>
              <span class="art-path">${esc(a.path)}</span>
              <span class="art-badge ${a.change}">${badge[a.change] ?? a.change}</span>
              <span class="art-stat">+${a.added} −${a.removed}</span>
            </summary>
            <pre class="art-diff">${esc(a.diff)}</pre>
          </details>`,
            )
            .join("")}
        </div>`;
      })()
    : "";
  const u = o.usage;
  const costBlock =
    u && (u.total || u.ms)
      ? `<div class="cost">
          <span class="cost-k">成本</span>
          <span>输入 ${fmt(u.input)}</span>
          <span>输出 ${fmt(u.output)}</span>
          <span>缓存命中 ${fmt(u.cached)}</span>
          <span class="cost-total">合计 ${fmt(u.total)} tok</span>
          <span class="cost-ms">${(u.ms / 1000).toFixed(1)}s</span>
        </div>`
      : "";
  el.innerHTML = `
    <div class="orch-task">
      <div class="orch-head">
        <span class="orch-title">${esc(o.task)}</span>
        <span class="orch-state ${o.state}">${stateText}</span>
        ${running ? `<button class="orch-stop" id="orchStop">停</button>` : ""}
      </div>
      ${o.note ? `<div class="orch-note">${esc(o.note)}</div>` : ""}
      <div class="orch-steps">${steps}</div>
      ${arts}
      ${costBlock}
      ${v}
    </div>`;
}

$("orchList").addEventListener("click", async (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLElement) || !state.orch) return;
  const post = (path, body) =>
    fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});

  if (t.closest("#orchStop")) {
    await post("./api/orch/stop", { id: state.orch.id });
    return;
  }
  const retry = t.closest(".step-retry");
  if (retry instanceof HTMLElement) {
    await post("./api/orch/retry", { id: state.orch.id, i: Number(retry.dataset.retry) });
  }
});

for (const btn of document.querySelectorAll(".view")) {
  btn.addEventListener("click", () => setView(btn.dataset.view));
}$("composer").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (state.sending) return;
  const prompt = $("task").value.trim();
  if (!prompt) return;

  state.sending = true;
  const btn = $("send");
  btn.disabled = true;
  btn.textContent = "跑着…";
  try {
    const chat = state.view === "chat";
    const room = chat && state.room;
    const orch = state.view === "orch";
    const res = await fetch(
      orch ? "./api/orchestrate" : room ? "./api/room" : chat ? "./api/chat" : "./api/task",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          orch
            ? { task: prompt }
            : room
              ? { threadId: state.threadId, prompt, hops: state.roomHops, attachments: state.attachments ?? [] }
              : chat
                ? { threadId: state.threadId, prompt, agent: state.target, attachments: state.attachments ?? [] }
                : { agent: state.target, prompt, attachments: state.attachments ?? [] },
        ),
      },
    );
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? "派活失败");
    $("task").value = "";
    if (!orch) {
      state.attachments = [];
      renderAttachments();
    }
    if (orch) {
      state.orchId = null;
      state.orch = data.orch;
      renderOrch();
      await loadOrchs();
    } else if (room) {
      const isNew = data.threadId && data.threadId !== state.threadId;
      state.threadId = data.threadId;
      state.pendingRuns.clear();
      renderChat();
      if (isNew) {
        await loadThreads();
        await openThread(data.threadId);
      }
    } else if (chat) {
      const isNew = data.threadId && data.threadId !== state.threadId;
      state.threadId = data.threadId;
      state.pending = "";
      state.pendingThink = "";
      renderChat();
      if (isNew) {
        await loadThreads();
        await openThread(data.threadId);
      }
    } else if (data.run) {
      state.runs = [data.run, ...state.runs.filter((r) => r.id !== data.run.id)].slice(0, 6);
      renderRuns();
    }
  } catch (err) {
    $("hint").textContent = `派活失败：${err.message}`;
    $("hint").classList.add("bad");
  } finally {
    state.sending = false;
    btn.disabled = false;
    btn.textContent = "派活";
  }
});

function addEvents(list) {
  for (const e of list) {
    e._isNew = true;
    state.events.push(e);
    state.counts[e.agent] = (state.counts[e.agent] ?? 0) + 1;
  }
  if (state.events.length > 400) state.events.splice(0, state.events.length - 400);
  renderStream();
  renderDetail();
  renderAgents();
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    state.filter = tab.dataset.agent;
    syncTabs();
    renderAgents();
    renderStream();
  });
}

$("follow").addEventListener("change", (e) => {
  state.follow = e.target.checked;
  if (state.follow) eventsEl.scrollTop = eventsEl.scrollHeight;
});

eventsEl.addEventListener("scroll", () => {
  const nearBottom = eventsEl.scrollHeight - eventsEl.scrollTop - eventsEl.clientHeight < 40;
  if (!nearBottom && state.follow) {
    state.follow = false;
    $("follow").checked = false;
  }
});

setInterval(() => {
  $("clock").textContent = new Date().toTimeString().slice(0, 8);
}, 1000);

async function boot() {
  const res = await fetch("./api/state");
  const data = await res.json();
  state.status = data.status;
  state.runs = data.runs ?? [];
  state.env = data.env ?? state.env;
  state.counts = Object.fromEntries(data.status.agents.map((a) => [a.id, a.count]));
  state.events = data.events.map((e) => ({ ...e }));
  renderAgents();
  renderStream();
  renderDetail();
  renderRuns();
  syncPick();
  attachEvents();
  renderAttachments();

  try {
    await loadThreads();
    if (state.threads.length) await openThread(state.threads[0].id);
  } catch {
    // 没有历史对话也能用
  }

  try {
    await showLatestOrch();
  } catch {
    // 没有任务链也能用
  }

  const es = new EventSource("./api/stream");
  es.onopen = () => $("live").classList.remove("down");
  es.onerror = () => {
    $("live").classList.add("down");
    $("live").innerHTML = "<i></i>断开";
  };
  es.onmessage = (msg) => {
    const payload = JSON.parse(msg.data);
    if (payload.type === "init") {
      state.status = payload.status;
      state.runs = payload.runs ?? state.runs;
      state.env = payload.env ?? state.env;
      state.events = payload.events.map((e) => ({ ...e }));
      state.counts = Object.fromEntries(payload.status.agents.map((a) => [a.id, a.count]));
      renderAgents();
      renderStream();
      renderDetail();
      renderRuns();
      syncPick();
      return;
    }
    if (payload.type === "status") {
      state.status = payload.status;
      renderAgents();
      renderDetail();
      return;
    }
    if (payload.type === "events") addEvents(payload.events);
    if (payload.type === "orch" && payload.orch) {
      const o = payload.orch;
      if (state.orchId === null || state.orchId === o.id) {
        state.orch = o;
        if (state.view === "orch") renderOrch();
      }
      const hit = state.orchs.find((x) => x.id === o.id);
      if (!hit) {
        // 新任务链：插到最前
        state.orchs.unshift({ id: o.id, task: o.task, state: o.state, createdAt: o.createdAt, steps: o.steps.length });
        renderOrchPick();
      } else if (hit.state !== o.state) {
        hit.state = o.state;
        renderOrchPick();
      }
    }
    if (payload.type === "runs" && Array.isArray(payload.runs)) {
      state.runs = payload.runs;
      renderRuns();
    }
    if (payload.type === "chat-think" && payload.threadId === state.threadId) {
      const cur = state.pendingRuns.get(payload.runId) ?? { agent: payload.agent, text: "", think: "" };
      cur.think += payload.text;
      state.pendingRuns.set(payload.runId, cur);
      if (state.view === "chat") renderChat();
      return;
    }
    if (payload.type === "chat-delta" && payload.threadId === state.threadId) {
      const cur = state.pendingRuns.get(payload.runId) ?? { agent: payload.agent, text: "", think: "" };
      cur.text += (cur.text ? "\n" : "") + payload.text;
      state.pendingRuns.set(payload.runId, cur);
      if (state.view === "chat") renderChat();
      return;
    }
    if (payload.type === "thread") {
      state.threadId = payload.thread.id;
      state.thread = payload.thread;
      state.room = payload.thread.mode === "room";
      state.pending = "";
      state.pendingThink = "";
      if (state.view === "chat") renderChat();
      loadThreads();
    }
  };
}

boot().catch((err) => {
  $("live").classList.add("down");
  $("live").innerHTML = "<i></i>连接失败";
  eventsEl.innerHTML = `<div class="empty"><p>连不上本地服务</p><span>${esc(err.message)}</span></div>`;
});

/* ---------------- 附件：拖进来、粘进来、点＋选 ---------------- */

function renderAttachments() {
  const bar = $("attachBar");
  const list = state.attachments ?? [];
  bar.hidden = list.length === 0;
  bar.innerHTML = list
    .map(
      (a, i) => `
      <span class="chip${a.note ? " bad" : ""}" title="${esc(a.note || a.rel)}">
        ${a.kind === "image" ? "🖼" : a.kind === "video" ? "🎬" : "📄"} ${esc(a.name)}
        <button type="button" data-drop="${i}" title="移除">×</button>
      </span>`,
    )
    .join("");
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function uploadFile(file) {
  state.attachments = state.attachments ?? [];
  if (state.attachments.length >= 6) {
    setHint("最多 6 个附件");
    return;
  }
  try {
    const data = await readAsBase64(file);
    const res = await fetch("./api/attach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: state.threadId, name: file.name, mime: file.type, data }),
    });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error ?? "上传失败");
    state.attachments.push(out.attachment);
    renderAttachments();
    if (out.attachment.note) setHint(out.attachment.note);
  } catch (err) {
    setHint(`附件失败：${err.message}`);
  }
}

function attachEvents() {
  $("attachBtn").addEventListener("click", () => $("filePick").click());
  $("filePick").addEventListener("change", async (ev) => {
    for (const file of ev.target.files ?? []) await uploadFile(file);
    ev.target.value = "";
  });
  $("attachBar").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-drop]");
    if (!btn) return;
    state.attachments.splice(Number(btn.dataset.drop), 1);
    renderAttachments();
  });
  document.addEventListener("paste", (ev) => {
    const items = [...(ev.clipboardData?.items ?? [])];
    const files = items.filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    ev.preventDefault();
    files.forEach((f) => uploadFile(f));
  });
  const composer = $("composer");
  composer.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    composer.classList.add("dropping");
  });
  composer.addEventListener("dragleave", () => composer.classList.remove("dropping"));
  composer.addEventListener("drop", (ev) => {
    ev.preventDefault();
    composer.classList.remove("dropping");
    [...(ev.dataTransfer?.files ?? [])].forEach((f) => uploadFile(f));
  });
}
