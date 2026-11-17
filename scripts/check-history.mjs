// 验证「任务历史」下拉：条数、切换、状态显示
// 用法: node scripts/check-history.mjs [url]
const { chromium } = await import("file:///D:/campus-copilot/node_modules/playwright-core/index.mjs");

const url = process.argv[2] ?? "http://127.0.0.1:4319";
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: "networkidle" });
await page.click('.view[data-view="orch"]');
await page.waitForTimeout(800);

const options = await page.$$eval("#orchPick option", (els) => els.map((e) => ({ value: e.value, text: e.textContent })));
const firstTask = (await page.textContent(".orch-title"))?.trim();

let switched = null;
if (options.length > 1) {
  await page.selectOption("#orchPick", options[1].value);
  await page.waitForTimeout(800);
  const state = (await page.textContent(".orch-state"))?.trim();
  const task = (await page.textContent(".orch-title"))?.trim();
  switched = { task, state, sameAsFirst: task === firstTask };
}

// 点「最新」应回到第一条
await page.click("#orchNew");
await page.waitForTimeout(800);
const backTask = (await page.textContent(".orch-title"))?.trim();

console.log(
  JSON.stringify(
    { options: options.length, firstTask, switched, backToFirst: backTask === firstTask, errors },
    null,
    2,
  ),
);
await browser.close();
