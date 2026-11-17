// 等「验收中」徽章出现后截图（验证 v0.8 的状态跳变）
// 用法: node scripts/shot-verify.mjs [url] [out] [timeoutMs]
const { chromium } = await import("file:///D:/campus-copilot/node_modules/playwright-core/index.mjs");

const url = process.argv[2] ?? "http://127.0.0.1:4319";
const out = process.argv[3] ?? "D:/foreman/docs/orch-verifying.png";
const timeout = Number(process.argv[4] ?? 180000);

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: "networkidle" });
await page.click('.view[data-view="orch"]');

let seen = false;
try {
  await page.waitForSelector(".orch-state.verifying", { timeout });
  seen = true;
  await page.waitForTimeout(600);
  await page.screenshot({ path: out });
  console.log("shot ->", out, "(verifying)");
} catch {
  await page.screenshot({ path: out });
  console.log("shot ->", out, "(没等到 verifying，拍的是最终状态)");
}
console.log("console errors:", errors.length ? errors.join(" | ") : "none");
await browser.close();
process.exit(seen ? 0 : 2);
