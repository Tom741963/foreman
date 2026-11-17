// 排队自测：同一 agent 同时提交两条链，后一条的步骤应该先「排队中」再被执行，两条都要完成
// 用法: node scripts/check-queue.mjs [url]
const url = process.argv[2] ?? "http://127.0.0.1:4319";

const api = (p, init) => fetch(url + p, init).then((r) => r.json());
const post = (p, body) =>
  api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const task = (n) => `在 docs 下新建 queue-${n}.md，内容一行：排队测试 ${n}。让 dsh 给正文，再让 codex 写文件。`;

const a = await post("/api/orchestrate", { task: task("a") });
const b = await post("/api/orchestrate", { task: task("b") });
console.log("started", a.orch.id, b.orch.id);

let sawQueued = false;
let states = {};
for (let i = 0; i < 300; i++) {
  const [oa, ob] = await Promise.all([api(`/api/orch?id=${a.orch.id}`), api(`/api/orch?id=${b.orch.id}`)]);
  states = { a: oa.state, b: ob.state };
  const queued = [...oa.steps, ...ob.steps].filter((s) => s.state === "queued");
  if (queued.length) {
    sawQueued = true;
    console.log("queued:", queued.map((s) => `${s.agent}#${s.i + 1} 前面 ${s.queuePos}`).join(", "));
  }
  if (["done", "failed", "stopped"].includes(oa.state) && ["done", "failed", "stopped"].includes(ob.state)) break;
  await sleep(2000);
}

const [fa, fb] = await Promise.all([api(`/api/orch?id=${a.orch.id}`), api(`/api/orch?id=${b.orch.id}`)]);
const result = {
  sawQueued,
  a: { state: fa.state, usage: fa.usage?.total ?? 0 },
  b: { state: fb.state, usage: fb.usage?.total ?? 0 },
  problems: [],
};
if (!sawQueued) result.problems.push("没有观察到排队状态");
if (fa.state !== "done") result.problems.push(`第一条链状态是 ${fa.state}`);
if (fb.state !== "done") result.problems.push(`第二条链状态是 ${fb.state}`);
if (!fa.usage?.total) result.problems.push("第一条链没有 token 统计");
if (!fb.usage?.total) result.problems.push("第二条链没有 token 统计");

console.log(JSON.stringify(result, null, 2));
process.exit(result.problems.length ? 1 : 0);
