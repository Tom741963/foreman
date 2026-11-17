// 排队截图：先起一条链，等它开跑后再起第二条，趁第二条排队时截图
// 用法: node scripts/shot-queue.mjs [url] [out]
const { chromium } = await import("file:///D:/campus-copilot/node_modules/playwright-core/index.mjs");

const url = process.argv[2] ?? "http://127.0.0.1:4319";
const out = process.argv[3] ?? "D:/foreman/docs/orch-queue.png";
const api = (p, init) => fetch(url + p, init).then((r) => r.json());
const post = (p, body) =>
  api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: "networkidle" });
await page.click('.view[data-view="orch"]');

const a = await post("/api/orchestrate", { task: "在 docs 下新建 queue-shot-a.md，内容一行：第一条。让 dsh 给正文，再让 codex 写文件。" });
// 等第一条真正开跑
for (let i = 0; i < 30; i++) {
  const o = await api(`/api/orch?id=${a.orch.id}`);
  if (o.steps.some((s) => s.state === "running")) break;
  await sleep(500);
}
await post("/api/orchestrate", { task: "在 docs 下新建 queue-shot-b.md，内容一行：第二条。让 dsh 给正文，再让 codex 写文件。" });

// 等第二条出现排队状态
let waited = 0;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  const list = await api("/api/orchs");
  const row = list.find((o) => o.task.includes("queue-shot-b"));
  if (!row) continue;
  const b = await api(`/api/orch?id=${row.id}`);
  if (b.steps.some((s) => s.state === "queued")) {
    waited = i;
    break;
  }
}
await sleep(400);
await page.screenshot({ path: out });
console.log("queued wait ticks =", waited, "->", out);
await browser.close();
