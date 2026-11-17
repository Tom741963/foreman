// 产物面板自测：跑一条会改文件的任务链，检查 artifacts 的字段和 diff 头
// 用法: node scripts/check-artifacts.mjs [url] [--run]
const url = process.argv[2] ?? "http://127.0.0.1:4319";
const run = process.argv.includes("--run");

const api = (p, init) => fetch(url + p, init).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let id;
if (run) {
  const created = await api("/api/orchestrate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: "在 docs 下新建 artifact-selftest.md，内容一行：产物自测。让 dsh 给正文，再让 codex 写文件。" }),
  });
  id = created.orch.id;
  console.log("started", id);
} else {
  const list = await api("/api/orchs");
  const done = list.find((o) => o.state === "done") ?? list[0];
  id = done.id;
}

for (let i = 0; i < 120; i++) {
  const o = await api(`/api/orch?id=${id}`);
  if (["done", "failed", "stopped"].includes(o.state)) {
    const arts = o.artifacts ?? [];
    const bad = [];
    for (const a of arts) {
      if (!a.path || !a.change) bad.push(`${a.path}: 缺字段`);
      if (a.change === "added" && !a.diff.startsWith("--- /dev/null")) bad.push(`${a.path}: 新增文件的 diff 头不对`);
      if (typeof a.added !== "number" || typeof a.removed !== "number") bad.push(`${a.path}: 行数不是数字`);
    }
    console.log(
      JSON.stringify(
        {
          id,
          state: o.state,
          files: arts.length,
          summary: arts.map((a) => `${a.change} ${a.path} +${a.added} −${a.removed}`),
          problems: bad,
        },
        null,
        2,
      ),
    );
    process.exit(bad.length ? 1 : 0);
  }
  await sleep(2000);
}
console.log("超时，任务链没跑完");
process.exit(2);
